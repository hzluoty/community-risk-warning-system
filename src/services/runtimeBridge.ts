/**
 * 运行时桥接（唯一入口）：渲染端经由一个模块获取 apiBase / 鉴权头 / VLM 状态。
 * Electron 实现读 window.electronAPI（contextBridge），Tauri 实现走
 * window.__TAURI__.core.invoke。http.ts 与 useVlmAnalysis.ts 只依赖本模块
 * 导出的接口 —— 桌面壳迁移的改动面收敛到此文件。
 *
 * 运行时契约类型的唯一所有者也在此：`ElectronApi` 形状同时被
 * src/types/electron.d.ts 的全局 Window 声明引用，禁止在他处重复 declare。
 */

export interface ElectronApi {
  getApiBase: () => Promise<string | undefined>
  getApiAuthHeaders?: () => Promise<Record<string, string> | undefined>
  getOllamaStatus: () => Promise<
    { ready: boolean; status: string; baseUrl: string; gpu: 'unknown' } | undefined
  >
}

export interface RuntimeBridge {
  getApiBase: () => Promise<string | undefined>
  getApiAuthHeaders: () => Promise<Record<string, string> | undefined>
  getOllamaStatus: () => Promise<
    { ready: boolean; status: string; baseUrl: string; gpu: 'unknown' } | undefined
  >
}

interface TauriCore {
  invoke: (command: string) => Promise<unknown>
}

export interface TauriGlobal {
  core?: TauriCore
}

declare global {
  interface Window {
    electronAPI?: ElectronApi
    __TAURI__?: TauriGlobal
    __TAURI_INTERNALS__?: { invoke?: TauriCore['invoke'] }
  }
}

// 全局 Window 声明的唯一所有者在本模块（src/types/electron.d.ts 仅做类型再导出引用，
// 不重复 declare）。

function detectElectronApi(): ElectronApi | undefined {
  return typeof window === 'undefined' ? undefined : window.electronAPI
}

function detectTauriCore(): TauriCore | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  // Tauri v2 全局注入（withGlobalTauri）或 __TAURI_INTERNALS__（默认注入）
  const tauri = window.__TAURI__?.core ?? window.__TAURI_INTERNALS__
  if (tauri && typeof tauri.invoke === 'function') {
    return { invoke: (command: string) => tauri.invoke!(command) }
  }
  return undefined
}

/** Electron 桥接（contextBridge 语义透传）。 */
export function createElectronBridge(electronApi: ElectronApi): RuntimeBridge {
  return {
    getApiBase: () => electronApi.getApiBase() ?? Promise.resolve(undefined),
    getApiAuthHeaders: () => electronApi.getApiAuthHeaders?.() ?? Promise.resolve(undefined),
    getOllamaStatus: () =>
      electronApi.getOllamaStatus() ?? Promise.resolve(undefined)
  }
}

/** Tauri 桥接（invoke 语义透传；命令名与壳侧 #[tauri::command] 一一对应）。 */
export function createTauriBridge(core: TauriCore): RuntimeBridge {
  const invokeString = async (command: string): Promise<string | undefined> => {
    const value = await core.invoke(command)
    return typeof value === 'string' ? value : undefined
  }
  const invokeRecord = async (command: string): Promise<Record<string, string> | undefined> => {
    const value = await core.invoke(command)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => [key, String(v ?? '')] as const)
      .filter(([, v]) => v !== '')
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }
  const invokeStatus = async (
    command: string
  ): Promise<{ ready: boolean; status: string; baseUrl: string; gpu: 'unknown' } | undefined> => {
    const value = await core.invoke(command)
    if (!value || typeof value !== 'object') {
      return undefined
    }
    const record = value as Record<string, unknown>
    if (typeof record.ready !== 'boolean' || typeof record.status !== 'string') {
      return undefined
    }
    return {
      ready: record.ready,
      status: record.status,
      baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
      gpu: 'unknown'
    }
  }

  return {
    getApiBase: () => invokeString('get_api_base'),
    getApiAuthHeaders: () => invokeRecord('get_api_auth_headers'),
    getOllamaStatus: () => invokeStatus('get_ollama_status')
  }
}

/** 环境探测顺序：Electron contextBridge 优先（共存时不误判），其次 Tauri。 */
export function createRuntimeBridge(
  options: {
    electronApi?: ElectronApi
    tauriCore?: TauriCore
  } = {}
): RuntimeBridge {
  const electronApi = options.electronApi ?? detectElectronApi()
  const tauriCore = options.tauriCore ?? detectTauriCore()

  if (electronApi) {
    return createElectronBridge(electronApi)
  }
  if (tauriCore) {
    return createTauriBridge(tauriCore)
  }
  // 浏览器直连（dev:web + dev:server）：无桥接，走相对路径 + Vite 代理
  return {
    getApiBase: async () => undefined,
    getApiAuthHeaders: async () => undefined,
    getOllamaStatus: async () => undefined
  }
}

/** 单例桥接（渲染端模块图共享同一实例）。 */
export const runtimeBridge: RuntimeBridge = createRuntimeBridge()

/** 唯一适配器：把三态桥接适配为 ElectronApi 形状（含全部三方法）。
 * ElectronApi.getOllamaStatus 必返四字段：缺桥（浏览器直连）时回退 error 形状。 */
export function asElectronApi(bridge: RuntimeBridge = runtimeBridge): ElectronApi {
  return {
    getApiBase: () => bridge.getApiBase(),
    getApiAuthHeaders: () => bridge.getApiAuthHeaders(),
    getOllamaStatus: async () => {
      const status = await bridge.getOllamaStatus()
      return status ?? { ready: false, status: 'error', baseUrl: '', gpu: 'unknown' as const }
    }
  }
}
