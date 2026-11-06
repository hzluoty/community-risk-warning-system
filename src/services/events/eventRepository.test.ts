import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENT_STORAGE_KEY, loadEventState, projectDecisionEvents, saveEventState } from './eventRepository';
import { applyEventObservation, emptyDecisionState, EVENT_SESSION_ID } from './decisionEngine';
import { buildOllamaRequestBody } from '../../../shared/vlmRequestBody.js';
import { EVENT_RESPONSE_FORMAT } from '../../../shared/eventResponseSchema.js';
import { parseEventChatResponse } from '@/services/llm/eventClient';
import { useAppStore } from '@/store/useAppStore';
import type { EventObservation } from '@/types/riskEvents';
function sample(seq = 1): EventObservation {
  return { context: { cameraId: 'cam', frameId: `f${seq}`, sequence: seq, capturedAt: 100000 + seq * 1000, capturedMonotonicAt: seq * 1000, sessionId: EVENT_SESSION_ID, modelVersion: 'model' }, receivedMonotonicAt: seq * 1000, status: 'ok',
    output: { quality: 'clear', summary: '当前帧可见堆物', candidates: [{ id: 'c', category: 'fire', subtype: 'blocked', confidence: 0.9, scores: { consequence: 85, exposure: 85, urgency: 85 }, observation: '当前帧通道有物体', evidenceFrameIds: [`f${seq}`], box: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }, regionId: null }], eventChecks: [] } };
}
function memory() { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; }
const state = () => applyEventObservation(emptyDecisionState(), sample());
afterEach(() => { vi.unstubAllGlobals(); useAppStore.setState({ decisionState: emptyDecisionState(), events: [], persistenceError: null }); });
describe('metadata persistence and production wiring', () => {
  it('production store starts without mock warning events', () => { expect(useAppStore.getInitialState().events).toEqual([]); });
  it('writes only metadata and restores active events as unresolved, never alive', () => {
    const storage = memory(), initial = state(); initial.events[0].confirmedAt = 123456;
    (initial.events[0] as unknown as Record<string, unknown>).snapshot = 'PRIVATE_IMAGE';
    saveEventState(initial, storage);
    expect(storage.getItem(EVENT_STORAGE_KEY)).not.toContain('PRIVATE_IMAGE');
    const restored = loadEventState('new-session', storage);
    expect(restored.events[0]).toMatchObject({ lifecycle: 'ended_unresolved', health: 'stale', confirmedAt: 123456, previousScore: null });
    expect(restored.watermarks).toEqual({}); expect(restored.review).toEqual([]); expect(restored.audit).toEqual([]);
  });
  it('rejects malformed, nonfinite and duplicate metadata', () => {
    const storage = memory(); storage.setItem(EVENT_STORAGE_KEY, '{bad'); expect(loadEventState('s', storage).events).toEqual([]);
    const initial = state(); initial.events[0].score = NaN; expect(() => saveEventState(initial, storage)).toThrow();
    const duplicate = state(); duplicate.events.push(duplicate.events[0]); expect(() => saveEventState(duplicate, storage)).toThrow();
  });
  it('bounds disk input size and reports write failure', () => {
    const storage = memory(); storage.setItem(EVENT_STORAGE_KEY, 'x'.repeat(4 * 1024 * 1024 + 1)); expect(loadEventState('s', storage).events).toEqual([]);
    expect(() => saveEventState(state(), { getItem: () => null, setItem: () => { throw new Error('quota'); } })).toThrow('quota');
  });
  it('does not represent the first high candidate as confirmed A', () => {
    const projected = projectDecisionEvents(state(), []);
    expect(projected[0].level).toBe('Normal'); expect(projected[0].title).toContain('待连续确认');
    expect(projected[0].analysis.confidence).toBe(0.9); expect(projected[0].snapshot).toContain('未持久化图像');
  });
  it('preserves the server-whitelisted event schema through the actual proxy builder', () => {
    expect(buildOllamaRequestBody({ response_format: EVENT_RESPONSE_FORMAT }, 'model').response_format).toEqual(EVENT_RESPONSE_FORMAT);
    expect(buildOllamaRequestBody({ response_format: { type: 'arbitrary' } }, 'model').response_format).not.toEqual({ type: 'arbitrary' });
  });
  it('runs parser to engine to real store to metadata restore with synthetic outputs', () => {
    const storage = memory(); vi.stubGlobal('localStorage', storage);
    useAppStore.setState({ decisionState: emptyDecisionState(), events: [] });
    for (let i = 1; i <= 2; i++) {
      const obs = sample(i);
      obs.output = parseEventChatResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(obs.output) } }] }, obs.context, useAppStore.getState().decisionState.events, []);
      useAppStore.getState().applyEventObservation(obs);
    }
    const store = useAppStore.getState(); expect(store.events[0].level).toBe('A'); expect(store.persistenceError).toBeNull();
    const id = store.events[0].id;
    store.markEventStatus(id, 'done'); store.confirmEvent(id);
    expect(useAppStore.getState().decisionState.events[0]).toMatchObject({ grade: 'A', lifecycle: 'active', handling: 'done' });
    expect(useAppStore.getState().decisionState.events[0].confirmedAt).not.toBeNull();
    expect(loadEventState('restart', storage).events[0]).toMatchObject({ handling: 'done', grade: 'A', lifecycle: 'ended_unresolved' });
  });
  it('store exposes storage error without losing in-memory warning', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota exceeded'); } });
    useAppStore.getState().applyEventObservation(sample());
    expect(useAppStore.getState().persistenceError).toContain('quota'); expect(useAppStore.getState().decisionState.events).toHaveLength(1);
  });
  it('global timer expiry changes lifecycle without injecting a safe score', () => {
    vi.stubGlobal('localStorage', memory()); useAppStore.getState().applyEventObservation(sample());
    useAppStore.getState().tickEventClock(31001);
    expect(useAppStore.getState().decisionState.events[0]).toMatchObject({ lifecycle: 'ended_unresolved', health: 'stale', score: 85 });
  });
});
