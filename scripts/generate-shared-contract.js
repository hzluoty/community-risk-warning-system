/**
 * 从 shared/ 生成契约与行为夹具（三个文件，职责分层）：
 *   shared/contract.json              —— 路由 / schema / 模型别名 / 端点表 / 任务 ID（纯契约）
 *   shared/fixtures/env.json          —— 环境解析夹具（parseBoolean / parseInteger / vlmRuntimeConfig / bodyLimits）
 *   shared/fixtures/requestBody.json  —— 上游请求体裁决夹具（三个 builder 的实算期望）
 * 夹具计算层在 shared/contractFixtures.js（JS 单测与 Rust 共用同一份期望）。
 * 生成器只 import shared/，不依赖任何服务端实现模块（重构期间旧模块可被安全删除）。
 * 运行：npm run gen:contract；CI 用 npm run check:contract 校验无漂移。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  API_HEALTH_ROUTE,
  LOCAL_PROXY_TOKEN_HEADER,
  OLLAMA_CHAT_COMPLETIONS_ROUTE,
  OLLAMA_STATUS_ROUTE,
  QWEN_CHAT_COMPLETIONS_ROUTE,
  TASKS_INGEST_ROUTE,
  TASKS_RESULTS_ROUTE,
  TASKS_ROUTE_PREFIX,
  TASKS_RUN_ROUTE
} from '../shared/apiRoutes.js'
import {
  DEFAULT_QWEN_VLM_API_MODEL,
  DEFAULT_VLM_MODEL_ALIAS,
  LLAMA_CPP_CUDA_VERSION,
  LLAMA_CPP_VERSION,
  VLM_HAS_MMPROJ,
  VLM_MMPROJ_FILE,
  VLM_MMPROJ_SHA256,
  VLM_MODEL_FILE,
  VLM_MODEL_SHA256
} from '../shared/vlmModelConfig.js'
import { VLM_RESPONSE_FORMAT } from '../shared/vlmResponseSchema.js'
import { EVENT_RESPONSE_FORMAT } from '../shared/eventResponseSchema.js'
import { QWEN_ENDPOINTS } from '../shared/qwenEndpoints.js'
import { COMPETITION_TASK_IDS } from '../shared/taskIds.js'
import { ROUTE_PLACEHOLDERS, TOKEN_PLACEHOLDER } from '../shared/apiRoutes.js'
import { readFileSync } from 'node:fs'
import { buildEnvCases, buildRequestBodyCases } from '../shared/contractFixtures.js'

const scriptDir = dirname(fileURLToPath(import.meta.url))

export function buildContract() {
  return {
    apiRoutes: {
      health: API_HEALTH_ROUTE,
      qwenChatCompletions: QWEN_CHAT_COMPLETIONS_ROUTE,
      ollamaChatCompletions: OLLAMA_CHAT_COMPLETIONS_ROUTE,
      ollamaStatus: OLLAMA_STATUS_ROUTE
    },
    tasksRoutes: {
      prefix: TASKS_ROUTE_PREFIX,
      ingest: TASKS_INGEST_ROUTE,
      results: TASKS_RESULTS_ROUTE,
      run: TASKS_RUN_ROUTE
    },
    headers: {
      localProxyToken: LOCAL_PROXY_TOKEN_HEADER
    },
    routePlaceholders: { ...ROUTE_PLACEHOLDERS, [TOKEN_PLACEHOLDER]: '' },
    // VLM 进程监管参数（llama-server 参数模板 / env 白名单 / 退避常量 / 必需运行时文件）：
    // 源文件 shared/vlmRuntime.json，由 TS（electron/ollamaManager.ts）与 Rust（crws-vlm）
    // 共读 —— check:contract 的字节比对自动覆盖本段（消灭 divergences 的无断言分叉）。
    vlmRuntime: JSON.parse(readFileSync(join(scriptDir, '..', 'shared', 'vlmRuntime.json'), 'utf8')),
    vlmModel: {
      defaultAlias: DEFAULT_VLM_MODEL_ALIAS,
      defaultQwenApiModel: DEFAULT_QWEN_VLM_API_MODEL,
      modelFile: VLM_MODEL_FILE,
      mmprojFile: VLM_MMPROJ_FILE,
      hasMmproj: VLM_HAS_MMPROJ,
      modelSha256: VLM_MODEL_SHA256,
      mmprojSha256: VLM_MMPROJ_SHA256,
      llamaCppVersion: LLAMA_CPP_VERSION,
      llamaCppCudaVersion: LLAMA_CPP_CUDA_VERSION
    },
    vlmResponseFormat: VLM_RESPONSE_FORMAT,
    eventResponseFormat: EVENT_RESPONSE_FORMAT,
    qwenEndpoints: Object.values(QWEN_ENDPOINTS).map(({ key, baseUrl }) => ({ key, baseUrl })),
    competitionTaskIds: [...COMPETITION_TASK_IDS]
  }
}

const sharedDir = join(scriptDir, '..', 'shared')
const fixturesDir = join(sharedDir, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })

const writeJson = (file, value) => {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  console.log(`written ${file}`)
}

writeJson(join(sharedDir, 'contract.json'), buildContract())
writeJson(join(fixturesDir, 'env.json'), buildEnvCases())
writeJson(join(fixturesDir, 'requestBody.json'), buildRequestBodyCases())
