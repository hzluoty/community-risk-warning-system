//! crws-app：Tauri 壳（对齐 electron/main.ts 职责）。
//! - 启动时：生成会话密钥（VLM_API_KEY 覆盖）与本地代理令牌 → 装配代理
//! - 随机端口绑定本地代理（run_proxy_with_trust），信任句柄由 VLM supervisor 拥有
//! - spawn llama-server（资源目录由壳唯一解析并注入 supervisor），就绪后信任态置真
//! - invoke 命令：get_api_base / get_api_auth_headers / get_ollama_status
//! 鉴权头名/路由等 wire 契约一律取自 crws_core::contract（shared/contract.json），
//! 壳内禁止字符串字面量。安全语义对齐：令牌仅保护本地 127.0.0.1 代理。

use std::path::PathBuf;
use std::sync::Arc;

use rand::{Rng, RngCore};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crws_core::contract::local_proxy_token_header;
use crws_core::{load_vlm_runtime_config, EnvMap, VlmRuntimeConfig};
use crws_proxy::config::load_proxy_config;
use crws_proxy::run_proxy_with_trust;
use crws_vlm::{Supervisor, VlmStatusHandle};

/// 壳运行时状态：api_base + 令牌 + supervisor（代理服务 spawn 成后台任务）。
pub struct ShellState {
    pub api_base: String,
    pub local_proxy_token: String,
    pub supervisor: Arc<Mutex<Supervisor>>,
    /// 无锁状态快照：get_ollama_status 在启动窗口（start 持锁最长 60s）也不阻塞。
    pub vlm_status: VlmStatusHandle,
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 会话密钥与令牌生成（对齐 electron/main.ts 的 crypto.randomBytes(32)）。
pub fn generate_session_secrets() -> (String, String) {
    let vlm_api_key = random_hex(32);
    let local_proxy_token = random_hex(32);
    (vlm_api_key, local_proxy_token)
}

/// 会话级 VLM 端口（对齐 electron/main.ts 的 crypto.randomInt(20_000, 60_000)）：
/// llama-server 监听端口与代理上游端口共用同一值（单次生成、两处消费）。
pub fn generate_session_vlm_port() -> u16 {
    rand::rng().random_range(20_000..60_000)
}

/// 从 .env + 会话覆盖装配代理配置（对齐 electron/main.ts 的 proxyConfig 构造）：
/// - 代理绑定 OS 随机端口（listen(0) 语义；忽略 SERVER_PORT，会话间不冲突）
/// - VLM 上游端口 = 会话随机端口（vlm.port 已在调用前覆写，代理与 supervisor 同源）
/// - 允许本地 file origin（dev 态）+ 注入随机令牌与会话密钥
/// - 追加壳自身 renderer origin 的 CORS 白名单（代理只提供数据，不猜 origin）
pub fn build_proxy_config(
    vlm: &VlmRuntimeConfig,
    env: &EnvMap,
    vlm_api_key: &str,
    local_proxy_token: &str,
) -> crws_proxy::config::ProxyConfig {
    let lookup = |k: &str| env.get(k).cloned();
    let mut config = load_proxy_config(&lookup, vlm, Some(vlm_api_key.to_string()));
    config.host = "127.0.0.1".to_string();
    config.port = 0; // OS 随机端口（run_proxy 绑定后回读实际端口）
    config.allow_local_file_origins = true;
    config.local_proxy_token = local_proxy_token.to_string();
    // 壳是自身 renderer origin 的唯一知情人：注入 Tauri origin（Windows =
    // http://tauri.localhost；macOS/Linux = tauri://localhost）+ dev 态 Vite origin。
    // 代理侧只提供数据（is_allowed_cors_origin），不猜 origin。
    for origin in [
        "tauri://localhost",
        "http://tauri.localhost",
        "http://localhost:5173",
    ] {
        if !config.cors_origin.iter().any(|o| o == origin) {
            config.cors_origin.push(origin.to_string());
        }
    }
    config
}

#[tauri::command]
fn get_api_base(state: State<'_, ShellState>) -> String {
    state.api_base.clone()
}

#[tauri::command]
fn get_api_auth_headers(state: State<'_, ShellState>) -> Value {
    json!({ local_proxy_token_header(): state.local_proxy_token })
}

#[tauri::command]
async fn get_ollama_status(state: State<'_, ShellState>) -> Result<Value, String> {
    // 无锁快照（A）：完全不碰 Mutex —— start() 持锁最长 startup_timeout 也不阻塞。
    // 周期驱动由壳后台 tick 循环独占（B：单一调度者，状态命令不旁路触发）。
    let ready = state.vlm_status.is_ready();
    let base_url = state.vlm_status.base_url();
    Ok(json!({
        "ready": ready,
        "status": if ready { "ready" } else { "starting" },
        "baseUrl": base_url,
        "gpu": "unknown"
    }))
}

/// 壳初始化：起代理 + 起 supervisor（llama-server）+ 注册命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle: AppHandle = app.handle().clone();

            // .env（可选）：优先 exe 同级（打包布局），其次 CWD
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    let _ = dotenvy::from_path(dir.join(".env"));
                }
            }
            let _ = dotenvy::dotenv();

            let env: EnvMap = std::env::vars().collect();
            let (vlm_api_key, local_proxy_token) = generate_session_secrets();

            // VLM 运行配置解析一次：代理与 supervisor 共用（同一 host/port/model）。
            // 会话级随机端口覆写 VLM_PORT（对齐 electron/main.ts 的 managedVlmPort）。
            let mut vlm = load_vlm_runtime_config(&|k| env.get(k).cloned(), crws_core::contract::default_vlm_model_alias());
            vlm.port = generate_session_vlm_port();
            let config = build_proxy_config(&vlm, &env, &vlm_api_key, &local_proxy_token);

            // supervisor：持有信任句柄（写权），路由只读 —— fail-closed 由其驱动。
            // 资源目录由壳唯一解析（dev=仓库根探测 / 打包=resource_dir），注入 supervisor。
            let resource_dir = resolve_vlm_resource_dir(&handle);
            // 唯一 trust 创建点：supervisor 与代理共享同一实例（F1 —— 两个 new() 会让
            // 代理侧永远 false，本地 VLM 通道恒 503）
            let (supervisor_instance, vlm_status) = Supervisor::new(
                vlm,
                resource_dir,
                env,
                vlm_api_key,
            );
            let supervisor = Arc::new(Mutex::new(supervisor_instance));

            let server = tauri::async_runtime::block_on(async {
                // 只读句柄注入路由（写权留在 supervisor 内部 —— C 条读写分离）
                run_proxy_with_trust(config, vlm_status.reader_handle()).await
            })
            .expect("[shell] Failed to start local proxy");

            let api_base = format!("http://127.0.0.1:{}", server.addr.port());
            println!("[shell] Qwen proxy server is running at {api_base}");

            handle.manage(ShellState {
                api_base,
                local_proxy_token,
                supervisor: supervisor.clone(),
                vlm_status,
            });

            // 代理服务与 VLM supervisor 在后台运行（不阻塞 setup）
            tauri::async_runtime::spawn(async move {
                let _ = server.run().await;
            });
            // supervisor 后台循环：首次 start + 周期巡检（5s，对齐 Electron
            // RESOURCE_POLL_INTERVAL_MS）—— 资源后补齐时自动恢复（F3）。
            tauri::async_runtime::spawn(async move {
                if let Err(message) = supervisor.lock().await.start().await {
                    eprintln!("[vlm] {message}");
                }
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        crws_vlm::resource_poll_interval_ms(),
                    ))
                    .await;
                    supervisor.lock().await.tick().await;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_api_base,
            get_api_auth_headers,
            get_ollama_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// VLM 资源目录（llama-server.exe / gguf / CUDA DLL）的唯一解析点，返回 vlm 目录本身。
/// 打包态：Tauri resource_dir()/vlm（scripts/tauri-build.mjs 注入 bundle.resources 映射：
/// ../resources/vlm/* → vlm/，文件平铺到 vlm/ 下，与 Electron extraResources 同层语义）。
fn resolve_vlm_resource_dir(app: &AppHandle) -> PathBuf {
    // 打包态优先：resource_dir 由 Tauri 管理（extraResources 落点）
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir.join("vlm");
        if packaged.join("llama-server.exe").is_file() {
            return packaged;
        }
    }

    // 开发态：<repo>/src-tauri/target/debug/crws-app.exe → 4 次 pop = 仓库根
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.clone();
        for _ in 0..4 {
            dir.pop();
        }
        let dev_candidate = dir.join("resources").join("vlm");
        if dev_candidate.is_dir() {
            return dev_candidate;
        }
        // 兜底：从 CWD 逐级向上找 resources/vlm
        let mut cwd = std::env::current_dir().unwrap_or_default();
        loop {
            let candidate = cwd.join("resources").join("vlm");
            if candidate.is_dir() {
                return candidate;
            }
            if !cwd.pop() {
                break;
            }
        }
    }

    PathBuf::from("resources").join("vlm")
}
