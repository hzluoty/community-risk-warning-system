//! 任务回传通道（tasksIngest 的 Rust 移植）。
//! 状态归 TaskStore（Arc<RwLock>）经 State 注入，路由与状态可分离测试。
//! 长度语义按注释意图统一为字节（serde_json::to_vec().len()），保留原阈值。

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};
use tokio::sync::RwLock;

use crate::contract::{self, competition_task_ids};

// 字段长度与信封总字节预算：未鉴权写入者不能靠超长字段放大内存
// （max_results=200 条 × 上限 ≈ 6.4MB 堆，而不是 200 × 1MB body = 200MB）。
// 注意：原 JS 用 JSON.stringify().length（字符数）判定，与"总字节预算"注释意图不符；
// Rust 侧按注释意图统一为字节（架构评审第六轮 F/第 6 条），阈值不变。
const MAX_LOCATION_LENGTH: usize = 200;
const MAX_ANNOUNCEMENT_LENGTH: usize = 4000;
const MAX_BOXES: usize = 100;
const MAX_ENVELOPE_JSON_BYTES: usize = 32 * 1024;
const MAX_RUN_JSON_BYTES: usize = 8 * 1024;
const DEFAULT_MAX_RESULTS: usize = 200;
/// tasks ingest 独立 body 上限（1mb，对齐 tasksIngest 的独立解析器）。
const MAX_INGEST_BODY_BYTES: usize = 1024 * 1024;

/// 比较用字符数（与 JS .length 一致）：按 Unicode 标量计数。
fn js_length(s: &str) -> usize {
    s.chars().count()
}

/// 校验任务结果信封（TaskAnalysisResult）。返回 Err(message) 即 400。
pub fn validate_task_envelope(payload: &Value) -> Result<(), String> {
    let Some(obj) = payload.as_object() else {
        return Err("负载必须是 JSON 对象".to_string());
    };

    if obj.get("type").and_then(Value::as_str) != Some("task") {
        return Err("type 必须为 'task'".to_string());
    }

    let task_id = obj.get("taskId").and_then(Value::as_str).unwrap_or("");
    if !competition_task_ids().contains(&task_id) {
        return Err(format!("未知 taskId：{}", display_task_id(obj)));
    }

    let Some(location) = obj.get("location").and_then(Value::as_str) else {
        return Err("location 必须为非空字符串".to_string());
    };
    if location.is_empty() {
        return Err("location 必须为非空字符串".to_string());
    }
    if js_length(location) > MAX_LOCATION_LENGTH {
        return Err(format!("location 长度不能超过 {MAX_LOCATION_LENGTH}"));
    }

    match obj.get("capturedAt") {
        Some(Value::Number(n)) if n.as_f64().map(f64::is_finite).unwrap_or(false) => {}
        _ => return Err("capturedAt 必须为数字时间戳".to_string()),
    }

    let Some(result) = obj.get("result").and_then(Value::as_object) else {
        return Err("result 必须为对象".to_string());
    };
    if result.get("task").and_then(Value::as_str) != Some(task_id) {
        return Err("result.task 必须与 taskId 一致".to_string());
    }

    let Some(announcement) = result.get("announcement").and_then(Value::as_str) else {
        return Err("result.announcement 必须为字符串".to_string());
    };
    if js_length(announcement) > MAX_ANNOUNCEMENT_LENGTH {
        return Err(format!(
            "announcement 长度不能超过 {MAX_ANNOUNCEMENT_LENGTH}"
        ));
    }

    if let Some(boxes) = obj.get("boxes") {
        let Some(arr) = boxes.as_array() else {
            return Err("boxes 必须为数组".to_string());
        };
        if arr.len() > MAX_BOXES {
            return Err(format!("boxes 数量不能超过 {MAX_BOXES}"));
        }
    }

    let serialized = serde_json::to_vec(payload).map_err(|_| "信封负载超过大小限制".to_string())?;
    if serialized.len() > MAX_ENVELOPE_JSON_BYTES {
        return Err("信封负载超过大小限制".to_string());
    }

    Ok(())
}

fn display_task_id(obj: &Map<String, Value>) -> String {
    match obj.get("taskId") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => "undefined".to_string(),
    }
}

/// 校验运行事件（type='run'，status: running|done）。
pub fn validate_run_event(payload: &Value) -> Result<(), String> {
    let Some(obj) = payload.as_object() else {
        return Err("负载必须是 JSON 对象".to_string());
    };
    if obj.get("type").and_then(Value::as_str) != Some("run") {
        return Err("type 必须为 'run'".to_string());
    }
    match obj.get("status").and_then(Value::as_str) {
        Some("running") | Some("done") => {}
        _ => return Err("status 必须为 running|done".to_string()),
    }
    let serialized =
        serde_json::to_vec(payload).map_err(|_| "运行事件负载超过大小限制".to_string())?;
    if serialized.len() > MAX_RUN_JSON_BYTES {
        return Err("运行事件负载超过大小限制".to_string());
    }
    Ok(())
}

/// 已存储条目 = {...envelope, receivedAt}（最新在前）。
#[derive(Clone)]
pub struct StoredEntry {
    pub envelope: Value,
    pub received_at: u64,
}

#[derive(Clone)]
pub struct TaskStore {
    inner: Arc<RwLock<TaskState>>,
    max_results: usize,
}

struct TaskState {
    results: Vec<StoredEntry>,
    run: Option<Value>,
}

impl TaskStore {
    pub fn new() -> Self {
        Self::with_max_results(DEFAULT_MAX_RESULTS)
    }

    pub fn with_max_results(max_results: usize) -> Self {
        Self {
            inner: Arc::new(RwLock::new(TaskState {
                results: Vec::new(),
                run: None,
            })),
            max_results,
        }
    }

    async fn store_task(&self, envelope: Value) {
        let received_at = now_ms();
        let mut state = self.inner.write().await;
        state.results.insert(
            0,
            StoredEntry {
                envelope,
                received_at,
            },
        );
        state.results.truncate(self.max_results);
    }

    async fn store_run(&self, event: Value) {
        let received_at = now_ms();
        let mut state = self.inner.write().await;
        let mut stored = event.clone();
        if let Some(obj) = stored.as_object_mut() {
            obj.insert("receivedAt".to_string(), json!(received_at));
        }
        state.run = Some(stored);
    }

    async fn results_since(&self, since: Option<i64>) -> Vec<StoredEntry> {
        let state = self.inner.read().await;
        state
            .results
            .iter()
            .filter(|entry| match since {
                Some(s) => (entry.received_at as i64) > s,
                None => true,
            })
            .cloned()
            .collect()
    }

    async fn find_by_task_id(&self, task_id: &str) -> Option<StoredEntry> {
        let state = self.inner.read().await;
        state
            .results
            .iter()
            .find(|entry| entry.envelope.get("taskId").and_then(Value::as_str) == Some(task_id))
            .cloned()
    }

    async fn run(&self) -> Option<Value> {
        self.inner.read().await.run.clone()
    }
}

impl Default for TaskStore {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn stored_entry_to_json(entry: &StoredEntry) -> Value {
    let mut out = entry.envelope.clone();
    if let Some(obj) = out.as_object_mut() {
        obj.insert("receivedAt".to_string(), json!(entry.received_at));
    }
    out
}

/// POST /api/tasks/ingest（显式解析 body：畸形 JSON → JSON 400 invalid_request，
/// 对齐 Express 错误处理器返回的响应形状，而非 axum JsonRejection 的纯文本）。
pub async fn ingest(State(store): State<TaskStore>, request: axum::extract::Request) -> Response {
    let body_bytes =
        match axum::body::to_bytes(request.into_body(), MAX_INGEST_BODY_BYTES + 1).await {
            Ok(bytes) => bytes,
            Err(error) => {
                return crate::responses::build_express_error_response(400, &error.to_string());
            }
        };

    let payload: Value = if body_bytes.is_empty() {
        Value::Object(Map::new())
    } else {
        match serde_json::from_slice(&body_bytes) {
            Ok(value) => value,
            Err(error) => {
                return crate::responses::build_express_error_response(400, &error.to_string());
            }
        }
    };

    ingest_value(store, payload).await
}

/// 校验并存储已解析的负载（处理器与测试共用）。
pub async fn ingest_value(store: TaskStore, payload: Value) -> Response {
    if payload.get("type").and_then(Value::as_str) == Some("run") {
        if let Err(error) = validate_run_event(&payload) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": error })),
            )
                .into_response();
        }
        store.store_run(payload).await;
        return (StatusCode::OK, Json(json!({ "ok": true, "stored": "run" }))).into_response();
    }

    if let Err(error) = validate_task_envelope(&payload) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        )
            .into_response();
    }
    store.store_task(payload).await;
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "stored": "task" })),
    )
        .into_response()
}

/// GET /api/tasks/results?since=
pub async fn list_results(
    State(store): State<TaskStore>,
    Query(params): Query<Vec<(String, String)>>,
) -> Response {
    let since = params
        .iter()
        .find(|(k, _)| k == "since")
        .and_then(|(_, v)| parse_js_number(v));
    let entries = store.results_since(since).await;
    let results: Vec<Value> = entries.iter().map(stored_entry_to_json).collect();
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "count": results.len(), "results": results })),
    )
        .into_response()
}

/// JS Number() 语义：非有限/非数值 → None（Number.isFinite 过滤）。
fn parse_js_number(raw: &str) -> Option<i64> {
    let t = raw.trim();
    if t.is_empty() {
        return Some(0);
    }
    let n: f64 = t.parse().ok()?;
    if n.is_finite() && n.fract() == 0.0 && n >= i64::MIN as f64 && n <= i64::MAX as f64 {
        Some(n as i64)
    } else {
        None
    }
}

/// GET /api/tasks/results/:taskId
pub async fn get_result(State(store): State<TaskStore>, Path(task_id): Path<String>) -> Response {
    match store.find_by_task_id(&task_id).await {
        Some(entry) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "result": stored_entry_to_json(&entry) })),
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "暂无该任务结果" })),
        )
            .into_response(),
    }
}

/// GET /api/tasks/run
pub async fn get_run(State(store): State<TaskStore>) -> Response {
    let run = store.run().await;
    let body = match run {
        Some(value) => json!({ "ok": true, "run": value }),
        None => json!({ "ok": true, "run": null }),
    };
    (StatusCode::OK, Json(body)).into_response()
}

/// 挂载到 /api/tasks 前缀的子路由（路径全部来自契约）。
pub fn router(store: TaskStore) -> axum::Router {
    let ingest_path = relative(contract::tasks_ingest_route());
    let results_path = relative(contract::tasks_results_route());
    let run_path = relative(contract::tasks_run_route());

    axum::Router::new()
        .route(&ingest_path, axum::routing::post(ingest))
        .route(&results_path, axum::routing::get(list_results))
        .route(
            &format!("{results_path}/{{task_id}}"),
            axum::routing::get(get_result),
        )
        .route(&run_path, axum::routing::get(get_run))
        .with_state(store)
}

/// 契约绝对路径 → 去前缀相对路径（Router 挂在 /api/tasks 下）。
fn relative(route: &str) -> String {
    let prefix = contract::tasks_route_prefix();
    route
        .strip_prefix(prefix)
        .unwrap_or_else(|| panic!("tasks route {route} must start with prefix {prefix}"))
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_envelope() -> Value {
        serde_json::json!({
            "type": "task",
            "taskId": "traffic_light",
            "location": "traffic_light_zone",
            "capturedAt": 1756370000000i64,
            "result": { "task": "traffic_light", "state": "green", "announcement": "前方交通灯为绿色，可以通行。" },
            "boxes": []
        })
    }

    #[test]
    fn accepts_valid_envelopes() {
        assert!(validate_task_envelope(&valid_envelope()).is_ok());
    }

    #[test]
    fn rejects_non_objects_wrong_types_and_unknown_task_ids() {
        assert!(validate_task_envelope(&serde_json::json!(null)).is_err());
        assert!(validate_task_envelope(&serde_json::json!([1])).is_err());
        let mut wrong_type = valid_envelope();
        wrong_type["type"] = json!("risk");
        assert!(validate_task_envelope(&wrong_type).is_err());
        let mut unknown = valid_envelope();
        unknown["taskId"] = json!("unknown_task");
        assert!(validate_task_envelope(&unknown).is_err());
    }

    #[test]
    fn rejects_mismatched_result_task_and_missing_announcement() {
        let mut mismatch = valid_envelope();
        mismatch["result"] = json!({ "task": "people_count" });
        assert!(validate_task_envelope(&mismatch).is_err());
        let mut missing = valid_envelope();
        missing["result"] = json!({ "task": "traffic_light" });
        assert!(validate_task_envelope(&missing).is_err());
        let mut bad_boxes = valid_envelope();
        bad_boxes["boxes"] = json!("nope");
        assert!(validate_task_envelope(&bad_boxes).is_err());
    }

    #[test]
    fn rejects_overlength_fields_and_oversized_envelopes() {
        let mut long_location = valid_envelope();
        long_location["location"] = json!("x".repeat(201));
        assert!(validate_task_envelope(&long_location).is_err());

        let mut long_announcement = valid_envelope();
        long_announcement["result"] = json!({
            "task": "traffic_light",
            "announcement": "x".repeat(4001)
        });
        assert!(validate_task_envelope(&long_announcement).is_err());

        let mut many_boxes = valid_envelope();
        many_boxes["boxes"] =
            serde_json::json!((0..101).map(|_| {
            json!({ "x": 0, "y": 0, "width": 1, "height": 1, "label": "a", "confidence": 1 })
        }).collect::<Vec<_>>());
        assert!(validate_task_envelope(&many_boxes).is_err());

        let mut padded = valid_envelope();
        padded["padding"] = json!("x".repeat(33 * 1024));
        assert!(validate_task_envelope(&padded).is_err());
    }

    #[test]
    fn validates_run_events() {
        assert!(validate_run_event(&json!({ "type": "run", "status": "running" })).is_ok());
        assert!(
            validate_run_event(&json!({ "type": "run", "status": "done", "detail": [] })).is_ok()
        );
        assert!(validate_run_event(&json!({ "type": "run", "status": "paused" })).is_err());
        assert!(validate_run_event(&json!({ "type": "task" })).is_err());
    }

    #[tokio::test]
    async fn stores_envelopes_newest_first_and_truncates() {
        let store = TaskStore::with_max_results(3);
        for i in 0..5i64 {
            let mut envelope = valid_envelope();
            envelope["capturedAt"] = json!(i);
            store.store_task(envelope).await;
        }
        let all = store.results_since(None).await;
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].envelope["capturedAt"], json!(4));
    }

    #[tokio::test]
    async fn run_events_roundtrip() {
        let store = TaskStore::new();
        let event = json!({ "type": "run", "status": "running", "startedAt": 1 });
        store.store_run(event).await;
        let run = store.run().await.unwrap();
        assert_eq!(run["status"], json!("running"));
        assert!(run.get("receivedAt").is_some());
    }
}
