# 实现分歧登记表（双实现并存声明）

> 状态：**Rust 侧为实验/并行实现**。当前唯一发布路径仍是 `npm run package`（Electron + JS 内嵌代理）。
> 本文件登记 JS 与 Rust 两份实现之间的边界：哪些行为被共享契约锁定、哪些允许分叉、切换点在哪里。

## 共享契约（双端锁定，改一侧不改另一侧会红）

| 层 | 事实源 | 消费端 | 锁定方式 |
| --- | --- | --- | --- |
| 路由（health/qwen/ollama/tasks×4 + 前缀） | `shared/apiRoutes.js` → `contract.json` | JS 服务端、Rust proxy、渲染端、两个壳 | `npm run check:contract` + `contract.rs` 断言 + `apiRoutes.test.js` |
| 鉴权头名 `x-local-proxy-token` | 同上（headers.localProxyToken） | 四端 | 同上 |
| 云端端点表（key + baseUrl） | `shared/qwenEndpoints.js` → `contract.json` | JS、Rust `endpoints.rs`（查表壳） | 同上 |
| 响应 schema（VLM/event） | `shared/vlm{Response,eventResponse}Schema.js` | JS、Rust `contract.rs` | 同上 |
| 模型文件/别名/SHA | `shared/vlmModelConfig.js` | Rust `contract.rs`、壳直读 `crws_core::contract` | 同上 |
| 任务 ID 白名单 | `shared/taskIds.js` | JS、Rust `tasks.rs` | 同上 |
| 请求体裁决（三 builder，含键序敏感白名单） | `shared/vlmRequestBody.js` | JS、Rust `upstream/request_body.rs` | `fixtures/requestBody.json` 双端 runner |
| VLM 健康状态映射（2xx/503/其余） | `shared/ollamaHealthStatus.js` | JS（Electron + 服务端）、Rust `crws-core` | `fixtures/env.json` 的 healthStatus 段双端断言 |
| llama-server 参数表（含 mmproj/MTP 分支与互斥告警文案）/ env 白名单（含 unix 补充表）/ 退避常量 / 必需运行时文件 | `shared/vlmRuntime.json` → contract.json 的 vlmRuntime 段 | TS（`electron/ollamaManager.ts`）、Rust（`crws-vlm` args/resources/lib） | 契约同源 + 条目形状校验（check:contract）+ 同序 argv 全列表双端断言（TS `matches the full ordered argv list shared with the Rust side` ↔ Rust `llama_server_args_match_the_electron_manager`） |
| env 解析语义 | `shared/envParsers.js` | JS、Rust `crws-core` | `fixtures/env.json` 双端 runner |
| **HTTP 行为**（23 条 golden 所覆盖：状态码/错误文案/中间件顺序/限流/403 先于 400/多字节字节预算/拒绝类载荷） | `shared/proxyCases.json`（23 条） | JS `proxyContract.test.js`、Rust `contract_cases.rs` | 双端 runner（占位符绑定契约 + step 键白名单） |
| **chat 载荷校验规则**（null/布尔/字符串形态、n/best_of、max_tokens 归一、DISALLOWED 字段表、阈值） | `shared/payloadValidation.js`（本体）→ `fixtures/payloadValidation.json`（20 条 + config 阈值）与 contract.json 的 payloadValidation 段 | JS 服务端 + 渲染端测试 + Rust `payload.rs`（契约驱动） | 校验函数层双端断言（`qwenProxy.test.js` ↔ `payload_validation_matches_shared_fixtures`） |
| 信封字节预算（32KB/8KB，UTF-8 字节） | `shared/proxyCases.json` 多字节用例 | 双端 | golden 用例锁定单位 |

## 允许分叉（显式登记）

| 面 | JS 实现 | Rust 实现 | 分叉说明 |
| --- | --- | --- | --- |
| VLM 进程监管（进程生命周期/调度结构） | `electron/ollamaManager.ts`（Electron 主进程内） | `crws-vlm` crate（Tauri 壳内 supervisor） | **参数表/env 白名单/退避常量已入共享契约**（见上表）；结构实现（定时器 vs tick 状态机）允许不同 —— 可观察行为（退避节奏/轮询间隔）由契约常量锁定 |
| 会话策略（端口范围/密钥长度/origin 清单） | `electron/main.ts` | `src-tauri/src/lib.rs` | 手写翻译，无共享断言 |
| 限流实现 | express-rate-limit（滑窗近似） | `ratelimit.rs` 固定窗口 | golden 只锁可观察行为（429 语义），内部算法允许不同 |
| 上游响应流读取 | fetch stream | reqwest bytes_stream | 大小上限语义一致（golden 锁定），背压行为允许不同 |

## 切换点（未执行）

- **发布路径**：`npm run package` = Electron + JS 内嵌代理（`electron/main.ts` import `server/qwenProxy.js`）。
- **实验路径**：`npm run tauri:build`（需先 `npm run download-model` + `prepare-vlm`）= Tauri 壳 + Rust 代理 + Rust supervisor。已通过：cargo test 三 crate 全绿、golden 双端 23 条、校验层夹具 20 条、壳冒烟（随机端口/信任态/CORS tauri origin/令牌 403）、真实 VLM 推理（llama.cpp b9484 + Qwen3.5-4B-Q4_K_M + mmproj，CUDA RTX 4060）。
- 切换条件（全部满足才可删 JS 侧）：
  1. ~~supervisor 参数表入 shared 契约~~ **已完成**；~~载荷校验规则入 shared~~ **已完成**（payloadValidation.js 本体 + 夹具双端断言）；会话策略（端口范围/密钥长度/origin 清单）仍未入契约；
  2. `npm run tauri:build` 产物在本机完成一次完整手工验收（地图/视频/检测/VLM 分析四页面）；
  3. CI 的 Tauri 产物列（NSIS）经一次真实安装验证。
- 删除清单（切换时）：`server/qwenProxy.js`、`server/tasksIngest.js`、`server/index.js`、`server/proxyContract.test.js`、`server/ollamaHealthStatus.js|.d.ts|.test.js`（再导出壳，本体已在 shared/）、`electron/ollamaManager.ts|.test.ts`、`electron/vlmResourcePath.ts|.test.ts`（只被 ollamaManager 消费）；`dev:server` 脚本改 `cargo run -p crws-proxy --bin community-proxy`。
- **删除后必须同步更新 `electron/tsconfig.json` 的 include 列表**（逐个点名了 ollamaManager / vlmResourcePath 及其测试）—— 否则 typecheck 红。
