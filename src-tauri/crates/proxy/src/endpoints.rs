//! 云端 Qwen 上游端点查表壳 —— 表本体只读 `shared/contract.json` 的
//! `qwenEndpoints` 段（事实源：shared/qwenEndpoints.js）。
//! `chat_completions_url` 一律由 `base_url` 派生（评审第 2/3 条：消灭双表与表内重复）。

use std::sync::OnceLock;

use url::Url;

use crate::contract;

#[derive(Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub key: String,
    pub base_url: String,
}

impl Endpoint {
    /// 端点的 chat/completions 完整 URL，由 base_url 派生。
    pub fn chat_completions_url(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }
}

pub fn qwen_endpoints() -> &'static Vec<Endpoint> {
    static TABLE: OnceLock<Vec<Endpoint>> = OnceLock::new();
    TABLE.get_or_init(|| {
        contract::qwen_endpoint_table()
            .into_iter()
            .map(|(key, base_url)| Endpoint { key, base_url })
            .collect()
    })
}

/// 规范化 base URL：去 hash、去 query、去尾部斜杠（对齐 qwenProxy.js#normalizeBaseUrl）。
pub fn normalize_base_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let Ok(mut url) = Url::parse(trimmed) else {
        return String::new();
    };

    url.set_fragment(None);
    url.set_query(None);
    let path = url.path().trim_end_matches('/').to_string();
    let path = if path.is_empty() {
        "/".to_string()
    } else {
        path
    };
    url.set_path(&path);

    let mut normalized = url.to_string();
    if normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

/// 只有源码内置上游可用：QWEN_BASE_URL 必须命中端点表，否则视为未配置。
pub fn resolve_qwen_endpoint(raw_base_url: &str) -> Option<&'static Endpoint> {
    let normalized = normalize_base_url(raw_base_url);
    qwen_endpoints().iter().find(|e| e.base_url == normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_trailing_slashes_and_strips_query() {
        assert_eq!(
            normalize_base_url("http://127.0.0.1:1234/v1/"),
            "http://127.0.0.1:1234/v1"
        );
        assert_eq!(
            normalize_base_url("https://open.bigmodel.cn/api/paas/v4/"),
            "https://open.bigmodel.cn/api/paas/v4"
        );
        assert_eq!(normalize_base_url("  "), "");
    }

    #[test]
    fn resolves_known_endpoints_by_normalized_base_url() {
        assert_eq!(
            resolve_qwen_endpoint("http://127.0.0.1:1234/v1/").map(|e| e.key.as_str()),
            Some("local-lm-studio")
        );
        assert_eq!(
            resolve_qwen_endpoint("https://open.bigmodel.cn/api/paas/v4/").map(|e| e.key.as_str()),
            Some("bigmodel")
        );
        assert_eq!(
            resolve_qwen_endpoint("https://dashscope.aliyuncs.com/compatible-mode/v1")
                .map(|e| e.key.as_str()),
            Some("dashscope-cn")
        );
    }

    #[test]
    fn rejects_unlisted_and_workspace_maas_urls() {
        assert_eq!(
            resolve_qwen_endpoint("http://169.254.169.254/latest/meta-data"),
            None
        );
        assert_eq!(
            resolve_qwen_endpoint(
                "https://workspace-abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/"
            ),
            None
        );
    }

    #[test]
    fn derives_chat_completions_urls_from_base_urls() {
        for endpoint in qwen_endpoints() {
            assert_eq!(
                endpoint.chat_completions_url(),
                format!("{}/chat/completions", endpoint.base_url)
            );
        }
        let bigmodel = resolve_qwen_endpoint("https://open.bigmodel.cn/api/paas/v4").unwrap();
        assert_eq!(
            bigmodel.chat_completions_url(),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
        let lm_studio = resolve_qwen_endpoint("http://127.0.0.1:1234/v1/").unwrap();
        assert_eq!(
            lm_studio.chat_completions_url(),
            "http://127.0.0.1:1234/v1/chat/completions"
        );
    }

    #[test]
    fn table_is_loaded_from_the_shared_contract() {
        assert_eq!(qwen_endpoints().len(), 8);
    }
}
