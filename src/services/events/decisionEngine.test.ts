import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DECISION_CONFIG as config, advanceGrade, applyEventObservation, calculateCri,
  emptyDecisionState, expireDecisionEvents, historyTerm, maximumWeightAssignment, semanticBase, validateDecisionConfig
} from './decisionEngine';
import type { DecisionEvent, DecisionState, EventCandidate, EventObservation } from '@/types/riskEvents';
const candidate = (frame: number, value = 85, overrides: Partial<EventCandidate> = {}): EventCandidate => ({
  id: 'c1', category: 'fire', subtype: 'blocked', confidence: 0.9,
  scores: { consequence: value, exposure: value, urgency: value }, observation: '当前帧通道有物体',
  evidenceFrameIds: [`f${frame}`], box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, regionId: null, ...overrides
});
const observation = (seq: number, ms: number, value: number | null = 85): EventObservation => ({
  context: { cameraId: 'cam', frameId: `f${seq}`, sequence: seq, capturedAt: 100000 + ms, capturedMonotonicAt: ms, sessionId: 's', modelVersion: 'test' },
  receivedMonotonicAt: ms, status: 'ok', output: { quality: 'clear', summary: '当前帧', candidates: value === null ? [] : [candidate(seq, value)], eventChecks: [] }
});
const apply = (state: DecisionState, seq: number, ms: number, value: number | null = 85) => applyEventObservation(state, observation(seq, ms, value));
const alarm = () => apply(apply(emptyDecisionState(), 1, 0), 2, 1000);
function negative(state: DecisionState, seq: number, ms: number) {
  const obs = observation(seq, ms, null);
  obs.output!.eventChecks = state.events.filter((e) => e.lifecycle === 'active' || e.lifecycle === 'pending').map((e) => ({ eventId: e.id, verdict: 'absent', regionVisible: true, evidenceFrameIds: [`f${seq}`] }));
  return applyEventObservation(state, obs);
}

describe('production event decisions', () => {
  it('uses frozen three semantic dimensions independently of confidence', () => {
    expect(semanticBase({ consequence: 100, exposure: 50, urgency: 0 })).toBe(65);
    expect(() => semanticBase({ consequence: NaN, exposure: 0, urgency: 0 })).toThrow();
  });
  it('matches the independent reference arithmetic', () => {
    expect(calculateCri(80, 1, 0, 0, 0)).toBe(80);
    expect(calculateCri(60, 1, 30, 0, 0)).toBeCloseTo(63.4688, 4);
    expect(calculateCri(50, 1.4, 120, 0.5, 0.5)).toBeCloseTo(86.3966, 4);
    expect(calculateCri(0, 1.4, 600, 1, 1)).toBe(0);
    expect(() => calculateCri(101, 1, 0, 0, 0)).toThrow();
  });
  it('checks 10908 scoring combinations for range and monotonic time', () => {
    let count = 0;
    for (let base = 0; base <= 100; base++) for (const scene of [0.8, 1, 1.4]) for (const history of [0, 0.5, 1]) for (const env of [0, 0.5, 1]) {
      let prev = -1;
      for (const seconds of [0, 30, 300, 600]) {
        const score = calculateCri(base, scene, seconds, history, env);
        expect(score).toBeGreaterThanOrEqual(prev - 1e-10); expect(score).toBeLessThanOrEqual(100);
        expect(score).toBeGreaterThanOrEqual(Math.min(scene * base, 100) - 1e-10);
        prev = score; count++;
      }
    }
    expect(count).toBe(10908);
  });
  it('consumes first candidate and confirms only after second valid observation', () => {
    const first = apply(emptyDecisionState(), 1, 0);
    expect(first.events[0]).toMatchObject({ grade: 'Normal', lifecycle: 'pending', previousScore: 85, score: 85, firstAlert: true });
    expect(alarm().events[0]).toMatchObject({ grade: 'A', lifecycle: 'active', firstAlert: false });
    expect(first.events[0].grade).toBe('Normal'); // immutable previous state
  });
  it('confirms highest common grade for 85 then 65', () => {
    const state = apply(apply(emptyDecisionState(), 1, 0), 2, 1, 65);
    expect(state.events[0].grade).toBe('B');
  });
  it('retains grade inside hysteresis and resets downgrade count', () => {
    const event = { ...alarm().events[0] };
    for (const score of [70, 75, 70]) advanceGrade(event, score);
    expect(event.grade).toBe('A'); expect(event.downCount).toBe(1);
  });
  it('requires six explicit negatives to clear A', () => {
    let state = alarm(); const grades = [];
    for (let i = 3; i <= 8; i++) { state = negative(state, i, i * 1000); grades.push(state.events[0].grade); }
    expect(grades).toEqual(['A', 'B', 'B', 'C', 'C', 'Normal']);
    expect(state.events[0].lifecycle).toBe('observationally_cleared');
  });
  it('does not convert empty candidates or omitted eventChecks to zero scores', () => {
    const state = apply(alarm(), 3, 3000, null);
    expect(state.events[0]).toMatchObject({ grade: 'A', health: 'unknown', previousScore: null });
    expect(state.events[0].score).toBeGreaterThan(80);
  });
  it('rejects invisible or unreferenced negative declarations for automatic downgrade', () => {
    let state = alarm();
    for (let i = 3; i < 6; i++) {
      const obs = observation(i, i * 1000, null);
      obs.output!.eventChecks = [{ eventId: state.events[0].id, verdict: 'absent', regionVisible: false, evidenceFrameIds: [`f${i}`] }];
      state = applyEventObservation(state, obs);
    }
    expect(state.events[0].grade).toBe('A');
  });
  it('positive association overrides model absent and records conflict', () => {
    const state = alarm(), obs = observation(3, 3000);
    obs.output!.eventChecks = [{ eventId: state.events[0].id, verdict: 'absent', regionVisible: true, evidenceFrameIds: ['f3'] }];
    const result = applyEventObservation(state, obs);
    expect(result.events[0].grade).toBe('A');
    expect(result.audit.some((a) => a.reason.startsWith('positive-absent-conflict:'))).toBe(true);
  });
  it('failure advances watermark, breaks confirmation and never adds zero', () => {
    let state = apply(emptyDecisionState(), 1, 0);
    const fail = observation(3, 3000); fail.status = 'failure'; delete fail.output;
    state = applyEventObservation(state, fail);
    expect(state.events[0]).toMatchObject({ score: 85, grade: 'Normal', previousScore: null, health: 'failure' });
    state = apply(state, 2, 2000);
    expect(state.audit[state.audit.length - 1]?.reason).toBe('old-sequence');
    state = apply(state, 4, 4000);
    expect(state.events[0].grade).toBe('Normal');
  });
  it('uncertain quality does not create or clear events', () => {
    const obs = observation(1, 0); obs.output!.quality = 'uncertain';
    expect(applyEventObservation(emptyDecisionState(), obs).events).toEqual([]);
  });
  it('low confidence matches for deduplication but cannot refresh valid time', () => {
    const state = alarm(), obs = observation(3, 3000);
    obs.output!.candidates[0].confidence = 0.2;
    const result = applyEventObservation(state, obs);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ grade: 'A', health: 'review', lastValidMono: 1000, previousScore: null });
    expect(result.review).toHaveLength(1);
  });
  it('low unmatched candidates go only to manual review queue', () => {
    const obs = observation(1, 0); obs.output!.candidates[0].confidence = 0.1;
    const state = applyEventObservation(emptyDecisionState(), obs);
    expect(state.events).toEqual([]); expect(state.review).toHaveLength(1);
  });
  it('pending consecutive negatives are interrupted by unknown', () => {
    let state = negative(apply(emptyDecisionState(), 1, 0, 20), 2, 1000);
    state = apply(state, 3, 2000, null);
    state = negative(state, 4, 3000);
    expect(state.events[0].lifecycle).toBe('pending');
    state = negative(state, 5, 4000);
    expect(state.events[0].lifecycle).toBe('observationally_cleared');
  });
  it('clears positive duration segment on explicit absent and restarts at zero', () => {
    let state = apply(emptyDecisionState(), 1, 0);
    state = negative(state, 2, 1000);
    state = apply(state, 3, 2000);
    expect(state.events[0].segmentStartMono).toBe(2000);
    expect(state.events[0].score).toBe(85);
  });
  it('expires strictly after gap and never resurrects old ID', () => {
    let state = apply(emptyDecisionState(), 1, 0);
    expect(expireDecisionEvents(state, 30000, 's').events[0].lifecycle).toBe('pending');
    state = expireDecisionEvents(state, 30001, 's');
    expect(state.events[0].lifecycle).toBe('ended_unresolved');
    const result = apply(state, 2, 31000);
    expect(result.events).toHaveLength(2); expect(result.events[0].lifecycle).toBe('ended_unresolved');
    expect(result.events[0].id).not.toBe(result.events[1].id);
  });
  it('old and expired frames are audit only', () => {
    const state = alarm(), obs = observation(3, 2000); obs.receivedMonotonicAt = 32001;
    const result = applyEventObservation(state, obs);
    expect(result.audit[result.audit.length - 1]?.reason).toBe('expired-frame');
    expect(result.events[0].grade).toBe('A');
  });
  it('rejects fabricated frame references and malformed geometry at business boundary', () => {
    const obs = observation(1, 0); obs.output!.candidates[0].evidenceFrameIds = ['invented'];
    expect(() => applyEventObservation(emptyDecisionState(), obs)).toThrow('Untrusted');
    obs.output!.candidates[0] = candidate(1, 85, { box: { x: 0.9, y: 0.1, width: 0.2, height: 0.2 } });
    expect(() => applyEventObservation(emptyDecisionState(), obs)).toThrow();
  });
  it('uses true maximum-weight matching rather than greedy highest-edge first', () => {
    expect(maximumWeightAssignment([[0.9, 0.8], [0.85, 0]])).toEqual([[0, 1], [1, 0]]);
    expect(maximumWeightAssignment([[0, 0], [0, 0]])).toEqual([]);
    expect(maximumWeightAssignment(Array.from({ length: 2000 }, () => []))).toEqual([]);
    const large = Array.from({ length: 2000 }, (_, i) => [i === 1999 ? 1 : 0]);
    expect(maximumWeightAssignment(large)).toEqual([[1999, 0]]);
    expect(maximumWeightAssignment([[0.4], [0.8]])).toEqual([[1, 0]]);
    expect(maximumWeightAssignment([[1, 1], [1, 1]])).toEqual([[0, 0], [1, 1]]);
  });
  it('separates multiple instances and subtypes with one-to-one association', () => {
    const obs = observation(1, 0);
    obs.output!.candidates.push(candidate(1, 65, { id: 'c2', box: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 } }));
    let state = applyEventObservation(emptyDecisionState(), obs);
    const next = observation(2, 1000); next.output!.candidates = obs.output!.candidates.map((c) => ({ ...c, evidenceFrameIds: ['f2'] }));
    state = applyEventObservation(state, next);
    expect(state.events).toHaveLength(2); expect(state.events.map((e) => e.grade)).toEqual(['A', 'B']);
  });
  it('limits fixed-region duplicates and validates region registration', () => {
    const regionConfig = { ...config, regions: [{ id: 'r', cameraId: 'cam', box: { x: 0, y: 0, width: 1, height: 1 }, sceneFactor: 1.4, environment: 0.5 }] };
    const obs = observation(1, 0); obs.output!.candidates[0].regionId = 'r';
    obs.output!.candidates.push(candidate(1, 85, { id: 'c2', regionId: 'r' }));
    const state = applyEventObservation(emptyDecisionState(), obs, regionConfig);
    expect(state.events).toHaveLength(1); expect(state.review[0].reason).toBe('duplicate-region');
    expect(state.events[0].environmentMissing).toBe(false);
    expect(() => applyEventObservation(emptyDecisionState(), obs)).toThrow('Unregistered');
  });
  it('history includes only deduplicated human-confirmed prior same-region events', () => {
    const event = { ...alarm().events[0], regionId: 'r' };
    const old: DecisionEvent = { ...event, id: 'old', confirmedAt: 1000 };
    const wrong = { ...old, id: 'wrong', regionId: 'other' };
    const exact = config.historyWeight * Math.exp(-1000 / config.historyDecayMs);
    expect(historyTerm([old, old, wrong, event], event, 2000, config)).toBeCloseTo(exact, 12);
    expect(historyTerm([old], { ...event, regionId: null }, 2000, config)).toBe(0);
    expect(historyTerm([{ ...old, confirmedAt: 2000 }], event, 2000, config)).toBe(0);
    expect(historyTerm([{ ...old, confirmedAt: null }], event, 2000, config)).toBe(0);
  });
  it('rejects impossible config ordering and invalid host clocks', () => {
    expect(() => validateDecisionConfig({ ...config, freshMs: 40000 })).toThrow();
    const obs = observation(1, 0); obs.context.sequence = NaN;
    expect(() => applyEventObservation(emptyDecisionState(), obs)).toThrow();
  });
  it('clears first high-score prompt on failure, unknown and low-quality interruption', () => {
    for (const kind of ['failure', 'unknown', 'low'] as const) {
      const first = apply(emptyDecisionState(), 1, 0);
      const obs = observation(2, 1000, kind === 'unknown' ? null : 85);
      if (kind === 'failure') obs.status = 'failure';
      if (kind === 'low') obs.output!.candidates[0].confidence = 0.1;
      const result = applyEventObservation(first, obs);
      expect(result.events[0].firstAlert).toBe(false);
    }
  });
  it('ends old fixed-region identity before a positive reappears after association gap', () => {
    const cfg = { ...config, regions: [{ id: 'r', cameraId: 'cam', box: { x: 0, y: 0, width: 1, height: 1 }, sceneFactor: 1, environment: null }] };
    const first = observation(1, 0); first.output!.candidates[0].regionId = 'r';
    let state = applyEventObservation(emptyDecisionState(), first, cfg);
    const absent = observation(2, 20000, null);
    absent.output!.eventChecks = [{ eventId: state.events[0].id, verdict: 'absent', regionVisible: true, evidenceFrameIds: ['f2'] }];
    state = applyEventObservation(state, absent, cfg);
    const next = observation(3, 35000); next.output!.candidates[0].regionId = 'r';
    state = applyEventObservation(state, next, cfg);
    expect(state.events).toHaveLength(2);
    expect(state.events[0].lifecycle).toBe('ended_unresolved'); expect(state.events[1].lifecycle).toBe('pending');
  });
  it('permits spaced valid negatives after old positive to finish gradual clearance', () => {
    let state = alarm();
    for (let i = 3; i <= 8; i++) state = negative(state, i, (i - 2) * 20000);
    expect(state.events).toHaveLength(1); expect(state.events[0].lifecycle).toBe('observationally_cleared');
  });
  it('low-confidence candidate conflicts conservatively with absent, not an automatic safe result', () => {
    let state = negative(apply(emptyDecisionState(), 1, 0), 2, 1000);
    const obs = observation(3, 2000); obs.output!.candidates[0].confidence = 0.1;
    obs.output!.eventChecks = [{ eventId: state.events[0].id, verdict: 'absent', regionVisible: true, evidenceFrameIds: ['f3'] }];
    state = applyEventObservation(state, obs);
    expect(state.events[0]).toMatchObject({ lifecycle: 'pending', health: 'review', absentCount: 0 });
  });

});
