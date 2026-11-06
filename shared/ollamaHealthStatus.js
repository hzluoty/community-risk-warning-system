/**
 * VLM 健康状态映射（跨端 wire 规则）：上游 HTTP 状态码 → {ready, status, gpu}。
 * 单一事实源 —— Electron（ollamaManager）、JS 服务端（qwenProxy）从本模块读；
 * Rust 侧（crws-core#resolve_ollama_health_status）经 shared/fixtures/env.json 的
 * healthStatus 段锁同一语义（双端断言：core 的 health_status_maps_503_to_loading
 * 与 server/ollamaHealthStatus.test.js 消费同一组期望）。
 */

export const GPU_AVAILABILITY_UNKNOWN = 'unknown';

export function resolveOllamaHealthStatus(statusCode) {
  if (statusCode >= 200 && statusCode < 300) {
    return { ready: true, status: 'ready', gpu: GPU_AVAILABILITY_UNKNOWN };
  }

  if (statusCode === 503) {
    return { ready: false, status: 'loading', gpu: GPU_AVAILABILITY_UNKNOWN };
  }

  return { ready: false, status: 'error', gpu: GPU_AVAILABILITY_UNKNOWN };
}
