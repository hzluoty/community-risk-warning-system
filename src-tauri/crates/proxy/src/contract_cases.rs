//! 行为契约 runner：消费 shared/proxyCases.json（JS 与 Rust 代理共享的 golden 用例），
//! 经 tower::ServiceExt::oneshot 打 build_router 装配的完整 Router。
//! 任何一侧行为漂移都会在本侧或对侧变红 —— cargo test 能取代 JS 代理测试的前提。

use std::net::SocketAddr;
use std::sync::OnceLock;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;

use crate::app::{build_router, AppState};
use crate::config::config_from_env;
use crate::contract;
use crate::tasks::TaskStore;
use crws_core::EnvMap;
use crws_core::VlmTrust;

const PROXY_CASES_JSON: &str = include_str!("../../../../shared/proxyCases.json");

fn cases() -> &'static Value {
    static CASES: OnceLock<Value> = OnceLock::new();
    CASES.get_or_init(|| {
        serde_json::from_str(PROXY_CASES_JSON).expect("shared/proxyCases.json must be valid JSON")
    })
}

/// proxyCases 的 env 对象 → EnvMap（config_from_env 的现成扩展点）。
fn env_map_from_json(env: &Value) -> EnvMap {
    env.as_object()
        .expect("case env must be an object")
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

fn build_state(env: &Value) -> AppState {
    let map = env_map_from_json(env);
    let config = config_from_env(&map);
    AppState::with_task_store_and_trust(config, TaskStore::new(), {
        let (_writer, reader) = VlmTrust::creator();
        reader
    })
}

/// 用例占位符展开：单一表（contract::route_placeholders，事实源
/// shared/apiRoutes.js 的 ROUTE_PLACEHOLDERS）循环替换 —— 不再维护 replace 链。
fn resolve_path(path: &str) -> String {
    let mut resolved = path.to_string();
    for (placeholder, value) in contract::route_placeholders() {
        if !value.is_empty() {
            resolved = resolved.replace(placeholder, value);
        }
    }
    resolved
}

fn resolve_headers(headers: Option<&Value>, state: &AppState) -> Vec<(String, String)> {
    headers
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .map(|(k, v)| {
                    // 头名占位符走同一张表；值里的 {{TOKEN}} 换会话令牌
                    let mut key = k.clone();
                    for (placeholder, value) in contract::route_placeholders() {
                        if !value.is_empty() {
                            key = key.replace(placeholder, value);
                        }
                    }
                    let value = v
                        .as_str()
                        .unwrap_or_default()
                        .replace("{{TOKEN}}", &state.config.local_proxy_token);
                    (key, value)
                })
                .collect()
        })
        .unwrap_or_default()
}

struct StepResult {
    status: u16,
    headers: Vec<(String, String)>,
    body: Value,
}

async fn run_step(state: &AppState, step: &Value) -> StepResult {
    let method = step["method"].as_str().expect("method");
    let path = resolve_path(step["path"].as_str().expect("path"));

    let mut builder = Request::builder().method(method).uri(&path);
    for (key, value) in resolve_headers(step.get("headers"), state) {
        builder = builder.header(key, value);
    }

    let has_body = step.get("rawBody").is_some() || step.get("body").is_some();
    let body: Body = if let Some(raw) = step.get("rawBody").and_then(Value::as_str) {
        builder = builder.header("content-type", "application/json");
        Body::from(raw.to_string())
    } else if let Some(body) = step.get("body") {
        builder = builder.header("content-type", "application/json");
        Body::from(serde_json::to_string(body).expect("serialize body"))
    } else {
        Body::empty()
    };
    let _ = has_body;

    let request = builder.body(body).expect("build request");
    let mut router = build_router(state.clone());
    // oneshot 模式无真实 socket：注入 ConnectInfo（127.0.0.1）供限流取 IP
    let request = request;
    let mut request = request;
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo::<SocketAddr>(
            "127.0.0.1:0".parse().expect("socket addr"),
        ));

    let response = router.oneshot(request).await.expect("router call");

    let status = response.status().as_u16();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                v.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read body");
    let body: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };

    StepResult {
        status,
        headers,
        body,
    }
}

fn strip_ignored(body: &Value, keys: &[&str]) -> Value {
    let mut cloned = body.clone();
    fn walk(value: &mut Value, keys: &[&str]) {
        if let Some(obj) = value.as_object_mut() {
            for key in keys {
                obj.remove(*key);
            }
            for child in obj.values_mut() {
                walk(child, keys);
            }
        }
    }
    walk(&mut cloned, keys);
    cloned
}

/// subset 匹配：expected 的每个字段必须存在且相等（不要求完全一致）。
fn assert_subset(actual: &Value, expected: &Value, path: &str) {
    if let Some(expected_obj) = expected.as_object() {
        let actual_obj = actual
            .as_object()
            .unwrap_or_else(|| panic!("subset mismatch at {path}: expected object, got {actual}"));
        for (key, expected_value) in expected_obj {
            let actual_value = actual_obj
                .get(key)
                .unwrap_or_else(|| panic!("subset mismatch at {path}.{key}: key missing"));
            if expected_value.is_object() {
                assert_subset(actual_value, expected_value, &format!("{path}.{key}"));
            } else {
                assert_eq!(
                    actual_value, expected_value,
                    "subset mismatch at {path}.{key}"
                );
            }
        }
    }
}

#[tokio::test]
async fn proxy_behavior_contract_matches_shared_golden_cases() {
    let cases = cases();
    let total = cases["cases"].as_array().expect("cases array").len();

    for case in cases["cases"].as_array().expect("cases array") {
        let name = case["name"].as_str().expect("case name");
        let env = &cases["configs"][case["config"].as_str().expect("config")]["env"];
        let state = build_state(env);

        for step in case["steps"].as_array().expect("steps") {
            let result = run_step(&state, step).await;
            let step_desc = format!(
                "{name}: {} {}",
                step["method"].as_str().unwrap(),
                step["path"].as_str().unwrap()
            );

            let expected_status = step["expectedStatus"].as_u64().expect("expectedStatus");
            assert_eq!(
                result.status as u64, expected_status,
                "{step_desc}: status mismatch"
            );

            if let Some(expected_body) = step.get("expectedBody") {
                let ignore_keys: Vec<&str> = step
                    .get("ignoreBodyKeys")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let actual = strip_ignored(&result.body, &ignore_keys);

                if step
                    .get("matchBodySubset")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    assert_subset(&actual, expected_body, &step_desc);
                } else {
                    assert_eq!(actual, *expected_body, "{step_desc}: body mismatch");
                }
            }

            if let Some(expected_headers) = step.get("expectedHeaders").and_then(Value::as_object) {
                for (name, value) in expected_headers {
                    let lower = name.to_lowercase();
                    let header_value = result
                        .headers
                        .iter()
                        .find(|(k, _)| k.to_lowercase() == lower)
                        .map(|(_, v)| v.clone())
                        .unwrap_or_default();
                    let expected = value.as_str().unwrap_or_default().to_lowercase();
                    assert!(
                        header_value.to_lowercase().contains(&expected),
                        "{step_desc}: header {name} = {header_value:?}, expected to contain {expected:?}"
                    );
                }
            }
        }
    }

    // 全部用例被执行（防用例数意外归零）
    assert!(
        total >= 15,
        "expected at least 15 golden cases, found {total}"
    );
}

/// 未知路径 → 纯 404（不吞鉴权语义：不配置令牌时也 404 而非 403）。
#[tokio::test]
async fn unknown_paths_return_plain_404() {
    let state = build_state(&serde_json::json!({}));
    let router = build_router(state);

    let response = router
        .clone()
        .oneshot(Request::get("/api/unknown").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = router
        .oneshot(
            Request::get("/api/tasks/unknown-subpath")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// CORS expose-headers 契约（对齐 JS 用例 exposes-the-vlm-source-response-header）。
#[tokio::test]
async fn cors_exposes_vlm_source_header() {
    let state = build_state(&serde_json::json!({}));
    let mut router = build_router(state);

    let response = router
        .oneshot(
            Request::get(contract::health_route())
                .header("origin", "http://localhost:5173")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let expose = response
        .headers()
        .get("access-control-expose-headers")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_lowercase();
    assert!(expose.contains("x-vlm-source"), "expose headers: {expose}");
}
