/**
 * 行为夹具计算层：期望值由 shared/ 的**活实现**实算产出。
 * 三方消费：生成器（落盘 shared/fixtures/*.json）、JS 单测（反查活实现，双向锁定）、
 * Rust（src-tauri/crates/proxy/src/fixtures.rs include_str! 同一份 JSON）。
 * 与 contract.json（纯契约常量）分离：改用例不产生契约文件全量 diff。
 */
import { parseBoolean, parseInteger } from './envParsers.js';
import { loadVlmRuntimeConfig } from './vlmRuntimeConfig.js';
import { VLM_RESPONSE_FORMAT } from './vlmResponseSchema.js';
import { EVENT_RESPONSE_FORMAT } from './eventResponseSchema.js';
import {
  buildOllamaRequestBody,
  buildQwenFallbackRequestBody,
  buildQwenRequestBody
} from './vlmRequestBody.js';
import { resolveOllamaHealthStatus } from './ollamaHealthStatus.js';

const BUILDERS = {
  buildQwenRequestBody,
  buildQwenFallbackRequestBody,
  buildOllamaRequestBody
};

/**
 * 环境解析共享用例：JS 与 Rust 双实现共用同一组期望（防静默漂移）。
 */
export function buildEnvCases() {
  return {
    parseBoolean: [
      { value: undefined, fallback: false },
      { value: undefined, fallback: true },
      { value: '', fallback: false },
      { value: '', fallback: true },
      { value: 'true', fallback: false },
      { value: 'TRUE', fallback: false },
      { value: 'True', fallback: false },
      { value: 'false', fallback: true },
      { value: '1', fallback: false },
      { value: 'yes', fallback: false }
    ].map((item) => ({ ...item, expected: parseBoolean(item.value, item.fallback) })),
    parseInteger: [
      { value: undefined, fallback: 7, min: 1 },
      { value: null, fallback: 7, min: 1 },
      { value: '', fallback: 7, min: 1 },
      { value: '42', fallback: 7, min: 1 },
      { value: '1e3', fallback: 7, min: 1 },
      { value: '3.5', fallback: 7, min: 1 },
      { value: '0', fallback: 7, min: 1 },
      { value: 'abc', fallback: 7, min: 1 },
      { value: '-5', fallback: 7, min: 0 },
      { value: '  12  ', fallback: 7, min: 1 },
      { value: '99', fallback: 7, min: 100 }
    ].map((item) => ({ ...item, expected: parseInteger(item.value, item.fallback, item.min) })),
    vlmRuntimeConfig: [
      { env: {} },
      { env: { VLM_HOST: 'localhost', VLM_PORT: '12345', VLM_MODEL: 'custom-alias' } },
      { env: { VLM_HOST: 'evil.example.com', VLM_PORT: 'not-a-number' } },
      { env: { VLM_FORCE_CPU: 'true', VLM_GPU_LAYERS: '40' } },
      { env: { VLM_CACHE_TYPE_K: 'q8_0', VLM_CACHE_TYPE_V: 'bogus' } },
      { env: { VLM_CONTEXT_SIZE: '300', VLM_BATCH_SIZE: '8', VLM_UBATCH_SIZE: '4' } },
      { env: { VLM_MTP_ENABLED: 'true', VLM_MTP_DRAFT_TOKENS: '6' } },
      { env: { VLM_STARTUP_TIMEOUT_MS: '9000' } }
    ].map((item) => ({ env: item.env, expected: loadVlmRuntimeConfig(item.env) })),
    // VLM 健康状态映射（shared/ollamaHealthStatus.js 实算）：
    // JS 与 Rust（crws-core#resolve_ollama_health_status）双端同语义锁定的期望源。
    healthStatus: [200, 201, 404, 500, 503, 504].map((statusCode) => ({
      statusCode,
      expected: resolveOllamaHealthStatus(statusCode)
    })),
    // Node `bytes` 包语义的请求体上限解析（JS 侧由 express.json 消费，Rust 侧自行解析；
    // 期望值手写，但两端的断言都读这份 JSON）。
    bodyLimits: [
      { value: '2mb', expected: 2097152 },
      { value: '1b', expected: 1 },
      { value: '6KB', expected: 6144 },
      { value: '100', expected: 100 },
      { value: '1.5mb', expected: 1572864 },
      { value: '2gb', expected: 2147483648 },
      { value: 'nonsense', expected: null },
      { value: '', expected: null }
    ]
  };
}

/**
 * 上游请求体裁决共享用例：Rust upstream 模块重写同一裁决时用同一组 fixture 锁死。
 * 含键序敏感白名单行为（ollama-key-order-sensitive-*）：
 * Rust 侧必须用规范化 JSON 文本比较复刻 JSON.stringify 的键序语义，不得用 Value 相等。
 */
export function buildRequestBodyCases() {
  const eventFormatReordered = {
    json_schema: EVENT_RESPONSE_FORMAT.json_schema,
    type: 'json_schema'
  };

  const caseDefs = [
    {
      name: 'qwen-forces-configured-model',
      builder: 'buildQwenRequestBody',
      args: [{ messages: [], model: 'custom' }, 'qwen-default']
    },
    {
      name: 'qwen-fallback-downgrades-schema-and-disables-stream',
      builder: 'buildQwenFallbackRequestBody',
      args: [
        {
          model: 'local-vlm',
          stream: true,
          response_format: VLM_RESPONSE_FORMAT,
          chat_template_kwargs: { enable_thinking: false },
          messages: [{ role: 'user', content: 'ok' }]
        },
        'glm-4v-flash'
      ]
    },
    {
      name: 'ollama-rewrites-model-and-whitelist-format',
      builder: 'buildOllamaRequestBody',
      args: [{ model: 'stale-browser-model', messages: [{ role: 'user', content: 'ok' }] }, 'local-vlm']
    },
    {
      name: 'ollama-event-format-passes-through-exactly',
      builder: 'buildOllamaRequestBody',
      args: [{ response_format: EVENT_RESPONSE_FORMAT }, 'model']
    },
    {
      name: 'ollama-arbitrary-format-replaced-by-whitelist',
      builder: 'buildOllamaRequestBody',
      args: [{ response_format: { type: 'arbitrary' } }, 'model']
    },
    {
      name: 'ollama-key-order-sensitive-whitelist-replaces-reordered-event-format',
      builder: 'buildOllamaRequestBody',
      args: [{ response_format: eventFormatReordered }, 'model']
    },
    {
      name: 'ollama-merges-thinking-kwargs',
      builder: 'buildOllamaRequestBody',
      args: [
        {
          response_format: { type: 'text' },
          chat_template_kwargs: { other: true, enable_thinking: true },
          messages: [{ role: 'user', content: 'ok' }]
        },
        'local-vlm'
      ]
    }
  ];

  return caseDefs.map(({ name, builder, args }) => ({
    name,
    builder,
    args,
    expected: BUILDERS[builder](...args.map((arg) => structuredClone(arg)))
  }));
}

/**
 * 载荷校验规则夹具计算层：期望 verdict 由发布路径（server/qwenProxy.js 的
 * validateChatCompletionPayload —— JS 语义为准）实算产出。
 * 双端消费：server/qwenProxy.test.js（直调校验函数）与
 * crates/proxy/src/payload.rs 单测（validate_chat_completion_payload）——
 * null/布尔/字符串形态在此穷举；HTTP golden 只保留可确定观测的拒绝类。
 */
import {
  DISALLOWED_TOKEN_LIMIT_FIELDS,
  PAYLOAD_VALIDATION_DEFAULTS,
  validateChatCompletionPayload
} from './payloadValidation.js';

export function buildPayloadValidationCases() {
  // 阈值随夹具落盘（双端各读夹具里的 config，不各持一份硬编码）
  const config = { ...PAYLOAD_VALIDATION_DEFAULTS };

  const defs = [
    { name: 'accepts-clean-body', body: { messages: [{ role: 'user', content: 'ok' }], stream: false } },
    { name: 'accepts-absent-optional-fields', body: { messages: [{ role: 'user', content: 'ok' }] } },
    { name: 'accepts-n-one', body: { messages: [{ role: 'user', content: 'ok' }], n: 1 } },
    { name: 'accepts-best-of-one', body: { messages: [{ role: 'user', content: 'ok' }], best_of: 1 } },
    { name: 'accepts-null-max-tokens', body: { messages: [{ role: 'user', content: 'ok' }], max_tokens: null } },
    { name: 'accepts-string-max-tokens-like-js-number', body: { messages: [{ role: 'user', content: 'ok' }], max_tokens: '99' } },
    { name: 'rejects-stream-null', body: { messages: [{ role: 'user', content: 'ok' }], stream: null } },
    { name: 'rejects-stream-true', body: { messages: [{ role: 'user', content: 'ok' }], stream: true } },
    { name: 'rejects-n-null', body: { messages: [{ role: 'user', content: 'ok' }], n: null } },
    { name: 'rejects-n-false', body: { messages: [{ role: 'user', content: 'ok' }], n: false } },
    { name: 'rejects-n-two', body: { messages: [{ role: 'user', content: 'ok' }], n: 2 } },
    { name: 'rejects-best-of-null', body: { messages: [{ role: 'user', content: 'ok' }], best_of: null } },
    { name: 'rejects-max-tokens-string-non-numeric', body: { messages: [{ role: 'user', content: 'ok' }], max_tokens: 'abc' } },
    { name: 'rejects-max-tokens-zero', body: { messages: [{ role: 'user', content: 'ok' }], max_tokens: 0 } },
    { name: 'rejects-empty-messages', body: { messages: [] } },
    ...DISALLOWED_TOKEN_LIMIT_FIELDS.map((field) => ({
      name: `rejects-disallowed-field-${field}`,
      body: { messages: [{ role: 'user', content: 'ok' }], [field]: 100 }
    }))
  ];

  return {
    config: { ...PAYLOAD_VALIDATION_DEFAULTS },
    cases: defs.map(({ name, body }) => {
      const verdict = validateChatCompletionPayload(body, config);
      return { name, body, expected: verdict };
    })
  };
}
