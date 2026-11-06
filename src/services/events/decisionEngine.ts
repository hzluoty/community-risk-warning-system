import type {
  DecisionConfig, DecisionEvent, DecisionState, EventBox, EventCandidate,
  EventFrameContext, EventGrade, EventObservation, SemanticScores
} from '@/types/riskEvents';

/** Engineering configuration, not learned/calibrated severity or accident probability. */
export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  version: 'event-rules-v1', freshMs: 30000, gapMs: 30000,
  confidence: 0.6, iouThreshold: 0.3, regions: [],
  historyWindowMs: 30 * 86400000, historyDecayMs: 7 * 86400000, historyWeight: 0.2
};
export const EVENT_SESSION_ID = globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random()}`;
export const emptyDecisionState = (): DecisionState => ({ events: [], watermarks: {}, audit: [], review: [], nextId: 1 });
let hostSequence = 0;
export function createEventFrameContext(cameraId: string, capturedAt: number, capturedMonotonicAt: number, modelVersion: string): EventFrameContext {
  const sequence = ++hostSequence;
  return { cameraId, capturedAt, capturedMonotonicAt, modelVersion, sequence,
    sessionId: EVENT_SESSION_ID, frameId: `${EVENT_SESSION_ID}:${sequence}` };
}
const GRADES: EventGrade[] = ['Normal', 'C', 'B', 'A'];
const EXIT = [0, 35, 54, 72];
const live = (event: DecisionEvent) => event.lifecycle === 'pending' || event.lifecycle === 'active';
const clip = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));

export function validateDecisionConfig(config: DecisionConfig): void {
  if (!config.version || !Number.isFinite(config.freshMs) || config.freshMs <= 0 ||
    !Number.isFinite(config.gapMs) || config.gapMs < config.freshMs ||
    !Number.isFinite(config.confidence) || config.confidence < 0 || config.confidence > 1 ||
    !Number.isFinite(config.iouThreshold) || config.iouThreshold <= 0 || config.iouThreshold > 1 ||
    !Number.isFinite(config.historyWindowMs) || config.historyWindowMs <= 0 ||
    !Number.isFinite(config.historyDecayMs) || config.historyDecayMs <= 0 ||
    !Number.isFinite(config.historyWeight) || config.historyWeight < 0 ||
    config.regions.length > 32) throw new Error('Invalid event decision configuration');
  const ids = new Set<string>();
  for (const region of config.regions) {
    const key = JSON.stringify([region.cameraId, region.id]);
    if (!region.id || !region.cameraId || ids.has(key) || !validBox(region.box) ||
      !Number.isFinite(region.sceneFactor) || region.sceneFactor <= 0 ||
      (region.environment !== null && (!Number.isFinite(region.environment) || region.environment < 0 || region.environment > 1))) {
      throw new Error('Invalid registered region');
    }
    ids.add(key);
  }
}
export function validBox(box: EventBox): boolean {
  return !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 &&
    box.x + box.width <= 1 && box.y + box.height <= 1;
}
export function boxContains(outer: EventBox, inner: EventBox): boolean {
  return validBox(outer) && validBox(inner) && inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width + 1e-12 &&
    inner.y + inner.height <= outer.y + outer.height + 1e-12;
}
export function boxIou(a: EventBox, b: EventBox): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}
export function semanticBase(scores: SemanticScores): number {
  if (![scores.consequence, scores.exposure, scores.urgency].every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) {
    throw new Error('Invalid semantic scores');
  }
  return 0.5 * scores.consequence + 0.3 * scores.exposure + 0.2 * scores.urgency;
}
export function calculateCri(base: number, scene: number, durationSeconds: number, history: number, environment: number): number {
  if (![base, scene, durationSeconds, history, environment].every(Number.isFinite) ||
    base < 0 || base > 100 || scene <= 0 || durationSeconds < 0 || history < 0 || history > 1 || environment < 0 || environment > 1) {
    throw new Error('Invalid CRI input');
  }
  const time = clip(Math.log1p(durationSeconds / 30) / Math.log(11));
  return clip(100 * clip(scene * base / 100) * (1 + 0.2 * time + 0.1 * history + 0.1 * environment), 0, 100);
}
export function historyTerm(events: DecisionEvent[], event: DecisionEvent, now: number, config: DecisionConfig): number {
  if (event.regionId === null) return 0;
  const seen = new Set<string>();
  let sum = 0;
  for (const previous of events) {
    if (previous.id === event.id || seen.has(previous.id) || previous.cameraId !== event.cameraId ||
      previous.regionId !== event.regionId || previous.subtype !== event.subtype || previous.category !== event.category ||
      previous.confirmedAt === null || previous.confirmedAt < now - config.historyWindowMs || previous.confirmedAt >= now) continue;
    seen.add(previous.id);
    sum += Math.exp(-(now - previous.confirmedAt) / config.historyDecayMs);
  }
  return clip(config.historyWeight * sum);
}
function resetConfirmation(event: DecisionEvent): void {
  event.previousScore = null;
  event.downCount = 0;
  event.absentCount = 0;
  event.firstAlert = false;
}
export function advanceGrade(event: DecisionEvent, score: number): void {
  const instant = (value: number) => value >= 80 ? 3 : value >= 60 ? 2 : value >= 40 ? 1 : 0;
  const current = GRADES.indexOf(event.grade);
  const up = event.previousScore === null ? 0 : Math.min(instant(event.previousScore), instant(score));
  if (up > current) {
    event.grade = GRADES[up]; event.downCount = 0;
  } else if (current > 0 && score < EXIT[current]) {
    event.downCount++;
    if (event.downCount >= 2) {
      event.grade = GRADES[current - 1];
      event.previousScore = null; event.downCount = 0;
      return;
    }
  } else event.downCount = 0;
  event.previousScore = score;
}

/** Hungarian assignment: maximum total weight after removing forbidden edges (zero weight). */
export function maximumWeightAssignment(weights: number[][]): [number, number][] {
  const rows = weights.length, cols = weights[0]?.length ?? 0;
  if (!rows || !cols) return [];
  // Rectangular Hungarian: iterate the smaller side instead of padding thousands of events
  // to a square matrix for a response containing at most 32 candidates.
  const transposed = rows > cols;
  const count = Math.min(rows, cols), width = Math.max(rows, cols);
  const weight = (i: number, j: number) => transposed ? weights[j][i] : weights[i][j];
  const u = Array(count + 1).fill(0), v = Array(width + 1).fill(0);
  const p = Array(width + 1).fill(0), way = Array(width + 1).fill(0);
  for (let i = 1; i <= count; i++) {
    p[0] = i;
    let j0 = 0;
    const min = Array(width + 1).fill(Infinity), used = Array(width + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= width; j++) if (!used[j]) {
        const cost = -weight(i0 - 1, j - 1) - u[i0] - v[j];
        if (cost < min[j]) { min[j] = cost; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      for (let j = 0; j <= width; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else min[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const result: [number, number][] = [];
  for (let j = 1; j <= width; j++) if (p[j] && weight(p[j] - 1, j - 1) > 0) {
    result.push(transposed ? [j - 1, p[j] - 1] : [p[j] - 1, j - 1]);
  }
  return result.sort((a, b) => a[0] - b[0]);
}
export function expireDecisionEvents(state: DecisionState, nowMono: number, sessionId: string, config = DEFAULT_DECISION_CONFIG): DecisionState {
  validateDecisionConfig(config);
  return { ...state, events: state.events.map((original) => {
    const event = { ...original };
    if (live(event) && (event.sessionId !== sessionId || nowMono - event.lastValidMono > config.gapMs)) {
      event.lifecycle = 'ended_unresolved'; event.health = 'stale'; resetConfirmation(event);
    } else if (live(event) && nowMono - event.lastValidMono > config.freshMs) event.health = 'stale';
    return event;
  }) };
}
export function applyEventObservation(previous: DecisionState, observation: EventObservation, config = DEFAULT_DECISION_CONFIG): DecisionState {
  validateDecisionConfig(config);
  const { context, receivedMonotonicAt: now, output } = observation;
  if (!Number.isSafeInteger(context.sequence) || context.sequence < 1 ||
    ![now, context.capturedMonotonicAt, context.capturedAt].every(Number.isFinite) ||
    context.capturedMonotonicAt < 0 || !context.sessionId || !context.frameId || !context.cameraId || !context.modelVersion) {
    throw new Error('Invalid host frame context');
  }
  const state = expireDecisionEvents(previous, now, context.sessionId, config);
  state.watermarks = { ...previous.watermarks };
  state.audit = [...previous.audit]; state.review = [...previous.review];
  const audit = (reason: string) => {
    state.audit.push({ frameId: context.frameId, cameraId: context.cameraId, reason });
    state.audit = state.audit.slice(-500);
  };
  const key = JSON.stringify([context.sessionId, context.cameraId]);
  if (context.sequence <= (state.watermarks[key] ?? 0)) { audit('old-sequence'); return state; }
  if (now < context.capturedMonotonicAt || now - context.capturedMonotonicAt > config.freshMs) { audit('expired-frame'); return state; }
  state.watermarks[key] = context.sequence;
  let active = state.events.filter((event) => event.cameraId === context.cameraId && live(event)).sort((a, b) => a.id.localeCompare(b.id));
  if (observation.status === 'failure' || !output || output.quality !== 'clear') {
    for (const event of active) { resetConfirmation(event); event.health = observation.status === 'failure' ? 'failure' : 'review'; }
    audit(observation.status === 'failure' ? 'failure' : 'uncertain');
    return state;
  }
  // The production parser validates the complete protocol. Recheck provenance at the business boundary too.
  const candidates = output.candidates.slice().sort((a, b) => a.id.localeCompare(b.id));
  for (const candidate of candidates) {
    if (!validBox(candidate.box) || candidate.evidenceFrameIds.length !== 1 || candidate.evidenceFrameIds[0] !== context.frameId ||
      !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) throw new Error('Untrusted candidate');
    semanticBase(candidate.scores);
    if (candidate.regionId !== null) {
      const region = config.regions.find((r) => r.id === candidate.regionId && r.cameraId === context.cameraId);
      if (!region || !boxContains(region.box, candidate.box)) throw new Error('Unregistered region');
    }
  }
  // Valid negatives may continue a downgrade after the last positive ages out. Only a NEW
  // compatible positive beyond the association gap ends that old identity before creating another.
  for (const event of active) {
    const reappearance = candidates.some((candidate) => candidate.confidence >= config.confidence &&
      candidate.category === event.category && candidate.subtype === event.subtype && candidate.regionId === event.regionId &&
      (candidate.regionId !== null || boxIou(event.box, candidate.box) >= config.iouThreshold));
    if (reappearance && context.capturedMonotonicAt - event.lastPositiveMono > config.gapMs) {
      event.lifecycle = 'ended_unresolved'; event.health = 'stale'; resetConfirmation(event);
      audit(`association-gap:${event.id}`);
    }
  }
  active = active.filter(live);
  const matchedEvents = new Set<string>(), matchedCandidates = new Set<string>();
  const matches: [DecisionEvent, EventCandidate][] = [];
  const associate = (pool: EventCandidate[]) => {
    const available = active.filter((e) => !matchedEvents.has(e.id));
    const weights = available.map((event) => pool.map((candidate) => {
      if (candidate.category !== event.category || candidate.subtype !== event.subtype || candidate.regionId !== event.regionId ||
        context.capturedMonotonicAt - event.lastPositiveMono > config.gapMs) return 0;
      if (candidate.regionId !== null) return 1;
      const iou = boxIou(event.box, candidate.box);
      return iou >= config.iouThreshold ? iou : 0;
    }));
    for (const [i, j] of maximumWeightAssignment(weights)) {
      matchedEvents.add(available[i].id); matchedCandidates.add(pool[j].id); matches.push([available[i], pool[j]]);
    }
  };
  associate(candidates.filter((c) => c.confidence >= config.confidence));
  associate(candidates.filter((c) => c.confidence < config.confidence));
  const review = (candidate: EventCandidate, reason: string) => state.review.push({ frameId: context.frameId, candidateId: candidate.id, reason });
  for (const candidate of candidates) if (!matchedCandidates.has(candidate.id)) {
    if (candidate.confidence < config.confidence) { review(candidate, 'low-confidence'); continue; }
    if (candidate.regionId !== null && active.concat(matches.map(([e]) => e)).some((e) => e.regionId === candidate.regionId && e.subtype === candidate.subtype && e.category === candidate.category)) {
      review(candidate, 'duplicate-region'); continue;
    }
    const id = `EV-${context.sessionId}-${state.nextId++}`;
    const event: DecisionEvent = {
      id, cameraId: context.cameraId, category: candidate.category, subtype: candidate.subtype,
      regionId: candidate.regionId, box: { ...candidate.box }, grade: 'Normal', lifecycle: 'pending', health: 'fresh',
      handling: 'pending', confirmedAt: null, createdAt: context.capturedAt, updatedAt: context.capturedAt,
      sessionId: context.sessionId, lastPositiveMono: context.capturedMonotonicAt, lastValidMono: context.capturedMonotonicAt,
      segmentStartMono: null, previousScore: null, downCount: 0, absentCount: 0, score: 0, confidence: candidate.confidence, modelVersion: context.modelVersion, baseScore: 0,
      historyTerm: 0, environmentMissing: true, observation: candidate.observation, lastFrameId: context.frameId,
      firstAlert: false, configVersion: config.version
    };
    state.events.push(event); matches.push([event, candidate]); matchedEvents.add(id);
  }
  for (const [event, candidate] of matches) {
    if (candidate.confidence < config.confidence) { resetConfirmation(event); event.health = 'review'; review(candidate, 'low-confidence'); continue; }
    const region = config.regions.find((r) => r.cameraId === context.cameraId && r.id === candidate.regionId);
    event.segmentStartMono ??= context.capturedMonotonicAt;
    event.baseScore = semanticBase(candidate.scores);
    event.historyTerm = historyTerm(state.events, event, context.capturedAt, config);
    event.environmentMissing = region?.environment == null;
    event.score = calculateCri(event.baseScore, region?.sceneFactor ?? 1,
      Math.max(0, context.capturedMonotonicAt - event.segmentStartMono) / 1000, event.historyTerm, region?.environment ?? 0);
    const check = output.eventChecks.find((c) => c.eventId === event.id);
    if (check?.verdict === 'absent') audit(`positive-absent-conflict:${event.id}`);
    advanceGrade(event, event.score);
    event.firstAlert = event.grade === 'Normal' && event.score >= 80;
    if (event.grade !== 'Normal') event.lifecycle = 'active';
    event.lastPositiveMono = context.capturedMonotonicAt; event.lastValidMono = context.capturedMonotonicAt;
    event.confidence = candidate.confidence; event.modelVersion = context.modelVersion;
    event.updatedAt = context.capturedAt; event.health = 'fresh'; event.absentCount = 0;
    event.box = { ...candidate.box }; event.observation = candidate.observation; event.lastFrameId = context.frameId;
  }
  for (const event of active) if (!matchedEvents.has(event.id)) {
    const check = output.eventChecks.find((item) => item.eventId === event.id);
    // The host verifies geometry and exact frame reference; visibility is still a model declaration, not pixel truth.
    const absent = check?.verdict === 'absent' && check.regionVisible && validBox(event.box) &&
      check.evidenceFrameIds.length === 1 && check.evidenceFrameIds[0] === context.frameId;
    if (!absent) { resetConfirmation(event); event.health = 'unknown'; continue; }
    const wasAlarm = event.grade !== 'Normal';
    event.segmentStartMono = null; event.score = 0; event.absentCount++;
    advanceGrade(event, 0);
    event.health = 'fresh'; event.lastValidMono = context.capturedMonotonicAt;
    event.lastFrameId = context.frameId; event.updatedAt = context.capturedAt; event.firstAlert = false;
    event.observation = '当前帧对应区域可见，模型报告未见该风险；不表示人工办结';
    event.confidence = 0; event.modelVersion = context.modelVersion;
    if ((wasAlarm && event.grade === 'Normal') || (event.lifecycle === 'pending' && event.absentCount >= 2)) event.lifecycle = 'observationally_cleared';
  }
  state.review = state.review.slice(-200);
  audit('applied');
  return state;
}
