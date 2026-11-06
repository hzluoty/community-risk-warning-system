/**
 * 上游请求体裁决 —— 服务端白名单规则的事实源。
 * 从 server/qwenProxy.js 下沉到 shared/：渲染端测试（eventRepository.test.ts）、
 * JS 服务端与 Rust 端（src-tauri/src/upstream/，用同一组 fixture 断言锁死）三方共用，
 * 避免"服务端裁决"在重构后变成两份实现。
 */
import { VLM_RESPONSE_FORMAT } from './vlmResponseSchema.js';
import { EVENT_RESPONSE_FORMAT } from './eventResponseSchema.js';

export function buildQwenRequestBody(body = {}, defaultModel) {
  return { ...body, model: defaultModel };
}

export function buildQwenFallbackRequestBody(body = {}, model) {
  const requestBody = {
    ...body,
    model,
    stream: false,
    response_format: { type: 'json_object' }
  };

  delete requestBody.chat_template_kwargs;
  return requestBody;
}

export function buildOllamaRequestBody(body = {}, model) {
  return {
    ...body,
    model,
    response_format: JSON.stringify(body.response_format) === JSON.stringify(EVENT_RESPONSE_FORMAT)
      ? EVENT_RESPONSE_FORMAT : VLM_RESPONSE_FORMAT,
    chat_template_kwargs: {
      ...(body.chat_template_kwargs || {}),
      enable_thinking: false
    }
  };
}
