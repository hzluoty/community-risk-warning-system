import { describe, expect, it, vi } from 'vitest';
import { buildEventRequest, EVENT_OUTPUT_SCHEMA, parseEventChatResponse, analyzeEventFrame } from './eventClient';
import { applyEventObservation, emptyDecisionState } from '@/services/events/decisionEngine';
import { http } from '@/services/http';
import type { EventFrameContext, EventModelOutput } from '@/types/riskEvents';
const context: EventFrameContext = { cameraId: 'cam', frameId: 'frame1', sequence: 1, capturedAt: 1000, capturedMonotonicAt: 0, sessionId: 'session', modelVersion: 'model' };
const output = (): EventModelOutput => ({ quality: 'clear', summary: '当前帧通道可见物体。需要核查。', candidates: [{
  id: 'c1', category: 'fire', subtype: 'blocked', confidence: 0.9,
  scores: { consequence: 80, exposure: 90, urgency: 90 }, observation: '当前帧通道有堆物', evidenceFrameIds: ['frame1'],
  box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 }, regionId: null
}], eventChecks: [] });
const envelope = (payload: unknown) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(payload) } }] });
const parse = (payload: unknown) => parseEventChatResponse(envelope(payload), context, [], []);
describe('event protocol in real request path', () => {
  it('builds a single-image request with fixed schema, frame context and no fabricated history', () => {
    const request = buildEventRequest('data:image/jpeg;base64,test', 'cam', 'scene', context, [], []);
    expect(request.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'community_event_observation', strict: true, schema: EVENT_OUTPUT_SCHEMA } });
    expect(request.response_format).not.toHaveProperty('schema');
    expect(request.max_tokens).toBe(1600); expect(request.stream).toBe(false);
    expect(JSON.stringify(request)).toContain('frame1');
    expect(() => buildEventRequest('image', 'other', 'scene', context, [], [])).toThrow();
  });
  it('accepts current-frame structured candidates', () => { expect(parse(output())).toEqual(output()); });
  it.each(['十分钟前反复出现', '持续倒地', 'for 10 minutes', 'repeatedly crossing', 'previously seen'])('rejects unprovided temporal claims: %s', (claim) => {
    const payload = output(); payload.candidates[0].observation = claim;
    expect(() => parse(payload)).toThrow();
  });
  it('rejects invented and missing evidence references', () => {
    const payload = output(); payload.candidates[0].evidenceFrameIds = ['other']; expect(() => parse(payload)).toThrow();
    payload.candidates[0].evidenceFrameIds = []; expect(() => parse(payload)).toThrow();
  });
  it('rejects unknown keys instead of compatibility repairing', () => {
    expect(() => parse({ ...output(), extra: 1 })).toThrow();
    const missingCheck = { ...output() } as Record<string, unknown>;
    delete missingCheck.eventChecks; expect(() => parse(missingCheck)).toThrow();
    const payload = output(); (payload.candidates[0] as unknown as Record<string, unknown>).extra = 1;
    expect(() => parse(payload)).toThrow();
  });
  it.each([NaN, Infinity, -1, 101, '85'])('rejects invalid semantic score %s', (value) => {
    const payload = output(); payload.candidates[0].scores.consequence = value as number;
    expect(() => parse(payload)).toThrow();
  });
  it('rejects duplicate candidate IDs, illegal box and made-up region', () => {
    const payload = output(); payload.candidates.push({ ...payload.candidates[0] }); expect(() => parse(payload)).toThrow();
    payload.candidates.pop(); payload.candidates[0].box.width = 1; expect(() => parse(payload)).toThrow();
    payload.candidates[0].box.width = 0.2; payload.candidates[0].regionId = 'invented'; expect(() => parse(payload)).toThrow();
  });
  it('accepts only requested same-camera active event checks and visible negatives', () => {
    const events = applyEventObservation(emptyDecisionState(), { context, status: 'ok', receivedMonotonicAt: 0, output: output() }).events;
    const payload = output(); payload.candidates = []; payload.eventChecks = [{ eventId: events[0].id, verdict: 'absent', regionVisible: true, evidenceFrameIds: ['frame1'] }];
    expect(parseEventChatResponse(envelope(payload), context, events, []).eventChecks[0].verdict).toBe('absent');
    payload.eventChecks[0].regionVisible = false; expect(() => parseEventChatResponse(envelope(payload), context, events, [])).toThrow();
    payload.eventChecks[0].regionVisible = true; expect(() => parse(payload)).toThrow();
  });
  it('rejects length completion, multiple choices, refusal and non-JSON prose', () => {
    const data = envelope(output()); data.choices[0].finish_reason = 'length'; expect(() => parseEventChatResponse(data, context, [], [])).toThrow();
    data.choices[0].finish_reason = 'stop'; data.choices.push(data.choices[0]); expect(() => parseEventChatResponse(data, context, [], [])).toThrow();
    const bad = envelope(output()); bad.choices[0].message.content = 'Here is JSON: {}'; expect(() => parseEventChatResponse(bad, context, [], [])).toThrow();
    expect(() => parseEventChatResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output()), refusal: 'no' } }] }, context, [], [])).toThrow();
  });
  it('calls the existing transport with signal and returns real header source', async () => {
    const post = vi.spyOn(http, 'post').mockResolvedValue({ data: envelope(output()), headers: { 'x-vlm-source': 'local' } });
    try {
      const controller = new AbortController();
      const result = await analyzeEventFrame('image', 'cam', 'scene', context, [], [], controller.signal);
      expect(result.output).toEqual(output()); expect(result.modelSource).toBe('local');
      expect(post.mock.calls[0][2]).toEqual({ signal: controller.signal });
    } finally { post.mockRestore(); }
  });
});
