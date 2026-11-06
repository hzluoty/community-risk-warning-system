//! crws-proxy：本地代理库（axum）。
//! 契约 → crws-core::contract（本 crate 私有引用，不对外转出）；夹具 → fixtures.rs；配置 → config.rs；
//! 上游传输 → upstream/；载荷校验 → payload.rs；任务通道 → tasks.rs；
//! 路由级策略 → policy.rs；CORS → cors.rs；VLM 进程管理 → crws-vlm crate（独立，零 axum）；
//! 路由处理器 → routes/；装配 → app.rs（唯一装配点）。

pub mod app;
pub mod auth;
pub mod config;
#[cfg(test)]
pub mod contract_cases;
pub mod cors;
pub mod endpoints;
pub mod fixtures;
pub mod payload;
pub mod policy;
pub mod ratelimit;
pub mod responses;
pub mod routes;
pub mod tasks;
pub mod upstream;

pub use app::{build_router, run_proxy, run_proxy_with_trust, AppState, ProxyServer};
// 契约层住在 crws-core —— proxy 私有引用（对外唯一路径是 crws_core::contract）
use crws_core::contract;
