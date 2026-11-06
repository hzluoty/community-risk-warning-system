//! 固定窗口限流（60s，按客户端 IP 计数）。
//! 对齐 express-rate-limit(windowMs=60_000, standardHeaders:true, legacyHeaders:false,
//! skip=...) 的可观察语义：合法令牌跳过鉴权桶（不计数也不拦截）。

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::response::Response;

use crate::config::ProxyConfig;
use crate::responses::error_response;

const WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct Bucket {
    window_start: Instant,
    count: u32,
}

pub struct FixedWindowLimiter {
    limit: u32,
    buckets: Mutex<HashMap<IpAddr, Bucket>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckOutcome {
    Allowed { remaining: u32 },
    Limited { limit: u32 },
}

impl FixedWindowLimiter {
    pub fn new(limit: u32) -> Self {
        Self {
            limit,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// 计数并判定：超过 limit 返回 Limited（该次请求本身也被计数）。
    pub fn check(&self, ip: IpAddr) -> CheckOutcome {
        if self.limit == 0 {
            return CheckOutcome::Allowed {
                remaining: u32::MAX,
            };
        }
        let mut buckets = self.lock();
        let bucket = buckets.entry(ip).or_insert(Bucket {
            window_start: Instant::now(),
            count: 0,
        });
        if bucket.window_start.elapsed() >= WINDOW {
            bucket.window_start = Instant::now();
            bucket.count = 0;
        }
        bucket.count += 1;
        if bucket.count > self.limit {
            CheckOutcome::Limited { limit: self.limit }
        } else {
            CheckOutcome::Allowed {
                remaining: self.limit - bucket.count,
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<IpAddr, Bucket>> {
        self.buckets.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct Limiters {
    pub chat: FixedWindowLimiter,
    pub auth: FixedWindowLimiter,
    pub status: FixedWindowLimiter,
    pub tasks: FixedWindowLimiter,
}

impl Limiters {
    pub fn from_config(config: &ProxyConfig) -> Self {
        Self {
            chat: FixedWindowLimiter::new(config.limits.chat_requests_per_minute),
            auth: FixedWindowLimiter::new(config.limits.auth_attempts_per_minute),
            status: FixedWindowLimiter::new(config.limits.status_requests_per_minute),
            tasks: FixedWindowLimiter::new(config.limits.tasks_requests_per_minute),
        }
    }
}

fn rate_limited_response(limit: u32, message: &str, error_type: &str) -> Response {
    let mut response = error_response(429, message, error_type);
    let headers = response.headers_mut();
    if let Ok(v) = limit.to_string().parse() {
        headers.insert("ratelimit-limit", v);
    }
    if let Ok(v) = "0".parse() {
        headers.insert("ratelimit-remaining", v);
    }
    if let Ok(v) = "60".parse() {
        headers.insert("ratelimit-reset", v);
    }
    response
}

fn guard(
    limiter: &FixedWindowLimiter,
    enabled: bool,
    message: &str,
    error_type: &str,
    ip: IpAddr,
) -> Option<Response> {
    if !enabled {
        return None;
    }
    match limiter.check(ip) {
        CheckOutcome::Allowed { .. } => None,
        CheckOutcome::Limited { limit } => Some(rate_limited_response(limit, message, error_type)),
    }
}

/// chat 路由限流：在令牌守卫与 body 解析之后执行（已授权请求才会计入）。
pub fn chat_guard(limiters: &Limiters, config: &ProxyConfig, ip: IpAddr) -> Option<Response> {
    guard(
        &limiters.chat,
        config.limits.chat_requests_per_minute > 0,
        "请求过于频繁，请稍后再试",
        "rate_limit",
        ip,
    )
}

/// 状态路由限流。
pub fn status_guard(limiters: &Limiters, config: &ProxyConfig, ip: IpAddr) -> Option<Response> {
    guard(
        &limiters.status,
        config.limits.status_requests_per_minute > 0,
        "状态查询过于频繁，请稍后再试",
        "rate_limit",
        ip,
    )
}

/// 任务通道限流。
pub fn tasks_guard(limiters: &Limiters, config: &ProxyConfig, ip: IpAddr) -> Option<Response> {
    guard(
        &limiters.tasks,
        config.limits.tasks_requests_per_minute > 0,
        "任务通道请求过于频繁，请稍后再试",
        "rate_limit",
        ip,
    )
}

/// 鉴权尝试限流：合法令牌 skip（不计数不拦截）；非法令牌计数，超限 429。
/// 必须排在令牌守卫之前（对齐 Express 的 authLimiter → tokenGuard 顺序）。
pub fn auth_attempt_guard(
    limiters: &Limiters,
    config: &ProxyConfig,
    ip: IpAddr,
    attempt_skipped: bool,
) -> Option<Response> {
    if config.local_proxy_token.is_empty() || config.limits.auth_attempts_per_minute == 0 {
        return None;
    }
    if attempt_skipped {
        return None;
    }
    guard(
        &limiters.auth,
        true,
        "未授权请求过于频繁，请稍后再试",
        "auth_rate_limit",
        ip,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip() -> IpAddr {
        "127.0.0.1".parse().unwrap()
    }

    #[test]
    fn allows_up_to_limit_then_limits() {
        let limiter = FixedWindowLimiter::new(2);
        assert_eq!(limiter.check(ip()), CheckOutcome::Allowed { remaining: 1 });
        assert_eq!(limiter.check(ip()), CheckOutcome::Allowed { remaining: 0 });
        assert_eq!(limiter.check(ip()), CheckOutcome::Limited { limit: 2 });
    }

    #[test]
    fn counts_per_ip_independently() {
        let limiter = FixedWindowLimiter::new(1);
        let other: IpAddr = "127.0.0.2".parse().unwrap();
        assert_eq!(limiter.check(ip()), CheckOutcome::Allowed { remaining: 0 });
        assert_eq!(limiter.check(other), CheckOutcome::Allowed { remaining: 0 });
        assert_eq!(limiter.check(ip()), CheckOutcome::Limited { limit: 1 });
    }

    #[test]
    fn zero_limit_is_disabled() {
        let limiter = FixedWindowLimiter::new(0);
        for _ in 0..100 {
            assert_eq!(
                limiter.check(ip()),
                CheckOutcome::Allowed {
                    remaining: u32::MAX
                }
            );
        }
    }
}
