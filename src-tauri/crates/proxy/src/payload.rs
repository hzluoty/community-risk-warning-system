//! chat completion 载荷校验与规范化
//! （对齐 qwenProxy.js 的 validateChatCompletionPayload / normalizeChatCompletionPayload）。

use serde_json::Value;

use crate::config::ProxyConfig;

const DISALLOWED_TOKEN_LIMIT_FIELDS: [&str; 5] = [
    "max_completion_tokens",
    "max_output_tokens",
    "max_new_tokens",
    "num_predict",
    "n_predict",
];

pub fn validate_chat_completion_payload(body: &Value, config: &ProxyConfig) -> Result<(), String> {
    let Some(obj) = body.as_object() else {
        return Err("request body must be an object".to_string());
    };

    let Some(messages) = obj.get("messages") else {
        return Err("messages must be a non-empty array".to_string());
    };
    let Some(messages_arr) = messages.as_array() else {
        return Err("messages must be a non-empty array".to_string());
    };
    if messages_arr.is_empty() {
        return Err("messages must be a non-empty array".to_string());
    }
    if messages_arr.len() as i64 > config.payload_limits.max_chat_messages {
        return Err("messages exceeds the configured limit".to_string());
    }

    for field in DISALLOWED_TOKEN_LIMIT_FIELDS {
        if obj.contains_key(field) {
            return Err(format!("{field} is not supported; use max_tokens"));
        }
    }

    match obj.get("stream") {
        None | Some(Value::Bool(false)) => {}
        Some(Value::Null) => {}
        _ => return Err("streaming responses are not supported".to_string()),
    }

    if let Some(n) = obj.get("n") {
        if !(n == &Value::Bool(false) || n.as_u64() == Some(1) || n.is_null()) {
            return Err("n must be 1".to_string());
        }
    }

    if let Some(best_of) = obj.get("best_of") {
        if !(best_of.as_u64() == Some(1) || best_of.is_null()) {
            return Err("best_of must be 1".to_string());
        }
    }

    if let Some(max_tokens) = obj.get("max_tokens") {
        if max_tokens.is_null() {
            return Ok(());
        }
        match max_tokens.as_u64() {
            Some(v) if v >= 1 => {
                if v as i64 > config.payload_limits.max_chat_tokens {
                    return Err("max_tokens exceeds the configured limit".to_string());
                }
            }
            _ => return Err("max_tokens must be a positive integer".to_string()),
        }
    }

    Ok(())
}

/// 规范化：缺省 max_tokens 注入上限；stream 强制 false；n/best_of 出现时收敛为 1。
pub fn normalize_chat_completion_payload(body: &Value, config: &ProxyConfig) -> Value {
    let mut out = body.clone();
    let obj = out.as_object_mut().expect("validated body is an object");

    match obj.get("max_tokens") {
        Some(Value::Null) | None => {
            obj.insert(
                "max_tokens".to_string(),
                Value::from(config.payload_limits.max_chat_tokens),
            );
        }
        Some(existing) => {
            let normalized = match existing.as_u64() {
                Some(v) => Value::from(v as i64),
                // 字符串数字（夹具里出现 max_tokens: '99'）：JS Number() 归一
                None => existing
                    .as_str()
                    .and_then(|s| s.trim().parse::<i64>().ok())
                    .map(Value::from)
                    .unwrap_or_else(|| existing.clone()),
            };
            obj.insert("max_tokens".to_string(), normalized);
        }
    }

    obj.insert("stream".to_string(), Value::Bool(false));

    if obj.contains_key("n") && !obj.get("n").map(Value::is_null).unwrap_or(false) {
        obj.insert("n".to_string(), Value::from(1));
    }
    if obj.contains_key("best_of") && !obj.get("best_of").map(Value::is_null).unwrap_or(false) {
        obj.insert("best_of".to_string(), Value::from(1));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::config_from_env;
    use crws_core::EnvMap;

    fn config(pairs: &[(&str, &str)]) -> ProxyConfig {
        let mut map = EnvMap::new();
        for (k, v) in pairs {
            map.insert(k.to_string(), v.to_string());
        }
        config_from_env(&map)
    }

    #[test]
    fn rejects_malformed_payloads_before_proxying() {
        let cfg = config(&[("MAX_CHAT_MESSAGES", "2"), ("MAX_CHAT_TOKENS", "100")]);

        assert!(validate_chat_completion_payload(
            &serde_json::json!({ "messages": [{ "role": "user", "content": "ok" }] }),
            &cfg
        )
        .is_ok());

        assert_eq!(
            validate_chat_completion_payload(&serde_json::json!({}), &cfg).unwrap_err(),
            "messages must be a non-empty array"
        );
        assert_eq!(
            validate_chat_completion_payload(
                &serde_json::json!({ "messages": [{}, {}, {}] }),
                &cfg
            )
            .unwrap_err(),
            "messages exceeds the configured limit"
        );
        assert_eq!(
            validate_chat_completion_payload(
                &serde_json::json!({ "messages": [{}], "max_tokens": 101 }),
                &cfg
            )
            .unwrap_err(),
            "max_tokens exceeds the configured limit"
        );
        assert_eq!(
            validate_chat_completion_payload(
                &serde_json::json!({ "messages": [{}], "max_completion_tokens": 10 }),
                &cfg
            )
            .unwrap_err(),
            "max_completion_tokens is not supported; use max_tokens"
        );
        assert_eq!(
            validate_chat_completion_payload(
                &serde_json::json!({ "messages": [{}], "stream": true }),
                &cfg
            )
            .unwrap_err(),
            "streaming responses are not supported"
        );
        assert_eq!(
            validate_chat_completion_payload(
                &serde_json::json!({ "messages": [{}], "n": 2 }),
                &cfg
            )
            .unwrap_err(),
            "n must be 1"
        );
    }

    #[test]
    fn injects_bounded_non_streaming_limit_when_max_tokens_omitted() {
        let cfg = config(&[("MAX_CHAT_TOKENS", "321")]);

        let normalized = normalize_chat_completion_payload(
            &serde_json::json!({ "messages": [{ "role": "user", "content": "ok" }] }),
            &cfg,
        );
        assert_eq!(normalized["max_tokens"], Value::from(321));
        assert_eq!(normalized["stream"], Value::Bool(false));

        let normalized = normalize_chat_completion_payload(
            &serde_json::json!({ "messages": [{}], "max_tokens": "99", "n": 1 }),
            &cfg,
        );
        assert_eq!(normalized["max_tokens"], Value::from(99));
        assert_eq!(normalized["n"], Value::from(1));
        assert_eq!(normalized["stream"], Value::Bool(false));
    }

    #[test]
    fn array_body_is_rejected_as_object() {
        let cfg = config(&[]);
        let body = Value::Array(vec![]);
        assert_eq!(
            validate_chat_completion_payload(&body, &cfg).unwrap_err(),
            "request body must be an object"
        );
        let _ = serde_json::Map::new();
    }
}
