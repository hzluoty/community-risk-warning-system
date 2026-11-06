/**
 * chat 载荷校验与规范化 —— 跨端规则本体（发布路径语义）。
 * 从 server/qwenProxy.js 下沉到 shared/：JS 服务端（再导出）、渲染端测试、
 * Rust（crates/proxy/src/payload.rs，经 shared/fixtures/payloadValidation.json
 * 锁同一语义）三方共读。shared 层不依赖任何上层实现。
 */

/** 夹具与双端断言共用的阈值（与 loadQwenProxyConfig() 默认一致）—— 入契约防漂移。 */
export const PAYLOAD_VALIDATION_DEFAULTS = Object.freeze({
  maxChatMessages: 16,
  maxChatTokens: 2048
});

export const DISALLOWED_TOKEN_LIMIT_FIELDS = Object.freeze([
  'max_completion_tokens',
  'max_output_tokens',
  'max_new_tokens',
  'num_predict',
  'n_predict'
]);

export function validateChatCompletionPayload(body = {}, config = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'request body must be an object' };
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, message: 'messages must be a non-empty array' };
  }

  if (body.messages.length > config.maxChatMessages) {
    return { ok: false, message: 'messages exceeds the configured limit' };
  }

  for (const field of DISALLOWED_TOKEN_LIMIT_FIELDS) {
    if (body[field] !== undefined) {
      return { ok: false, message: `${field} is not supported; use max_tokens` };
    }
  }

  if (body.stream !== undefined && body.stream !== false) {
    return { ok: false, message: 'streaming responses are not supported' };
  }

  if (body.n !== undefined && body.n !== 1) {
    return { ok: false, message: 'n must be 1' };
  }

  if (body.best_of !== undefined && body.best_of !== 1) {
    return { ok: false, message: 'best_of must be 1' };
  }

  if (body.max_tokens !== undefined && body.max_tokens !== null) {
    const maxTokens = Number(body.max_tokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      return { ok: false, message: 'max_tokens must be a positive integer' };
    }

    if (maxTokens > config.maxChatTokens) {
      return { ok: false, message: 'max_tokens exceeds the configured limit' };
    }
  }

  return { ok: true };
}

export function normalizeChatCompletionPayload(body = {}, config = {}) {
  return {
    ...body,
    max_tokens:
      body.max_tokens === undefined || body.max_tokens === null
        ? config.maxChatTokens
        : Number(body.max_tokens),
    stream: false,
    ...(body.n === undefined ? {} : { n: 1 }),
    ...(body.best_of === undefined ? {} : { best_of: 1 })
  };
}
