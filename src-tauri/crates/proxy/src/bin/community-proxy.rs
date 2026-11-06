//! 独立代理进程（对齐 server/index.js）：加载 .env → 安全断言 → run_proxy → 优雅退出。

use crws_core::EnvMap;
use crws_proxy::config::{assert_proxy_security_config, config_from_env};
use crws_proxy::run_proxy;

fn find_repo_root() -> std::path::PathBuf {
    if let Ok(root) = std::env::var("CRWS_ROOT") {
        return std::path::PathBuf::from(root);
    }
    // 从 CWD 逐级向上找 .env（server/index.js 按 server/ 所在目录解析的同位语义）
    let mut dir = std::env::current_dir().unwrap_or_default();
    loop {
        if dir.join(".env").is_file() || dir.join("package.json").is_file() {
            return dir;
        }
        if !dir.pop() {
            return std::env::current_dir().unwrap_or_default();
        }
    }
}

fn main() {
    // 加载项目根统一 .env；系统环境变量保持更高优先级（dotenvy 不覆盖已有变量）。
    let root = find_repo_root();
    if let Err(error) = dotenvy::from_path(root.join(".env")) {
        if error.not_found() {
            // .env 是可选的
        } else {
            eprintln!("[server] Failed to read .env: {error}");
        }
    }

    let env: EnvMap = std::env::vars().collect();
    let config = config_from_env(&env);
    if let Err(message) = assert_proxy_security_config(&config) {
        eprintln!("[server] {message}");
        std::process::exit(1);
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        match run_proxy(config).await {
            Ok(server) => {
                println!(
                    "[server] community-proxy is running at http://{}",
                    server.addr
                );
                if let Err(error) = server.run().await {
                    eprintln!("[server] server error: {error}");
                    std::process::exit(1);
                }
            }
            Err(message) => {
                eprintln!("[server] Failed to bind/listen: {message}");
                std::process::exit(1);
            }
        }
    });
}
