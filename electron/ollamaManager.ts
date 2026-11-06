import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { resolveVlmResourceDir } from './vlmResourcePath'
import {
  GPU_AVAILABILITY_UNKNOWN,
  resolveOllamaHealthStatus,
  type GpuAvailability,
  type OllamaRuntimeStatus
} from '../shared/ollamaHealthStatus.js'
import { VLM_HAS_MMPROJ, VLM_MODEL_FILE, VLM_MMPROJ_FILE } from '../shared/vlmModelConfig.js'
import { loadVlmRuntimeConfig, type VlmRuntimeConfig } from '../shared/vlmRuntimeConfig.js'
// VLM 进程监管参数（args 模板 / env 白名单 / 退避常量）—— 与 Rust（crws-vlm）共读
// 同一份 shared/vlmRuntime.json（Rust 经 contract.json 编译期副本）。
// 双端断言：本文件的同序 argv 全列表测试 ↔ crates/vlm/src/args.rs 的
// llama_server_args_match_the_electron_manager。
import vlmRuntimeJson from '../shared/vlmRuntime.json'

interface ArgsTemplateEntry {
  flag: string
  value?: string
  source?: string
}

interface VlmRuntimeSpec {
  llamaServerArgs: {
    argsTemplate: ArgsTemplateEntry[]
    mmprojFlag: string
    mmprojPrecedenceWarning: string
    mtpArgs: ArgsTemplateEntry[]
  }
  restartPolicy: { maxRestartAttempts: number; restartDelayMs: number; resourcePollIntervalMs: number }
  childEnvWhitelist: {
    common: string[]
    windows: string[]
    unix?: string[]
    prefixes: string[]
    apiKeyVariable: string
  }
  requiredRuntimeFiles: { serverExecutable: string; cudaDlls: string[] }
}

const vlmRuntimeSpec = vlmRuntimeJson as unknown as VlmRuntimeSpec

const LLAMA_ARGS_SPEC = vlmRuntimeSpec.llamaServerArgs
const RESTART_SPEC = vlmRuntimeSpec.restartPolicy

let serverProcess: ChildProcess | null = null
let ready = false
let status: OllamaRuntimeStatus = 'starting'
let runtimeConfig: VlmRuntimeConfig | null = null
let restartAttempts = 0
let resourcePollTimer: NodeJS.Timeout | null = null
let restartTimer: NodeJS.Timeout | null = null
let stopped = false
let lifecycleGeneration = 0
const MAX_RESTART_ATTEMPTS = RESTART_SPEC.maxRestartAttempts
const RESTART_DELAY_MS = RESTART_SPEC.restartDelayMs
const RESOURCE_POLL_INTERVAL_MS = RESTART_SPEC.resourcePollIntervalMs

export interface ProcessTerminationDetails {
  kind: 'error' | 'close'
  error?: Error
  code?: number | null
  signal?: NodeJS.Signals | null
}

export function createProcessTerminationHandlers(
  onTermination: (details: ProcessTerminationDetails) => void
): {
  onError: (error: Error) => void
  onClose: (code: number | null, signal: NodeJS.Signals | null) => void
} {
  let handled = false

  const finish = (details: ProcessTerminationDetails): void => {
    if (handled) return
    handled = true
    onTermination(details)
  }

  return {
    onError: (error) => finish({ kind: 'error', error }),
    onClose: (code, signal) => finish({ kind: 'close', code, signal })
  }
}

export function calculateRestartDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.trunc(attempt))
  return RESTART_DELAY_MS * (2 ** (normalizedAttempt - 1))
}

/**
 * 子进程环境白名单（契约驱动：shared/vlmRuntime.json 的 childEnvWh名单 ——
 * 与 Rust crates/vlm/src/args.rs#build_llama_server_env 同一数据源）。
 */
export function buildLlamaServerEnv(
  sourceEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  apiKey?: string
): NodeJS.ProcessEnv {
  const whitelist = vlmRuntimeSpec.childEnvWhitelist
  const commonNames = new Set<string>(whitelist.common)
  // 非 Windows 平台的补充变量（契约只锁 Windows 打包目标的表；unix 列表保持 TS 侧补充）
  const platformNames = platform === 'win32'
    ? new Set<string>(whitelist.windows)
    : new Set<string>(whitelist.unix ?? [])
  const prefixes = whitelist.prefixes
  const apiKeyVariable = whitelist.apiKeyVariable
  const childEnv = new Map<string, string>()

  for (const [name, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue

    const normalizedName = name.toUpperCase()
    const isRuntimeSetting = prefixes.some((prefix: string) => normalizedName.startsWith(prefix))

    if (commonNames.has(normalizedName) || platformNames.has(normalizedName) || isRuntimeSetting) {
      childEnv.set(name, value)
    }
  }

  if (apiKey) {
    childEnv.set(apiKeyVariable, apiKey)
  }

  return Object.fromEntries(childEnv)
}

export function isVlmLifecycleCurrent(
  generation: number,
  currentGeneration: number,
  isStopped: boolean
): boolean {
  return !isStopped && generation === currentGeneration
}

export function getMissingRequiredVlmFiles(
  modelPath: string,
  mmprojPath: string | null,
  existsSync: (filePath: string) => boolean = fs.existsSync
): string[] {
  return [modelPath, ...(mmprojPath ? [mmprojPath] : [])].filter(
    (filePath) => !existsSync(filePath)
  )
}

interface BuildLlamaServerArgsOptions {
  modelPath: string
  mmprojPath: string | null
  vlmConfig: VlmRuntimeConfig
  effectiveGpuLayers: number
}

/**
 * 从契约模板（shared/vlmRuntime.json 的 llamaServerArgs.argsTemplate —— 与 Rust
 * crates/vlm/src/args.rs 同一数据源、同一顺序）构建 llama-server 启动参数。
 * 双端断言：本函数的同序 argv 全列表测试 ↔ Rust 的 llama_server_args_match_the_electron_manager。
 */
export function buildLlamaServerArgs(options: BuildLlamaServerArgsOptions): string[] {
  const { modelPath, mmprojPath, vlmConfig, effectiveGpuLayers } = options

  const sourceValue = (source: string): string | undefined => {
    switch (source) {
      case 'modelPath': return modelPath
      case 'modelAlias': return vlmConfig.modelAlias
      case 'port': return String(vlmConfig.port)
      case 'host': return vlmConfig.host
      case 'gpuLayers': return String(effectiveGpuLayers)
      case 'contextSize': return String(vlmConfig.contextSize)
      case 'batchSize': return String(vlmConfig.batchSize)
      case 'ubatchSize': return String(vlmConfig.ubatchSize)
      case 'cacheTypeK': return vlmConfig.cacheTypeK
      case 'cacheTypeV': return vlmConfig.cacheTypeV
      case 'mtpDraftTokens': return String(vlmConfig.mtpDraftTokens)
      default: return undefined
    }
  }

  // 单一有序表：按契约顺序逐项展开（Rust 侧同序遍历 → 同一份 argv）
  const args: string[] = []
  for (const entry of LLAMA_ARGS_SPEC.argsTemplate) {
    args.push(entry.flag)
    if (entry.value !== undefined) {
      args.push(entry.value)
    } else if (entry.source !== undefined) {
      const value = sourceValue(entry.source)
      if (value !== undefined) {
        args.push(value)
      }
    }
  }

  // MTP（draft-mtp 推测解码）与 mmproj 视觉编码器在 llama.cpp 的 MTP 分支中互斥：
  // 启用 MTP 时只能加载主模型，mmproj 不被支持。本项目以视觉研判为核心，因此当两者
  // 同时出现时优先保留视觉（加载 mmproj、忽略 MTP）并告警。MTP 仅加速文本生成、对视觉
  // 编码无效，其 --spec-* 参数也只存在于 llama.cpp 的 MTP 专用构建（官方预编译包不含）。
  if (vlmConfig.mtpEnabled && mmprojPath) {
    // 告警文案来自契约（mmprojPrecedenceWarning）—— 与 Rust 侧同一段文本
    console.warn(`[vlm] ${LLAMA_ARGS_SPEC.mmprojPrecedenceWarning}`)
  }

  if (mmprojPath) {
    args.push(LLAMA_ARGS_SPEC.mmprojFlag, mmprojPath)
  } else if (vlmConfig.mtpEnabled) {
    // 真实可用的 MTP 启用方式仅需 --spec-type draft-mtp 与 --spec-draft-n-max，且要求模型
    // 自带 MTP head；不再加载第二份模型当 draft（原 --spec-draft-model 会翻倍显存）。
    for (const entry of LLAMA_ARGS_SPEC.mtpArgs) {
      args.push(entry.flag)
      if (entry.value !== undefined) {
        args.push(entry.value)
      } else if (entry.source !== undefined) {
        const value = sourceValue(entry.source)
        if (value !== undefined) {
          args.push(value)
        }
      }
    }
  }

  return args
}

function getVlmRuntimeConfig(): VlmRuntimeConfig {
  runtimeConfig ??= loadVlmRuntimeConfig(process.env)
  return runtimeConfig
}

function getVlmBaseUrl(): string {
  const config = getVlmRuntimeConfig()
  return `http://${config.host}:${config.port}`
}

export function getOllamaBaseUrl(): string {
  return getVlmBaseUrl()
}

export function isOllamaReady(): boolean {
  return Boolean(serverProcess && ready && !stopped)
}

export function isGpuAvailable(): GpuAvailability {
  return GPU_AVAILABILITY_UNKNOWN
}

export function getOllamaRuntimeStatus(): OllamaRuntimeStatus {
  return status
}

export async function refreshOllamaStatus(): Promise<void> {
  if (!serverProcess || stopped) {
    ready = false
    status = stopped ? 'starting' : 'error'
    return
  }

  ready = await checkReady()
}

async function checkReady(): Promise<boolean> {
  try {
    const res = await fetch(`${getVlmBaseUrl()}/health`, {
      signal: AbortSignal.timeout(2000)
    })
    const healthStatus = resolveOllamaHealthStatus(res.status)
    status = healthStatus.status
    return healthStatus.ready
  } catch {
    status = serverProcess ? 'starting' : 'error'
    return false
  }
}

async function waitForReady(timeoutMs: number, expectedProcess: ChildProcess): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (serverProcess !== expectedProcess) {
      throw new Error('VLM server process ended before becoming ready')
    }
    if (await checkReady()) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('VLM server did not become ready within timeout')
}

function findVlmResources(): { serverExe: string; modelDir: string; cudaAvailable: boolean } | null {
  const modelDir = resolveVlmResourceDir({
    isPackaged: app.isPackaged,
    exePath: app.getPath('exe'),
    appPath: app.getAppPath()
  })
  // 必需运行时文件名（契约驱动：vlmRuntime.requiredRuntimeFiles —— 与 Rust resources.rs 同源）
  const serverExecutable = path.join(modelDir, vlmRuntimeSpec.requiredRuntimeFiles.serverExecutable)

  if (fs.existsSync(serverExecutable)) {
    const cudaAvailable = vlmRuntimeSpec.requiredRuntimeFiles.cudaDlls.every((dll: string) =>
      fs.existsSync(path.join(modelDir, dll))
    )
    return { serverExe: serverExecutable, modelDir, cudaAvailable }
  }

  return null
}

function schedulePollForResources(reason: string): void {
  if (stopped || resourcePollTimer || restartTimer || serverProcess) return
  console.warn(`[vlm] ${reason} — will retry every ${RESOURCE_POLL_INTERVAL_MS}ms`)
  ready = false
  status = 'error'
  resourcePollTimer = setTimeout(() => {
    resourcePollTimer = null
    if (stopped) return
    startOllama().catch((err) => {
      console.error('[vlm] Poll-driven restart failed:', err)
      schedulePollForResources('startOllama threw during poll')
    })
  }, RESOURCE_POLL_INTERVAL_MS)
  resourcePollTimer.unref?.()
}

function scheduleProcessRestart(reason: string): void {
  if (stopped || restartTimer || resourcePollTimer || serverProcess) return

  ready = false
  status = 'error'

  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    restartAttempts = 0
    schedulePollForResources(`${reason}; restart limit reached`)
    return
  }

  restartAttempts++
  const delayMs = calculateRestartDelayMs(restartAttempts)
  console.warn(
    `[vlm] ${reason}; retrying in ${delayMs}ms ` +
      `(attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`
  )
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (stopped || serverProcess) return

    status = 'starting'
    startOllama().catch((err) => {
      console.error('[vlm] Restart failed:', err)
      scheduleProcessRestart('startOllama threw during restart')
    })
  }, delayMs)
  restartTimer.unref?.()
}

export async function startOllama(): Promise<void> {
  stopped = false
  const startGeneration = lifecycleGeneration
  const vlmConfig = getVlmRuntimeConfig()

  if (serverProcess) {
    console.log('[vlm] Already starting')
    return
  }

  const resources = findVlmResources()
  if (!resources) {
    schedulePollForResources(
      'llama-server.exe not found in resources\\vlm. Reinstall the portable app or extract vlm-models.zip into <app>\\resources\\vlm\\ to enable VLM features.'
    )
    return
  }

  const { serverExe, modelDir, cudaAvailable } = resources
  const modelPath = path.join(modelDir, VLM_MODEL_FILE)
  const configuredMmprojPath = VLM_HAS_MMPROJ ? path.join(modelDir, VLM_MMPROJ_FILE) : null

  const missingFiles = getMissingRequiredVlmFiles(modelPath, configuredMmprojPath)
  if (missingFiles.includes(modelPath)) {
    schedulePollForResources(
      `Model file not found: ${modelPath}. Extract vlm-models.zip into the same folder.`
    )
    return
  }

  if (configuredMmprojPath && missingFiles.includes(configuredMmprojPath)) {
    schedulePollForResources(
      `Required vision projector not found: ${configuredMmprojPath}. ` +
        'The visual VLM service will remain stopped until mmproj is installed.'
    )
    return
  }

  const effectiveGpuLayers = cudaAvailable ? vlmConfig.gpuLayers : 0
  if (!cudaAvailable) {
    console.warn(
      '[vlm] CUDA runtime DLLs not found in resources/vlm — falling back to CPU inference. ' +
        'Extract vlm-models.zip to enable GPU acceleration.'
    )
  }

  const mmprojPath = configuredMmprojPath
  const args = buildLlamaServerArgs({ modelPath, mmprojPath, vlmConfig, effectiveGpuLayers })

  if (!isVlmLifecycleCurrent(startGeneration, lifecycleGeneration, stopped)) {
    return
  }

  console.log('[vlm] Starting:', serverExe, args.join(' '))
  status = 'starting'

  let child: ChildProcess | null = null

  try {
    child = spawn(serverExe, args, {
      cwd: modelDir,
      env: buildLlamaServerEnv(process.env, process.platform, process.env.VLM_API_KEY),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false
    })
    serverProcess = child

    const terminationHandlers = createProcessTerminationHandlers((details) => {
      if (details.kind === 'error') {
        console.error('[vlm] Process error:', details.error?.message)
      } else {
        console.warn(
          '[vlm] Process closed with code',
          details.code,
          details.signal ? `signal ${details.signal}` : ''
        )
      }

      if (serverProcess !== child) return

      serverProcess = null
      ready = false
      status = 'error'

      if (!stopped) {
        scheduleProcessRestart(
          details.kind === 'error' ? 'VLM process failed to spawn' : 'VLM process closed unexpectedly'
        )
      }
    })

    child.once('error', terminationHandlers.onError)
    child.once('close', terminationHandlers.onClose)

    child.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) console.log('[vlm]', msg)
    })

    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) console.error('[vlm]', msg)
    })

    await waitForReady(vlmConfig.startupTimeoutMs, child)
    if (
      serverProcess !== child
      || !isVlmLifecycleCurrent(startGeneration, lifecycleGeneration, stopped)
    ) {
      child.kill()
      throw new Error('VLM server process ended during startup')
    }
    ready = true
    restartAttempts = 0
    status = 'ready'
    console.log('[vlm] Ready')
  } catch (err) {
    if (!isVlmLifecycleCurrent(startGeneration, lifecycleGeneration, stopped)) {
      child?.kill()
      return
    }

    console.error('[vlm] Failed to start:', err)
    ready = false

    if (child && serverProcess === child) {
      status = 'error'
      console.warn('[vlm] Process stayed unhealthy past startup timeout; terminating for a clean retry.')
      child.kill()
      return
    }

    status = 'error'
    if (!child) {
      scheduleProcessRestart('VLM process could not be created')
    }
  }
}

export async function stopOllama(): Promise<void> {
  stopped = true
  lifecycleGeneration++
  if (resourcePollTimer) {
    clearTimeout(resourcePollTimer)
    resourcePollTimer = null
  }
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (serverProcess) {
    serverProcess.kill()
    serverProcess = null
  }
  ready = false
  status = 'starting'
}
