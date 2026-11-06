import { describe, expect, it } from 'vitest';
import {
  API_HEALTH_ROUTE,
  LOCAL_PROXY_TOKEN_HEADER,
  OLLAMA_CHAT_COMPLETIONS_ROUTE,
  OLLAMA_STATUS_ROUTE,
  QWEN_CHAT_COMPLETIONS_ROUTE,
  TASKS_INGEST_ROUTE,
  TASKS_RESULTS_ROUTE,
  TASKS_ROUTE_PREFIX,
  TASKS_RUN_ROUTE
} from './apiRoutes.js';

describe('apiRoutes', () => {
  it('keeps public proxy route paths unchanged', () => {
    expect(API_HEALTH_ROUTE).toBe('/api/health');
    expect(QWEN_CHAT_COMPLETIONS_ROUTE).toBe('/api/qwen/chat/completions');
    expect(OLLAMA_CHAT_COMPLETIONS_ROUTE).toBe('/api/ollama/chat/completions');
    expect(OLLAMA_STATUS_ROUTE).toBe('/api/ollama/status');
  });

  it('keeps tasks channel routes unchanged (shared with the Rust contract)', () => {
    expect(TASKS_ROUTE_PREFIX).toBe('/api/tasks');
    expect(TASKS_INGEST_ROUTE).toBe('/api/tasks/ingest');
    expect(TASKS_RESULTS_ROUTE).toBe('/api/tasks/results');
    expect(TASKS_RUN_ROUTE).toBe('/api/tasks/run');
  });

  it('requires every tasks route to start with the tasks prefix (mount invariant)', () => {
    // 前缀切片推导相对路径（server/tasksIngest.js）依赖此不变式；
    // 违反即启动期语义破坏 —— 而不是静默切出垃圾路径。
    for (const route of [TASKS_INGEST_ROUTE, TASKS_RESULTS_ROUTE, TASKS_RUN_ROUTE]) {
      expect(route.startsWith(`${TASKS_ROUTE_PREFIX}/`)).toBe(true);
    }
  });

  it('keeps the local proxy auth header name unchanged (cross-runtime wire contract)', () => {
    expect(LOCAL_PROXY_TOKEN_HEADER).toBe('x-local-proxy-token');
  });
});
