import { http } from '@/services/http';
import { OLLAMA_CHAT_COMPLETIONS_ROUTE } from '../../../shared/apiRoutes.js';
import { DEFAULT_VLM_MODEL_ALIAS } from '../../../shared/vlmModelConfig.js';
import { VlmResponseError, normalizeVlmModelSource } from './ollamaClient';
import { boxContains, validBox } from '@/services/events/decisionEngine';
import type { DecisionEvent, EventFrameContext, EventModelOutput, RegisteredRegion } from '@/types/riskEvents';

import { EVENT_OUTPUT_SCHEMA, EVENT_RESPONSE_FORMAT } from '../../../shared/eventResponseSchema.js';
export { EVENT_OUTPUT_SCHEMA };
export const EVENT_SYSTEM_PROMPT = `你是社区视频当前帧观测模块。只返回符合Schema的一个JSON对象。所有文本只描述本次图像可见事实；禁止身份、意图、违法或医学定论，禁止历史、反复、持续时长、轨迹和先后过程推断。证据引用只能是请求提供的frameId，宿主机管理时间和事件ID。
每个风险实例输出一个candidate，框box是原图归一化x/y/width/height，必须在图内。category取fire/security/assistance/environment/facility。subtype使用稳定简短子类型名称。固定设施仅可引用登记的regionId，框必须在区域内；未登记区域必须null，绝不自行编造区域。
语义评分为三维0到100工程规则（非标定概率）：consequence为可见后果严重度，0无危险线索、25轻微物损线索、50可致财产损失/轻伤、75可致重伤、100生命威胁可见线索；exposure为可见暴露，0无暴露、25单一局部物体、50一人/局部通道、75多人/主要通道、100大量人员/关键疏散口；urgency为处置紧迫性，0无需处置、25例行核查、50应尽快核查、75应立即现场核查、100可见紧急危险需立即联络人工救援。允许中间值，依据不足则低confidence，不能编造分数依据。宿主机权重0.5/0.3/0.2，模型不输出最终等级。
逐项复查请求中的活跃事件：有对应候选为present；只有原区域全部清晰可见且没有该风险才能absent，regionVisible=true；遮挡、画外或信息不足为unknown。不要因没有新候选而批量absent。不认识的事件ID不得输出。activeEvents为空时eventChecks必须是空数组；frameId只可用于evidenceFrameIds，绝不能当作eventId。没有候选时candidates仍必须输出空数组，四个顶层字段无论是否有风险都不可省略。单帧跌倒姿态只能称疑似倒地，不能判断持续未起身。画面模糊、黑白屏或信息不足时quality=uncertain，不能报告clear正常。summary具体描述当前画面。`;

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: unknown, expected: string[]): v is RecordValue {
  return record(v) && Object.keys(v).length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(v, key));
}
const string = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 600;
const finite = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
// Conservative lexical guard, not proof that the remaining visual descriptions are true.
const TEMPORAL_ASSERTION = /(?:十分钟前|分钟前|小时前|此前|先前|反复|持续|一直|往返|轨迹|已经|曾经|再次|多次|\d+\s*(?:秒|分钟|小时|天)|\b(?:ago|previously|earlier|repeatedly|persistently|continuously|trajectory|again|for\s+\d+\s*(?:seconds?|minutes?|hours?))\b)/i;
export function buildEventRequest(image: string, cameraId: string, scene: string, context: EventFrameContext, activeEvents: DecisionEvent[], regions: RegisteredRegion[]): Record<string, unknown> {
  if (context.cameraId !== cameraId) throw new VlmResponseError('Host camera mismatch');
  return {
    model: DEFAULT_VLM_MODEL_ALIAS, temperature: 0.15, max_tokens: 1600, stream: false,
    response_format: EVENT_RESPONSE_FORMAT, chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: 'system', content: EVENT_SYSTEM_PROMPT }, { role: 'user', content: [
      { type: 'text', text: JSON.stringify({ cameraId, scene, frameId: context.frameId,
        activeEvents: activeEvents.filter((e) => e.cameraId === cameraId && (e.lifecycle === 'active' || e.lifecycle === 'pending')).slice(0, 32).map((e) => ({ eventId: e.id, category: e.category, subtype: e.subtype, box: e.box, regionId: e.regionId })),
        registeredRegions: regions.filter((r) => r.cameraId === cameraId) }) },
      { type: 'image_url', image_url: { url: image } }
    ] }]
  };
}
export function parseEventChatResponse(data: unknown, context: EventFrameContext, activeEvents: DecisionEvent[], regions: RegisteredRegion[]): EventModelOutput {
  const fail = (): never => { throw new VlmResponseError('事件响应结构、来源或单帧证据无效'); };
  if (!record(data) || !Array.isArray(data.choices) || data.choices.length !== 1) return fail();
  const choice = data.choices[0];
  if (!record(choice) || choice.finish_reason !== 'stop' || !record(choice.message) || choice.message.role !== 'assistant' ||
    (choice.message.refusal != null && choice.message.refusal !== '') ||
    (choice.message.reasoning_content != null && choice.message.reasoning_content !== '') || typeof choice.message.content !== 'string' || choice.message.content.length > 128000) return fail();
  let output: unknown;
  try { output = JSON.parse(choice.message.content); } catch { return fail(); }
  if (!keys(output, ['quality', 'summary', 'candidates', 'eventChecks']) ||
    !['clear', 'uncertain'].includes(output.quality as string) || !string(output.summary) || TEMPORAL_ASSERTION.test(output.summary) ||
    !Array.isArray(output.candidates) || output.candidates.length > 32 || !Array.isArray(output.eventChecks) || output.eventChecks.length > 32) return fail();
  const referenced = (v: unknown) => Array.isArray(v) && v.length === 1 && v[0] === context.frameId;
  const candidateIds = new Set<string>(), checkIds = new Set<string>();
  for (const candidate of output.candidates) {
    if (!keys(candidate, ['id', 'category', 'subtype', 'confidence', 'scores', 'observation', 'evidenceFrameIds', 'box', 'regionId']) ||
      !string(candidate.id) || candidateIds.has(candidate.id) || !string(candidate.subtype) || TEMPORAL_ASSERTION.test(candidate.subtype) ||
      !['fire', 'security', 'assistance', 'environment', 'facility'].includes(candidate.category as string) ||
      !finite(candidate.confidence, 1) || !string(candidate.observation) || TEMPORAL_ASSERTION.test(candidate.observation) || !referenced(candidate.evidenceFrameIds) ||
      !keys(candidate.scores, ['consequence', 'exposure', 'urgency']) || !Object.values(candidate.scores).every((v) => finite(v, 100)) ||
      !keys(candidate.box, ['x', 'y', 'width', 'height']) || !validBox(candidate.box as unknown as EventModelOutput['candidates'][number]['box']) ||
      !(candidate.regionId === null || string(candidate.regionId))) return fail();
    candidateIds.add(candidate.id);
    if (candidate.regionId !== null) {
      const region = regions.find((r) => r.cameraId === context.cameraId && r.id === candidate.regionId);
      if (!region || !boxContains(region.box, candidate.box as unknown as EventModelOutput['candidates'][number]['box'])) return fail();
    }
  }
  const allowed = new Set(activeEvents.filter((e) => e.cameraId === context.cameraId && (e.lifecycle === 'active' || e.lifecycle === 'pending')).slice(0, 32).map((e) => e.id));
  for (const check of output.eventChecks) {
    if (!keys(check, ['eventId', 'verdict', 'regionVisible', 'evidenceFrameIds']) || !string(check.eventId) || !allowed.has(check.eventId) || checkIds.has(check.eventId) ||
      !['present', 'absent', 'unknown'].includes(check.verdict as string) || typeof check.regionVisible !== 'boolean' || !referenced(check.evidenceFrameIds) ||
      (check.verdict === 'absent' && !check.regionVisible)) return fail();
    checkIds.add(check.eventId);
  }
  return output as unknown as EventModelOutput;
}
export async function analyzeEventFrame(image: string, cameraId: string, scene: string, context: EventFrameContext, activeEvents: DecisionEvent[], regions: RegisteredRegion[], signal?: AbortSignal) {
  const response = await http.post(OLLAMA_CHAT_COMPLETIONS_ROUTE, buildEventRequest(image, cameraId, scene, context, activeEvents, regions), { signal });
  return { output: parseEventChatResponse(response.data, context, activeEvents, regions), modelSource: normalizeVlmModelSource(response.headers?.['x-vlm-source']) };
}
