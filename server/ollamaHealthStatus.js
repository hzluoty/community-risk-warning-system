// 规则本体已下沉 shared/ollamaHealthStatus.js（Electron / JS 服务端 / Rust 三方共读）；
// 此处保留再导出以兼容旧导入路径，勿在此扩展。
export { GPU_AVAILABILITY_UNKNOWN, resolveOllamaHealthStatus } from '../shared/ollamaHealthStatus.js';
