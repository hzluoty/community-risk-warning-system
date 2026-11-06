/**
 * server/qwenProxy.js 的类型声明（JS 服务端模块被 Electron 主进程消费）。
 * 仅声明 Electron 侧实际使用的导出面；完整实现以 qwenProxy.js 为准。
 */
import type { Express, Router } from 'express';

export interface QwenProxyConfig {
  host?: string;
  port?: number;
  corsOrigin?: string[];
  allowLocalFileOrigins?: boolean;
  localProxyToken?: string;
  isLocalVlmTrusted?: () => boolean;
  [key: string]: unknown;
}

export interface QwenProxyAppOptions {
  /** 挂载到 /api/tasks 的比赛任务回传路由（必须在内部挂载以保证守卫与错误处理顺序）。 */
  tasksRouter?: Router;
}

export function loadQwenProxyConfig(env?: NodeJS.ProcessEnv): QwenProxyConfig;
export function createQwenProxyApp(config?: QwenProxyConfig, options?: QwenProxyAppOptions): Express;

export function buildOllamaRequestBody(body?: Record<string, unknown>, model?: string): Record<string, unknown>;
