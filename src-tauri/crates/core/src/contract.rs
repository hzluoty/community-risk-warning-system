//! 渲染端与 Rust 端共用的契约常量 —— 单一事实源是 `shared/contract.json`
//! （由 `npm run gen:contract` 从 shared/*.js 生成，CI 用 `npm run check:contract`
//! 防漂移）。Rust 侧绝不手写路由 / schema / 模型别名 / 任务 ID（评审第 4 条）。

use std::sync::OnceLock;

use serde_json::Value;

const CONTRACT_JSON: &str = include_str!("../../../../shared/contract.json");

fn contract() -> &'static Value {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(CONTRACT_JSON).expect("shared/contract.json must be valid JSON")
    })
}

fn route(name: &str) -> &'static str {
    contract()["apiRoutes"][name]
        .as_str()
        .unwrap_or_else(|| panic!("contract apiRoutes.{name} must be a string"))
}

pub fn health_route() -> &'static str {
    route("health")
}

pub fn qwen_chat_completions_route() -> &'static str {
    route("qwenChatCompletions")
}

pub fn ollama_chat_completions_route() -> &'static str {
    route("ollamaChatCompletions")
}

pub fn ollama_status_route() -> &'static str {
    route("ollamaStatus")
}

fn tasks_route(name: &str) -> &'static str {
    contract()["tasksRoutes"][name]
        .as_str()
        .unwrap_or_else(|| panic!("contract tasksRoutes.{name} must be a string"))
}

pub fn tasks_route_prefix() -> &'static str {
    tasks_route("prefix")
}

pub fn tasks_ingest_route() -> &'static str {
    tasks_route("ingest")
}

pub fn tasks_results_route() -> &'static str {
    tasks_route("results")
}

pub fn tasks_run_route() -> &'static str {
    tasks_route("run")
}

/// VLM 进程监管参数（contract.json 的 vlmRuntime 段；源文件 shared/vlmRuntime.json）：
/// llama-server 参数模板 / 子进程 env 白名单 / 退避常量 / 必需运行时文件。
/// TS（electron/ollamaManager.ts）与 Rust（crws-vlm::args）共读同一份。
pub fn vlm_runtime() -> &'static Value {
    &contract()["vlmRuntime"]
}

/// chat 载荷校验契约（contract.json 的 payloadValidation 段；
/// 事实源 shared/payloadValidation.js）：不支持的 token 上限字段表 + 阈值默认。
pub fn payload_validation() -> &'static Value {
    &contract()["payloadValidation"]
}

/// golden 用例占位符表（contract.json 的 routePlaceholders 段，
/// 事实源：shared/apiRoutes.js 的 ROUTE_PLACEHOLDERS + TOKEN_PLACEHOLDER）。
/// 返回 (占位符, 展开值) 列表；TOKEN 占位符展开值留空（运行期由 config 填）。
pub fn route_placeholders() -> Vec<(&'static str, &'static str)> {
    contract()["routePlaceholders"]
        .as_object()
        .expect("contract routePlaceholders must be an object")
        .iter()
        .map(|(k, v)| {
            let value = v.as_str().unwrap_or_default();
            (k.as_str(), value)
        })
        .collect()
}

/// 本地代理鉴权头名：跨端 wire 契约（四方注入与校验必须同名）。
pub fn local_proxy_token_header() -> &'static str {
    contract()["headers"]["localProxyToken"]
        .as_str()
        .expect("contract headers.localProxyToken must be a string")
}

pub fn default_vlm_model_alias() -> &'static str {
    contract()["vlmModel"]["defaultAlias"]
        .as_str()
        .expect("contract vlmModel.defaultAlias must be a string")
}

pub fn default_qwen_api_model() -> &'static str {
    contract()["vlmModel"]["defaultQwenApiModel"]
        .as_str()
        .expect("contract vlmModel.defaultQwenApiModel must be a string")
}

pub fn vlm_model_file() -> &'static str {
    contract()["vlmModel"]["modelFile"]
        .as_str()
        .expect("contract vlmModel.modelFile must be a string")
}

pub fn vlm_mmproj_file() -> &'static str {
    contract()["vlmModel"]["mmprojFile"]
        .as_str()
        .expect("contract vlmModel.mmprojFile must be a string")
}

pub fn vlm_has_mmproj() -> bool {
    contract()["vlmModel"]["hasMmproj"]
        .as_bool()
        .expect("contract vlmModel.hasMmproj must be a boolean")
}

pub fn vlm_response_format() -> Value {
    contract()["vlmResponseFormat"].clone()
}

pub fn event_response_format() -> Value {
    contract()["eventResponseFormat"].clone()
}

pub fn competition_task_ids() -> Vec<&'static str> {
    contract()["competitionTaskIds"]
        .as_array()
        .expect("contract competitionTaskIds must be an array")
        .iter()
        .map(|v| v.as_str().expect("task id must be a string"))
        .collect()
}

/// 云端上游端点表（key + baseUrl），仅来自 shared/qwenEndpoints.js 生成的契约；
/// chatCompletionsUrl 由 endpoints.rs 从 baseUrl 派生，禁止第二份 URL 清单。
pub fn qwen_endpoint_table() -> Vec<(String, String)> {
    contract()["qwenEndpoints"]
        .as_array()
        .expect("contract qwenEndpoints must be an array")
        .iter()
        .map(|e| {
            (
                e["key"]
                    .as_str()
                    .expect("endpoint key must be a string")
                    .to_string(),
                e["baseUrl"]
                    .as_str()
                    .expect("endpoint baseUrl must be a string")
                    .to_string(),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_match_the_renderer_contract() {
        assert_eq!(health_route(), "/api/health");
        assert_eq!(qwen_chat_completions_route(), "/api/qwen/chat/completions");
        assert_eq!(
            ollama_chat_completions_route(),
            "/api/ollama/chat/completions"
        );
        assert_eq!(ollama_status_route(), "/api/ollama/status");
    }

    #[test]
    fn tasks_routes_match_the_server_contract() {
        assert_eq!(tasks_route_prefix(), "/api/tasks");
        assert_eq!(tasks_ingest_route(), "/api/tasks/ingest");
        assert_eq!(tasks_results_route(), "/api/tasks/results");
        assert_eq!(tasks_run_route(), "/api/tasks/run");
    }

    #[test]
    fn local_proxy_token_header_matches_the_wire_contract() {
        assert_eq!(local_proxy_token_header(), "x-local-proxy-token");
    }

    #[test]
    fn model_contract_matches_the_shared_module() {
        assert_eq!(default_vlm_model_alias(), "qwen3.5-4b-mtp:q4_k_m");
        assert_eq!(default_qwen_api_model(), "qwen3-vl-plus");
        assert!(vlm_has_mmproj());
        assert_eq!(vlm_model_file(), "Qwen3.5-4B-Q4_K_M.gguf");
        assert_eq!(vlm_mmproj_file(), "mmproj-BF16.gguf");
    }

    #[test]
    fn competition_task_ids_cover_the_ten_tasks() {
        let ids = competition_task_ids();
        assert_eq!(ids.len(), 10);
        assert!(ids.contains(&"traffic_light"));
        assert!(ids.contains(&"parking"));
    }

    #[test]
    fn response_formats_are_json_schema_wrappers() {
        assert_eq!(vlm_response_format()["type"], "json_schema");
        assert_eq!(event_response_format()["type"], "json_schema");
        assert!(
            vlm_response_format()["schema"]["required"]
                .as_array()
                .unwrap()
                .len()
                >= 11
        );
    }

    #[test]
    fn qwen_endpoint_table_has_eight_unique_keys() {
        let table = qwen_endpoint_table();
        assert_eq!(table.len(), 8);
        let mut keys: Vec<_> = table.iter().map(|(k, _)| k.clone()).collect();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), 8);
        assert!(table.iter().any(|(k, _)| k == "dashscope-cn"));
        assert!(table.iter().any(|(k, _)| k == "bigmodel"));
    }
}
