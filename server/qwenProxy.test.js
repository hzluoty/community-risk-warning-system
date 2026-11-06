import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertQwenProxySecurityConfig,
  buildExpressErrorResponse,
  buildOllamaRequestBody,
  buildProxyErrorResponse,
  buildQwenFallbackRequestBody,
  buildQwenRequestBody,
  createQwenProxyApp,
  isAllowedCorsOrigin,
  isCloudFallbackAvailable,
  isLocalProxyTokenAuthorized,
  isLocalProxyTokenProtectedPath,
  isLoopbackBindHost,
  isQwenProxyConfigured,
  loadQwenProxyConfig,
  normalizeChatCompletionPayload,
  parseProxyResponseText,
  resolveVlmProxyStatus,
  shouldFallbackToQwen,
  validateChatCompletionPayload
} from './qwenProxy.js';
import { resolveOllamaHealthStatus } from './ollamaHealthStatus.js';
import { DEFAULT_QWEN_VLM_API_MODEL } from '../shared/vlmModelConfig.js';
import { VLM_RESPONSE_FORMAT } from '../shared/vlmResponseSchema.js';
import { createTasksIngestRouter } from './tasksIngest.js';

const testServers = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      testServers.push(server);
      resolve(server.address().port);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function requestJson(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
        ...headers
      }
    }, (response) => {
      response.setEncoding('utf8');
      let responseText = '';
      response.on('data', (chunk) => {
        responseText += chunk;
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: responseText ? JSON.parse(responseText) : null
        });
      });
    });

    request.on('error', reject);
    request.end(text);
  });
}

function requestGetJson(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers
    }, (response) => {
      response.setEncoding('utf8');
      let responseText = '';
      response.on('data', (chunk) => {
        responseText += chunk;
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: responseText ? JSON.parse(responseText) : null
      }));
    });

    request.on('error', reject);
    request.end();
  });
}

function startDisconnectingRequest(port, path, body) {
  const text = JSON.stringify(body);
  const request = http.request({
    hostname: '127.0.0.1',
    port,
    path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text)
    }
  });
  request.on('error', () => {});
  request.end(text);
  return request;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(testServers.splice(0).map(closeServer));
});

describe('qwenProxy', () => {
  it('normalizes config from environment variables', () => {
    const config = loadQwenProxyConfig({
      CORS_ORIGIN: 'http://localhost:5173, http://localhost:4173',
      QWEN_BASE_URL: 'http://127.0.0.1:1234/v1/',
      QWEN_API_KEY: 'test-key',
      QWEN_MODEL: 'qwen-vl',
      QWEN_TIMEOUT: '90000',
      ALLOW_CLOUD_FALLBACK: 'true',
      SERVER_HOST: '127.0.0.1',
      ALLOW_LOCAL_FILE_ORIGINS: 'true',
      REQUEST_BODY_LIMIT: '6mb',
      CHAT_REQUESTS_PER_MINUTE: '20',
      AUTH_ATTEMPTS_PER_MINUTE: '7',
      STATUS_REQUESTS_PER_MINUTE: '11',
      MAX_CHAT_MESSAGES: '8',
      MAX_CHAT_TOKENS: '1600',
      MAX_UPSTREAM_RESPONSE_BYTES: '4096',
      LOCAL_PROXY_TOKEN: 'local-token',
      LOG_MODEL_OUTPUT: 'true',
      VLM_MODEL: 'local-vlm',
      VLM_PORT: '12345',
      VLM_API_KEY: 'vlm-session-key'
    });

    expect(config.host).toBe('127.0.0.1');
    expect(config.corsOrigin).toEqual(['http://localhost:5173', 'http://localhost:4173']);
    expect(config.allowLocalFileOrigins).toBe(true);
    expect(config.qwenEndpointKey).toBe('local-lm-studio');
    expect(config.qwenBaseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(config.qwenChatCompletionsUrl).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(config.qwenApiKey).toBe('test-key');
    expect(config.qwenModel).toBe('qwen-vl');
    expect(config.qwenTimeout).toBe(90000);
    expect(config.allowCloudFallback).toBe(true);
    expect(config.requestBodyLimit).toBe('6mb');
    expect(config.chatRequestsPerMinute).toBe(20);
    expect(config.authAttemptsPerMinute).toBe(7);
    expect(config.statusRequestsPerMinute).toBe(11);
    expect(config.maxChatMessages).toBe(8);
    expect(config.maxChatTokens).toBe(1600);
    expect(config.maxUpstreamResponseBytes).toBe(4096);
    expect(config.localProxyToken).toBe('local-token');
    expect(config.logModelOutput).toBe(true);
    expect(config.ollamaModel).toBe('local-vlm');
    expect(config.ollamaHost).toBe('127.0.0.1');
    expect(config.ollamaPort).toBe(12345);
    expect(config.ollamaApiKey).toBe('vlm-session-key');
    expect(config.ollamaBaseUrl).toBe('http://127.0.0.1:12345');
  });

  it('defaults remote Qwen calls to a hosted VLM model', () => {
    const config = loadQwenProxyConfig({});

    expect(config.qwenModel).toBe(DEFAULT_QWEN_VLM_API_MODEL);
    expect(config.allowCloudFallback).toBe(false);
    expect(config.maxUpstreamResponseBytes).toBe(2 * 1024 * 1024);
  });

  it('uses explicit allow-lists for CORS and Qwen upstream URLs', () => {
    const wildcardCorsConfig = loadQwenProxyConfig({ CORS_ORIGIN: '*' });
    const unsupportedQwenConfig = loadQwenProxyConfig({
      QWEN_BASE_URL: 'http://169.254.169.254/latest/meta-data'
    });

    expect(wildcardCorsConfig.corsOrigin).toEqual(['http://localhost:5173']);
    expect(unsupportedQwenConfig.qwenBaseUrl).toBe('');
    expect(unsupportedQwenConfig.qwenChatCompletionsUrl).toBe('');
  });

  it('exposes the VLM source response header to allowed browser origins', async () => {
    const port = await listen(http.createServer(createQwenProxyApp(loadQwenProxyConfig({}))));
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: 'http://localhost:5173' }
    });

    expect(response.headers.get('access-control-expose-headers')).toContain('X-VLM-Source');
  });

  it('rejects workspace-specific MaaS URLs unless they are added to the fixed endpoint table', () => {
    const config = loadQwenProxyConfig({
      QWEN_BASE_URL: 'https://workspace-abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/'
    });

    expect(config.qwenEndpointKey).toBe('');
    expect(config.qwenBaseUrl).toBe('');
    expect(config.qwenChatCompletionsUrl).toBe('');
  });

  it('allows BigModel OpenAI-compatible VLM endpoints', () => {
    const config = loadQwenProxyConfig({
      QWEN_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4/'
    });

    expect(config.qwenEndpointKey).toBe('bigmodel');
    expect(config.qwenBaseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(config.qwenChatCompletionsUrl).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
  });

  it('always enforces the configured cloud model', () => {
    expect(buildQwenRequestBody({ messages: [] }, 'qwen-default')).toEqual({
      model: 'qwen-default',
      messages: []
    });

    expect(buildQwenRequestBody({ model: 'custom', messages: [] }, 'qwen-default')).toEqual({
      model: 'qwen-default',
      messages: []
    });
  });

  it('forces the configured cloud model when falling back from local VLM', () => {
    expect(buildQwenFallbackRequestBody({
      model: 'local-vlm',
      stream: true,
      response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'user', content: 'ok' }]
    }, 'glm-4v-flash')).toEqual({
      model: 'glm-4v-flash',
      stream: false,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'ok' }]
    });
  });

  it('downgrades llama.cpp-specific JSON schema formatting for cloud fallback', () => {
    expect(buildQwenFallbackRequestBody({
      response_format: VLM_RESPONSE_FORMAT,
      messages: [{ role: 'user', content: 'ok' }]
    }, 'qwen-vl')).toEqual({
      model: 'qwen-vl',
      stream: false,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'ok' }]
    });
  });

  it('rewrites local VLM requests to the managed llama-server alias', () => {
    expect(buildOllamaRequestBody({
      model: 'stale-browser-model',
      messages: [{ role: 'user', content: 'ok' }]
    }, 'local-vlm')).toEqual({
      model: 'local-vlm',
      messages: [{ role: 'user', content: 'ok' }],
      response_format: VLM_RESPONSE_FORMAT,
      chat_template_kwargs: { enable_thinking: false }
    });
  });

  it('overrides explicit text format and still disables thinking for local VLM', () => {
    expect(buildOllamaRequestBody({
      model: 'stale-browser-model',
      response_format: { type: 'text' },
      chat_template_kwargs: { other: true, enable_thinking: true },
      messages: [{ role: 'user', content: 'ok' }]
    }, 'local-vlm')).toEqual({
      model: 'local-vlm',
      response_format: VLM_RESPONSE_FORMAT,
      chat_template_kwargs: { other: true, enable_thinking: false },
      messages: [{ role: 'user', content: 'ok' }]
    });
  });

  it('blocks file origins by default and only allows them for the Electron proxy', () => {
    const allowedOrigins = ['http://localhost:5173'];

    expect(isAllowedCorsOrigin(undefined, allowedOrigins)).toBe(false);
    expect(isAllowedCorsOrigin('null', allowedOrigins)).toBe(false);
    expect(isAllowedCorsOrigin('file://', allowedOrigins)).toBe(false);
    expect(isAllowedCorsOrigin('http://localhost:5173', allowedOrigins)).toBe(true);
    expect(isAllowedCorsOrigin('https://example.com', allowedOrigins)).toBe(false);
    expect(isAllowedCorsOrigin('null', allowedOrigins, true)).toBe(true);
    expect(isAllowedCorsOrigin('file://', allowedOrigins, true)).toBe(true);
  });

  it('rejects malformed chat completion payloads before proxying', () => {
    const config = loadQwenProxyConfig({
      MAX_CHAT_MESSAGES: '2',
      MAX_CHAT_TOKENS: '100'
    });

    expect(validateChatCompletionPayload({ messages: [{ role: 'user', content: 'ok' }] }, config)).toEqual({
      ok: true
    });
    expect(validateChatCompletionPayload({}, config)).toEqual({
      ok: false,
      message: 'messages must be a non-empty array'
    });
    expect(validateChatCompletionPayload({ messages: [{}, {}, {}] }, config)).toEqual({
      ok: false,
      message: 'messages exceeds the configured limit'
    });
    expect(validateChatCompletionPayload({ messages: [{}], max_tokens: 101 }, config)).toEqual({
      ok: false,
      message: 'max_tokens exceeds the configured limit'
    });
    expect(validateChatCompletionPayload({ messages: [{}], max_completion_tokens: 10 }, config)).toEqual({
      ok: false,
      message: 'max_completion_tokens is not supported; use max_tokens'
    });
    expect(validateChatCompletionPayload({ messages: [{}], stream: true }, config)).toEqual({
      ok: false,
      message: 'streaming responses are not supported'
    });
    expect(validateChatCompletionPayload({ messages: [{}], n: 2 }, config)).toEqual({
      ok: false,
      message: 'n must be 1'
    });
  });

  it('injects a bounded non-streaming completion limit when max_tokens is omitted', () => {
    const config = loadQwenProxyConfig({ MAX_CHAT_TOKENS: '321' });

    expect(normalizeChatCompletionPayload({
      messages: [{ role: 'user', content: 'ok' }]
    }, config)).toEqual({
      messages: [{ role: 'user', content: 'ok' }],
      max_tokens: 321,
      stream: false
    });

    expect(normalizeChatCompletionPayload({
      messages: [{}],
      max_tokens: '99',
      n: 1
    }, config)).toMatchObject({ max_tokens: 99, n: 1, stream: false });
  });

  it('protects chat completion endpoints with an optional local proxy token', () => {
    const config = loadQwenProxyConfig({ LOCAL_PROXY_TOKEN: 'secret' });

    expect(isLocalProxyTokenProtectedPath('/api/qwen/chat/completions')).toBe(true);
    expect(isLocalProxyTokenProtectedPath('/api/ollama/chat/completions')).toBe(true);
    expect(isLocalProxyTokenProtectedPath('/api/tasks/ingest')).toBe(true);
    expect(isLocalProxyTokenProtectedPath('/api/tasks/results')).toBe(true);
    expect(isLocalProxyTokenProtectedPath('/api/health')).toBe(false);

    expect(isLocalProxyTokenAuthorized('/api/qwen/chat/completions', 'secret', config)).toBe(true);
    expect(isLocalProxyTokenAuthorized('/api/qwen/chat/completions', 'wrong', config)).toBe(false);
    expect(isLocalProxyTokenAuthorized('/api/health', 'wrong', config)).toBe(true);
    expect(isLocalProxyTokenAuthorized('/api/qwen/chat/completions', undefined, loadQwenProxyConfig({}))).toBe(true);
  });

  it('maps Ollama health responses without treating 503 as ready', () => {
    expect(resolveOllamaHealthStatus(200)).toEqual({ ready: true, status: 'ready', gpu: 'unknown' });
    expect(resolveOllamaHealthStatus(503)).toEqual({ ready: false, status: 'loading', gpu: 'unknown' });
    expect(resolveOllamaHealthStatus(500)).toEqual({ ready: false, status: 'error', gpu: 'unknown' });
  });

  it('marks the VLM proxy ready only when cloud fallback is explicitly enabled', () => {
    const cloudConfig = loadQwenProxyConfig({
      QWEN_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      QWEN_API_KEY: 'test-key',
      ALLOW_CLOUD_FALLBACK: 'true'
    });
    const fallbackDisabledConfig = loadQwenProxyConfig({
      QWEN_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      QWEN_API_KEY: 'test-key'
    });

    expect(isQwenProxyConfigured(cloudConfig)).toBe(true);
    expect(isCloudFallbackAvailable(cloudConfig)).toBe(true);
    expect(isCloudFallbackAvailable(fallbackDisabledConfig)).toBe(false);
    expect(resolveVlmProxyStatus({ ready: false, status: 'error', gpu: 'unknown' }, cloudConfig)).toEqual({
      ready: true,
      status: 'ready',
      gpu: 'unknown',
      source: 'cloud-fallback'
    });
    expect(resolveVlmProxyStatus({ ready: false, status: 'error', gpu: 'unknown' }, fallbackDisabledConfig)).toEqual({
      ready: false,
      status: 'error',
      gpu: 'unknown',
      source: 'local'
    });
  });

  it('falls back to cloud only for local VLM service failures', () => {
    expect(shouldFallbackToQwen({ status: 200 })).toBe(false);
    expect(shouldFallbackToQwen({ status: 400 })).toBe(false);
    expect(shouldFallbackToQwen({ status: 404 })).toBe(true);
    expect(shouldFallbackToQwen({ status: 500 })).toBe(true);
    expect(shouldFallbackToQwen({ status: 503 })).toBe(true);
  });

  it('fails closed when binding beyond loopback without a proxy token', () => {
    expect(isLoopbackBindHost('127.0.0.1')).toBe(true);
    expect(isLoopbackBindHost('::1')).toBe(true);
    expect(isLoopbackBindHost('0.0.0.0')).toBe(false);

    const insecureConfig = loadQwenProxyConfig({ SERVER_HOST: '0.0.0.0' });
    expect(() => assertQwenProxySecurityConfig(insecureConfig)).toThrow(/LOCAL_PROXY_TOKEN/);
    expect(() => createQwenProxyApp(insecureConfig)).toThrow(/LOCAL_PROXY_TOKEN/);
    expect(() => assertQwenProxySecurityConfig(loadQwenProxyConfig({
      SERVER_HOST: '0.0.0.0',
      LOCAL_PROXY_TOKEN: 'too-short'
    }))).toThrow(/32 bytes/);
    expect(assertQwenProxySecurityConfig(loadQwenProxyConfig({
      SERVER_HOST: '0.0.0.0',
      LOCAL_PROXY_TOKEN: '0123456789abcdef0123456789abcdef'
    }))).toBeTruthy();
  });

  it('authenticates before consuming the route rate-limit bucket', async () => {
    const app = createQwenProxyApp(loadQwenProxyConfig({
      LOCAL_PROXY_TOKEN: 'secret',
      CHAT_REQUESTS_PER_MINUTE: '1'
    }));
    const port = await listen(http.createServer(app));

    const unauthorized = await requestJson(port, '/api/qwen/chat/completions', {
      messages: [{ role: 'user', content: 'ok' }]
    }, { 'x-local-proxy-token': 'wrong' });
    const firstAuthorized = await requestJson(port, '/api/qwen/chat/completions', {}, {
      'x-local-proxy-token': 'secret'
    });
    const secondAuthorized = await requestJson(port, '/api/qwen/chat/completions', {}, {
      'x-local-proxy-token': 'secret'
    });

    expect(unauthorized.status).toBe(403);
    expect(firstAuthorized.status).toBe(400);
    expect(secondAuthorized.status).toBe(429);
  });

  it('rate-limits repeated authentication failures without penalizing valid tokens', async () => {
    const app = createQwenProxyApp(loadQwenProxyConfig({
      LOCAL_PROXY_TOKEN: 'secret',
      AUTH_ATTEMPTS_PER_MINUTE: '1',
      CHAT_REQUESTS_PER_MINUTE: '0'
    }));
    const port = await listen(http.createServer(app));

    const firstFailure = await requestJson(port, '/api/qwen/chat/completions', {}, {
      'x-local-proxy-token': 'wrong'
    });
    const secondFailure = await requestJson(port, '/api/qwen/chat/completions', {}, {
      'x-local-proxy-token': 'wrong-again'
    });
    const authorized = await requestJson(port, '/api/qwen/chat/completions', {}, {
      'x-local-proxy-token': 'secret'
    });

    expect(firstFailure.status).toBe(403);
    expect(secondFailure.status).toBe(429);
    expect(secondFailure.body.error.type).toBe('auth_rate_limit');
    expect(authorized.status).toBe(400);
  });

  it('rejects an unauthorized request before parsing an oversized JSON body', async () => {
    const app = createQwenProxyApp(loadQwenProxyConfig({
      LOCAL_PROXY_TOKEN: 'secret',
      REQUEST_BODY_LIMIT: '1b',
      AUTH_ATTEMPTS_PER_MINUTE: '0',
      CHAT_REQUESTS_PER_MINUTE: '0'
    }));
    const port = await listen(http.createServer(app));

    const response = await requestJson(port, '/api/qwen/chat/completions', {
      messages: [{ role: 'user', content: 'body larger than one byte' }]
    }, { 'x-local-proxy-token': 'wrong' });

    expect(response.status).toBe(403);
  });

  it('guards the mounted tasks router with the local proxy token when configured', async () => {
    const app = createQwenProxyApp(loadQwenProxyConfig({
      LOCAL_PROXY_TOKEN: 'secret'
    }), { tasksRouter: createTasksIngestRouter() });
    const port = await listen(http.createServer(app));

    const withoutToken = await requestGetJson(port, '/api/tasks/results');
    const withWrongToken = await requestGetJson(port, '/api/tasks/results', {
      'x-local-proxy-token': 'wrong'
    });
    const withToken = await requestGetJson(port, '/api/tasks/results', {
      'x-local-proxy-token': 'secret'
    });

    expect(withoutToken.status).toBe(403);
    expect(withWrongToken.status).toBe(403);
    expect(withToken.status).toBe(200);
    expect(withToken.body).toEqual({ ok: true, count: 0, results: [] });
  });

  it('serves tasks routes without a token on the default loopback deployment', async () => {
    const app = createQwenProxyApp(loadQwenProxyConfig({}), {
      tasksRouter: createTasksIngestRouter()
    });
    const port = await listen(http.createServer(app));

    const response = await requestGetJson(port, '/api/tasks/results');
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(0);
  });

  it('returns a JSON 400 instead of an HTML stack-trace page for malformed tasks JSON', async () => {
    const app = createQwenProxyApp(loadQwenProxyConfig({}), {
      tasksRouter: createTasksIngestRouter()
    });
    const port = await listen(http.createServer(app));

    const raw = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/tasks/ingest',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (response) => {
        response.setEncoding('utf8');
        let responseText = '';
        response.on('data', (chunk) => { responseText += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: responseText }));
      });
      request.on('error', reject);
      request.end('{"type":"task",broken');
    });

    expect(raw.status).toBe(400);
    const parsed = JSON.parse(raw.body);
    expect(parsed.error.type).toBe('invalid_request');
    // 不是 Express 默认 HTML 错误页，也不带多行堆栈/内部模块路径
    expect(raw.body).not.toMatch(/<!DOCTYPE|<html/i);
    expect(raw.body).not.toMatch(/\n\s*at /);
    expect(raw.body).not.toContain('node:internal');
  });

  it('injects the configured max_tokens limit before proxying to local VLM', async () => {
    let receivedBody;
    let receivedAuthorization;
    const upstreamPort = await listen(http.createServer((request, response) => {
      receivedAuthorization = request.headers.authorization;
      request.setEncoding('utf8');
      let text = '';
      request.on('data', (chunk) => {
        text += chunk;
      });
      request.on('end', () => {
        receivedBody = JSON.parse(text);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"choices":[]}');
      });
    }));
    const appPort = await listen(http.createServer(createQwenProxyApp(loadQwenProxyConfig({
      VLM_PORT: String(upstreamPort),
      VLM_API_KEY: 'session-vlm-key',
      MAX_CHAT_TOKENS: '77',
      CHAT_REQUESTS_PER_MINUTE: '0'
    }))));

    const result = await requestJson(appPort, '/api/ollama/chat/completions', {
      messages: [{ role: 'user', content: 'ok' }]
    });

    expect(result.status).toBe(200);
    expect(receivedBody).toMatchObject({
      max_tokens: 77,
      stream: false,
      response_format: VLM_RESPONSE_FORMAT,
      chat_template_kwargs: { enable_thinking: false }
    });
    expect(receivedAuthorization).toBe('Bearer session-vlm-key');
  });

  it('fails closed when Electron has not marked its managed VLM process trusted', async () => {
    const config = loadQwenProxyConfig({ CHAT_REQUESTS_PER_MINUTE: '0' });
    config.isLocalVlmTrusted = () => false;
    const port = await listen(http.createServer(createQwenProxyApp(config)));

    const chat = await requestJson(port, '/api/ollama/chat/completions', {
      messages: [{ role: 'user', content: 'do not forward' }]
    });
    const status = await requestGetJson(port, '/api/ollama/status');

    expect(chat.status).toBe(503);
    expect(chat.body.error.type).toBe('local_vlm_untrusted');
    expect(status.body.ready).toBe(false);
    expect(status.body.source).toBe('local');
  });

  it('uses cloud fallback for an untrusted local process only after explicit opt-in', async () => {
    const cloudFetch = vi.fn(async () => new Response('{"choices":[{"message":{"content":"cloud"}}]}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    vi.stubGlobal('fetch', cloudFetch);

    const config = loadQwenProxyConfig({
      QWEN_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      QWEN_API_KEY: 'test-key',
      QWEN_MODEL: 'glm-4v-flash',
      ALLOW_CLOUD_FALLBACK: 'true',
      CHAT_REQUESTS_PER_MINUTE: '0'
    });
    config.isLocalVlmTrusted = () => false;
    const port = await listen(http.createServer(createQwenProxyApp(config)));

    const chat = await requestJson(port, '/api/ollama/chat/completions', {
      messages: [{ role: 'user', content: 'explicit fallback' }]
    });
    const status = await requestGetJson(port, '/api/ollama/status');

    expect(chat.status).toBe(200);
    expect(chat.headers['x-vlm-source']).toBe('cloud-fallback');
    expect(status.body).toMatchObject({ ready: true, source: 'cloud-fallback' });
    expect(cloudFetch).toHaveBeenCalled();
  });

  it('does not use configured cloud credentials unless fallback is explicitly enabled', async () => {
    const upstreamPort = await listen(http.createServer((_request, response) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{"error":{"message":"local failed"}}');
    }));
    const cloudFetch = vi.fn(async () => new Response('{"choices":[{"message":{"content":"cloud"}}]}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    vi.stubGlobal('fetch', cloudFetch);

    const baseEnv = {
      VLM_PORT: String(upstreamPort),
      QWEN_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      QWEN_API_KEY: 'test-key',
      CHAT_REQUESTS_PER_MINUTE: '0'
    };
    const disabledPort = await listen(http.createServer(createQwenProxyApp(loadQwenProxyConfig(baseEnv))));
    const disabledResult = await requestJson(disabledPort, '/api/ollama/chat/completions', {
      messages: [{ role: 'user', content: 'ok' }]
    });

    expect(disabledResult.status).toBe(500);
    expect(disabledResult.headers['x-vlm-source']).toBe('local');
    expect(cloudFetch).not.toHaveBeenCalled();

    const enabledPort = await listen(http.createServer(createQwenProxyApp(loadQwenProxyConfig({
      ...baseEnv,
      ALLOW_CLOUD_FALLBACK: 'true'
    }))));
    const enabledResult = await requestJson(enabledPort, '/api/ollama/chat/completions', {
      messages: [{ role: 'user', content: 'ok' }]
    });

    expect(enabledResult.status).toBe(200);
    expect(enabledResult.headers['x-vlm-source']).toBe('cloud-fallback');
    expect(cloudFetch).toHaveBeenCalledTimes(1);
  });

  it('aborts a cloud upstream request when the client disconnects', async () => {
    let upstreamSignal;
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      upstreamSignal = init.signal;
      markFetchStarted();
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'));
        if (init.signal.aborted) {
          rejectAbort();
        } else {
          init.signal.addEventListener('abort', rejectAbort, { once: true });
        }
      });
    }));

    const appPort = await listen(http.createServer(createQwenProxyApp(loadQwenProxyConfig({
      QWEN_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      QWEN_API_KEY: 'test-key',
      CHAT_REQUESTS_PER_MINUTE: '0'
    }))));
    const request = startDisconnectingRequest(appPort, '/api/qwen/chat/completions', {
      messages: [{ role: 'user', content: 'ok' }]
    });

    await fetchStarted;
    request.destroy();
    await vi.waitFor(() => expect(upstreamSignal.aborted).toBe(true));
  });

  it('aborts local inference without triggering cloud fallback after client disconnect', async () => {
    let markLocalStarted;
    let markLocalClosed;
    const localStarted = new Promise((resolve) => {
      markLocalStarted = resolve;
    });
    const localClosed = new Promise((resolve) => {
      markLocalClosed = resolve;
    });
    const upstreamPort = await listen(http.createServer((_request, response) => {
      markLocalStarted();
      response.once('close', markLocalClosed);
    }));
    const cloudFetch = vi.fn();
    vi.stubGlobal('fetch', cloudFetch);
    const appPort = await listen(http.createServer(createQwenProxyApp(loadQwenProxyConfig({
      VLM_PORT: String(upstreamPort),
      QWEN_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      QWEN_API_KEY: 'test-key',
      ALLOW_CLOUD_FALLBACK: 'true',
      CHAT_REQUESTS_PER_MINUTE: '0'
    }))));
    const request = startDisconnectingRequest(appPort, '/api/ollama/chat/completions', {
      messages: [{ role: 'user', content: 'ok' }]
    });

    await localStarted;
    request.destroy();
    await localClosed;
    await new Promise((resolve) => setImmediate(resolve));
    expect(cloudFetch).not.toHaveBeenCalled();
  });

  it('rejects oversized local upstream responses', async () => {
    const upstreamPort = await listen(http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('x'.repeat(2048));
    }));
    const appPort = await listen(http.createServer(createQwenProxyApp(loadQwenProxyConfig({
      VLM_PORT: String(upstreamPort),
      MAX_UPSTREAM_RESPONSE_BYTES: '1024',
      CHAT_REQUESTS_PER_MINUTE: '0'
    }))));

    const result = await requestJson(appPort, '/api/ollama/chat/completions', {
      messages: [{ role: 'user', content: 'ok' }]
    });

    expect(result.status).toBe(502);
    expect(result.body.error.type).toBe('upstream_response_too_large');
  });

  it('rejects oversized cloud upstream responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2048), { status: 200 })));
    const appPort = await listen(http.createServer(createQwenProxyApp(loadQwenProxyConfig({
      QWEN_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      QWEN_API_KEY: 'test-key',
      MAX_UPSTREAM_RESPONSE_BYTES: '1024',
      CHAT_REQUESTS_PER_MINUTE: '0'
    }))));

    const result = await requestJson(appPort, '/api/qwen/chat/completions', {
      messages: [{ role: 'user', content: 'ok' }]
    });

    expect(result.status).toBe(502);
    expect(result.headers['x-vlm-source']).toBe('cloud');
    expect(result.body.error.type).toBe('upstream_response_too_large');
  });

  it('parses upstream JSON responses', () => {
    expect(parseProxyResponseText('{"choices":[{"message":{"content":"ok"}}]}')).toEqual({
      choices: [{ message: { content: 'ok' } }]
    });
  });

  it('keeps non-JSON upstream responses in a raw payload', () => {
    expect(parseProxyResponseText('service unavailable')).toEqual({ raw: 'service unavailable' });
  });

  it('builds Qwen timeout and proxy error responses without changing payload shape', () => {
    const timeoutError = new Error('aborted');
    timeoutError.name = 'AbortError';

    expect(buildProxyErrorResponse(timeoutError, {
      timeoutMessage: 'Qwen 接口请求超时',
      timeoutType: 'timeout_error',
      fallbackMessage: '代理请求失败',
      fallbackType: 'proxy_error'
    })).toEqual({
      statusCode: 504,
      body: {
        error: {
          message: 'Qwen 接口请求超时',
          type: 'timeout_error'
        }
      }
    });

    expect(buildProxyErrorResponse(new Error('network down'), {
      timeoutMessage: 'Qwen 接口请求超时',
      timeoutType: 'timeout_error',
      fallbackMessage: '代理请求失败',
      fallbackType: 'proxy_error'
    })).toEqual({
      statusCode: 500,
      body: {
        error: {
          // 5xx 不回传内部错误细节（如 connect ECONNREFUSED 泄露上游地址）
          message: '代理请求失败',
          type: 'proxy_error'
        }
      }
    });
  });

  it('builds Ollama timeout responses with the existing timeout type', () => {
    const timeoutError = new Error('aborted');
    timeoutError.name = 'AbortError';

    expect(buildProxyErrorResponse(timeoutError, {
      timeoutMessage: 'Ollama 推理超时',
      timeoutType: 'timeout',
      fallbackMessage: '代理请求失败',
      fallbackType: 'proxy_error'
    })).toEqual({
      statusCode: 504,
      body: {
        error: {
          message: 'Ollama 推理超时',
          type: 'timeout'
        }
      }
    });
  });

  it('preserves Express client error status codes instead of turning them into 500s', () => {
    const badJsonError = Object.assign(new Error('Unexpected token } in JSON'), { status: 400 });
    const tooLargeError = Object.assign(new Error('request entity too large'), { statusCode: 413 });

    expect(buildExpressErrorResponse(badJsonError)).toEqual({
      statusCode: 400,
      body: {
        error: {
          message: 'Unexpected token } in JSON',
          type: 'invalid_request'
        }
      }
    });
    expect(buildExpressErrorResponse(tooLargeError).statusCode).toBe(413);
    // 5xx 不向外回传内部错误消息，避免泄露实现细节
    expect(buildExpressErrorResponse(new Error('boom'))).toEqual({
      statusCode: 500,
      body: {
        error: {
          message: 'Internal server error',
          type: 'internal_error'
        }
      }
    });
  });
});

describe('payload validation contract (shared/fixtures/payloadValidation.json)', () => {
  const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'fixtures', 'payloadValidation.json');
  const { cases, config } = JSON.parse(readFileSync(fixturesPath, 'utf8'));

  it.each(cases.map((c) => [c.name, c]))('%s', (_name, { body, expected }) => {
    // 阈值来自夹具（生成器由 PAYLOAD_VALIDATION_DEFAULTS 实算落盘）—— 与 Rust 侧同源
    expect(validateChatCompletionPayload(body, config)).toEqual(expected);
  });
});
