//! 路由处理器：chat（Qwen/Ollama + 管线）、status、health。
//! 中间件顺序承载安全语义（对齐 Express 注册顺序）：
//! chat: authLimiter → tokenGuard → body 解析 → chat 限流 → 载荷校验 → 处理器。

pub mod tasks;

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::Value;

use crate::app::AppState;
use crate::auth::{self, extract_token};
use crate::payload::{normalize_chat_completion_payload, validate_chat_completion_payload};
use crate::policy;
use crate::ratelimit;
use crate::responses::{build_express_error_response, error_response, json_response, with_header};
use crate::upstream::request_body::{
    build_ollama_request_body, build_qwen_fallback_request_body, build_qwen_request_body,
};
use crate::upstream::UpstreamError;

pub fn client_ip(request: &Request) -> std::net::IpAddr {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip())
        .unwrap_or(std::net::IpAddr::from([127, 0, 0, 1]))
}

pub enum ChatVariant {
    Qwen,
    Ollama,
}

/// chat 路由统一管线（Express 中间件链的直译）：
/// 鉴权限流 → 令牌守卫 → body 解析 → chat 限流 → 载荷校验 → 处理器。
pub async fn chat_pipeline(state: AppState, request: Request, handler: ChatVariant) -> Response {
    let ip = client_ip(&request);
    let path = request.uri().path().to_string();
    let token = extract_token(request.headers()).map(str::to_string);

    // 1) 鉴权尝试限流（合法令牌 skip —— 不计数不拦截）
    if let Some(response) = ratelimit::auth_attempt_guard(
        &state.limiters,
        &state.config,
        ip,
        auth::auth_attempt_skipped_path_scoped(&state.config, &path, token.as_deref()),
    ) {
        return response;
    }

    // 2) 令牌守卫（必须先于 body 解析：403 早于 400/413）
    if let Some(response) = auth::guard_path_scoped(&state.config, &path, token.as_deref()) {
        return response;
    }

    // 3) body 解析（大小受限的 JSON；解析失败 → 400 invalid_request）
    let body_bytes = match axum::body::to_bytes(
        request.into_body(),
        state.config.request_body_limit_bytes() + 1,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            let message = error.to_string();
            if message.contains("length limit") || message.contains("too large") {
                return build_express_error_response(413, "request entity too large");
            }
            return build_express_error_response(400, &message);
        }
    };

    let payload: Value = if body_bytes.is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        match serde_json::from_slice(&body_bytes) {
            Ok(value) => value,
            Err(error) => return build_express_error_response(400, &error.to_string()),
        }
    };

    // 4) chat 限流（已授权请求才计入）
    if let Some(response) = ratelimit::chat_guard(&state.limiters, &state.config, ip) {
        return response;
    }

    // 5) 载荷校验 + 规范化
    if let Err(message) = validate_chat_completion_payload(&payload, &state.config) {
        return error_response(400, &message, "invalid_request");
    }
    let normalized = normalize_chat_completion_payload(&payload, &state.config);

    // 6) 处理器
    match handler {
        ChatVariant::Qwen => qwen_chat_handler(&state, normalized).await,
        ChatVariant::Ollama => ollama_chat_handler(&state, normalized).await,
    }
}

/// POST /api/qwen/chat/completions
pub async fn qwen_chat(state: State<AppState>, request: Request) -> Response {
    chat_pipeline(state.0, request, ChatVariant::Qwen).await
}

/// POST /api/ollama/chat/completions
pub async fn ollama_chat(state: State<AppState>, request: Request) -> Response {
    chat_pipeline(state.0, request, ChatVariant::Ollama).await
}

async fn qwen_chat_handler(state: &AppState, body: Value) -> Response {
    if !state.is_qwen_configured() {
        return error_response(
            500,
            "QWEN_BASE_URL 或 QWEN_API_KEY 未配置，请检查 .env",
            "configuration_error",
        );
    }

    let request_body = build_qwen_request_body(&body, &state.config.qwen_model);
    let Some(qwen) = state.qwen.clone() else {
        return error_response(500, "代理请求失败", "proxy_error");
    };

    match qwen.chat_completions(&request_body).await {
        Ok(upstream) => {
            let payload = policy::parse_proxy_response_text(&upstream.text);
            with_header(
                json_response(upstream.status, payload),
                "x-vlm-source",
                "cloud",
            )
        }
        Err(error) => {
            if matches!(error, UpstreamError::ClientDisconnected) {
                return StatusCode::NO_CONTENT.into_response();
            }
            policy::build_proxy_error_response(
                &error,
                &policy::ProxyErrorOptions {
                    timeout_message: "Qwen 接口请求超时",
                    timeout_type: "timeout_error",
                    fallback_message: "代理请求失败",
                    fallback_type: "proxy_error",
                },
            )
        }
    }
}

async fn ollama_chat_handler(state: &AppState, body: Value) -> Response {
    if !state.is_local_vlm_trusted() {
        if state.is_cloud_fallback_available() {
            return send_qwen_fallback(state, body).await;
        }
        return error_response(
            503,
            "本地 VLM 不是当前会话管理的可信进程",
            "local_vlm_untrusted",
        );
    }

    let ollama_model = if state.config.ollama_model.is_empty() {
        crate::contract::default_vlm_model_alias().to_string()
    } else {
        state.config.ollama_model.clone()
    };
    let request_body = build_ollama_request_body(&body, &ollama_model);

    match state.local_vlm.chat_completions(&request_body).await {
        Ok(upstream) => {
            let payload = policy::parse_proxy_response_text(&upstream.text);

            if policy::should_fallback_to_qwen(upstream.status)
                && state.is_cloud_fallback_available()
            {
                return send_qwen_fallback(state, body).await;
            }

            with_header(
                json_response(upstream.status, payload),
                "x-vlm-source",
                "local",
            )
        }
        Err(error) => {
            if matches!(error, UpstreamError::ClientDisconnected) {
                return StatusCode::NO_CONTENT.into_response();
            }
            if state.is_cloud_fallback_available() {
                return send_qwen_fallback(state, body).await;
            }
            policy::build_proxy_error_response(
                &error,
                &policy::ProxyErrorOptions {
                    timeout_message: "Ollama 推理超时",
                    timeout_type: "timeout",
                    fallback_message: "代理请求失败",
                    fallback_type: "proxy_error",
                },
            )
        }
    }
}

async fn send_qwen_fallback(state: &AppState, body: Value) -> Response {
    let Some(qwen) = state.qwen.clone() else {
        return error_response(500, "代理请求失败", "proxy_error");
    };
    let request_body = build_qwen_fallback_request_body(&body, &state.config.qwen_model);
    match qwen.chat_completions(&request_body).await {
        Ok(upstream) => {
            let payload = policy::parse_proxy_response_text(&upstream.text);
            with_header(
                json_response(upstream.status, payload),
                "x-vlm-source",
                "cloud-fallback",
            )
        }
        Err(error) => policy::build_proxy_error_response(
            &error,
            &policy::ProxyErrorOptions {
                timeout_message: "Qwen 接口请求超时",
                timeout_type: "timeout_error",
                fallback_message: "代理请求失败",
                fallback_type: "proxy_error",
            },
        ),
    }
}

/// GET /api/health
pub async fn health(state: State<AppState>) -> Response {
    let body = policy::health_body(
        state.is_qwen_configured(),
        state.is_cloud_fallback_available(),
        &state.config.qwen_model,
    );
    json_response(200, body)
}

/// GET /api/ollama/status
pub async fn ollama_status(state: State<AppState>, request: Request) -> Response {
    let ip = client_ip(&request);
    if let Some(response) = ratelimit::status_guard(&state.limiters, &state.config, ip) {
        return response;
    }

    if !state.is_local_vlm_trusted() {
        let body =
            policy::resolve_vlm_proxy_status(false, "error", state.is_cloud_fallback_available());
        return json_response(200, body);
    }

    match state.local_vlm.health().await {
        Ok(status) => {
            let (ready, status_text, _) = crws_core::resolve_ollama_health_status(status);
            let body = policy::resolve_vlm_proxy_status(
                ready,
                status_text,
                state.is_cloud_fallback_available(),
            );
            json_response(200, body)
        }
        Err(_) => {
            let body = policy::resolve_vlm_proxy_status(
                false,
                "error",
                state.is_cloud_fallback_available(),
            );
            json_response(200, body)
        }
    }
}
