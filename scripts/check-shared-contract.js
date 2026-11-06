/**
 * CI 防漂移校验：重新生成契约与夹具，并与已提交文件逐字节比对。
 * 不一致即退出码 1 —— 有人改了 shared/ 常量或夹具却忘了 npm run gen:contract。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildContract } from './generate-shared-contract.js'
import {
  buildEnvCases,
  buildPayloadValidationCases,
  buildRequestBodyCases
} from '../shared/contractFixtures.js'
import {
  ROUTE_PLACEHOLDERS,
  TASKS_RESULTS_ROUTE
} from '../shared/apiRoutes.js'
import { VLM_BUNDLE_FILTER } from '../shared/vlmBundleFiles.js'

const sharedDir = join(import.meta.dirname, '..', 'shared')

const committed = (file) => readFileSync(join(sharedDir, file), 'utf8')
const regenerated = (value) => `${JSON.stringify(value, null, 2)}\n`

const targets = [
  ['contract.json', buildContract()],
  ['fixtures/env.json', buildEnvCases()],
  ['fixtures/requestBody.json', buildRequestBodyCases()],
  ['fixtures/payloadValidation.json', buildPayloadValidationCases()]
]

let stale = false
for (const [file, value] of targets) {
  if (committed(file) !== regenerated(value)) {
    console.error(`${file} is stale — run \`npm run gen:contract\` and commit the result.`)
    stale = true
  }
}

if (stale) process.exit(1)

// proxyCases 路径必须绑定契约常量（占位符），否则报 stale。
// 谓词只接受两种情形：占位符展开后等于某条契约路由，或形如
// TASKS_RESULTS_ROUTE + '/<id>' 的动态子路径 —— 任意 /api/tasks/xxx 不再放行。
// 占位符表单一来源：shared/apiRoutes.js 的 ROUTE_PLACEHOLDERS（8 条）
const PLACEHOLDERS = ROUTE_PLACEHOLDERS

const proxyCases = JSON.parse(readFileSync(join(sharedDir, 'proxyCases.json'), 'utf8'))
const contractRoutes = Object.values(PLACEHOLDERS).filter(Boolean)

const resolveCasePath = (path) => {
  let resolved = path
  for (const [placeholder, value] of Object.entries(PLACEHOLDERS)) {
    resolved = resolved.replaceAll(placeholder, value)
  }
  return resolved
}

const isBoundPath = (rawPath) => {
  const hasPlaceholder = Object.keys(PLACEHOLDERS).some((ph) => rawPath.includes(ph))
  if (!hasPlaceholder) {
    return false
  }
  const resolved = resolveCasePath(rawPath)
  return (
    contractRoutes.includes(resolved) ||
    resolved.startsWith(`${TASKS_RESULTS_ROUTE}/`)
  )
}

// step 键白名单：两个 runner（JS 与 Rust）都只解释这组键 ——
// 未知键会被两侧静默吞掉（用例"声称断言了某事却没断言"），在此强制报 stale。
const ALLOWED_STEP_KEYS = new Set([
  'method',
  'path',
  'headers',
  'body',
  'rawBody',
  'expectedStatus',
  'expectedBody',
  'expectedHeaders',
  'ignoreBodyKeys',
  'matchBodySubset'
])

for (const testCase of proxyCases.cases) {
  for (const step of testCase.steps) {
    if (!isBoundPath(step.path)) {
      console.error(
        `shared/proxyCases.json path ${step.path} is not bound to shared/apiRoutes.js placeholders — use {{TASKS_INGEST_ROUTE}} etc.`
      )
      stale = true
    }
    for (const headerName of Object.keys(step.headers ?? {})) {
      if (headerName === 'x-local-proxy-token') {
        console.error(
          `shared/proxyCases.json uses literal header ${headerName} — use {{LOCAL_PROXY_TOKEN_HEADER}}.`
        )
        stale = true
      }
    }
    for (const key of Object.keys(step)) {
      if (!ALLOWED_STEP_KEYS.has(key)) {
        console.error(
          `shared/proxyCases.json step key "${key}" is unknown to both runners — ` +
            'add the assertion to server/proxyContract.test.js AND src-tauri/crates/proxy/src/contract_cases.rs, then extend ALLOWED_STEP_KEYS.'
        )
        stale = true
      }
    }
  }
}

// vlmRuntime.llamaServerArgs 条目形状校验：每条必须有 flag，value/source 至多一个，
// 且 source 必须在双端已实现的白名单内 —— 否则两端都产出"缺值参数"且测试可能仍绿。
const ALLOWED_ARG_SOURCES = new Set([
  'modelPath', 'modelAlias', 'port', 'host', 'gpuLayers', 'contextSize',
  'batchSize', 'ubatchSize', 'cacheTypeK', 'cacheTypeV', 'mtpDraftTokens'
])

const vlmRuntime = JSON.parse(readFileSync(join(sharedDir, 'vlmRuntime.json'), 'utf8'))
const validateArgEntries = (entries, section) => {
  for (const entry of entries) {
    if (typeof entry.flag !== 'string' || entry.flag.length === 0) {
      console.error(`vlmRuntime.${section}: entry ${JSON.stringify(entry)} lacks a flag`)
      stale = true
      continue
    }
    const hasValue = 'value' in entry
    const hasSource = 'source' in entry
    if (hasValue && hasSource) {
      console.error(`vlmRuntime.${section}.${entry.flag}: value 与 source 互斥`)
      stale = true
    }
    if (hasSource && !ALLOWED_ARG_SOURCES.has(entry.source)) {
      console.error(
        `vlmRuntime.${section}.${entry.flag}: unknown source "${entry.source}" — 双端都未实现，会产出缺值参数。`
      )
      stale = true
    }
  }
}
validateArgEntries(vlmRuntime.llamaServerArgs.argsTemplate, 'llamaServerArgs.argsTemplate')
validateArgEntries(vlmRuntime.llamaServerArgs.mtpArgs, 'llamaServerArgs.mtpArgs')

// Electron extraResources.filter 必须与 shared/vlmBundleFiles.js 的
// VLM_BUNDLE_FILTER 完全一致（双向：多出或缺失都报 —— 两壳运行时依赖集不得分叉；
// Tauri 打包脚本直接 import 后者，Electron 侧 electron-builder 只读 package.json）。
const pkg = JSON.parse(readFileSync(join(sharedDir, '..', 'package.json'), 'utf8'))
const electronFilter = pkg.build?.extraResources?.[0]?.filter ?? []
const electronSorted = [...electronFilter].sort()
const sharedSorted = [...VLM_BUNDLE_FILTER].sort()
if (JSON.stringify(electronSorted) !== JSON.stringify(sharedSorted)) {
  const electronSet = new Set(electronFilter)
  const sharedSet = new Set(VLM_BUNDLE_FILTER)
  for (const entry of sharedSet) {
    if (!electronSet.has(entry)) {
      console.error(`package.json extraResources.filter 缺少 ${entry} — 与 shared/vlmBundleFiles.js 不同步。`)
    }
  }
  for (const entry of electronSet) {
    if (!sharedSet.has(entry)) {
      console.error(`package.json extraResources.filter 多出 ${entry} — 与 shared/vlmBundleFiles.js 不同步。`)
    }
  }
  stale = true
}

if (stale) process.exit(1)
console.log('shared/contract.json, fixtures, and proxy cases are in sync.')
