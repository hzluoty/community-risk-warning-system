//! 路由级策略（非传输）：回落判定 / 响应包装 / 错误响应构造。
//! 健康状态映射的实现在 crws-core（resolve_ollama_health_status）。
//! 从 upstream/ 拆出（架构评审第七轮 #6）：upstream 只做传输。

use serde_json::{json, Value};

// 健康状态映射（唯一实现在 crws-core —— proxy 与 vlm 共用，两份本地副本已删）

use crate::responses::error_response;
use axum::response::Response;

/// 对齐 shouldFallbackToQwen：404 或 5xx 才回落云端。
pub fn should_fallback_to_qwen(status: u16) -> bool {
    status == 404 || status >= 500
}

/// 对齐 parseProxyResponseText：非法 JSON 包成 { raw: text }。
pub fn parse_proxy_response_text(text: &str) -> Value {
    match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => json!({ "raw": text }),
    }
}

pub struct ProxyErrorOptions {
    pub timeout_message: &'static str,
    pub timeout_type: &'static str,
    pub fallback_message: &'static str,
    pub fallback_type: &'static str,
}

/// 对齐 buildProxyErrorResponse：超时 → 504；超大 → 502；其他 → 500。
/// 5xx 不回传内部错误细节（不泄露上游地址等实现细节）。
pub fn build_proxy_error_response(
    error: &crate::upstream::UpstreamError,
    options: &ProxyErrorOptions,
) -> Response {
    match error {
        crate::upstream::UpstreamError::ResponseTooLarge => error_response(
            502,
            "上游响应超过代理允许的大小限制",
            "upstream_response_too_large",
        ),
        crate::upstream::UpstreamError::Timeout => {
            error_response(504, options.timeout_message, options.timeout_type)
        }
        _ => error_response(500, options.fallback_message, options.fallback_type),
    }
}

/// 本地 VLM 未就绪时的状态响应（对齐 resolveVlmProxyStatus 的语义）。
pub fn resolve_vlm_proxy_status(
    local_ready: bool,
    local_status: &'static str,
    cloud_fallback_available: bool,
) -> Value {
    if local_ready {
        return json!({ "ready": true, "status": local_status, "gpu": "unknown", "source": "local" });
    }
    if cloud_fallback_available {
        return json!({ "ready": true, "status": "ready", "gpu": "unknown", "source": "cloud-fallback" });
    }
    json!({ "ready": false, "status": local_status, "gpu": "unknown", "source": "local" })
}

/// 健康路由响应（对齐 /api/health 处理器）。
pub fn health_body(qwen_configured: bool, cloud_fallback_enabled: bool, model: &str) -> Value {
    json!({
        "ok": true,
        "service": "community-risk-warning-proxy",
        "qwenConfigured": qwen_configured,
        "cloudFallbackEnabled": cloud_fallback_enabled,
        "model": model,
        "timestamp": chrono::Utc::now().to_rfc3339()
    })
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn parses_upstream_json_and_wraps_non_json() {
        assert_eq!(
            parse_proxy_response_text(r#"{"choices":[{"message":{"content":"ok"}}]}"#),
            json!({"choices":[{"message":{"content":"ok"}}]})
        );
        assert_eq!(
            parse_proxy_response_text("service unavailable"),
            json!({"raw": "service unavailable"})
        );
    }

    #[test]
    fn falls_back_to_cloud_only_for_local_service_failures() {
        assert!(!should_fallback_to_qwen(200));
        assert!(!should_fallback_to_qwen(400));
        assert!(should_fallback_to_qwen(404));
        assert!(should_fallback_to_qwen(500));
        assert!(should_fallback_to_qwen(503));
    }

    #[test]
    fn proxy_status_prefers_local_then_cloud_fallback() {
        assert_eq!(
            resolve_vlm_proxy_status(true, "ready", false),
            json!({"ready": true, "status": "ready", "gpu": "unknown", "source": "local"})
        );
        assert_eq!(
            resolve_vlm_proxy_status(false, "error", true),
            json!({"ready": true, "status": "ready", "gpu": "unknown", "source": "cloud-fallback"})
        );
        assert_eq!(
            resolve_vlm_proxy_status(false, "error", false),
            json!({"ready": false, "status": "error", "gpu": "unknown", "source": "local"})
        );
    }
}
