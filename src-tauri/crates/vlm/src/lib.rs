//! VLM supervisor：llama-server 进程生命周期 + 就绪状态的所有者。
//! 对齐 electron/ollamaManager.ts：spawn / 就绪探测 / 重启退避（3 次指数，
//! 之后转资源轮询 5s）/ 终止处理。信任态是 core 的 `VlmTrustReader/Writer`（读写分离）——
//! 路由只读，缺省 fail-closed；两个壳（Electron/Tauri）把句柄注入 AppState。

use std::path::{Path, PathBuf};

pub mod args;
pub mod resources;

use crate::args::{build_llama_server_args, build_llama_server_env, BuildLlamaServerArgs};
use crate::resources::{find_vlm_resources, missing_required_vlm_files};

use crws_core::contract;
use crws_core::{
    resolve_ollama_health_status, VlmRuntimeConfig, VlmTrust, VlmTrustReader, VlmTrustWriter,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};

/// 退避/轮询常量（契约驱动：shared/vlmRuntime.json 的 restartPolicy 段 ——
/// TS 侧 electron/ollamaManager.ts 读同一份；双端断言见
/// vlm::tests::restart_policy_matches_shared_contract 与 ollamaManager.test.ts）。
pub fn max_restart_attempts() -> u32 {
    crws_core::contract::vlm_runtime()["restartPolicy"]["maxRestartAttempts"]
        .as_u64()
        .expect("restartPolicy.maxRestartAttempts") as u32
}

pub fn restart_delay_ms() -> u64 {
    crws_core::contract::vlm_runtime()["restartPolicy"]["restartDelayMs"]
        .as_u64()
        .expect("restartPolicy.restartDelayMs")
}

pub fn resource_poll_interval_ms() -> u64 {
    crws_core::contract::vlm_runtime()["restartPolicy"]["resourcePollIntervalMs"]
        .as_u64()
        .expect("restartPolicy.resourcePollIntervalMs")
}
const HEALTH_CHECK_TIMEOUT_MS: u64 = 2_000;

/// 无锁状态快照句柄（A）：可克隆、零 Mutex —— is_ready/base_url 读它不碰 Supervisor。
/// ShellState 持有它，get_ollama_status 在启动窗口（start 持锁最长 60s）也不阻塞。
#[derive(Clone)]
pub struct VlmStatusHandle {
    trust: VlmTrustReader,
    stopping: Arc<AtomicBool>,
    endpoint: Arc<str>,
}

impl VlmStatusHandle {
    /// 代理路由用的只读信任句柄（与快照同一实例）。
    pub fn reader_handle(&self) -> VlmTrustReader {
        self.trust.clone()
    }

    pub fn is_ready(&self) -> bool {
        !self.stopping.load(Ordering::Relaxed) && self.trust.is_trusted()
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Relaxed)
    }

    pub fn base_url(&self) -> String {
        self.endpoint.to_string()
    }
}

/// 指数退避（对齐 calculateRestartDelayMs）：restartDelayMs * 2^(attempt-1)。
pub fn calculate_restart_delay_ms(attempt: u32) -> u64 {
    let normalized = attempt.max(1);
    restart_delay_ms() * (1u64 << (normalized - 1))
}

/// 最小健康探测（GET /health，2s 超时）—— 与 proxy 的 LocalVlmClient 解耦：
/// vlm crate 只需要"这个端口上的 llama-server 活着吗"。
async fn probe_health(
    host: &str,
    port: u16,
    api_key: &str,
    timeout: Duration,
) -> Result<u16, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(format!("http://{host}:{port}/health"));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    Ok(response.status().as_u16())
}

/// supervisor：持有进程 + 信任句柄 + 重启状态。
/// `resource_dir` 语义 = vlm 资源目录本身（含 llama-server.exe / gguf / DLL）。
pub struct Supervisor {
    endpoint: String,
    config: VlmRuntimeConfig,
    trust_writer: VlmTrustWriter,
    trust_reader: VlmTrustReader,
    stopping: Arc<AtomicBool>,
    generation: Arc<std::sync::atomic::AtomicU64>,
    resource_dir: PathBuf,
    env: std::collections::HashMap<String, String>,
    vlm_api_key: String,
    child: Option<Child>,
    restart_attempts: u32,
    /// 单一调度器（B）：下次允许动作的时刻（退避/资源轮询统一状态机）
    next_action_at: tokio::time::Instant,
}

impl Supervisor {
    pub fn new(
        config: VlmRuntimeConfig,
        resource_dir: PathBuf,
        env: std::collections::HashMap<String, String>,
        vlm_api_key: String,
    ) -> (Self, VlmStatusHandle) {
        let (trust_writer, trust_reader) = VlmTrust::creator();
        let endpoint = format!("http://{}:{}", config.host, config.port);
        let supervisor = Self {
            endpoint: endpoint.clone(),
            config,
            trust_writer,
            trust_reader: trust_reader.clone(),
            stopping: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            resource_dir,
            env,
            vlm_api_key,
            child: None,
            restart_attempts: 0,
            next_action_at: tokio::time::Instant::now(),
        };
        let handle = VlmStatusHandle {
            trust: trust_reader,
            stopping: supervisor.stopping.clone(),
            endpoint: endpoint.as_str().into(),
        };
        (supervisor, handle)
    }

    fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Relaxed)
    }

    async fn check_ready(&mut self) -> bool {
        match probe_health(
            &self.config.host,
            self.config.port,
            &self.vlm_api_key,
            Duration::from_millis(HEALTH_CHECK_TIMEOUT_MS),
        )
        .await
        {
            Ok(status) => {
                let (ready, _, _) = resolve_ollama_health_status(status);
                ready
            }
            Err(_) => false,
        }
    }

    /// 启动 llama-server 并等待就绪（对齐 startOllama）。
    /// 资源缺失 → 返回 false（调用方进入资源轮询），进程失败 → 内部重试退避。
    pub async fn start(&mut self) -> Result<(), String> {
        self.stopping.store(false, Ordering::Relaxed);
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;

        if self.child.is_some() {
            return Ok(());
        }

        let Some(resources) = find_vlm_resources(&self.resource_dir) else {
            self.trust_writer.set_trusted(false);
            self.next_action_at =
                tokio::time::Instant::now() + Duration::from_millis(resource_poll_interval_ms());
            return Err(format!(
                "llama-server.exe not found in {}",
                self.resource_dir.display()
            ));
        };

        let model_path = resources.model_dir.join(contract::vlm_model_file());
        let mmproj_path = if contract::vlm_has_mmproj() {
            Some(resources.model_dir.join(contract::vlm_mmproj_file()))
        } else {
            None
        };

        let missing = missing_required_vlm_files(&model_path, mmproj_path.as_deref());
        if !missing.is_empty() {
            self.trust_writer.set_trusted(false);
            self.next_action_at =
                tokio::time::Instant::now() + Duration::from_millis(resource_poll_interval_ms());
            return Err(format!(
                "Required VLM files missing: {}",
                missing
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }

        let effective_gpu_layers = if resources.cuda_available {
            self.config.gpu_layers
        } else {
            0
        };

        let args = build_llama_server_args(&BuildLlamaServerArgs {
            model_path: model_path.display().to_string(),
            mmproj_path: mmproj_path.map(|p| p.display().to_string()),
            vlm_config: self.config.clone(),
            effective_gpu_layers,
        });

        let mut command = Command::new(&resources.server_exe);
        command
            .args(&args)
            .current_dir(&resources.model_dir)
            .env_clear()
            .envs(build_llama_server_env(&self.env, Some(&self.vlm_api_key)))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        #[cfg(windows)]
        {
            // tokio Command 在 Windows 上内置 creation_flags（无 std trait 导入需求）
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let child = command.spawn().map_err(|e| format!("spawn failed: {e}"))?;
        self.child = Some(child);
        self.trust_writer.set_trusted(false);

        // 等待就绪（对齐 waitForReady：1s 轮询直到 startup timeout）
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(self.config.startup_timeout_ms);
        loop {
            if self.child.is_none() {
                return Err("VLM server process ended during startup".to_string());
            }
            if self.check_ready().await {
                // 世代守卫：stop() 后的旧轮询不得回写新世代状态（对齐 lifecycleGeneration）
                if self.generation.load(Ordering::Relaxed) != generation || self.is_stopping() {
                    return Err("VLM lifecycle superseded during startup".to_string());
                }
                self.trust_writer.set_trusted(true);
                self.restart_attempts = 0;
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                self.kill_child().await;
                self.next_action_at =
                    tokio::time::Instant::now() + Duration::from_millis(restart_delay_ms());
                return Err("VLM server did not become ready within timeout".to_string());
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    /// 重启退避（对齐 scheduleProcessRestart：3 次指数退避 → 转 5s 资源轮询）。
    /// 节奏由 next_action_at 表达（tick 按 5s 驱动，start 不再挂锁 60s）。
    pub async fn restart_with_backoff(&mut self) -> Result<(), String> {
        if self.restart_attempts >= max_restart_attempts() {
            self.restart_attempts = 0;
            self.next_action_at =
                tokio::time::Instant::now() + Duration::from_millis(resource_poll_interval_ms());
            return Err("restart limit reached; polling for resources".to_string());
        }
        self.restart_attempts += 1;
        let delay = calculate_restart_delay_ms(self.restart_attempts);
        self.next_action_at = tokio::time::Instant::now() + Duration::from_millis(delay);
        self.kill_child().await;
        self.start().await
    }

    async fn kill_child(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
        }
        self.trust_writer.set_trusted(false);
    }

    /// 停止并清理（对齐 stopOllama）。
    pub async fn stop(&mut self) {
        self.stopping.store(true, Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.kill_child().await;
    }

    /// 单一调度器（B）：唯一的周期驱动入口 —— 退避与资源轮询在此状态机统一，
    /// 壳侧 5s 循环只调它；get_ollama_status 不再旁路触发（两个驱动者 → 一个）。
    /// - 进程存活 → 只探测；进程死亡 → 清信任态并退避重启
    /// - child 缺席（启动失败/资源缺失）→ 同走退避；3 次后转 5s 资源轮询
    pub async fn tick(&mut self) {
        if self.is_stopping() {
            return;
        }
        if tokio::time::Instant::now() < self.next_action_at {
            return;
        }

        match self.child.as_mut() {
            Some(child) => {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    self.child = None;
                    self.trust_writer.set_trusted(false);
                    if let Err(message) = self.restart_with_backoff().await {
                        eprintln!("[vlm] {message}");
                    }
                }
            }
            None => {
                if let Err(message) = self.restart_with_backoff().await {
                    eprintln!("[vlm] {message}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 健康映射（core 唯一实现）：503 必须是 loading 而非 error（回归哨兵）。
    #[test]
    fn health_status_maps_503_to_loading_via_core() {
        assert_eq!(
            crws_core::resolve_ollama_health_status(503),
            (false, "loading", "unknown")
        );
    }

    #[test]
    fn restart_delay_backoff_is_exponential() {
        assert_eq!(calculate_restart_delay_ms(1), restart_delay_ms());
        assert_eq!(calculate_restart_delay_ms(2), restart_delay_ms() * 2);
        assert_eq!(calculate_restart_delay_ms(3), restart_delay_ms() * 4);
        assert_eq!(calculate_restart_delay_ms(0), restart_delay_ms());
    }

    #[test]
    fn trust_creator_defaults_to_fail_closed_and_couples_rw() {
        let (writer, reader) = VlmTrust::creator();
        // 缺省 fail-closed
        assert!(!reader.is_trusted());
        // 写权写 → 读侧立即可见（同一 AtomicBool）
        writer.set_trusted(true);
        assert!(reader.is_trusted());
        // 读侧无 set_trusted 方法（编译期保证）——本测试即读写耦合的运行期断言
    }

    /// F1 锁死：supervisor 写入与无锁快照是同一实例 ——
    /// 两个独立 creator()（壳一份、supervisor 一份）会让路由侧永远 false。
    #[tokio::test]
    async fn supervisor_readiness_is_visible_through_the_status_handle() {
        let (mut supervisor, status) = Supervisor::new(
            default_vlm_config(),
            std::env::temp_dir().join("definitely-missing-vlm"),
            std::collections::HashMap::new(),
            String::new(),
        );
        assert!(!status.is_ready());

        // 资源缺失启动失败：信任态保持 false（fail-closed）
        let _ = supervisor.start().await;
        assert!(!status.is_ready());
        assert!(status.base_url().starts_with("http://"));
    }

    #[test]
    fn supervisor_base_url_carries_the_session_port() {
        let (_supervisor, status) = Supervisor::new(
            default_vlm_config(),
            std::env::temp_dir(),
            std::collections::HashMap::new(),
            String::new(),
        );
        assert_eq!(status.base_url(), "http://127.0.0.1:12345");
    }

    /// 资源缺失错误文案包含实际目录（E：不再硬编码 resourceslm）。
    #[tokio::test]
    async fn resource_missing_error_mentions_the_actual_directory() {
        let (_supervisor, _status) = Supervisor::new(
            default_vlm_config(),
            std::path::PathBuf::from("C:/definitely/missing/vlm"),
            std::collections::HashMap::new(),
            String::new(),
        );
        // start() 会因 llama-server.exe 缺失失败 —— 文案含实际目录
        // （通过 tick 驱动以验证 next_action_at 已设：第二次 tick 在退避窗口内不应再启动）
        // 此处只验证错误路径：直接调 start
        let mut supervisor = _supervisor;
        let result = supervisor.start().await;
        let message = result.unwrap_err();
        assert!(
            message.contains("llama-server.exe not found"),
            "message: {message}"
        );
        assert!(
            message.contains("definitely"),
            "message must contain actual dir: {message}"
        );
    }

    fn default_vlm_config() -> VlmRuntimeConfig {
        VlmRuntimeConfig {
            host: "127.0.0.1".to_string(),
            port: 12345,
            model_alias: "alias".to_string(),
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
}
