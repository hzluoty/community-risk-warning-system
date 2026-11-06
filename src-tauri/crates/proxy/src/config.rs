//! 环境变量 → `ProxyConfig`（`VlmRuntimeConfig` 与 env 解析住在 crws-core，此处转出）。
//! 语义逐条对齐 shared/envParsers.js、shared/vlmRuntimeConfig.js、
//! server/qwenProxy.js#loadQwenProxyConfig（含默认值与回退规则）。
//! 解析行为的期望值由 shared/fixtures/env.json 锁定（JS 与 Rust 共用同一组用例）。
//!
//! 配置结构职责（架构评审 B 条）：
//! - 端点只持 `Option<&'static Endpoint>` 引用（endpoints.rs 是唯一事实源，config 不拷贝）
//! - 本地上游收敛为 `LocalVlmUpstream`，base_url 由方法派生
//! - 限流阈值 / 载荷上限各自成组（`Limits` / `PayloadLimits`）
//! - 请求体上限与上游响应上限是两个独立策略，各自默认值互不复用

use std::net::IpAddr;
use std::str::FromStr;
use std::time::Duration;

use crate::contract;
use crate::endpoints::{resolve_qwen_endpoint, Endpoint};

pub const DEFAULT_CORS_ORIGINS: [&str; 1] = ["http://localhost:5173"];
pub const QWEN_TIMEOUT_OPTIONS_MS: [u64; 5] = [15_000, 30_000, 60_000, 90_000, 120_000];
pub const OLLAMA_TIMEOUT_OPTIONS_MS: [u64; 5] = [30_000, 60_000, 120_000, 180_000, 300_000];
/// 请求体上限的独立默认（2mb）——与上游响应上限是两个独立策略，勿复用对方常量。
pub const DEFAULT_REQUEST_BODY_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
pub const DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const LOCAL_OLLAMA_HOST: &str = "127.0.0.1";
const LOOPBACK_HOST_NAMES: [&str; 2] = ["127.0.0.1", "localhost"];

// EnvMap / env_lookup / parse_* 实现在 crws-core（单一实现、唯一公开路径）；
// 本 crate 私有引用 —— 调用方（壳/测试/bin）直接 use crws_core::…。
use crws_core::EnvMap;
use crws_core::{
    env_lookup, parse_body_limit_bytes, parse_boolean, parse_integer, parse_timeout_option,
};
use crws_core::{load_vlm_runtime_config, VlmRuntimeConfig};

pub fn process_env_lookup() -> impl Fn(&str) -> Option<String> {
    |k| std::env::var(k).ok()
}

// —— shared/vlmRuntimeConfig.js：定义与解析在 crws-core（契约与 env 解析的底层 crate）——

// —— server/qwenProxy.js#loadQwenProxyConfig ——

/// 限流阈值组（每分钟）。
#[derive(Clone, Debug)]
pub struct Limits {
    pub chat_requests_per_minute: u32,
    pub auth_attempts_per_minute: u32,
    pub status_requests_per_minute: u32,
    pub tasks_requests_per_minute: u32,
}

/// 载荷上限组。
#[derive(Clone, Debug)]
pub struct PayloadLimits {
    pub max_chat_messages: i64,
    pub max_chat_tokens: i64,
    pub max_upstream_response_bytes: usize,
}

/// 本地 VLM 上游（host + port 是唯一事实，base_url 由方法派生）。
#[derive(Clone, Debug)]
pub struct LocalVlmUpstream {
    pub host: String,
    pub port: u16,
}

impl LocalVlmUpstream {
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }
}

#[derive(Clone, Debug)]
pub struct ProxyConfig {
    pub host: String,
    pub port: u16,
    pub cors_origin: Vec<String>,
    pub allow_local_file_origins: bool,
    /// 端点表引用（endpoints.rs 唯一事实源；未配置时为 None）。
    pub qwen_endpoint: Option<&'static Endpoint>,
    pub qwen_api_key: String,
    pub qwen_model: String,
    pub qwen_timeout: Duration,
    pub allow_cloud_fallback: bool,
    pub ollama_timeout: Duration,
    pub ollama_upstream: LocalVlmUpstream,
    pub ollama_model: String,
    pub ollama_api_key: String,
    /// 原始请求体上限字符串（如 "2mb"），字节值由 `request_body_limit_bytes()` 派生。
    pub request_body_limit: String,
    pub limits: Limits,
    pub payload_limits: PayloadLimits,
    pub local_proxy_token: String,
    pub log_model_output: bool,
}

impl ProxyConfig {
    pub fn qwen_endpoint_key(&self) -> &str {
        self.qwen_endpoint.map(|e| e.key.as_str()).unwrap_or("")
    }

    pub fn qwen_base_url(&self) -> &str {
        self.qwen_endpoint
            .map(|e| e.base_url.as_str())
            .unwrap_or("")
    }

    pub fn qwen_chat_completions_url(&self) -> String {
        self.qwen_endpoint
            .map(|e| e.chat_completions_url())
            .unwrap_or_default()
    }

    pub fn ollama_base_url(&self) -> String {
        self.ollama_upstream.base_url()
    }

    /// 请求体上限（字节）：解析失败回退独立默认值（与上游响应上限无关）。
    pub fn request_body_limit_bytes(&self) -> usize {
        parse_body_limit_bytes(&self.request_body_limit).unwrap_or(DEFAULT_REQUEST_BODY_LIMIT_BYTES)
            as usize
    }
}

fn normalize_host(raw: Option<&str>) -> String {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.is_empty() {
        return LOCAL_OLLAMA_HOST.to_string();
    }
    trimmed.to_string()
}

fn normalize_loopback_host(raw: Option<&str>) -> String {
    let trimmed = raw.unwrap_or("").trim();
    if LOOPBACK_HOST_NAMES.contains(&trimmed) {
        return trimmed.to_string();
    }
    LOCAL_OLLAMA_HOST.to_string()
}

fn parse_cors_origin(raw: Option<&str>) -> Vec<String> {
    let raw = raw.unwrap_or("http://localhost:5173");
    let trimmed = raw.trim();
    if trimmed == "*" {
        return DEFAULT_CORS_ORIGINS.iter().map(|s| s.to_string()).collect();
    }
    let origins: Vec<String> = trimmed
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    if origins.is_empty() {
        DEFAULT_CORS_ORIGINS.iter().map(|s| s.to_string()).collect()
    } else {
        origins
    }
}

pub fn is_allowed_cors_origin(
    origin: Option<&str>,
    cors_origin: &[String],
    allow_local_file_origins: bool,
) -> bool {
    let Some(origin) = origin else {
        return allow_local_file_origins;
    };
    if origin.is_empty() || origin == "null" || origin.starts_with("file://") {
        return allow_local_file_origins;
    }
    cors_origin.iter().any(|o| o == origin)
}

pub fn is_loopback_bind_host(host: &str) -> bool {
    let normalized = host.trim().to_lowercase();
    let normalized = normalized.trim_start_matches('[').trim_end_matches(']');
    if normalized == "localhost" || normalized == "::1" || normalized == "::ffff:127.0.0.1" {
        return true;
    }
    if let Ok(IpAddr::V4(v4)) = IpAddr::from_str(normalized) {
        return v4.octets()[0] == 127;
    }
    false
}

/// 非回环绑定必须配置 ≥32 字节的 LOCAL_PROXY_TOKEN，否则拒绝启动（fail-closed）。
pub fn assert_proxy_security_config(config: &ProxyConfig) -> Result<(), String> {
    if !is_loopback_bind_host(&config.host) && config.local_proxy_token.is_empty() {
        return Err(
            "LOCAL_PROXY_TOKEN is required when SERVER_HOST is not a loopback address".to_string(),
        );
    }
    if !is_loopback_bind_host(&config.host) && config.local_proxy_token.len() < 32 {
        return Err(
            "LOCAL_PROXY_TOKEN must be at least 32 bytes when SERVER_HOST is not a loopback address"
                .to_string(),
        );
    }
    Ok(())
}

/// `vlm_api_key_override`：Tauri 会话用随机密钥覆盖 VLM_API_KEY
/// （对齐 electron/main.ts 在加载配置前写入 process.env 的做法）。
pub fn load_proxy_config(
    lookup: &dyn Fn(&str) -> Option<String>,
    vlm: &VlmRuntimeConfig,
    vlm_api_key_override: Option<String>,
) -> ProxyConfig {
    let qwen_endpoint = resolve_qwen_endpoint(lookup("QWEN_BASE_URL").as_deref().unwrap_or(""));
    let ollama_upstream = LocalVlmUpstream {
        host: normalize_loopback_host(Some(&vlm.host)),
        port: vlm.port,
    };

    ProxyConfig {
        host: normalize_host(lookup("SERVER_HOST").as_deref()),
        port: crws_core::parse_u16_port(lookup("SERVER_PORT").as_deref(), 8787),
        cors_origin: parse_cors_origin(lookup("CORS_ORIGIN").as_deref()),
        allow_local_file_origins: parse_boolean(
            lookup("ALLOW_LOCAL_FILE_ORIGINS").as_deref(),
            false,
        ),
        qwen_endpoint,
        qwen_api_key: lookup("QWEN_API_KEY").unwrap_or_default(),
        qwen_model: lookup("QWEN_MODEL")
            .unwrap_or_else(|| contract::default_qwen_api_model().to_string()),
        qwen_timeout: parse_timeout_option(
            lookup("QWEN_TIMEOUT").as_deref(),
            Duration::from_millis(60_000),
            &QWEN_TIMEOUT_OPTIONS_MS,
        ),
        allow_cloud_fallback: parse_boolean(lookup("ALLOW_CLOUD_FALLBACK").as_deref(), false),
        ollama_timeout: parse_timeout_option(
            lookup("OLLAMA_TIMEOUT").as_deref(),
            Duration::from_millis(120_000),
            &OLLAMA_TIMEOUT_OPTIONS_MS,
        ),
        ollama_upstream,
        ollama_model: vlm.model_alias.clone(),
        ollama_api_key: vlm_api_key_override
            .unwrap_or_else(|| lookup("VLM_API_KEY").unwrap_or_default()),
        request_body_limit: lookup("REQUEST_BODY_LIMIT").unwrap_or_else(|| "2mb".to_string()),
        limits: Limits {
            chat_requests_per_minute: parse_integer(
                lookup("CHAT_REQUESTS_PER_MINUTE").as_deref(),
                30,
                0,
            ) as u32,
            auth_attempts_per_minute: parse_integer(
                lookup("AUTH_ATTEMPTS_PER_MINUTE").as_deref(),
                20,
                0,
            ) as u32,
            status_requests_per_minute: parse_integer(
                lookup("STATUS_REQUESTS_PER_MINUTE").as_deref(),
                60,
                0,
            ) as u32,
            tasks_requests_per_minute: parse_integer(
                lookup("TASKS_REQUESTS_PER_MINUTE").as_deref(),
                120,
                0,
            ) as u32,
        },
        payload_limits: PayloadLimits {
            max_chat_messages: parse_integer(lookup("MAX_CHAT_MESSAGES").as_deref(), 16, 1),
            max_chat_tokens: parse_integer(lookup("MAX_CHAT_TOKENS").as_deref(), 2048, 1),
            max_upstream_response_bytes: parse_integer(
                lookup("MAX_UPSTREAM_RESPONSE_BYTES").as_deref(),
                DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES as i64,
                1024,
            ) as usize,
        },
        local_proxy_token: lookup("LOCAL_PROXY_TOKEN").unwrap_or_default(),
        log_model_output: parse_boolean(lookup("LOG_MODEL_OUTPUT").as_deref(), false),
    }
}

/// 便捷入口：直接从环境 map 构建完整配置（测试与独立代理共用）。
pub fn config_from_env(map: &EnvMap) -> ProxyConfig {
    let lookup = env_lookup(map);
    let vlm = load_vlm_runtime_config(&lookup, contract::default_vlm_model_alias());
    load_proxy_config(&lookup, &vlm, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn map(pairs: &[(&str, &str)]) -> EnvMap {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn env_map_from_json(env: &Value) -> EnvMap {
        env.as_object()
            .expect("fixture env must be an object")
            .iter()
            .map(|(k, v)| {
                let value = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                (k.clone(), value)
            })
            .collect()
    }

    // —— 共享夹具驱动：JS 与 Rust 解析行为必须同语义（fixtures/env.json 锁定） ——

    // —— 配置结构语义 ——

    #[test]
    fn normalizes_config_from_environment_variables() {
        let config = config_from_env(&map(&[
            (
                "CORS_ORIGIN",
                "http://localhost:5173, http://localhost:4173",
            ),
            ("QWEN_BASE_URL", "http://127.0.0.1:1234/v1/"),
            ("QWEN_API_KEY", "test-key"),
            ("QWEN_MODEL", "qwen-vl"),
            ("QWEN_TIMEOUT", "90000"),
            ("ALLOW_CLOUD_FALLBACK", "true"),
            ("SERVER_HOST", "127.0.0.1"),
            ("ALLOW_LOCAL_FILE_ORIGINS", "true"),
            ("REQUEST_BODY_LIMIT", "6mb"),
            ("CHAT_REQUESTS_PER_MINUTE", "20"),
            ("AUTH_ATTEMPTS_PER_MINUTE", "7"),
            ("STATUS_REQUESTS_PER_MINUTE", "11"),
            ("MAX_CHAT_MESSAGES", "8"),
            ("MAX_CHAT_TOKENS", "1600"),
            ("MAX_UPSTREAM_RESPONSE_BYTES", "4096"),
            ("LOCAL_PROXY_TOKEN", "local-token"),
            ("LOG_MODEL_OUTPUT", "true"),
            ("VLM_MODEL", "local-vlm"),
            ("VLM_PORT", "12345"),
            ("VLM_API_KEY", "vlm-session-key"),
        ]));

        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(
            config.cors_origin,
            vec![
                "http://localhost:5173".to_string(),
                "http://localhost:4173".to_string()
            ]
        );
        assert!(config.allow_local_file_origins);
        assert_eq!(config.qwen_endpoint_key(), "local-lm-studio");
        assert_eq!(config.qwen_base_url(), "http://127.0.0.1:1234/v1");
        assert_eq!(
            config.qwen_chat_completions_url(),
            "http://127.0.0.1:1234/v1/chat/completions"
        );
        assert_eq!(config.qwen_api_key, "test-key");
        assert_eq!(config.qwen_model, "qwen-vl");
        assert_eq!(config.qwen_timeout, Duration::from_millis(90_000));
        assert!(config.allow_cloud_fallback);
        assert_eq!(config.request_body_limit, "6mb");
        assert_eq!(config.request_body_limit_bytes(), 6 * 1024 * 1024);
        assert_eq!(config.limits.chat_requests_per_minute, 20);
        assert_eq!(config.limits.auth_attempts_per_minute, 7);
        assert_eq!(config.limits.status_requests_per_minute, 11);
        assert_eq!(config.payload_limits.max_chat_messages, 8);
        assert_eq!(config.payload_limits.max_chat_tokens, 1600);
        assert_eq!(config.payload_limits.max_upstream_response_bytes, 4096);
        assert_eq!(config.local_proxy_token, "local-token");
        assert!(config.log_model_output);
        assert_eq!(config.ollama_model, "local-vlm");
        assert_eq!(config.ollama_upstream.host, "127.0.0.1");
        assert_eq!(config.ollama_upstream.port, 12345);
        assert_eq!(config.ollama_api_key, "vlm-session-key");
        assert_eq!(config.ollama_base_url(), "http://127.0.0.1:12345");
    }

    #[test]
    fn defaults_remote_qwen_calls_to_a_hosted_vlm_model() {
        let config = config_from_env(&EnvMap::new());

        assert_eq!(config.qwen_model, contract::default_qwen_api_model());
        assert!(!config.allow_cloud_fallback);
        assert_eq!(
            config.payload_limits.max_upstream_response_bytes,
            2 * 1024 * 1024
        );
        assert_eq!(config.request_body_limit, "2mb");
        assert_eq!(config.request_body_limit_bytes(), 2 * 1024 * 1024);
        assert_eq!(config.qwen_timeout, Duration::from_millis(60_000));
        assert_eq!(config.ollama_timeout, Duration::from_millis(120_000));
        assert_eq!(config.ollama_upstream.port, 11434);
        assert_eq!(config.ollama_base_url(), "http://127.0.0.1:11434");
    }

    #[test]
    fn uses_explicit_allow_lists_for_cors_and_qwen_upstream_urls() {
        let wildcard = config_from_env(&map(&[("CORS_ORIGIN", "*")]));
        assert_eq!(
            wildcard.cors_origin,
            vec!["http://localhost:5173".to_string()]
        );

        let unsupported = config_from_env(&map(&[(
            "QWEN_BASE_URL",
            "http://169.254.169.254/latest/meta-data",
        )]));
        assert_eq!(unsupported.qwen_endpoint_key(), "");
        assert_eq!(unsupported.qwen_base_url(), "");
        assert_eq!(unsupported.qwen_chat_completions_url(), "");
    }

    #[test]
    fn rejects_workspace_specific_maas_urls() {
        let config = config_from_env(&map(&[(
            "QWEN_BASE_URL",
            "https://workspace-abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
        )]));
        assert_eq!(config.qwen_endpoint_key(), "");
    }

    #[test]
    fn allows_bigmodel_openai_compatible_vlm_endpoints() {
        let config = config_from_env(&map(&[(
            "QWEN_BASE_URL",
            "https://open.bigmodel.cn/api/paas/v4/",
        )]));
        assert_eq!(config.qwen_endpoint_key(), "bigmodel");
        assert_eq!(
            config.qwen_base_url(),
            "https://open.bigmodel.cn/api/paas/v4"
        );
        assert_eq!(
            config.qwen_chat_completions_url(),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
    }

    #[test]
    fn blocks_file_origins_by_default_and_allows_them_when_configured() {
        let allowed = vec!["http://localhost:5173".to_string()];

        assert!(!is_allowed_cors_origin(None, &allowed, false));
        assert!(!is_allowed_cors_origin(Some("null"), &allowed, false));
        assert!(!is_allowed_cors_origin(Some("file://"), &allowed, false));
        assert!(is_allowed_cors_origin(
            Some("http://localhost:5173"),
            &allowed,
            false
        ));
        assert!(!is_allowed_cors_origin(
            Some("https://example.com"),
            &allowed,
            false
        ));
        assert!(is_allowed_cors_origin(Some("null"), &allowed, true));
        assert!(is_allowed_cors_origin(Some("file://"), &allowed, true));
    }

    #[test]
    fn fails_closed_when_binding_beyond_loopback_without_a_proxy_token() {
        assert!(is_loopback_bind_host("127.0.0.1"));
        assert!(is_loopback_bind_host("::1"));
        assert!(!is_loopback_bind_host("0.0.0.0"));

        let insecure = config_from_env(&map(&[("SERVER_HOST", "0.0.0.0")]));
        assert!(assert_proxy_security_config(&insecure)
            .unwrap_err()
            .contains("LOCAL_PROXY_TOKEN"));

        let too_short = config_from_env(&map(&[
            ("SERVER_HOST", "0.0.0.0"),
            ("LOCAL_PROXY_TOKEN", "too-short"),
        ]));
        assert!(assert_proxy_security_config(&too_short)
            .unwrap_err()
            .contains("32 bytes"));

        let secure = config_from_env(&map(&[
            ("SERVER_HOST", "0.0.0.0"),
            ("LOCAL_PROXY_TOKEN", "0123456789abcdef0123456789abcdef"),
        ]));
        assert!(assert_proxy_security_config(&secure).is_ok());
    }

    #[test]
    fn timeout_options_snap_up_to_nearest_step() {
        let fallback = Duration::from_millis(60_000);
        assert_eq!(
            parse_timeout_option(Some("90000"), fallback, &QWEN_TIMEOUT_OPTIONS_MS),
            Duration::from_millis(90_000)
        );
        assert_eq!(
            parse_timeout_option(Some("31000"), fallback, &QWEN_TIMEOUT_OPTIONS_MS),
            Duration::from_millis(60_000)
        );
        assert_eq!(
            parse_timeout_option(Some("5000"), fallback, &QWEN_TIMEOUT_OPTIONS_MS),
            fallback
        );
        assert_eq!(
            parse_timeout_option(Some("abc"), fallback, &QWEN_TIMEOUT_OPTIONS_MS),
            fallback
        );
        assert_eq!(
            parse_timeout_option(None, fallback, &QWEN_TIMEOUT_OPTIONS_MS),
            fallback
        );
    }

    #[test]
    fn request_body_limit_falls_back_to_its_own_default() {
        let config = config_from_env(&map(&[("REQUEST_BODY_LIMIT", "nonsense")]));
        // 独立默认：与上游响应上限（2MB）同值但不同源，互不影响
        assert_eq!(
            config.request_body_limit_bytes(),
            DEFAULT_REQUEST_BODY_LIMIT_BYTES as usize
        );
        assert_eq!(DEFAULT_REQUEST_BODY_LIMIT_BYTES, 2 * 1024 * 1024);
        assert_eq!(
            config.payload_limits.max_upstream_response_bytes,
            2 * 1024 * 1024
        );
    }
}
