import type { CameraPoint, RiskEvent } from '@/types';
import type { DecisionEvent, DecisionState } from '@/types/riskEvents';
import { emptyDecisionState, validBox } from './decisionEngine';

export const EVENT_STORAGE_KEY = 'community-risk-events-v1';
interface EventStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 2000;
function browserStorage(): EventStorage | undefined {
  try { return globalThis.localStorage; } catch { throw new Error('无法访问事件本地存储'); }
}
const string = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1000;
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function validEvent(value: unknown): value is DecisionEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as DecisionEvent;
  return [e.id, e.cameraId, e.subtype, e.sessionId, e.observation, e.lastFrameId, e.configVersion, e.modelVersion].every(string) &&
    ['fire', 'security', 'assistance', 'environment', 'facility'].includes(e.category) &&
    ['Normal', 'C', 'B', 'A'].includes(e.grade) &&
    ['pending', 'active', 'observationally_cleared', 'ended_unresolved'].includes(e.lifecycle) &&
    ['fresh', 'unknown', 'failure', 'stale', 'review'].includes(e.health) &&
    ['pending', 'processing', 'done'].includes(e.handling) &&
    (e.regionId === null || string(e.regionId)) && validBox(e.box) &&
    [e.createdAt, e.updatedAt, e.lastPositiveMono, e.lastValidMono, e.score, e.baseScore, e.historyTerm, e.confidence].every(finite) &&
    e.score <= 100 && e.baseScore <= 100 && e.historyTerm <= 1 && e.confidence <= 1 &&
    (e.confirmedAt === null || finite(e.confirmedAt)) && (e.segmentStartMono === null || finite(e.segmentStartMono)) &&
    (e.previousScore === null || (finite(e.previousScore) && e.previousScore <= 100)) &&
    Number.isSafeInteger(e.downCount) && e.downCount >= 0 && e.downCount <= 1 &&
    Number.isSafeInteger(e.absentCount) && e.absentCount >= 0 &&
    typeof e.environmentMissing === 'boolean' && typeof e.firstAlert === 'boolean';
}
/** Explicit allowlist: no snapshots, URLs, arbitrary keys, or model response blobs are persisted. */
function metadata(e: DecisionEvent): DecisionEvent {
  return {
    id: e.id, cameraId: e.cameraId, category: e.category, subtype: e.subtype, regionId: e.regionId,
    box: { x: e.box.x, y: e.box.y, width: e.box.width, height: e.box.height },
    grade: e.grade, lifecycle: e.lifecycle, health: e.health, handling: e.handling, confirmedAt: e.confirmedAt,
    createdAt: e.createdAt, updatedAt: e.updatedAt, sessionId: e.sessionId, lastPositiveMono: e.lastPositiveMono,
    lastValidMono: e.lastValidMono, segmentStartMono: e.segmentStartMono, previousScore: e.previousScore,
    downCount: e.downCount, absentCount: e.absentCount, score: e.score, confidence: e.confidence, modelVersion: e.modelVersion,
    baseScore: e.baseScore, historyTerm: e.historyTerm, environmentMissing: e.environmentMissing,
    observation: e.observation, lastFrameId: e.lastFrameId, firstAlert: e.firstAlert, configVersion: e.configVersion
  };
}
export function saveEventState(state: DecisionState, storage?: EventStorage): void {
  if (state.events.length > MAX_EVENTS || !state.events.every(validEvent) || new Set(state.events.map((e) => e.id)).size !== state.events.length ||
    !Number.isSafeInteger(state.nextId) || state.nextId < 1) throw new Error('事件存储容量或数据校验失败');
  const serialized = JSON.stringify({ version: 1, events: state.events.map(metadata), nextId: state.nextId });
  if (new TextEncoder().encode(serialized).length > MAX_BYTES) throw new Error('事件存储容量超限');
  const target = storage ?? browserStorage();
  if (!target) throw new Error('当前环境不提供事件本地存储');
  target.setItem(EVENT_STORAGE_KEY, serialized);
}
export function loadEventState(sessionId: string, storage?: EventStorage): DecisionState {
  try {
    const raw = (storage ?? browserStorage())?.getItem(EVENT_STORAGE_KEY);
    if (!raw || raw.length > MAX_BYTES || new TextEncoder().encode(raw).length > MAX_BYTES) return emptyDecisionState();
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !Array.isArray(data.events) || data.events.length > MAX_EVENTS || !data.events.every(validEvent) ||
      new Set(data.events.map((e: DecisionEvent) => e.id)).size !== data.events.length || !Number.isSafeInteger(data.nextId) || data.nextId < 1) return emptyDecisionState();
    const events = data.events.map((original: DecisionEvent) => {
      const event = metadata(original);
      // A reload is a new observation session even if a caller accidentally reuses its session label.
      if (event.lifecycle === 'active' || event.lifecycle === 'pending') {
        event.lifecycle = 'ended_unresolved'; event.health = 'stale'; event.firstAlert = false;
      }
      event.sessionId = sessionId; event.previousScore = null; event.downCount = 0; event.absentCount = 0; event.segmentStartMono = null;
      return event;
    });
    return { ...emptyDecisionState(), events, nextId: data.nextId };
  } catch { return emptyDecisionState(); }
}
export function projectDecisionEvents(state: DecisionState, cameras: CameraPoint[]): RiskEvent[] {
  return state.events.map((e) => {
    const camera = cameras.find((c) => c.id === e.cameraId);
    const score = Math.round(e.score * 100) / 100;
    const summary = `${e.observation}；等级=${e.grade}；观测=${e.health}；生命周期=${e.lifecycle}`;
    return {
      id: e.id, title: `${e.firstAlert ? '高分候选·待连续确认：' : ''}${e.subtype}`,
      cameraId: e.cameraId, cameraName: camera?.name ?? e.cameraId, area: camera?.area ?? '未登记点位',
      eventType: e.category, riskScore: score, level: e.grade, status: e.handling,
      occurredAt: new Date(e.createdAt).toLocaleString(), summary,
      suggestion: '请人工现场核查；确认、处置与观测解除分别记录。', snapshot: `帧引用：${e.lastFrameId}（未持久化图像）`,
      tags: [...new Set([e.health, e.lifecycle, e.configVersion, e.modelVersion, ...(e.confirmedAt === null ? [] : ['人工已确认'])])],
      analysis: { riskScore: score, level: e.grade, hasRisk: e.grade !== 'Normal' || e.firstAlert,
        confidence: e.confidence, summary, evidenceTimeline: [`${e.lastFrameId}：${e.observation}`], breakdown: [], trend: [] }
    };
  });
}
