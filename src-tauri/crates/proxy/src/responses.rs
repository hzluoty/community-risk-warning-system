//! 统一的 JSON 响应构造（对齐 buildExpressErrorResponse / buildProxyErrorResponse
//! 的掩码策略：5xx 不回传内部错误细节，4xx 保留原始消息便于调试）。

use axum::http::{header, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

pub fn error_body(message: &str, error_type: &str) -> Value {
    json!({ "error": { "message": message, "type": error_type } })
}

pub fn status_from_u16(status: u16) -> StatusCode {
    StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY)
}

/// 404 兜底（未匹配的未知路径 —— 纯 404，不吞鉴权语义）。
pub fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(serde_json::json!({ "error": { "message": "Not Found", "type": "not_found" } })),
    )
        .into_response()
}

pub fn json_response(status: u16, body: Value) -> Response {
    (status_from_u16(status), axum::Json(body)).into_response()
}

pub fn error_response(status: u16, message: &str, error_type: &str) -> Response {
    json_response(status, error_body(message, error_type))
}

pub fn with_header(mut response: Response, name: &'static str, value: &str) -> Response {
    let name = HeaderName::from_static(name);
    if let Ok(value) = header::HeaderValue::from_str(value) {
        response.headers_mut().insert(name, value);
    }
    response
}

/// 对齐 buildExpressErrorResponse：4xx 保留原始消息；5xx 掩码为 Internal server error。
pub fn build_express_error_response(status: u16, raw_message: &str) -> Response {
    let status = status_from_u16(status);
    let code = status.as_u16();
    let message = if code >= 500 {
        "Internal server error"
    } else if raw_message.is_empty() {
        "Invalid request"
    } else {
        raw_message
    };
    let error_type = if code >= 500 {
        "internal_error"
    } else {
        "invalid_request"
    };
    json_response(code, error_body(message, error_type))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_bodies_with_the_documented_shape() {
        assert_eq!(
            error_body("代理请求失败", "proxy_error"),
            json!({"error": {"message": "代理请求失败", "type": "proxy_error"}})
        );
    }

    #[test]
    fn masks_5xx_but_keeps_4xx_messages() {
        let masked = build_express_error_response(500, "boom");
        assert_eq!(masked.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let kept = build_express_error_response(400, "Unexpected token } in JSON");
        assert_eq!(kept.status(), StatusCode::BAD_REQUEST);
    }
}
