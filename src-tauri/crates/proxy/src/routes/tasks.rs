//! tasks 前缀路由：鉴权/限流经 `middleware::from_fn` 挂在嵌套路由上
//! （先于 body 解析，对齐 Express 中间件链），分派交给 tasks::router（唯一路由表）。

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;

use crate::app::AppState;
use crate::auth::{auth_attempt_skipped_all, extract_token, guard_all};
use crate::ratelimit;
use crate::routes::client_ip;

/// 挂在 /api/tasks 嵌套路由上的守卫中间件：
/// 鉴权限流(protectAll) → 令牌守卫(protectAll) → tasks 限流 → next（路由表）。
/// 顺序语义（鉴权先于 body 解析）只在此写一遍 —— 唯一所有者。
pub async fn tasks_guard_middleware(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let ip = client_ip(&request);
    let token = extract_token(request.headers()).map(str::to_string);

    // 1) 鉴权尝试限流（合法令牌 skip —— 不计数不拦截）
    if let Some(response) = ratelimit::auth_attempt_guard(
        &state.limiters,
        &state.config,
        ip,
        auth_attempt_skipped_all(&state.config, token.as_deref()),
    ) {
        return response;
    }

    // 2) 令牌守卫（protectAll：整段受保护，只看令牌）—— 必须先于 body 解析
    if let Some(response) = guard_all(&state.config, token.as_deref()) {
        return response;
    }

    // 3) tasks 限流
    if let Some(response) = ratelimit::tasks_guard(&state.limiters, &state.config, ip) {
        return response;
    }

    next.run(request).await
}

/// 嵌套路由（挂在契约前缀下）：子路由 + 守卫 layer。
/// 守卫经 from_fn_with_state 挂载，顺序语义（鉴权先于 body 解析）只在此写一遍。
pub fn nested_router(state: AppState) -> axum::Router<AppState> {
    crate::tasks::router(state.tasks.clone())
        // with_state 把 TaskStore 状态的 Router<()> 转为携带 AppState 的 Router<AppState>
        .with_state(())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            tasks_guard_middleware,
        ))
}
