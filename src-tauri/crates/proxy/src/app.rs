//! 代理装配（唯一装配点）：AppState + build_router + run_proxy。
//! 路由处理器在 routes/，CORS 在 cors.rs，任务路由表在 tasks::router。
//! 中间件顺序承载安全语义（对齐 Express 注册顺序）：
//!   chat: authLimiter → tokenGuard → body 解析 → chat 限流 → 载荷校验 → handler
//!   tasks: 前缀级 authLimiter(protectAll) → tokenGuard(protectAll) → tasksLimiter → tasks::router
//! 令牌守卫先于 body 解析（403 早于 400/413 —— proxyCases 已锁定该顺序）。

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;

use crate::config::ProxyConfig;
use crate::cors::cors_layer;
use crate::routes;
use crate::tasks::TaskStore;
use crate::upstream::{LocalVlmClient, QwenClient};
use crws_core::VlmTrustReader;

/// 共享应用状态：配置 + 限流器 + 上游客户端 + 任务存储 + VLM 信任句柄。
/// 信任态由 supervisor 独占（crws-vlm crate 持 VlmTrustWriter 写权），
/// 路由只读 `VlmTrustReader` —— 无写 API，fail-closed 闸门无法被 crate 外置真。
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<ProxyConfig>,
    pub limiters: Arc<crate::ratelimit::Limiters>,
    pub qwen: Option<Arc<QwenClient>>,
    pub local_vlm: Arc<LocalVlmClient>,
    pub tasks: TaskStore,
    /// 本地 VLM 是否可信（supervisor 注入只读句柄；fail-closed）
    pub local_vlm_trusted: VlmTrustReader,
}

impl AppState {
    /// 唯一构造入口：supervisor 的信任句柄由外部传入（代理单独跑 = 永不信任本地 VLM，
    /// 由 supervisor 进程置真；Tauri/Electron 壳持有 supervisor 时注入同一句柄）。
    pub fn with_task_store_and_trust(
        config: ProxyConfig,
        tasks: TaskStore,
        trust: VlmTrustReader,
    ) -> Self {
        let qwen = if config.qwen_endpoint.is_some() {
            Some(Arc::new(QwenClient::new(
                &config.qwen_chat_completions_url(),
                &config.qwen_api_key,
                config.qwen_timeout,
                config.payload_limits.max_upstream_response_bytes,
            )))
        } else {
            None
        };
        let local_vlm = Arc::new(LocalVlmClient::new(
            &config.ollama_base_url(),
            &config.ollama_api_key,
            config.ollama_timeout,
            config.payload_limits.max_upstream_response_bytes,
        ));
        Self {
            limiters: Arc::new(crate::ratelimit::Limiters::from_config(&config)),
            config: Arc::new(config),
            qwen,
            local_vlm,
            tasks,
            local_vlm_trusted: trust,
        }
    }

    pub fn is_qwen_configured(&self) -> bool {
        self.config.qwen_endpoint.is_some() && !self.config.qwen_api_key.is_empty()
    }

    pub fn is_cloud_fallback_available(&self) -> bool {
        self.config.allow_cloud_fallback && self.is_qwen_configured()
    }

    pub fn is_local_vlm_trusted(&self) -> bool {
        self.local_vlm_trusted.is_trusted()
    }
}

/// 绑定代理并返回服务句柄（端口 0 由 OS 分配）。
/// `run_proxy` 是库层唯一服务入口：独立进程与 Tauri 壳都只调用它。
/// 独立进程模式：本地 VLM 恒不可信（fail-closed —— 只读句柄恒 false，
/// 独立代理无从得知外部 llama-server 是否为本会话管理的可信进程）。
pub async fn run_proxy(config: ProxyConfig) -> Result<ProxyServer, String> {
    run_proxy_with_trust(config, fail_closed_reader()).await
}

/// 带信任句柄绑定（壳把 supervisor 的只读句柄注入路由）。
pub async fn run_proxy_with_trust(
    config: ProxyConfig,
    trust: VlmTrustReader,
) -> Result<ProxyServer, String> {
    crate::config::assert_proxy_security_config(&config)?;

    let state = AppState::with_task_store_and_trust(config, TaskStore::new(), trust);
    let addr: SocketAddr = format!("{}:{}", state.config.host, state.config.port)
        .parse()
        .map_err(|e| format!("invalid bind address: {e}"))?;

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("failed to bind {addr}: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?;

    Ok(ProxyServer {
        addr: bound,
        listener,
        router: build_router(state),
    })
}

/// 代理服务句柄：绑定地址 + 监听器 + 已装配的 Router。
/// `run()` 阻塞服务直到 ctrl_c / SIGTERM（graceful）。
pub struct ProxyServer {
    pub addr: SocketAddr,
    listener: tokio::net::TcpListener,
    router: Router,
}

impl ProxyServer {
    pub async fn run(self) -> std::io::Result<()> {
        axum::serve(
            self.listener,
            self.router
                .into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown_signal())
        .await
    }
}

/// 恒 false 的只读信任句柄（独立代理模式）：fail-closed 的类型级表达。
fn fail_closed_reader() -> VlmTrustReader {
    // creator 丢弃 writer → reader 永远 false
    let (_writer, reader) = crws_core::VlmTrust::creator();
    reader
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

/// 装配 Router（唯一装配点）。中间件顺序见模块注释。
/// tasks：nest(契约前缀, tasks::router) —— 前缀由 nest 剥离，相对路径注册成立；
/// 守卫（鉴权限流 → 令牌 → tasks 限流）在嵌套路由内经 from_fn_with_state 挂载。
pub fn build_router(state: AppState) -> Router {
    let tasks_nested = crate::routes::tasks::nested_router(state.clone());

    Router::new()
        .route(
            contract::qwen_chat_completions_route(),
            post(routes::qwen_chat),
        )
        .route(
            contract::ollama_chat_completions_route(),
            post(routes::ollama_chat),
        )
        .route(contract::health_route(), get(routes::health))
        .route(contract::ollama_status_route(), get(routes::ollama_status))
        .nest(contract::tasks_route_prefix(), tasks_nested)
        .fallback(|_: axum::extract::Request| async { crate::responses::not_found() })
        .layer(cors_layer(&state.config))
        .with_state(state)
}

use crate::contract;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_come_from_the_contract() {
        assert_eq!(
            contract::qwen_chat_completions_route(),
            "/api/qwen/chat/completions"
        );
        assert_eq!(
            contract::ollama_chat_completions_route(),
            "/api/ollama/chat/completions"
        );
        assert_eq!(contract::health_route(), "/api/health");
        assert_eq!(contract::ollama_status_route(), "/api/ollama/status");
        assert_eq!(contract::tasks_route_prefix(), "/api/tasks");
    }
}
