//! 行为夹具（shared/fixtures/*.json，由 shared/contractFixtures.js 实算落盘）：
//! JS 与 Rust 双实现共用同一组期望，防静默漂移。
//! 注意：requestBody 夹具的断言必须用 `serde_json::to_string` 的规范化文本比较
//! （preserve_order 保插入序），复刻 JS `JSON.stringify` 的键序敏感语义；
//! IndexMap 的 `PartialEq` 是顺序无关的，禁止用 `Value == Value` 判键序。

use std::sync::OnceLock;

use serde_json::Value;

const REQUEST_BODY_FIXTURES_JSON: &str =
    include_str!("../../../../shared/fixtures/requestBody.json");
const PAYLOAD_VALIDATION_FIXTURES_JSON: &str =
    include_str!("../../../../shared/fixtures/payloadValidation.json");

fn request_body_fixtures() -> &'static Value {
    static FIXTURES: OnceLock<Value> = OnceLock::new();
    FIXTURES.get_or_init(|| {
        serde_json::from_str(REQUEST_BODY_FIXTURES_JSON)
            .expect("shared/fixtures/requestBody.json must be valid JSON")
    })
}

pub fn request_body_cases() -> &'static Vec<Value> {
    request_body_fixtures()
        .as_array()
        .expect("requestBody fixtures must be an array")
}

/// 载荷校验夹具（shared/fixtures/payloadValidation.json，由发布路径 JS 语义实算落盘）：
/// `{ config, cases }` —— config 为阈值（双端读同一份，不各持硬编码），
/// cases 为 null/布尔/字符串形态的双端同语义锁定用例。
pub fn payload_validation_fixtures() -> &'static Value {
    static FIXTURES: OnceLock<Value> = OnceLock::new();
    FIXTURES.get_or_init(|| {
        serde_json::from_str(PAYLOAD_VALIDATION_FIXTURES_JSON)
            .expect("shared/fixtures/payloadValidation.json must be valid JSON")
    })
}

pub fn payload_validation_cases() -> &'static Vec<Value> {
    payload_validation_fixtures()["cases"]
        .as_array()
        .expect("payloadValidation cases must be an array")
}

/// 夹具阈值（maxChatMessages / maxChatTokens）—— 与契约 payloadValidation.defaults 同源。
pub fn payload_validation_config() -> &'static Value {
    &payload_validation_fixtures()["config"]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_body_fixtures_are_loaded_and_populated() {
        assert!(request_body_cases().len() >= 7);
    }

    #[test]
    fn request_body_fixtures_cover_the_key_order_sensitive_case() {
        let names: Vec<&str> = request_body_cases()
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        assert!(
            names.contains(&"ollama-key-order-sensitive-whitelist-replaces-reordered-event-format")
        );
    }
}
