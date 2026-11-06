export const API_HEALTH_ROUTE = '/api/health';
export const QWEN_CHAT_COMPLETIONS_ROUTE = '/api/qwen/chat/completions';
export const OLLAMA_CHAT_COMPLETIONS_ROUTE = '/api/ollama/chat/completions';
export const OLLAMA_STATUS_ROUTE = '/api/ollama/status';

// 比赛任务回传通道（tasksIngest）：前缀 + 四条子路由 —— 全部入契约，
// JS 服务端与 Rust 端共用，禁止任何一侧手写第三份。
export const TASKS_ROUTE_PREFIX = '/api/tasks';
export const TASKS_INGEST_ROUTE = '/api/tasks/ingest';
export const TASKS_RESULTS_ROUTE = '/api/tasks/results';
export const TASKS_RUN_ROUTE = '/api/tasks/run';

// 本地代理鉴权头名：跨端 wire 契约（Electron 壳 / JS 服务端 / Rust 端 / Tauri 壳
// 四方注入与校验必须同名）。HTTP 头大小写不敏感，但常量必须单一事实源。
export const LOCAL_PROXY_TOKEN_HEADER = 'x-local-proxy-token';

// —— golden 用例占位符表（单一事实源）——
// proxyCases.json 的 path/headers 用 {{...}} 占位符绑定契约常量；
// JS 侧（check-shared-contract.js / proxyContract.test.js）直接 import 本表，
// Rust 侧经 contract.json 的 routePlaceholders 段（生成器写入）循环展开。
// 新增契约路由时只需在 ROUTE_PLACEHOLDERS 加一行 + npm run gen:contract。

export const TOKEN_PLACEHOLDER = '{{TOKEN}}';

export const ROUTE_PLACEHOLDERS = Object.freeze({
  '{{API_HEALTH_ROUTE}}': API_HEALTH_ROUTE,
  '{{QWEN_CHAT_COMPLETIONS_ROUTE}}': QWEN_CHAT_COMPLETIONS_ROUTE,
  '{{OLLAMA_CHAT_COMPLETIONS_ROUTE}}': OLLAMA_CHAT_COMPLETIONS_ROUTE,
  '{{OLLAMA_STATUS_ROUTE}}': OLLAMA_STATUS_ROUTE,
  '{{TASKS_INGEST_ROUTE}}': TASKS_INGEST_ROUTE,
  '{{TASKS_RESULTS_ROUTE}}': TASKS_RESULTS_ROUTE,
  '{{TASKS_RUN_ROUTE}}': TASKS_RUN_ROUTE,
  '{{LOCAL_PROXY_TOKEN_HEADER}}': LOCAL_PROXY_TOKEN_HEADER
});
