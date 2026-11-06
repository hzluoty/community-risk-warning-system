//! 上游请求体裁决 —— 与 shared/vlmRequestBody.js 同语义的双实现，
//! 期望值由 shared/fixtures/requestBody.json 锁定（fixtures::request_body_cases）。
//! 键序敏感白名单判定：用 `serde_json::to_string` 的规范化文本比较复刻
//! JS `JSON.stringify` 的键序语义；IndexMap 的 PartialEq 是顺序无关的，禁止用 Value 相等。

use serde_json::{Map, Value};

use crate::contract;

pub fn build_qwen_request_body(body: &Value, default_model: &str) -> Value {
    let mut out = body.clone();
    out["model"] = Value::String(default_model.to_string());
    out
}

pub fn build_qwen_fallback_request_body(body: &Value, model: &str) -> Value {
    let mut out = body.clone();
    out["model"] = Value::String(model.to_string());
    out["stream"] = Value::Bool(false);
    out["response_format"] = serde_json::json!({ "type": "json_object" });
    if let Some(map) = out.as_object_mut() {
        map.remove("chat_template_kwargs");
    }
    out
}

/// 键序敏感的 response_format 白名单判定（对齐 JS 的 JSON.stringify 等值比较）。
fn response_format_matches_event_format(body: &Value) -> bool {
    let Some(response_format) = body.get("response_format") else {
        return false;
    };
    let Some(event_format_text) = serialize_canonical(&contract::event_response_format()) else {
        return false;
    };
    serialize_canonical(response_format).as_deref() == Some(event_format_text.as_str())
}

/// 规范化 JSON 文本（preserve_order 保插入序，与 JSON.stringify 的键序语义一致）。
pub fn serialize_canonical(value: &Value) -> Option<String> {
    serde_json::to_string(value).ok()
}

pub fn build_ollama_request_body(body: &Value, model: &str) -> Value {
    let mut out = body.clone();
    out["model"] = Value::String(model.to_string());

    // 白名单：事件 schema 原样放行（键序敏感），其余一律替换为 VLM 响应 schema。
    if response_format_matches_event_format(body) {
        out["response_format"] = contract::event_response_format();
    } else {
        out["response_format"] = contract::vlm_response_format();
    }

    // 合并 chat_template_kwargs 并强制 enable_thinking=false（保留其他键）。
    let mut kwargs = body
        .get("chat_template_kwargs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    kwargs.insert("enable_thinking".to_string(), Value::Bool(false));
    out["chat_template_kwargs"] = Value::Object(kwargs);
    out
}

/// 从夹具的 args（[body, model]）调用对应 builder（测试与 case runner 共用）。
pub fn dispatch_builder(name: &str, args: &[Value]) -> Option<Value> {
    let body = args.first().cloned().unwrap_or(Value::Object(Map::new()));
    let model = args
        .get(1)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    match name {
        "buildQwenRequestBody" => Some(build_qwen_request_body(&body, &model)),
        "buildQwenFallbackRequestBody" => Some(build_qwen_fallback_request_body(&body, &model)),
        "buildOllamaRequestBody" => Some(build_ollama_request_body(&body, &model)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures;

    /// 全部夹具用规范化文本比较（复刻 JS 键序敏感语义 —— 不是 Value 结构相等）。
    #[test]
    fn request_body_builders_match_shared_fixtures_by_canonical_text() {
        for case in fixtures::request_body_cases() {
            let name = case["name"].as_str().expect("name");
            let builder = case["builder"].as_str().expect("builder");
            let args = case["args"].as_array().expect("args");
            let expected = &case["expected"];

            let actual = dispatch_builder(builder, args)
                .unwrap_or_else(|| panic!("unknown builder {builder}"));

            let actual_text = serialize_canonical(&actual).expect("serialize actual");
            let expected_text = serialize_canonical(expected).expect("serialize expected");
            assert_eq!(
                actual_text, expected_text,
                "fixture {name}: canonical text mismatch"
            );
        }
    }

    /// 键序敏感行为显式锁定：乱序的 event format 不匹配键序敏感比较，
    /// 被替换为 VLM 白名单（与 JS fixture 期望一致）；若误用 Value 相等
    /// （顺序无关），乱序输入会被当作 event format 放行 —— 文本比较能抓到。
    #[test]
    fn key_order_sensitive_whitelist_replaces_reordered_event_format() {
        let reordered = serde_json::json!({
            "json_schema": contract::event_response_format()["json_schema"],
            "type": "json_schema"
        });
        let body = serde_json::json!({ "response_format": reordered });
        let built = build_ollama_request_body(&body, "model");
        let actual_text = serialize_canonical(&built["response_format"]).unwrap();
        // JS：JSON.stringify(乱序) !== JSON.stringify(EVENT_FORMAT) → 选 VLM 白名单
        let expected_text = serialize_canonical(&contract::vlm_response_format()).unwrap();
        assert_eq!(actual_text, expected_text);
        // 且确实不等于 event format（证明乱序输入被替换而非保留）
        let event_text = serialize_canonical(&contract::event_response_format()).unwrap();
        assert_ne!(actual_text, event_text);
    }

    #[test]
    fn arbitrary_format_is_replaced_by_vlm_whitelist() {
        let body = serde_json::json!({ "response_format": { "type": "arbitrary" } });
        let built = build_ollama_request_body(&body, "model");
        assert_eq!(
            serialize_canonical(&built["response_format"]).unwrap(),
            serialize_canonical(&contract::vlm_response_format()).unwrap()
        );
    }

    #[test]
    fn thinking_kwargs_merge_keeps_other_keys() {
        let body = serde_json::json!({
            "chat_template_kwargs": { "other": true, "enable_thinking": true },
            "messages": [{ "role": "user", "content": "ok" }]
        });
        let built = build_ollama_request_body(&body, "local-vlm");
        assert_eq!(built["chat_template_kwargs"]["other"], Value::Bool(true));
        assert_eq!(
            built["chat_template_kwargs"]["enable_thinking"],
            Value::Bool(false)
        );
    }

    #[test]
    fn qwen_fallback_strips_chat_template_kwargs_and_disables_stream() {
        let body = serde_json::json!({
            "model": "local-vlm",
            "stream": true,
            "chat_template_kwargs": { "enable_thinking": false },
            "messages": [{ "role": "user", "content": "ok" }]
        });
        let built = build_qwen_fallback_request_body(&body, "glm-4v-flash");
        assert_eq!(built["model"], Value::String("glm-4v-flash".into()));
        assert_eq!(built["stream"], Value::Bool(false));
        assert_eq!(
            built["response_format"],
            serde_json::json!({ "type": "json_object" })
        );
        assert!(built.get("chat_template_kwargs").is_none());
    }
}
