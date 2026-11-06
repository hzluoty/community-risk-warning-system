//! 本地代理令牌守卫：常量时间比较 + 受保护路径判定
//! （对齐 qwenProxy.js 的 isLocalProxyToken* 家族与 createLocalProxyTokenGuard）。
//! 路径事实源是 contract（shared/apiRoutes.js），本模块不手写任何路由常量。

use axum::response::Response;

use crate::config::ProxyConfig;
use crate::contract;
use crate::responses::error_response;

/// 唯一事实源：shared/apiRoutes.js → contract.json 的 headers.localProxyToken。
/// 运行期取值（契约是启动时反序列化的 JSON，不能做编译期常量）。
pub fn local_proxy_token_header() -> &'static str {
    contract::local_proxy_token_header()
}

/// 常量时间比较（长度不等直接失败，等长时逐字节异或累积）。
pub fn timing_safe_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc: u8 = 0;
    for i in 0..a.len() {
        acc |= a[i] ^ b[i];
    }
    acc == 0
}

pub fn is_local_proxy_token_protected_path(pathname: &str) -> bool {
    pathname == contract::qwen_chat_completions_route()
        || pathname == contract::ollama_chat_completions_route()
        || pathname.starts_with(contract::tasks_route_prefix())
}

pub fn is_local_proxy_token_present(token: Option<&str>, config: &ProxyConfig) -> bool {
    if config.local_proxy_token.is_empty() {
        return true;
    }
    match token {
        Some(token) => timing_safe_eq(token.as_bytes(), config.local_proxy_token.as_bytes()),
        None => false,
    }
}

pub fn is_local_proxy_token_authorized(
    pathname: &str,
    token: Option<&str>,
    config: &ProxyConfig,
) -> bool {
    if config.local_proxy_token.is_empty() || !is_local_proxy_token_protected_path(pathname) {
        return true;
    }
    is_local_proxy_token_present(token, config)
}

/// 路径作用域守卫（chat 路由）：路径在保护集内才校验令牌。
/// 未授权时返回 403 JSON，授权返回 None 放行。
pub fn guard_path_scoped(
    config: &ProxyConfig,
    path: &str,
    token: Option<&str>,
) -> Option<Response> {
    if is_local_proxy_token_authorized(path, token, config) {
        return None;
    }
    Some(error_response(403, "本地代理请求未授权", "forbidden"))
}

/// 全量守卫（挂在 /api/tasks 前缀下）：路由收到的是去前缀的相对路径，
/// 整段视为受保护，只看令牌本身。
pub fn guard_all(config: &ProxyConfig, token: Option<&str>) -> Option<Response> {
    if is_local_proxy_token_present(token, config) {
        return None;
    }
    Some(error_response(403, "本地代理请求未授权", "forbidden"))
}

/// 鉴权尝试限流的 skip 判定（chat 路由）：合法令牌不消耗鉴权配额。
pub fn auth_attempt_skipped_path_scoped(
    config: &ProxyConfig,
    path: &str,
    token: Option<&str>,
) -> bool {
    is_local_proxy_token_authorized(path, token, config)
}

/// 鉴权尝试限流的 skip 判定（tasks 前缀）：只看令牌本身。
pub fn auth_attempt_skipped_all(config: &ProxyConfig, token: Option<&str>) -> bool {
    is_local_proxy_token_present(token, config)
}

/// 提取请求头中的本地代理令牌（头名来自契约）。
pub fn extract_token(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get(local_proxy_token_header())
        .and_then(|v| v.to_str().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::config_from_env;
    use crws_core::EnvMap;

    fn config_with_token(token: &str) -> ProxyConfig {
        let mut map = EnvMap::new();
        map.insert("LOCAL_PROXY_TOKEN".into(), token.into());
        config_from_env(&map)
    }

    #[test]
    fn timing_safe_compare_matches_only_equal_bytes() {
        assert!(timing_safe_eq(b"secret", b"secret"));
        assert!(!timing_safe_eq(b"secret", b"secreu"));
        assert!(!timing_safe_eq(b"secret", b"secre"));
        assert!(timing_safe_eq(b"", b""));
    }

    #[test]
    fn protects_chat_and_tasks_paths_but_not_health() {
        assert!(is_local_proxy_token_protected_path(
            "/api/qwen/chat/completions"
        ));
        assert!(is_local_proxy_token_protected_path(
            "/api/ollama/chat/completions"
        ));
        assert!(is_local_proxy_token_protected_path("/api/tasks/ingest"));
        assert!(is_local_proxy_token_protected_path("/api/tasks/results"));
        assert!(!is_local_proxy_token_protected_path("/api/health"));
    }

    #[test]
    fn authorizes_only_matching_tokens_on_protected_paths() {
        let config = config_with_token("secret");

        assert!(is_local_proxy_token_authorized(
            "/api/qwen/chat/completions",
            Some("secret"),
            &config
        ));
        assert!(!is_local_proxy_token_authorized(
            "/api/qwen/chat/completions",
            Some("wrong"),
            &config
        ));
        assert!(is_local_proxy_token_authorized(
            "/api/health",
            Some("wrong"),
            &config
        ));
        // token 缺失且已配置令牌 → 拒绝（JS：typeof token !== 'string' → false）
        assert!(!is_local_proxy_token_authorized(
            "/api/qwen/chat/completions",
            None,
            &config
        ));
        // 未配置令牌（回环部署默认）→ 放行
        let no_token = config_from_env(&EnvMap::new());
        assert!(is_local_proxy_token_authorized(
            "/api/qwen/chat/completions",
            None,
            &no_token
        ));
    }

    #[test]
    fn named_guards_return_403_only_when_unauthorized() {
        let config = config_with_token("secret");

        // 路径作用域守卫：chat 路径校验令牌，health 放行
        assert!(guard_path_scoped(&config, "/api/qwen/chat/completions", Some("wrong")).is_some());
        assert!(guard_path_scoped(&config, "/api/qwen/chat/completions", Some("secret")).is_none());
        assert!(guard_path_scoped(&config, "/api/health", Some("wrong")).is_none());

        // 全量守卫：只看令牌
        assert!(guard_all(&config, Some("secret")).is_none());
        assert!(guard_all(&config, Some("wrong")).is_some());
        assert!(guard_all(&config, None).is_some());
    }

    #[test]
    fn skip_predicates_match_guard_semantics() {
        let config = config_with_token("secret");

        assert!(auth_attempt_skipped_path_scoped(
            &config,
            "/api/qwen/chat/completions",
            Some("secret")
        ));
        assert!(!auth_attempt_skipped_path_scoped(
            &config,
            "/api/qwen/chat/completions",
            Some("wrong")
        ));
        assert!(auth_attempt_skipped_path_scoped(
            &config,
            "/api/health",
            Some("wrong")
        ));

        assert!(auth_attempt_skipped_all(&config, Some("secret")));
        assert!(!auth_attempt_skipped_all(&config, Some("wrong")));
    }
}
