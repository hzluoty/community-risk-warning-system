//! chat completion 载荷校验与规范化
//! （对齐 qwenProxy.js 的 validateChatCompletionPayload / normalizeChatCompletionPayload）。

use serde_json::Value;

use crate::config::ProxyConfig;

/// 不支持的 token 上限字段表 —— 契约驱动（contract.json 的
/// payloadValidation.disallowedTokenLimitFields 段；事实源 shared/payloadValidation.js）。
fn disallowed_token_limit_fields() -> Vec<&'static str> {
    crate::contract::payload_validation()["disallowedTokenLimitFields"]
        .as_array()
        .expect("disallowedTokenLimitFields array")
        .iter()
        .map(|v| v.as_str().expect("field entry"))
        .collect()
}

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

    for field in disallowed_token_limit_fields() {
        if obj.contains_key(field) {
            return Err(format!("{field} is not supported; use max_tokens"));
        }
    }

    // JS 语义（发布路径为准，fixtures/payloadValidation.json 锁定）：
    // null ≠ 缺省 —— stream/n/best_of 为 null 一律拒绝；stream 仅接受 false。
    match obj.get("stream") {
        None | Some(Value::Bool(false)) => {}
        _ => return Err("streaming responses are not supported".to_string()),
    }

    if let Some(n) = obj.get("n") {
        if n != &Value::from(1) {
            return Err("n must be 1".to_string());
        }
    }

    if let Some(best_of) = obj.get("best_of") {
        if best_of != &Value::from(1) {
            return Err("best_of must be 1".to_string());
        }
    }

    if let Some(max_tokens) = obj.get("max_tokens") {
        // JS：null 显式跳过；其余按 Number() 归一（"99" → 99 接受；"abc" → NaN 拒）
        if !max_tokens.is_null() {
            let normalized = crws_core::js_number_value(max_tokens);
            match normalized {
                Some(v) if v >= 1.0 && v.fract() == 0.0 => {
                    if v > config.payload_limits.max_chat_tokens as f64 {
                        return Err("max_tokens exceeds the configured limit".to_string());
                    }
                }
                _ => return Err("max_tokens must be a positive integer".to_string()),
            }
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
            // JS Number() 归一（单一实现 core::js_number_value —— 与校验侧同源；
            // 空串 → 0、数字字符串 → 数值、其余保留原值）
            let normalized = match crws_core::js_number_value(existing) {
                Some(v) if v.fract() == 0.0 => Value::from(v as i64),
                _ => existing.clone(),
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

#[cfg(test)]
mod payload_validation_contract {
    use super::*;
    use crate::config::config_from_env;
    use crws_core::EnvMap;
    use crate::fixtures::{payload_validation_cases, payload_validation_config};

    /// 双端同语义锁定：与 server/qwenProxy.test.js 消费同一份
    /// shared/fixtures/payloadValidation.json（发布路径 JS 语义实算）。
    /// 期望 {ok, message} ←→ Result<(), String> 映射：Ok → {ok:true}；
    /// Err(msg) → {ok:false, message}。
    #[test]
    fn payload_validation_matches_shared_fixtures() {
        // 阈值来自夹具（与契约 payloadValidation.defaults 同源）—— 不用 env 默认值
        let mut config = config_from_env(&EnvMap::new());
        let fixture_config = payload_validation_config();
        config.payload_limits.max_chat_messages =
            fixture_config["maxChatMessages"].as_i64().expect("maxChatMessages");
        config.payload_limits.max_chat_tokens =
            fixture_config["maxChatTokens"].as_i64().expect("maxChatTokens");

        for case in payload_validation_cases() {
            let name = case["name"].as_str().expect("case name");
            let body = case["body"].clone();
            let expected = &case["expected"];
            let verdict = validate_chat_completion_payload(&body, &config);
            let expected_ok = expected["ok"].as_bool().expect("expected.ok");

            let actual_ok = verdict.is_ok();
            assert_eq!(
                actual_ok, expected_ok,
                "case {name}: expected ok={expected_ok}, actual ok={actual_ok}"
            );
            if let Some(expected_message) = expected["message"].as_str() {
                let Err(actual_message) = &verdict else {
                    panic!("case {name}: expected rejection message {expected_message:?}, got Ok");
                };
                assert_eq!(
                    actual_message, expected_message,
                    "case {name}: message mismatch"
                );
            }
        }
    }
}
