//! llama-server 启动参数表与子进程环境白名单 —— **契约驱动**：
//! 事实源 shared/vlmRuntime.json → contract.json 的 vlmRuntime 段
//! （crws_core::contract::vlm_runtime()）。
//!
//! TS 侧 electron/ollamaManager.ts#buildLlamaServerArgs 读同一份
//! argsTemplate（单一有序表：{flag, value?|source?}）—— 双端产出同一份 argv。
//! Rust 侧断言：args::tests::llama_server_args_match_the_electron_manager；
//! TS 侧断言：electron/ollamaManager.test.ts（同源锁定）。
//!
//! "哪个 flag 带值"由契约条目形状表达（value/source 可选）——
//! 本模块不硬编码任何 flag 名单。

use std::collections::HashMap;

use crws_core::VlmRuntimeConfig;

pub struct BuildLlamaServerArgs {
    pub model_path: String,
    pub mmproj_path: Option<String>,
    pub vlm_config: VlmRuntimeConfig,
    pub effective_gpu_layers: i64,
}

fn source_value(source: &str, options: &BuildLlamaServerArgs) -> Option<String> {
    let BuildLlamaServerArgs {
        model_path,
        mmproj_path: _,
        vlm_config,
        effective_gpu_layers,
    } = options;
    match source {
        "modelPath" => Some(model_path.clone()),
        "modelAlias" => Some(vlm_config.model_alias.clone()),
        "port" => Some(vlm_config.port.to_string()),
        "host" => Some(vlm_config.host.clone()),
        "gpuLayers" => Some(effective_gpu_layers.to_string()),
        "contextSize" => Some(vlm_config.context_size.to_string()),
        "batchSize" => Some(vlm_config.batch_size.to_string()),
        "ubatchSize" => Some(vlm_config.ubatch_size.to_string()),
        "cacheTypeK" => Some(vlm_config.cache_type_k.clone()),
        "cacheTypeV" => Some(vlm_config.cache_type_v.clone()),
        "mtpDraftTokens" => Some(vlm_config.mtp_draft_tokens.to_string()),
        _ => None,
    }
}

/// 展开一个契约条目：{flag, value?} 或 {flag, source?}。
fn push_entry(entry: &serde_json::Value, args: &mut Vec<String>, options: &BuildLlamaServerArgs) {
    let Some(flag) = entry["flag"].as_str() else { return };
    args.push(flag.to_string());
    if let Some(value) = entry["value"].as_str() {
        args.push(value.to_string());
    } else if let Some(source) = entry["source"].as_str() {
        if let Some(value) = source_value(source, options) {
            args.push(value);
        }
    }
}

/// 从契约模板（vlmRuntime.llamaServerArgs.argsTemplate）构建 llama-server 启动参数。
/// 与 electron/ollamaManager.ts#buildLlamaServerArgs 同一数据源、同一顺序。
pub fn build_llama_server_args(options: &BuildLlamaServerArgs) -> Vec<String> {
    let spec = &crws_core::contract::vlm_runtime()["llamaServerArgs"];
    let mut args: Vec<String> = Vec::new();

    // 单一有序表：按契约顺序逐项展开（TS 侧同序遍历 → 同一份 argv）
    for entry in spec["argsTemplate"].as_array().expect("argsTemplate array") {
        push_entry(entry, &mut args, options);
    }

    // mmproj / MTP 分支（视觉优先：互斥 —— 契约 mmprojPrecedenceWarning 字段锁定双端行为；
    // TS 侧 ollamaManager.ts 同样告警同文案）
    if let Some(mmproj) = &options.mmproj_path {
        if options.vlm_config.mtp_enabled {
            eprintln!(
                "[vlm] {}",
                spec["mmprojPrecedenceWarning"]
                    .as_str()
                    .unwrap_or("VLM_MTP_ENABLED=true 与 mmproj 视觉编码器互斥；已保留视觉能力并忽略 MTP。")
            );
        }
        args.push(
            spec["mmprojFlag"]
                .as_str()
                .expect("mmprojFlag")
                .to_string(),
        );
        args.push(mmproj.clone());
    } else if options.vlm_config.mtp_enabled {
        for entry in spec["mtpArgs"].as_array().expect("mtpArgs array") {
            push_entry(entry, &mut args, options);
        }
    }

    args
}

/// 子进程环境白名单（契约 vlmRuntime.childEnvWhitelist）：
/// 与 electron/ollamaManager.ts#buildLlamaServerEnv 同一数据源。
pub fn build_llama_server_env(
    source: &HashMap<String, String>,
    api_key: Option<&str>,
) -> Vec<(String, String)> {
    use std::collections::HashSet;

    let spec = &crws_core::contract::vlm_runtime()["childEnvWhitelist"];
    let common: HashSet<String> = spec["common"]
        .as_array()
        .expect("common array")
        .iter()
        .map(|v| v.as_str().expect("common entry").to_string())
        .collect();
    let platform: HashSet<String> = spec["windows"]
        .as_array()
        .expect("windows array")
        .iter()
        .map(|v| v.as_str().expect("windows entry").to_string())
        .collect();
    let prefixes: Vec<String> = spec["prefixes"]
        .as_array()
        .expect("prefixes array")
        .iter()
        .map(|v| v.as_str().expect("prefix entry").to_string())
        .collect();
    let api_key_variable = spec["apiKeyVariable"]
        .as_str()
        .expect("apiKeyVariable")
        .to_string();

    let mut child_env: Vec<(String, String)> = Vec::new();
    for (name, value) in source {
        let normalized = name.to_uppercase();
        let is_runtime_setting = prefixes.iter().any(|p| normalized.starts_with(p.as_str()));
        if common.contains(&normalized) || platform.contains(&normalized) || is_runtime_setting {
            child_env.push((name.clone(), value.clone()));
        }
    }

    if let Some(api_key) = api_key {
        if !api_key.is_empty() {
            child_env.push((api_key_variable, api_key.to_string()));
        }
    }

    child_env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vlm_config() -> VlmRuntimeConfig {
        VlmRuntimeConfig {
            host: "127.0.0.1".to_string(),
            port: 12345,
            model_alias: "qwen3.5-4b-mtp:q4_k_m".to_string(),
            gpu_layers: 99,
            context_size: 4096,
            batch_size: 512,
            ubatch_size: 256,
            cache_type_k: "f16".to_string(),
            cache_type_v: "f16".to_string(),
            startup_timeout_ms: 60_000,
            mtp_enabled: false,
            mtp_draft_tokens: 4,
        }
    }

    /// 与 electron/ollamaManager.ts#buildLlamaServerArgs 同一契约数据源、同一顺序：
    /// 断言完整 argv（不只 contains —— 顺序漂移即红）。
    #[test]
    fn llama_server_args_match_the_electron_manager() {
        let vlm = vlm_config();
        let args = build_llama_server_args(&BuildLlamaServerArgs {
            model_path: "model.gguf".to_string(),
            mmproj_path: Some("mmproj.gguf".to_string()),
            vlm_config: vlm.clone(),
            effective_gpu_layers: 99,
        });
        let expected = [
            "-m", "model.gguf",
            "-a", "qwen3.5-4b-mtp:q4_k_m",
            "--port", "12345",
            "--host", "127.0.0.1",
            "-ngl", "99",
            "-c", "4096",
            "-b", "512",
            "-ub", "256",
            "--flash-attn", "on",
            "--cache-type-k", "f16",
            "--cache-type-v", "f16",
            "--no-warmup",
            "--cont-batching",
            "--jinja",
            "--reasoning", "off",
            "--mmproj", "mmproj.gguf",
        ];
        assert_eq!(args, expected, "argv must match the TS-side order exactly");
    }

    /// MTP 分支（无 mmproj 且显式开启）。
    #[test]
    fn mtp_args_match_the_electron_manager() {
        let vlm = vlm_config();
        let args = build_llama_server_args(&BuildLlamaServerArgs {
            model_path: "model.gguf".to_string(),
            mmproj_path: None,
            vlm_config: VlmRuntimeConfig {
                mtp_enabled: true,
                mtp_draft_tokens: 6,
                ..vlm
            },
            effective_gpu_layers: 0,
        });
        let joined = args.join(" ");
        assert!(joined.contains("--spec-type draft-mtp"));
        assert!(joined.contains("--spec-draft-n-max 6"));
        assert!(!joined.contains("--mmproj"));
    }

    /// env 白名单（契约驱动）：只透传运行时相关变量 + LLAMA_API_KEY。
    #[test]
    fn child_env_whitelist_passes_runtime_settings_only() {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "C:/bin".to_string());
        env.insert("SYSTEMROOT".to_string(), "C:/Windows".to_string());
        env.insert("GGML_CUDA_PATH".to_string(), "/cuda".to_string());
        env.insert("QWEN_API_KEY".to_string(), "secret".to_string());
        env.insert("LOCAL_PROXY_TOKEN".to_string(), "secret".to_string());

        let child_env = build_llama_server_env(&env, Some("vlm-session-key"));
        let names: Vec<&str> = child_env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(names.contains(&"PATH"));
        assert!(names.contains(&"SYSTEMROOT"));
        assert!(names.contains(&"GGML_CUDA_PATH"));
        assert!(names.contains(&"LLAMA_API_KEY"));
        assert!(!names.contains(&"QWEN_API_KEY"));
        assert!(!names.contains(&"LOCAL_PROXY_TOKEN"));
    }
}
