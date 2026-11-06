/**
 * 行为契约测试：消费 shared/proxyCases.json（JS 与 Rust 代理共享的 golden 用例），
 * 打到当前 Express 实现上。Rust 侧（src-tauri/crates/proxy）用同一份文件
 * 经 tower::ServiceExt::oneshot 断言 —— 任何一侧行为漂移都会在本侧或对侧变红。
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadQwenProxyConfig, createQwenProxyApp } from './qwenProxy.js';
import { createTasksIngestRouter } from './tasksIngest.js';
import { ROUTE_PLACEHOLDERS, TOKEN_PLACEHOLDER } from '../shared/apiRoutes.js';

const casesFile = JSON.parse(readFileSync(new URL('../shared/proxyCases.json', import.meta.url), 'utf8'));

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

function stripIgnored(body, keys) {
  if (!body || typeof body !== 'object' || !keys?.length) return body;
  const clone = structuredClone(body);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const key of keys) delete node[key];
    for (const value of Object.values(node)) walk(value);
  };
  walk(clone);
  return clone;
}

function matchSubset(actual, expected, path = '') {
  for (const [key, value] of Object.entries(expected ?? {})) {
    const at = path ? `${path}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      expect(actual?.[key], at).toBeTypeOf('object');
      matchSubset(actual?.[key], value, at);
    } else {
      expect(actual?.[key], at).toEqual(value);
    }
  }
}

// 占位符表单一来源：shared/apiRoutes.js 的 ROUTE_PLACEHOLDERS（含鉴权头名）+ TOKEN_PLACEHOLDER
const resolveCaseValue = (value, config) => {
  let resolved = value
  for (const [placeholder, route] of Object.entries(ROUTE_PLACEHOLDERS)) {
    resolved = resolved.replaceAll(placeholder, route)
  }
  resolved = resolved.replaceAll(TOKEN_PLACEHOLDER, config.localProxyToken || '')
  return resolved
}

async function runStep(port, step, config) {
  const headers = {};
  for (const [key, value] of Object.entries(step.headers ?? {})) {
    headers[resolveCaseValue(key, config)] = resolveCaseValue(String(value), config);
  }
  let body;
  if ('rawBody' in step) {
    body = step.rawBody;
    headers['Content-Type'] = 'application/json';
  } else if (step.body !== undefined) {
    body = JSON.stringify(step.body);
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`http://127.0.0.1:${port}${resolveCaseValue(step.path, config)}`, {
    method: step.method,
    headers,
    body,
    signal: AbortSignal.timeout(10_000)
  });

  const responseHeaders = Object.fromEntries(response.headers.entries());
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  return { status: response.status, headers: responseHeaders, body: parsed, raw: text };
}

afterEach(async () => {
  await Promise.all(
    testServers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    )
  );
});

describe('proxy behavior contract (shared/proxyCases.json)', () => {
  for (const testCase of casesFile.cases) {
    it(testCase.name, async () => {
      const envConfig = casesFile.configs[testCase.config]?.env ?? {};
      const config = loadQwenProxyConfig(envConfig);
      const app = createQwenProxyApp(config, { tasksRouter: createTasksIngestRouter() });
      const port = await listen(http.createServer(app));

      for (const step of testCase.steps) {
        const result = await runStep(port, step, config);

        expect(result.status, `${testCase.name} ${step.method} ${step.path}`).toBe(step.expectedStatus);

        if (step.expectedBody !== undefined) {
          const actual = stripIgnored(result.body, step.ignoreBodyKeys);
          if (step.matchBodySubset) {
            matchSubset(actual, step.expectedBody);
          } else {
            expect(actual, `${testCase.name} body`).toEqual(step.expectedBody);
          }
        }

        if (step.expectedHeaders) {
          for (const [name, value] of Object.entries(step.expectedHeaders)) {
            const lower = name.toLowerCase();
            expect(
              result.headers[lower],
              `${testCase.name} header ${name}`
            ).toContain(value);
          }
        }
      }
    });
  }
});
