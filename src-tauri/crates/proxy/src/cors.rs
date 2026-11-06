//! CORS 策略（唯一所有者）：allow-list 判定复用 config::is_allowed_cors_origin
//! （与 JS isAllowedCorsOrigin 同语义），config 只提供数据。

use axum::http::{header, HeaderValue, Method};

use crate::auth;
use crate::config::{is_allowed_cors_origin, ProxyConfig};
use tower_http::cors::{AllowOrigin, CorsLayer};

pub fn cors_layer(config: &ProxyConfig) -> CorsLayer {
    CorsLayer::new()
        .expose_headers([header::HeaderName::from_static("x-vlm-source")])
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            header::HeaderName::from_static(auth::local_proxy_token_header()),
        ])
        .allow_origin(allow_origin_matcher(config))
}

/// 运行期 Origin 判定：allow-list / null / file:// 全部经 is_allowed_cors_origin
/// 单一语义函数裁决（不在此自建第二份 allow-list）。
fn allow_origin_matcher(config: &ProxyConfig) -> AllowOrigin {
    let cors_origin = config.cors_origin.clone();
    let allow_local = config.allow_local_file_origins;
    AllowOrigin::predicate(move |origin: &HeaderValue, _parts| {
        let origin_str = origin.to_str().unwrap_or_default();
        is_allowed_cors_origin(Some(origin_str), &cors_origin, allow_local)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::config_from_env;
    use crws_core::EnvMap;

    #[test]
    fn cors_layer_builds_from_config() {
        let config = config_from_env(&EnvMap::new());
        let _ = cors_layer(&config);
    }
}
