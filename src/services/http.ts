import axios, { AxiosHeaders } from 'axios'
import { asElectronApi, type ElectronApi } from '@/services/runtimeBridge'

export type { ElectronApi }

interface ApiBaseResolverOptions {
  envBase?: string
  electronApi?: ElectronApi
}

interface ApiAuthHeaderResolverOptions {
  electronApi?: ElectronApi
}

function normalizeApiBase(base?: string): string | undefined {
  if (!base) return undefined

  try {
    const url = new URL(base)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.port !== '0') {
      return base
    }
  } catch {
    return undefined
  }

  return undefined
}

function normalizeApiAuthHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined

  const normalized = Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [key.trim(), String(value || '').trim()])
      .filter(([key, value]) => key && value)
  )

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function extractProxyErrorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined
  }

  const error = (data as { error?: unknown }).error
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return undefined
  }

  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.trim() ? message.trim() : undefined
}

export function createApiBaseResolver(options: ApiBaseResolverOptions) {
  let cachedBase = normalizeApiBase(options.envBase)
  let pendingBase: Promise<string | undefined> | undefined

  return {
    async getApiBase() {
      if (cachedBase) {
        return cachedBase
      }

      if (!options.electronApi) {
        return undefined
      }

      pendingBase ??= options.electronApi.getApiBase().then((base) => {
        cachedBase = normalizeApiBase(base)
        return cachedBase
      }).finally(() => {
        pendingBase = undefined
      })

      return pendingBase
    }
  }
}

export function createApiAuthHeaderResolver(options: ApiAuthHeaderResolverOptions) {
  let cachedHeaders: Record<string, string> | undefined
  let pendingHeaders: Promise<Record<string, string> | undefined> | undefined

  return {
    async getApiAuthHeaders() {
      if (cachedHeaders) {
        return cachedHeaders
      }

      if (!options.electronApi?.getApiAuthHeaders) {
        return undefined
      }

      pendingHeaders ??= options.electronApi.getApiAuthHeaders().then((headers) => {
        cachedHeaders = normalizeApiAuthHeaders(headers)
        return cachedHeaders
      }).finally(() => {
        pendingHeaders = undefined
      })

      return pendingHeaders
    }
  }
}

const apiBaseResolver = createApiBaseResolver({
  envBase: import.meta.env.VITE_API_BASE_URL || undefined,
  electronApi: asElectronApi()
})

const apiAuthHeaderResolver = createApiAuthHeaderResolver({
  electronApi: asElectronApi()
})


export const http = axios.create({
  timeout: 120000
})

http.interceptors.request.use(async (config) => {
  const [apiBase, apiAuthHeaders] = await Promise.all([
    apiBaseResolver.getApiBase(),
    apiAuthHeaderResolver.getApiAuthHeaders()
  ])

  if (apiBase) {
    config.baseURL = apiBase
  }

  if (apiAuthHeaders) {
    const headers = AxiosHeaders.from(config.headers)
    for (const [key, value] of Object.entries(apiAuthHeaders)) {
      headers.set(key, value)
    }
    config.headers = headers
  }

  return config
})

http.interceptors.response.use(
  (response) => response,
  (error) => {
    // Pass through abort/cancellation errors unchanged
    if (axios.isCancel(error) || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') {
      return Promise.reject(error)
    }
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        return Promise.reject(new Error('请求超时，请检查网络连接或稍后重试'))
      }
      if (!error.response) {
        return Promise.reject(new Error('网络连接失败，请检查后端服务是否已启动'))
      }
      const serverMessage = extractProxyErrorMessage(error.response.data)
      if (serverMessage) {
        return Promise.reject(new Error(serverMessage))
      }
      if (error.response.status >= 500) {
        return Promise.reject(new Error('服务器内部错误，请稍后重试'))
      }
    }
    return Promise.reject(error)
  }
)
