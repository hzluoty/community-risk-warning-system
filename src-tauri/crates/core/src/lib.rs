//! crws-core：跨 crate 的底层共享 —— env 解析（shared/envParsers.js 同语义）、
//! VLM 运行配置（shared/vlmRuntimeConfig.js 同语义）、信任态读写类型。
//! 依赖方向：core ← proxy、core ← vlm（proxy 与 vlm 互不依赖，DAG 无环）。
//! 解析行为由 shared/fixtures/env.json 锁定（JS 与 Rust 双端同一组期望）。

pub mod contract;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const LOCAL_OLLAMA_HOST: &str = "127.0.0.1";
const VALID_CACHE_TYPES: [&str; 8] = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "q5_0", "q5_1"];

/// 环境查询抽象：生产读 `std::env`，测试注入 HashMap。
pub type EnvMap = HashMap<String, String>;

pub fn env_lookup(map: &EnvMap) -> impl Fn(&str) -> Option<String> + '_ {
    move |k| map.get(k).cloned()
}

// —— shared/envParsers.js ——

/// JS `Number()` 语义的近似：空白串是 0，解析失败是 NaN（返回 None）。
fn js_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    t.parse::<f64>().ok()
}

pub fn parse_boolean(value: Option<&str>, fallback: bool) -> bool {
    match value {
        None | Some("") => fallback,
        Some(v) => v.eq_ignore_ascii_case("true"),
    }
}

pub fn parse_integer(value: Option<&str>, fallback: i64, min: i64) -> i64 {
    let Some(v) = value else { return fallback };
    match js_number(v) {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n >= min as f64 => n as i64,
        _ => fallback,
    }
}

/// 对齐 parseTimeoutOption：必须是整数且不低于最小档位，然后向上取最近的档位。
pub fn parse_timeout_option(value: Option<&str>, fallback: Duration, options: &[u64]) -> Duration {
    let Some(v) = value else { return fallback };
    match js_number(v) {
        Some(n) if n.is_finite() && n.fract() == 0.0 => {
            let parsed = n as i64;
            if parsed < options[0] as i64 {
                return fallback;
            }
            let chosen = options.iter().copied().find(|o| *o as i64 >= parsed);
            Duration::from_millis(chosen.unwrap_or(fallback.as_millis() as u64))
        }
        _ => fallback,
    }
}

/// Node `bytes` 包语义（b/kb/mb/gb/tb/pb，大小写不敏感，裸数字按字节）。
pub fn parse_body_limit_bytes(raw: &str) -> Option<u64> {
    let t = raw.trim().to_lowercase();
    if t.is_empty() {
        return None;
    }
    let split = t
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
        .unwrap_or(t.len());
    let (num_part, unit_part) = t.split_at(split);
    let n: f64 = num_part.trim().parse().ok()?;
    if !(n.is_finite() && n >= 0.0) {
        return None;
    }
    let mult: u64 = match unit_part.trim() {
        "" | "b" => 1,
        "k" | "kb" => 1024,
        "m" | "mb" => 1024 * 1024,
        "g" | "gb" => 1024 * 1024 * 1024,
        "t" | "tb" => 1024u64.pow(4),
        "p" | "pb" => 1024u64.pow(5),
        _ => return None,
    };
    Some((n * mult as f64) as u64)
}

// —— shared/vlmRuntimeConfig.js ——

fn parse_vlm_host(value: Option<&str>) -> String {
    let host = value.unwrap_or("").trim();
    if host == "127.0.0.1" || host == "localhost" {
        return host.to_string();
    }
    LOCAL_OLLAMA_HOST.to_string()
}

fn parse_cache_type(value: Option<&str>, fallback: &str) -> String {
    let t = value.unwrap_or("").trim().to_lowercase();
    if VALID_CACHE_TYPES.contains(&t.as_str()) {
        return t;
    }
    fallback.to_string()
}

pub fn parse_u16_port(value: Option<&str>, fallback: u16) -> u16 {
    let parsed = parse_integer(value, fallback as i64, 1);
    if (1..=u16::MAX as i64).contains(&parsed) {
        parsed as u16
    } else {
        fallback
    }
}

/// 对齐 resolveOllamaHealthStatus：2xx → ready；503 → loading；其余 → error。
/// （原在 proxy/policy.rs 与 vlm 各一份 —— 下沉 core 后两侧共用唯一实现。）
pub fn resolve_ollama_health_status(status_code: u16) -> (bool, &'static str, &'static str) {
    if (200..300).contains(&status_code) {
        (true, "ready", "unknown")
    } else if status_code == 503 {
        (false, "loading", "unknown")
    } else {
        (false, "error", "unknown")
    }
}

#[derive(Clone, Debug)]
pub struct VlmRuntimeConfig {
    pub host: String,
    pub port: u16,
    /// 模型别名（llama-server -a 参数与代理 ollama_model 同源）。
    /// 默认值由调用方从契约注入 —— 本 crate 不持有第二份默认别名。
    pub model_alias: String,
    pub gpu_layers: i64,
    pub context_size: i64,
    pub batch_size: i64,
    pub ubatch_size: i64,
    pub cache_type_k: String,
    pub cache_type_v: String,
    pub startup_timeout_ms: u64,
    pub mtp_enabled: bool,
    pub mtp_draft_tokens: i64,
}

/// `default_model_alias`：调用方注入契约值（shared/vlmModelConfig.js 的
/// DEFAULT_VLM_MODEL_ALIAS 经 contract.json）—— core 不硬编码第二份默认。
pub fn load_vlm_runtime_config(
    lookup: &dyn Fn(&str) -> Option<String>,
    default_model_alias: &str,
) -> VlmRuntimeConfig {
    let force_cpu = parse_boolean(lookup("VLM_FORCE_CPU").as_deref(), false);
    let model_alias = lookup("VLM_MODEL")
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let model_alias = if model_alias.is_empty() {
        default_model_alias.to_string()
    } else {
        model_alias
    };
    VlmRuntimeConfig {
        host: parse_vlm_host(lookup("VLM_HOST").as_deref()),
        port: parse_u16_port(lookup("VLM_PORT").as_deref(), 11434),
        model_alias,
        gpu_layers: if force_cpu {
            0
        } else {
            parse_integer(lookup("VLM_GPU_LAYERS").as_deref(), 99, 0)
        },
        context_size: parse_integer(lookup("VLM_CONTEXT_SIZE").as_deref(), 4096, 512),
        batch_size: parse_integer(lookup("VLM_BATCH_SIZE").as_deref(), 512, 1),
        ubatch_size: parse_integer(lookup("VLM_UBATCH_SIZE").as_deref(), 256, 1),
        cache_type_k: parse_cache_type(lookup("VLM_CACHE_TYPE_K").as_deref(), "f16"),
        cache_type_v: parse_cache_type(lookup("VLM_CACHE_TYPE_V").as_deref(), "f16"),
        startup_timeout_ms: parse_integer(
            lookup("VLM_STARTUP_TIMEOUT_MS").as_deref(),
            60_000,
            5_000,
        ) as u64,
        mtp_enabled: parse_boolean(lookup("VLM_MTP_ENABLED").as_deref(), false),
        mtp_draft_tokens: parse_integer(lookup("VLM_MTP_DRAFT_TOKENS").as_deref(), 4, 1),
    }
}

// —— 信任态读写类型（读写分离，写权独占 supervisor）——

/// 只读信任句柄：路由 / AppState / 状态快照持有 —— 只能读。
#[derive(Clone)]
pub struct VlmTrustReader {
    inner: Arc<AtomicBool>,
}

impl VlmTrustReader {
    pub fn is_trusted(&self) -> bool {
        self.inner.load(Ordering::Relaxed)
    }
}

/// 可写信任句柄：supervisor 独占 —— crate 外拿不到、路由无法置真。
pub struct VlmTrustWriter {
    inner: Arc<AtomicBool>,
}

impl VlmTrustWriter {
    pub fn set_trusted(&self, value: bool) {
        self.inner.store(value, Ordering::Relaxed);
    }
}

/// 信任态生成器（唯一创建点）：产出 (writer, reader)。
/// writer 交给 supervisor；reader 交给路由 / AppState / 状态快照。
pub struct VlmTrust;

impl VlmTrust {
    pub fn creator() -> (VlmTrustWriter, VlmTrustReader) {
        let inner = Arc::new(AtomicBool::new(false));
        (
            VlmTrustWriter {
                inner: inner.clone(),
            },
            VlmTrustReader { inner },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// shared/fixtures/env.json（由 shared/contractFixtures.js 实算落盘）：
    /// env 解析行为的期望值唯一来源 —— core 持实现、core 跑断言（不再由 proxy 代跑）。
    const ENV_FIXTURES_JSON: &str = include_str!("../../../../shared/fixtures/env.json");

    // 夹具期望的默认别名 = 契约值（contract::default_vlm_model_alias），
    /// 不再手抄第二份常量。

    fn env_fixtures() -> &'static Value {
        static FIXTURES: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        FIXTURES.get_or_init(|| {
            serde_json::from_str(ENV_FIXTURES_JSON)
                .expect("shared/fixtures/env.json must be valid JSON")
        })
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

    #[test]
    fn parse_boolean_matches_shared_fixtures() {
        for case in env_fixtures()["parseBoolean"]
            .as_array()
            .expect("parseBoolean array")
        {
            let value = case["value"].as_str();
            let fallback = case["fallback"].as_bool().expect("fallback bool");
            let expected = case["expected"].as_bool().expect("expected bool");
            assert_eq!(
                parse_boolean(value, fallback),
                expected,
                "parseBoolean fixture failed: value={value:?} fallback={fallback}"
            );
        }
    }

    #[test]
    fn parse_integer_matches_shared_fixtures() {
        for case in env_fixtures()["parseInteger"]
            .as_array()
            .expect("parseInteger array")
        {
            let value = case["value"].as_str();
            let fallback = case["fallback"].as_i64().expect("fallback int");
            let min = case["min"].as_i64().expect("min int");
            let expected = case["expected"].as_i64().expect("expected int");
            assert_eq!(
                parse_integer(value, fallback, min),
                expected,
                "parseInteger fixture failed: value={value:?} fallback={fallback} min={min}"
            );
        }
    }

    #[test]
    fn vlm_runtime_config_matches_shared_fixtures() {
        for case in env_fixtures()["vlmRuntimeConfig"]
            .as_array()
            .expect("vlmRuntimeConfig array")
        {
            let env = env_map_from_json(&case["env"]);
            let lookup = env_lookup(&env);
            let actual = load_vlm_runtime_config(&lookup, contract::default_vlm_model_alias());
            let expected = &case["expected"];

            assert_eq!(
                actual.host,
                expected["host"].as_str().unwrap(),
                "host mismatch for env {:?}",
                case["env"]
            );
            assert_eq!(actual.port, expected["port"].as_u64().unwrap() as u16);
            // modelAlias：夹具由 shared 实算（默认别名即契约值）—— 断言与期望一致
            assert_eq!(actual.model_alias, expected["modelAlias"].as_str().unwrap());
            assert_eq!(actual.gpu_layers, expected["gpuLayers"].as_i64().unwrap());
            assert_eq!(
                actual.context_size,
                expected["contextSize"].as_i64().unwrap()
            );
            assert_eq!(actual.batch_size, expected["batchSize"].as_i64().unwrap());
            assert_eq!(actual.ubatch_size, expected["ubatchSize"].as_i64().unwrap());
            assert_eq!(
                actual.cache_type_k,
                expected["cacheTypeK"].as_str().unwrap()
            );
            assert_eq!(
                actual.cache_type_v,
                expected["cacheTypeV"].as_str().unwrap()
            );
            assert_eq!(
                actual.startup_timeout_ms,
                expected["startupTimeoutMs"].as_u64().unwrap()
            );
            assert_eq!(
                actual.mtp_enabled,
                expected["mtpEnabled"].as_bool().unwrap()
            );
            assert_eq!(
                actual.mtp_draft_tokens,
                expected["mtpDraftTokens"].as_i64().unwrap()
            );
        }
    }

    #[test]
    fn body_limits_match_shared_fixtures() {
        for case in env_fixtures()["bodyLimits"]
            .as_array()
            .expect("bodyLimits array")
        {
            let value = case["value"].as_str().expect("value string");
            let expected = case["expected"].as_u64();
            assert_eq!(
                parse_body_limit_bytes(value),
                expected,
                "bodyLimit fixture failed: value={value}"
            );
        }
    }

    #[test]
    fn health_status_matches_shared_fixtures() {
        for case in env_fixtures()["healthStatus"]
            .as_array()
            .expect("healthStatus array")
        {
            let status_code = case["statusCode"].as_u64().expect("statusCode") as u16;
            let expected = &case["expected"];
            let (ready, status, gpu) = resolve_ollama_health_status(status_code);
            assert_eq!(
                ready,
                expected["ready"].as_bool().unwrap(),
                "statusCode {status_code}"
            );
            assert_eq!(
                status,
                expected["status"].as_str().unwrap(),
                "statusCode {status_code}"
            );
            assert_eq!(
                gpu,
                expected["gpu"].as_str().unwrap(),
                "statusCode {status_code}"
            );
        }
    }

    #[test]
    fn trust_creator_defaults_to_fail_closed_and_couples_rw() {
        let (writer, reader) = VlmTrust::creator();
        assert!(!reader.is_trusted());
        writer.set_trusted(true);
        assert!(reader.is_trusted());
    }

    #[test]
    fn vlm_runtime_config_uses_injected_default_alias() {
        let config = load_vlm_runtime_config(&|_| None, "contract-alias");
        assert_eq!(config.model_alias, "contract-alias");

        let config = load_vlm_runtime_config(
            &|k| (k == "VLM_MODEL").then(|| "custom".to_string()),
            "contract-alias",
        );
        assert_eq!(config.model_alias, "custom");
    }

    #[test]
    fn vlm_runtime_config_defaults_and_overrides() {
        let empty = load_vlm_runtime_config(&|_| None, "alias");
        assert_eq!(empty.host, "127.0.0.1");
        assert_eq!(empty.port, 11434);
        assert_eq!(empty.gpu_layers, 99);
        assert_eq!(empty.context_size, 4096);
        assert_eq!(empty.cache_type_k, "f16");
        assert!(!empty.mtp_enabled);

        let forced = load_vlm_runtime_config(
            &|k| match k {
                "VLM_FORCE_CPU" => Some("true".to_string()),
                "VLM_CACHE_TYPE_K" => Some("q8_0".to_string()),
                "VLM_CACHE_TYPE_V" => Some("bogus".to_string()),
                _ => None,
            },
            "alias",
        );
        assert_eq!(forced.gpu_layers, 0);
        assert_eq!(forced.cache_type_k, "q8_0");
        assert_eq!(forced.cache_type_v, "f16");
    }

    #[test]
    fn env_parsers_match_js_semantics() {
        assert!(parse_boolean(Some("TRUE"), false));
        assert!(!parse_boolean(Some("1"), false));
        assert!(parse_boolean(None, true));
        // JS：Number('')=0 → isInteger ✓ 但 0 < min(1) → fallback（fixture env.json 同期望）
        assert_eq!(parse_integer(Some(""), 7, 1), 7);
        assert_eq!(parse_integer(Some("1e3"), 7, 1), 1000);
        assert_eq!(parse_integer(Some("3.5"), 7, 1), 7);
        assert_eq!(parse_integer(Some("99"), 7, 100), 7);
    }

    #[test]
    fn timeout_options_snap_up_to_nearest_step() {
        let fallback = Duration::from_millis(60_000);
        let options = [15_000u64, 30_000, 60_000, 90_000, 120_000];
        assert_eq!(
            parse_timeout_option(Some("90000"), fallback, &options),
            Duration::from_millis(90_000)
        );
        assert_eq!(
            parse_timeout_option(Some("31000"), fallback, &options),
            Duration::from_millis(60_000)
        );
        assert_eq!(
            parse_timeout_option(Some("5000"), fallback, &options),
            fallback
        );
    }

    #[test]
    fn parses_node_bytes_style_body_limits() {
        assert_eq!(parse_body_limit_bytes("2mb"), Some(2 * 1024 * 1024));
        assert_eq!(parse_body_limit_bytes("1b"), Some(1));
        assert_eq!(parse_body_limit_bytes("6KB"), Some(6 * 1024));
        assert_eq!(parse_body_limit_bytes("100"), Some(100));
        assert_eq!(parse_body_limit_bytes("nonsense"), None);
    }
}
