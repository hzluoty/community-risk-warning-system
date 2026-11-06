//! 上游传输客户端：云端 Qwen（reqwest + rustls）与本地 llama-server。
//! 只做传输；回落判定 / 健康映射 / 响应包装等策略在 policy.rs。

pub mod request_body;

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;

/// 上游响应：状态码 + 文本体（大小上限内）。
#[derive(Debug)]
pub struct UpstreamText {
    pub status: u16,
    pub text: String,
}

/// 上游错误分类（对齐 buildProxyErrorResponse 的语义分支）。
#[derive(Debug)]
pub enum UpstreamError {
    /// 请求超过大小上限 → 502 upstream_response_too_large
    ResponseTooLarge,
    /// 超时 → 504
    Timeout,
    /// 客户端已断开（静默放弃，不再回写）
    ClientDisconnected,
    /// 其他上游/网络错误 → 500 proxy_error
    Upstream(String),
}

/// 云端 Qwen 客户端：只连端点表派生的 chat/completions URL。
pub struct QwenClient {
    http: reqwest::Client,
    chat_completions_url: String,
    api_key: String,
    max_response_bytes: usize,
}

impl QwenClient {
    pub fn new(
        chat_completions_url: &str,
        api_key: &str,
        timeout: Duration,
        max_response_bytes: usize,
    ) -> Self {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .expect("reqwest client");
        Self {
            http,
            chat_completions_url: chat_completions_url.to_string(),
            api_key: api_key.to_string(),
            max_response_bytes,
        }
    }

    pub async fn chat_completions(
        &self,
        request_body: &Value,
    ) -> Result<UpstreamText, UpstreamError> {
        let response = self
            .http
            .post(&self.chat_completions_url)
            .header("Content-Type", "application/json")
            .bearer_auth(&self.api_key)
            .json(request_body)
            .send()
            .await
            .map_err(classify_reqwest_error)?;

        read_response_text(response, self.max_response_bytes).await
    }
}

/// 本地 llama-server 客户端（对齐 requestLocalOllamaText：fail fast、大小上限）。
pub struct LocalVlmClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    max_response_bytes: usize,
}

impl LocalVlmClient {
    pub fn new(
        base_url: &str,
        api_key: &str,
        timeout: Duration,
        max_response_bytes: usize,
    ) -> Self {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .expect("reqwest client");
        Self {
            http,
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
            max_response_bytes,
        }
    }

    pub async fn chat_completions(
        &self,
        request_body: &Value,
    ) -> Result<UpstreamText, UpstreamError> {
        let mut request = self
            .http
            .post(format!("{}/v1/chat/completions", self.base_url))
            .header("Content-Type", "application/json")
            .json(request_body);
        if !self.api_key.is_empty() {
            request = request.bearer_auth(&self.api_key);
        }
        let response = request.send().await.map_err(classify_reqwest_error)?;
        read_response_text(response, self.max_response_bytes).await
    }

    pub async fn health(&self) -> Result<u16, UpstreamError> {
        let response = self
            .http
            .get(format!("{}/health", self.base_url))
            .timeout(Duration::from_millis(3_000))
            .send()
            .await
            .map_err(classify_reqwest_error)?;
        Ok(response.status().as_u16())
    }
}

/// 读响应体（流式累计，超上限即断 —— 对齐 readFetchResponseText）。
async fn read_response_text(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<UpstreamText, UpstreamError> {
    let status = response.status().as_u16();

    if let Some(len) = response.content_length() {
        if len as usize > max_bytes {
            return Err(UpstreamError::ResponseTooLarge);
        }
    }

    let mut stream = response.bytes_stream();
    let mut total = 0usize;
    let mut chunks: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| UpstreamError::Upstream(e.to_string()))?;
        total += chunk.len();
        if total > max_bytes {
            return Err(UpstreamError::ResponseTooLarge);
        }
        chunks.extend_from_slice(&chunk);
    }

    Ok(UpstreamText {
        status,
        text: String::from_utf8_lossy(&chunks).to_string(),
    })
}

fn classify_reqwest_error(error: reqwest::Error) -> UpstreamError {
    // 连接失败（如 ECONNREFUSED）→ 500 proxy_error（对齐 JS：不为 connect 错误回 504）。
    // 必须先于 is_request() 判：connect 错误同时满足 is_request()。
    if error.is_connect() {
        return UpstreamError::Upstream("connect failed".to_string());
    }
    if error.is_timeout() || error.is_request() {
        return UpstreamError::Timeout;
    }
    UpstreamError::Upstream(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_vlm_health_reports_connection_failure_as_upstream_error() {
        // 端口 1（不可达）→ connect error（不是超时）
        let client =
            LocalVlmClient::new("http://127.0.0.1:1", "", Duration::from_millis(3000), 1024);
        let result = client.health().await;
        assert!(matches!(result, Err(UpstreamError::Upstream(_))));
    }

    #[tokio::test]
    async fn local_vlm_chat_reports_oversized_responses() {
        // 上游返回 2048 字节，但上限 1024 → ResponseTooLarge
        let upstream = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(|| async {
                (
                    axum::http::StatusCode::OK,
                    [("content-type", "text/plain")],
                    "x".repeat(2048),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });

        let client = LocalVlmClient::new(
            &format!("http://{addr}"),
            "",
            Duration::from_millis(3000),
            1024,
        );
        let result = client
            .chat_completions(&serde_json::json!({ "messages": [] }))
            .await;
        assert!(matches!(result, Err(UpstreamError::ResponseTooLarge)));
    }
}
