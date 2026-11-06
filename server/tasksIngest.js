/**
 * 任务结果回传通道（materials/02 决策 D4 的"结果回传"落点）。
 *
 * ROS 侧任务执行器把 TaskAnalysisResult 信封 POST 到 /api/tasks/ingest，
 * 前端经 GET /api/tasks/results 轮询展示（D6：store 的 taskResults/taskRun 切片）。
 * 本路由为只读聚合代理：仅缓存最近若干条结果，不持久化、不转发到任何外部服务；
 * 与风险流水线（qwenProxy / shared schema）完全隔离，不改变其任何行为。
 *
 * taskId 白名单镜像 competition/code/task-contract 的 TaskId 联合类型；
 * 契约本体以 task-contract/specs.ts（单测覆盖）为单一事实源。
 */

import { Router } from 'express';
import express from 'express';
import {
  TASKS_INGEST_ROUTE,
  TASKS_RESULTS_ROUTE,
  TASKS_ROUTE_PREFIX,
  TASKS_RUN_ROUTE
} from '../shared/apiRoutes.js';
import { COMPETITION_TASK_IDS } from '../shared/taskIds.js';

// 契约事实已下沉 shared/taskIds.js（渲染端 / JS 服务端 / Rust 三方共读）；此处保留再导出
// 以兼容旧导入路径，勿在此扩展白名单。
export { COMPETITION_TASK_IDS } from '../shared/taskIds.js';

const KNOWN_RUN_STATUSES = new Set(['running', 'done']);

// 字段长度与信封总字节预算：未鉴权写入者不能靠超长字段放大内存
// （maxResults=200 条 × 上限 ≈ 6.4MB 堆，而不是 200 × 1MB body = 200MB）。
const MAX_LOCATION_LENGTH = 200;
const MAX_ANNOUNCEMENT_LENGTH = 4000;
const MAX_BOXES = 100;
const MAX_ENVELOPE_JSON_LENGTH = 32 * 1024;
const MAX_RUN_JSON_LENGTH = 8 * 1024;

/**
 * 校验任务结果信封（TaskAnalysisResult）。返回 { ok, error?, envelope? }。
 * 宽松校验：结构必须是任务信封（type/taskId/location/capturedAt/result/boxes），
 * result.task 必须等于 taskId，announcement 必须为字符串。
 */
export function validateTaskEnvelope(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: '负载必须是 JSON 对象' };
  }
  if (payload.type !== 'task') {
    return { ok: false, error: "type 必须为 'task'" };
  }
  if (!COMPETITION_TASK_IDS.includes(payload.taskId)) {
    return { ok: false, error: `未知 taskId：${String(payload.taskId)}` };
  }
  if (typeof payload.location !== 'string' || !payload.location) {
    return { ok: false, error: 'location 必须为非空字符串' };
  }
  if (payload.location.length > MAX_LOCATION_LENGTH) {
    return { ok: false, error: `location 长度不能超过 ${MAX_LOCATION_LENGTH}` };
  }
  if (!Number.isFinite(payload.capturedAt)) {
    return { ok: false, error: 'capturedAt 必须为数字时间戳' };
  }
  const result = payload.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, error: 'result 必须为对象' };
  }
  if (result.task !== payload.taskId) {
    return { ok: false, error: 'result.task 必须与 taskId 一致' };
  }
  if (typeof result.announcement !== 'string') {
    return { ok: false, error: 'result.announcement 必须为字符串' };
  }
  if (result.announcement.length > MAX_ANNOUNCEMENT_LENGTH) {
    return { ok: false, error: `announcement 长度不能超过 ${MAX_ANNOUNCEMENT_LENGTH}` };
  }
  if (payload.boxes !== undefined) {
    if (!Array.isArray(payload.boxes)) {
      return { ok: false, error: 'boxes 必须为数组' };
    }
    if (payload.boxes.length > MAX_BOXES) {
      return { ok: false, error: `boxes 数量不能超过 ${MAX_BOXES}` };
    }
  }
  // 字节预算（与 Rust serde_json::to_vec().len() 同单位；多字节 UTF-8 安全）：
  // 原实现用 JSON.stringify().length（UTF-16 码元数），与下方"总字节预算"注释意图
  // 不符 —— 统一为字节，阈值不变（架构评审第十五轮 P0-2）。
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_ENVELOPE_JSON_LENGTH) {
    return { ok: false, error: '信封负载超过大小限制' };
  }
  return { ok: true, envelope: payload };
}

/** 校验运行事件（type='run'，status: running|done）。 */
export function validateRunEvent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: '负载必须是 JSON 对象' };
  }
  if (payload.type !== 'run') {
    return { ok: false, error: "type 必须为 'run'" };
  }
  if (!KNOWN_RUN_STATUSES.has(payload.status)) {
    return { ok: false, error: `status 必须为 ${[...KNOWN_RUN_STATUSES].join('|')}` };
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_RUN_JSON_LENGTH) {
    return { ok: false, error: '运行事件负载超过大小限制' };
  }
  return { ok: true, event: payload };
}

export function createTasksIngestRouter({ maxResults = 200 } = {}) {
  const router = Router();
  // qwenProxy 的 JSON 解析只作用于 chat 路由，这里自带解析器保持路由自包含
  const jsonParser = express.json({ limit: '1mb' });
  /** 最新结果在前；条目 = {...envelope, receivedAt} */
  const state = { results: [], run: null };

  // Router 挂载在 /api/tasks 前缀下，路由内用去前缀的相对路径；
  // 相对路径由 shared 契约常量推导，避免第二份手写路径。
  const ingestPath = TASKS_INGEST_ROUTE.slice(TASKS_ROUTE_PREFIX.length);
  const resultsPath = TASKS_RESULTS_ROUTE.slice(TASKS_ROUTE_PREFIX.length);
  const runPath = TASKS_RUN_ROUTE.slice(TASKS_ROUTE_PREFIX.length);

  router.post(ingestPath, jsonParser, (req, res) => {
    const payload = req.body;
    if (payload && payload.type === 'run') {
      const checked = validateRunEvent(payload);
      if (!checked.ok) return res.status(400).json({ ok: false, error: checked.error });
      state.run = { ...checked.event, receivedAt: Date.now() };
      return res.json({ ok: true, stored: 'run' });
    }
    const checked = validateTaskEnvelope(payload);
    if (!checked.ok) return res.status(400).json({ ok: false, error: checked.error });
    state.results.unshift({ ...checked.envelope, receivedAt: Date.now() });
    if (state.results.length > maxResults) state.results.length = maxResults;
    return res.json({ ok: true, stored: 'task' });
  });

  router.get(resultsPath, (req, res) => {
    const since = Number(req.query.since);
    const items = Number.isFinite(since)
      ? state.results.filter((item) => item.receivedAt > since)
      : state.results;
    res.json({ ok: true, count: items.length, results: items });
  });

  router.get(`${resultsPath}/:taskId`, (req, res) => {
    const item = state.results.find((entry) => entry.taskId === req.params.taskId);
    if (!item) return res.status(404).json({ ok: false, error: '暂无该任务结果' });
    res.json({ ok: true, result: item });
  });

  router.get(runPath, (_req, res) => {
    res.json({ ok: true, run: state.run });
  });

  return router;
}
