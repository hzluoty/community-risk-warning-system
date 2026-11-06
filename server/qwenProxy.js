import express from 'express';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import http from 'node:http';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { resolveOllamaHealthStatus } from './ollamaHealthStatus.js';
import {
  API_HEALTH_ROUTE,
  OLLAMA_CHAT_COMPLETIONS_ROUTE,
  OLLAMA_STATUS_ROUTE,
  QWEN_CHAT_COMPLETIONS_ROUTE,
  TASKS_ROUTE_PREFIX
} from '../shared/apiRoutes.js';
import { DEFAULT_QWEN_VLM_API_MODEL, DEFAULT_VLM_MODEL_ALIAS } from '../shared/vlmModelConfig.js';
import { loadVlmRuntimeConfig } from '../shared/vlmRuntimeConfig.js';
import { parseBoolean, parseInteger } from '../shared/envParsers.js';
import { QWEN_ENDPOINTS, findQwenEndpointByKey } from '../shared/qwenEndpoints.js';
import { LOCAL_PROXY_TOKEN_HEADER } from '../shared/apiRoutes.js';
// 请求体裁决已下沉 shared/vlmRequestBody.js（渲染端测试 / JS 服务端 / Rust 三方共用）；
// 此处保留再导出以兼容旧导入路径（qwenProxy.test.js 等）。
export {
  buildOllamaRequestBody,
  buildQwenFallbackRequestBody,
  buildQwenRequestBody
} from '../shared/vlmRequestBody.js';
import {
  buildOllamaRequestBody,
  buildQwenFallbackRequestBody,
  buildQwenRequestBody
} from '../shared/vlmRequestBody.js';

// 鉴权头名再导出：唯一事实源在 shared/apiRoutes.js（跨端 wire 契约）。
export { LOCAL_PROXY_TOKEN_HEADER } from '../shared/apiRoutes.js';

const DEFAULT_CORS_ORIGINS = ['http://localhost:5173'];
const QWEN_TIMEOUT_OPTIONS_MS = [15_000, 30_000, 60_000, 90_000, 120_000];
const OLLAMA_TIMEOUT_OPTIONS_MS = [30_000, 60_000, 120_000, 180_000, 300_000];
const OLLAMA_HEALTH_TIMEOUT_MS = 3000;
const LOCAL_OLLAMA_HOST = '127.0.0.1';
const LOOPBACK_HOST_NAMES = new Set(['127.0.0.1', 'localhost']);
const DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
const UPSTREAM_RESPONSE_TOO_LARGE = 'UPSTREAM_RESPONSE_TOO_LARGE';
const DISALLOWED_TOKEN_LIMIT_FIELDS = [
  'max_completion_tokens',
  'max_output_tokens',
  'max_new_tokens',
  'num_predict',
  'n_predict'
];
/** 比赛任务回传通道挂载前缀：唯一事实源在 shared/apiRoutes.js（与 Rust 契约共用）。 */

function normalizeHost(host) {
  const trimmed = String(host || '').trim();
  return trimmed || '127.0.0.1';
}

function normalizeLoopbackHost(host) {
  const trimmed = String(host || '').trim();
  return LOOPBACK_HOST_NAMES.has(trimmed) ? trimmed : LOCAL_OLLAMA_HOST;
}

export function isLoopbackBindHost(host) {
  const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
    || (isIP(normalized) === 4 && normalized.startsWith('127.'));
}

function parseTimeoutOption(value, fallback, options) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < options[0]) {
    return fallback;
  }

  return options.find((option) => parsed <= option) ?? fallback;
}

function normalizeBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    return '';
  }

  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

// 端点匹配只走 shared 表反查（新增端点时只改表，不改分支）。
function resolveQwenEndpoint(rawBaseUrl) {
  const normalized = normalizeBaseUrl(rawBaseUrl);
  return (
    Object.values(QWEN_ENDPOINTS).find((endpoint) => endpoint.baseUrl === normalized) ?? {
      key: '',
      baseUrl: '',
      chatCompletionsUrl: ''
    }
  );
}

function fetchKnownQwenChatCompletions(endpointKey, init) {
  const endpoint = findQwenEndpointByKey(endpointKey);
  if (!endpoint) {
    throw new Error('Unsupported Qwen upstream endpoint');
  }

  return fetch(endpoint.chatCompletionsUrl, init);
}

function parseCorsOrigin(rawOrigin = 'http://localhost:5173') {
  const trimmed = rawOrigin.trim();
  if (trimmed === '*') {
    return [...DEFAULT_CORS_ORIGINS];
  }

  const origins = trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return origins.length > 0 ? origins : [...DEFAULT_CORS_ORIGINS];
}

export function isAllowedCorsOrigin(origin, corsOrigin, allowLocalFileOrigins = false) {
  if (!origin || origin === 'null' || origin.startsWith('file://')) {
    return allowLocalFileOrigins;
  }

  return Array.isArray(corsOrigin) && corsOrigin.includes(origin);
}

function createCorsOriginOption(config) {
  return (origin, callback) => {
    callback(null, isAllowedCorsOrigin(origin, config.corsOrigin, config.allowLocalFileOrigins));
  };
}

export function loadQwenProxyConfig(env = process.env) {
  const vlmRuntimeConfig = loadVlmRuntimeConfig(env);
  const qwenEndpoint = resolveQwenEndpoint(env.QWEN_BASE_URL);
  const ollamaHost = normalizeLoopbackHost(vlmRuntimeConfig.host);
  const ollamaPort = parseInteger(vlmRuntimeConfig.port, 11434, 1);

  return {
    host: normalizeHost(env.SERVER_HOST || '127.0.0.1'),
    port: parseInteger(env.SERVER_PORT, 8787),
    corsOrigin: parseCorsOrigin(env.CORS_ORIGIN || 'http://localhost:5173'),
    allowLocalFileOrigins: parseBoolean(env.ALLOW_LOCAL_FILE_ORIGINS, false),
    qwenEndpointKey: qwenEndpoint.key,
    qwenBaseUrl: qwenEndpoint.baseUrl,
    qwenChatCompletionsUrl: qwenEndpoint.chatCompletionsUrl,
    qwenApiKey: env.QWEN_API_KEY || '',
    qwenModel: env.QWEN_MODEL || DEFAULT_QWEN_VLM_API_MODEL,
    qwenTimeout: parseTimeoutOption(env.QWEN_TIMEOUT, 60_000, QWEN_TIMEOUT_OPTIONS_MS),
    allowCloudFallback: parseBoolean(env.ALLOW_CLOUD_FALLBACK, false),
    ollamaTimeout: parseTimeoutOption(env.OLLAMA_TIMEOUT, 120_000, OLLAMA_TIMEOUT_OPTIONS_MS),
    ollamaModel: vlmRuntimeConfig.modelAlias,
    requestBodyLimit: env.REQUEST_BODY_LIMIT || '2mb',
    chatRequestsPerMinute: parseInteger(env.CHAT_REQUESTS_PER_MINUTE, 30, 0),
    authAttemptsPerMinute: parseInteger(env.AUTH_ATTEMPTS_PER_MINUTE, 20, 0),
    statusRequestsPerMinute: parseInteger(env.STATUS_REQUESTS_PER_MINUTE, 60, 0),
    tasksRequestsPerMinute: parseInteger(env.TASKS_REQUESTS_PER_MINUTE, 120, 0),
    maxChatMessages: parseInteger(env.MAX_CHAT_MESSAGES, 16),
    maxChatTokens: parseInteger(env.MAX_CHAT_TOKENS, 2048),
    maxUpstreamResponseBytes: parseInteger(
      env.MAX_UPSTREAM_RESPONSE_BYTES,
      DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES,
      1024
    ),
    localProxyToken: env.LOCAL_PROXY_TOKEN || '',
    logModelOutput: parseBoolean(env.LOG_MODEL_OUTPUT, false),
    ollamaHost,
    ollamaPort,
    ollamaApiKey: env.VLM_API_KEY || '',
    ollamaBaseUrl: `http://${ollamaHost}:${ollamaPort}`
  };
}

export function isQwenProxyConfigured(config = loadQwenProxyConfig()) {
  return Boolean(config.qwenEndpointKey && config.qwenApiKey);
}

export function isCloudFallbackAvailable(config = loadQwenProxyConfig()) {
  return config.allowCloudFallback === true && isQwenProxyConfigured(config);
}

export function isLocalVlmTrusted(config = loadQwenProxyConfig()) {
  return typeof config.isLocalVlmTrusted !== 'function' || config.isLocalVlmTrusted() === true;
}

export function assertQwenProxySecurityConfig(config = loadQwenProxyConfig()) {
  if (!isLoopbackBindHost(config.host) && !config.localProxyToken) {
    throw new Error('LOCAL_PROXY_TOKEN is required when SERVER_HOST is not a loopback address');
  }

  if (!isLoopbackBindHost(config.host) && Buffer.byteLength(config.localProxyToken, 'utf8') < 32) {
    throw new Error('LOCAL_PROXY_TOKEN must be at least 32 bytes when SERVER_HOST is not a loopback address');
  }

  return config;
}

export function shouldFallbackToQwen(response) {
  return response.status === 404 || response.status >= 500;
}

export function resolveVlmProxyStatus(localStatus, config = loadQwenProxyConfig()) {
  if (localStatus.ready) {
    return { ...localStatus, source: 'local' };
  }

  if (isCloudFallbackAvailable(config)) {
    return {
      ready: true,
      status: 'ready',
      gpu: 'unknown',
      source: 'cloud-fallback'
    };
  }

  return { ...localStatus, source: 'local' };
}

export function parseProxyResponseText(text, onInvalidJson) {
  try {
    return JSON.parse(text);
  } catch {
    onInvalidJson?.(text);
    return { raw: text };
  }
}

export function buildProxyErrorResponse(error, options) {
  if (error?.code === UPSTREAM_RESPONSE_TOO_LARGE) {
    return {
      statusCode: 502,
      body: {
        error: {
          message: '上游响应超过代理允许的大小限制',
          type: 'upstream_response_too_large'
        }
      }
    };
  }

  const isAbortError = error instanceof Error && error.name === 'AbortError';
  return {
    statusCode: isAbortError ? 504 : 500,
    body: {
      error: {
        // 与 buildExpressErrorResponse 的掩码策略一致：5xx 不回传内部错误细节
        //（如 connect ECONNREFUSED 会暴露上游地址），仅在服务端日志可见。
        message: isAbortError ? options.timeoutMessage : options.fallbackMessage,
        type: isAbortError ? options.timeoutType : options.fallbackType
      }
    }
  };
}

function createUpstreamResponseTooLargeError(maxBytes) {
  return Object.assign(
    new Error(`Upstream response exceeds ${maxBytes} bytes`),
    { code: UPSTREAM_RESPONSE_TOO_LARGE }
  );
}

function createUpstreamAbortContext(req, res, timeoutMs) {
  const controller = new AbortController();
  let abortReason = null;
  let cleanedUp = false;

  const abort = (reason) => {
    if (controller.signal.aborted) {
      return;
    }

    abortReason = reason;
    controller.abort();
  };
  const onRequestAborted = () => abort('client');
  const onResponseClosed = () => {
    if (!res.writableEnded) {
      abort('client');
    }
  };
  const timer = setTimeout(() => abort('timeout'), timeoutMs);

  req.once('aborted', onRequestAborted);
  res.once('close', onResponseClosed);

  if (req.aborted || res.destroyed) {
    abort('client');
  }

  return {
    signal: controller.signal,
    get abortReason() {
      return abortReason;
    },
    cleanup() {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      clearTimeout(timer);
      req.off('aborted', onRequestAborted);
      res.off('close', onResponseClosed);
    }
  };
}

function isClientDisconnected(req, res, abortContext) {
  return abortContext?.abortReason === 'client' || req.aborted || res.destroyed;
}

async function readFetchResponseText(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.body?.cancel().catch(() => {});
    throw createUpstreamResponseTooLargeError(maxBytes);
  }

  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw createUpstreamResponseTooLargeError(maxBytes);
      }

      text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function requestLocalOllamaText(config, options) {
  const hostname = config.ollamaHost === 'localhost' ? 'localhost' : LOCAL_OLLAMA_HOST;

  return new Promise((resolve, reject) => {
    let settled = false;
    const upstreamRequest = http.request({
      hostname,
      port: config.ollamaPort,
      path: options.path,
      method: options.method,
      headers: {
        ...(config.ollamaApiKey ? { Authorization: `Bearer ${config.ollamaApiKey}` } : {}),
        ...options.headers
      },
      signal: options.signal
    }, (upstreamResponse) => {
      upstreamResponse.setEncoding('utf8');

      // 上游在响应头之后过早断开时，必须 fail fast，否则 promise 会悬挂到
      // 外层 AbortController 超时（默认 120s）才释放。
      const settleFromResponse = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      };
      upstreamResponse.on('error', settleFromResponse);
      upstreamResponse.on('aborted', () => settleFromResponse(new Error('Upstream response aborted')));

      let text = '';
      let totalBytes = 0;
      upstreamResponse.on('data', (chunk) => {
        if (settled) {
          return;
        }

        text += chunk;
        totalBytes += Buffer.byteLength(chunk, 'utf8');
        if (totalBytes > config.maxUpstreamResponseBytes) {
          settled = true;
          const error = createUpstreamResponseTooLargeError(config.maxUpstreamResponseBytes);
          upstreamResponse.destroy(error);
          reject(error);
        }
      });
      upstreamResponse.on('end', () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve({
          status: upstreamResponse.statusCode || 502,
          text
        });
      });
    });

    upstreamRequest.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    if (options.body) {
      upstreamRequest.write(options.body);
    }

    upstreamRequest.end();
  });
}

export function isLocalProxyTokenProtectedPath(pathname) {
  return pathname === QWEN_CHAT_COMPLETIONS_ROUTE
    || pathname === OLLAMA_CHAT_COMPLETIONS_ROUTE
    || pathname.startsWith(TASKS_ROUTE_PREFIX);
}

/**
 * 当代理配置了 LOCAL_PROXY_TOKEN（非回环部署强制）时校验令牌；
 * 未配置令牌（默认回环部署）时放行，保持原有行为。
 */
export function isLocalProxyTokenPresent(token, config = loadQwenProxyConfig()) {
  if (!config.localProxyToken) {
    return true;
  }

  if (typeof token !== 'string') {
    return false;
  }

  const actual = Buffer.from(token, 'utf8');
  const expected = Buffer.from(config.localProxyToken, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isLocalProxyTokenAuthorized(pathname, token, config = loadQwenProxyConfig()) {
  if (!config.localProxyToken || !isLocalProxyTokenProtectedPath(pathname)) {
    return true;
  }

  return isLocalProxyTokenPresent(token, config);
}

function createLocalProxyTokenGuard(config, { protectAll = false } = {}) {
  return (req, res, next) => {
    const token = req.get(LOCAL_PROXY_TOKEN_HEADER);
    const authorized = protectAll
      // 挂载在路由前缀下的 guard 收到的 req.path 是去前缀的相对路径，
      // 因此 tasks 路由整段视为受保护路径，只看令牌本身。
      ? isLocalProxyTokenPresent(token, config)
      : isLocalProxyTokenAuthorized(req.path, token, config);
    if (authorized) {
      return next();
    }

    return res.status(403).json({
      error: {
        message: '本地代理请求未授权',
        type: 'forbidden'
      }
    });
  };
}

export function buildExpressErrorResponse(error) {
  const statusCandidate = Number(error?.status ?? error?.statusCode);
  const statusCode = Number.isInteger(statusCandidate) && statusCandidate >= 400 && statusCandidate < 600
    ? statusCandidate
    : 500;
  // 5xx 不向外回传内部错误消息，避免泄露实现细节/堆栈/上游 URL。
  // 4xx 通常是客户端错误，可以保留原始消息以便调试。
  const message = statusCode >= 500
    ? 'Internal server error'
    : (error instanceof Error && error.message ? error.message : 'Invalid request');

  return {
    statusCode,
    body: {
      error: {
        message,
        type: statusCode >= 500 ? 'internal_error' : 'invalid_request'
      }
    }
  };
}

export function validateChatCompletionPayload(body = {}, config = loadQwenProxyConfig()) {
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

export function normalizeChatCompletionPayload(body = {}, config = loadQwenProxyConfig()) {
  return {
    ...body,
    max_tokens: body.max_tokens === undefined || body.max_tokens === null
      ? config.maxChatTokens
      : Number(body.max_tokens),
    stream: false,
    ...(body.n === undefined ? {} : { n: 1 }),
    ...(body.best_of === undefined ? {} : { best_of: 1 })
  };
}

function createChatPayloadValidator(config) {
  return (req, res, next) => {
    const validation = validateChatCompletionPayload(req.body, config);
    if (!validation.ok) {
      return res.status(400).json({
        error: {
          message: validation.message,
          type: 'invalid_request'
        }
      });
    }

    req.body = normalizeChatCompletionPayload(req.body, config);
    return next();
  };
}

function createChatRateLimiter(config) {
  const limit = config.chatRequestsPerMinute;
  if (!limit) {
    return (_req, _res, next) => next();
  }

  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      return res.status(429).json({
        error: {
          message: '请求过于频繁，请稍后再试',
          type: 'rate_limit'
        }
      });
    }
  });
}

function createAuthAttemptRateLimiter(config, { protectAll = false } = {}) {
  if (!config.localProxyToken || !config.authAttemptsPerMinute) {
    return createDisabledRateLimiter();
  }

  return rateLimit({
    windowMs: 60_000,
    limit: config.authAttemptsPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => protectAll
      ? isLocalProxyTokenPresent(req.get(LOCAL_PROXY_TOKEN_HEADER), config)
      : isLocalProxyTokenAuthorized(
        req.path,
        req.get(LOCAL_PROXY_TOKEN_HEADER),
        config
      ),
    handler: (_req, res) => res.status(429).json({
      error: {
        message: '未授权请求过于频繁，请稍后再试',
        type: 'auth_rate_limit'
      }
    })
  });
}

function createStatusRateLimiter(config) {
  if (!config.statusRequestsPerMinute) {
    return createDisabledRateLimiter();
  }

  return rateLimit({
    windowMs: 60_000,
    limit: config.statusRequestsPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({
      error: {
        message: '状态查询过于频繁，请稍后再试',
        type: 'rate_limit'
      }
    })
  });
}

function createTasksRateLimiter(config) {
  if (!config.tasksRequestsPerMinute) {
    return createDisabledRateLimiter();
  }

  return rateLimit({
    windowMs: 60_000,
    limit: config.tasksRequestsPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({
      error: {
        message: '任务通道请求过于频繁，请稍后再试',
        type: 'rate_limit'
      }
    })
  });
}

function createDisabledRateLimiter() {
  return (_req, _res, next) => next();
}

function resolveChatRateLimiter(config) {
  return config.chatRequestsPerMinute ? createChatRateLimiter(config) : createDisabledRateLimiter();
}

async function requestQwenChatCompletionsText(config, requestBody, signal) {
  const response = await fetchKnownQwenChatCompletions(config.qwenEndpointKey, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.qwenApiKey}`
    },
    body: JSON.stringify(requestBody),
    signal
  });

  return {
    status: response.status,
    text: await readFetchResponseText(response, config.maxUpstreamResponseBytes)
  };
}

async function sendQwenChatResponse(req, res, config, requestBody, source = 'cloud') {
  const abortContext = createUpstreamAbortContext(req, res, config.qwenTimeout);
  res.set('X-VLM-Source', source);

  try {
    if (isClientDisconnected(req, res, abortContext)) {
      return;
    }

    const response = await requestQwenChatCompletionsText(config, requestBody, abortContext.signal);
    if (isClientDisconnected(req, res, abortContext)) {
      return;
    }

    const payload = parseProxyResponseText(response.text);

    return res.status(response.status).json(payload);
  } catch (error) {
    if (isClientDisconnected(req, res, abortContext)) {
      return;
    }

    const errorResponse = buildProxyErrorResponse(error, {
      timeoutMessage: 'Qwen 接口请求超时',
      timeoutType: 'timeout_error',
      fallbackMessage: '代理请求失败',
      fallbackType: 'proxy_error'
    });
    return res.status(errorResponse.statusCode).json(errorResponse.body);
  } finally {
    abortContext.cleanup();
  }
}

function createQwenChatHandler(config) {
  return async (req, res) => {
    if (!isQwenProxyConfigured(config)) {
      return res.status(500).json({
        error: {
          message: 'QWEN_BASE_URL 或 QWEN_API_KEY 未配置，请检查 .env',
          type: 'configuration_error'
        }
      });
    }

    return sendQwenChatResponse(
      req,
      res,
      config,
      buildQwenRequestBody(req.body, config.qwenModel),
      'cloud'
    );
  };
}

function createOllamaChatHandler(config) {
  const OLLAMA_MODEL = config.ollamaModel || DEFAULT_VLM_MODEL_ALIAS;

  return async (req, res) => {
    if (!isLocalVlmTrusted(config)) {
      if (isCloudFallbackAvailable(config)) {
        return sendQwenChatResponse(
          req,
          res,
          config,
          buildQwenFallbackRequestBody(req.body, config.qwenModel),
          'cloud-fallback'
        );
      }

      return res.status(503).json({
        error: {
          message: '本地 VLM 不是当前 Electron 会话管理的可信进程',
          type: 'local_vlm_untrusted'
        }
      });
    }

    const abortContext = createUpstreamAbortContext(req, res, config.ollamaTimeout);
    res.set('X-VLM-Source', 'local');

    try {
      const response = await requestLocalOllamaText(config, {
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildOllamaRequestBody(req.body, OLLAMA_MODEL)),
        signal: abortContext.signal
      });

      const text = response.text;
      const payload = parseProxyResponseText(text, () => {
        console.error('[ollama-proxy] Non-JSON response from upstream');
      });

      if (
        shouldFallbackToQwen(response)
        && isCloudFallbackAvailable(config)
        && !isClientDisconnected(req, res, abortContext)
      ) {
        console.warn(`[ollama-proxy] Local VLM returned HTTP ${response.status}; falling back to Qwen VLM`);
        abortContext.cleanup();
        return sendQwenChatResponse(
          req,
          res,
          config,
          buildQwenFallbackRequestBody(req.body, config.qwenModel),
          'cloud-fallback'
        );
      }

      if (config.logModelOutput) {
        console.log('[ollama-proxy] Model output metadata:', {
          statusCode: response.status,
          contentLength: payload?.choices?.[0]?.message?.content?.length ?? 0
        });
      }

      if (isClientDisconnected(req, res, abortContext)) {
        return;
      }

      return res.status(response.status).json(payload);
    } catch (error) {
      if (isClientDisconnected(req, res, abortContext)) {
        return;
      }

      if (isCloudFallbackAvailable(config)) {
        console.warn('[ollama-proxy] Local VLM request failed; falling back to Qwen VLM');
        abortContext.cleanup();
        return sendQwenChatResponse(
          req,
          res,
          config,
          buildQwenFallbackRequestBody(req.body, config.qwenModel),
          'cloud-fallback'
        );
      }

      const errorResponse = buildProxyErrorResponse(error, {
        timeoutMessage: 'Ollama 推理超时',
        timeoutType: 'timeout',
        fallbackMessage: '代理请求失败',
        fallbackType: 'proxy_error'
      });
      return res.status(errorResponse.statusCode).json(errorResponse.body);
    } finally {
      abortContext.cleanup();
    }
  };
}

export function createQwenProxyApp(config = loadQwenProxyConfig(), { tasksRouter } = {}) {
  assertQwenProxySecurityConfig(config);
  const app = express();
  const chatRateLimiter = resolveChatRateLimiter(config);
  const authAttemptRateLimiter = createAuthAttemptRateLimiter(config);
  const statusRateLimiter = createStatusRateLimiter(config);
  const chatPayloadValidator = createChatPayloadValidator(config);
  const localProxyTokenGuard = createLocalProxyTokenGuard(config);
  const chatJsonParser = express.json({ limit: config.requestBodyLimit });

  app.use(compression());

  app.use(
    cors({
      origin: createCorsOriginOption(config),
      credentials: config.corsOrigin !== true,
      exposedHeaders: ['X-VLM-Source']
    })
  );
  createOllamaProxyRoutes(
    app,
    config,
    chatRateLimiter,
    chatPayloadValidator,
    localProxyTokenGuard,
    authAttemptRateLimiter,
    chatJsonParser,
    statusRateLimiter
  );

  app.get(API_HEALTH_ROUTE, statusRateLimiter, (_req, res) => {
    res.json({
      ok: true,
      service: 'community-risk-warning-proxy',
      qwenConfigured: Boolean(config.qwenBaseUrl && config.qwenApiKey),
      cloudFallbackEnabled: isCloudFallbackAvailable(config),
      model: config.qwenModel,
      timestamp: new Date().toISOString()
    });
  });

  app.post(
    QWEN_CHAT_COMPLETIONS_ROUTE,
    authAttemptRateLimiter,
    localProxyTokenGuard,
    chatJsonParser,
    chatRateLimiter,
    chatPayloadValidator,
    createQwenChatHandler(config)
  );

  // 比赛任务回传通道：与 chat 路由共用令牌守卫（protectAll，见 createLocalProxyTokenGuard），
  // 必须挂在全局错误处理器之前，否则 JSON 解析错误会落到 Express 默认 HTML 错误页泄漏堆栈。
  if (tasksRouter) {
    app.use(
      TASKS_ROUTE_PREFIX,
      createAuthAttemptRateLimiter(config, { protectAll: true }),
      createLocalProxyTokenGuard(config, { protectAll: true }),
      createTasksRateLimiter(config),
      tasksRouter
    );
  }

  // 全局错误处理，避免 Express 返回 HTML 500 页面
  app.use((err, _req, res, _next) => {
    const errorResponse = buildExpressErrorResponse(err);
    if (errorResponse.statusCode >= 500) {
      console.error('[ollama-proxy] Unhandled error:', err);
    }
    res.status(errorResponse.statusCode).json(errorResponse.body);
  });

  return app;
}

export function createOllamaProxyRoutes(
  app,
  config = loadQwenProxyConfig(),
  chatRateLimiter,
  chatPayloadValidator,
  localProxyTokenGuard,
  authAttemptRateLimiter,
  chatJsonParser,
  statusRateLimiter
) {
  const rateLimiter = chatRateLimiter ?? resolveChatRateLimiter(config);
  const payloadValidator = chatPayloadValidator ?? createChatPayloadValidator(config);
  const tokenGuard = localProxyTokenGuard ?? createLocalProxyTokenGuard(config);
  const authLimiter = authAttemptRateLimiter ?? createAuthAttemptRateLimiter(config);
  const bodyParser = chatJsonParser ?? express.json({ limit: config.requestBodyLimit });
  const statusLimiter = statusRateLimiter ?? createStatusRateLimiter(config);

  app.post(
    OLLAMA_CHAT_COMPLETIONS_ROUTE,
    authLimiter,
    tokenGuard,
    bodyParser,
    rateLimiter,
    payloadValidator,
    createOllamaChatHandler(config)
  );

  app.get(OLLAMA_STATUS_ROUTE, statusLimiter, async (req, res) => {
    if (!isLocalVlmTrusted(config)) {
      return res.json(resolveVlmProxyStatus({ ready: false, status: 'error', gpu: 'unknown' }, config));
    }

    const abortContext = createUpstreamAbortContext(req, res, OLLAMA_HEALTH_TIMEOUT_MS);

    try {
      const response = await requestLocalOllamaText(config, {
        path: '/health',
        method: 'GET',
        signal: abortContext.signal
      });
      if (isClientDisconnected(req, res, abortContext)) {
        return;
      }

      res.json(resolveVlmProxyStatus(resolveOllamaHealthStatus(response.status), config));
    } catch {
      if (isClientDisconnected(req, res, abortContext)) {
        return;
      }

      res.json(resolveVlmProxyStatus({ ready: false, status: 'error', gpu: 'unknown' }, config));
    } finally {
      abortContext.cleanup();
    }
  });
}
