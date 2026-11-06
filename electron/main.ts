import { app, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import crypto from 'node:crypto'
import dotenv from 'dotenv'
import { createQwenProxyApp, loadQwenProxyConfig } from '../server/qwenProxy.js'
import { createTasksIngestRouter } from '../server/tasksIngest.js'
import { LOCAL_PROXY_TOKEN_HEADER } from '../shared/apiRoutes.js'
import {
  startOllama,
  stopOllama,
  isOllamaReady,
  getOllamaBaseUrl,
  getOllamaRuntimeStatus,
  isGpuAvailable,
  refreshOllamaStatus
} from './ollamaManager.js'
import {
  assertTrustedIpcSender,
  isAllowedVideoPermissionCheck,
  isAllowedVideoPermissionRequest,
  isTrustedMainFrameNavigation,
  isTrustedRendererUrl
} from './security.js'

const baseDir = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath()

const envPath = path.resolve(baseDir, '.env')
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: false })
}

const managedVlmPort = crypto.randomInt(20_000, 60_000)
const managedVlmApiKey = crypto.randomBytes(32).toString('hex')
process.env.VLM_PORT = String(managedVlmPort)
process.env.VLM_API_KEY = managedVlmApiKey

const localProxyToken = crypto.randomBytes(32).toString('hex')
const proxyConfig = {
  ...loadQwenProxyConfig(),
  host: '127.0.0.1',
  allowLocalFileOrigins: true,
  localProxyToken,
  isLocalVlmTrusted: () => isOllamaReady()
}
const server = createQwenProxyApp(proxyConfig, { tasksRouter: createTasksIngestRouter() })

let apiPort = 0
let resolveApiBase!: (apiBase: string) => void
let rejectApiBase!: (error: Error) => void
const apiBaseReady = new Promise<string>((resolve, reject) => {
  resolveApiBase = resolve
  rejectApiBase = reject
})
apiBaseReady.catch((error) => {
  console.error('[proxy] Failed to start local proxy:', error)
})
const httpServer = server.listen(0, proxyConfig.host, () => {
  const addr = httpServer.address()
  if (addr && typeof addr === 'object') {
    apiPort = addr.port
    const apiBase = `http://${proxyConfig.host}:${apiPort}`
    console.log(`Qwen proxy server is running at ${apiBase}`)
    resolveApiBase(apiBase)
    return
  }
  rejectApiBase(new Error('Qwen proxy server did not expose a TCP address'))
})

httpServer.on('error', (error: Error) => {
  rejectApiBase(error)
})

// 设置 5 分钟超时，防止慢客户端无限占用连接
httpServer.timeout = 300_000
// Node 推荐：headersTimeout 必须大于 keepAliveTimeout，且都不超过 timeout
httpServer.keepAliveTimeout = 60_000
httpServer.headersTimeout = 65_000

let mainWindow: BrowserWindow | null = null
let trustedRendererUrl: string | null = null

function assertTrustedRendererIpc(event: Electron.IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event, mainWindow?.webContents ?? null, trustedRendererUrl)
}

ipcMain.handle('get-api-base', async (event) => {
  assertTrustedRendererIpc(event)
  return apiBaseReady
})

ipcMain.handle('get-api-auth-headers', (event) => {
  assertTrustedRendererIpc(event)
  // 注意：此 token 仅保护本地 127.0.0.1 代理免遭同机其他进程滥用；
  // 它由 contextBridge 进入渲染进程是必要的，但意味着任何渲染端 XSS 都能拿到。
  // 渲染端严格 CSP、拒绝远程内容、IPC sender 校验是缓解层。
  // 头名来自 shared/apiRoutes.js（跨端 wire 契约，HTTP 头大小写不敏感）。
  return {
    [LOCAL_PROXY_TOKEN_HEADER]: localProxyToken
  }
})

ipcMain.handle('get-ollama-status', async (event) => {
  assertTrustedRendererIpc(event)
  await refreshOllamaStatus()

  return {
    ready: isOllamaReady(),
    status: getOllamaRuntimeStatus(),
    baseUrl: getOllamaBaseUrl(),
    gpu: isGpuAvailable()
  }
})

function configureWindowSecurity(window: BrowserWindow, rendererUrl: string): void {
  const { webContents } = window

  webContents.on('will-navigate', (event) => {
    if (!isTrustedRendererUrl(event.url, rendererUrl)) {
      event.preventDefault()
    }
  })

  webContents.on('will-frame-navigate', (event) => {
    if (!isTrustedMainFrameNavigation(event.url, event.isMainFrame, rendererUrl)) {
      event.preventDefault()
    }
  })

  webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererUrl)) {
      event.preventDefault()
    }
  })

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const rendererSession = webContents.session
  rendererSession.setPermissionCheckHandler((requestingContents, permission, _origin, details) => {
    if (
      requestingContents !== webContents
      || webContents.isDestroyed()
      || !isTrustedRendererUrl(webContents.getURL(), rendererUrl)
    ) {
      return false
    }

    return isAllowedVideoPermissionCheck(permission, details, rendererUrl)
  })

  rendererSession.setPermissionRequestHandler((requestingContents, permission, callback, details) => {
    const allowed = requestingContents === webContents
      && !webContents.isDestroyed()
      && isTrustedRendererUrl(webContents.getURL(), rendererUrl)
      && isAllowedVideoPermissionRequest(permission, details, rendererUrl)

    callback(allowed)
  })
}

function createWindow(): void {
  const rendererEntryPath = path.join(__dirname, '../renderer/index.html')
  const developmentRendererUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const rendererUrl = developmentRendererUrl || pathToFileURL(rendererEntryPath).href

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: '险封·社区风险预警平台',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      // Renderer loads no remote content; block plugins and spellcheck for attack surface reduction.
      plugins: false,
      spellcheck: false
    }
  })

  trustedRendererUrl = rendererUrl
  configureWindowSecurity(mainWindow, rendererUrl)

  if (developmentRendererUrl) {
    mainWindow.loadURL(developmentRendererUrl)
  } else {
    mainWindow.loadFile(rendererEntryPath)
  }
}

app.on('ready', async () => {
  try {
    await apiBaseReady
    createWindow()
    await startOllama()
  } catch (error) {
    console.error('[main] Failed to initialize application:', error)
    app.quit()
  }
})

app.on('window-all-closed', async () => {
  try {
    await stopOllama()
  } catch (error) {
    console.error('[main] Failed to stop Ollama cleanly:', error)
  }

  // 等待 in-flight 请求完成，最多 5 秒
  await new Promise<void>((resolve) => {
    const forceExit = setTimeout(() => resolve(), 5000)
    forceExit.unref()
    // 空闲 keep-alive 连接不会等 close 回调，主动断开避免拖满 5 秒
    httpServer.closeIdleConnections?.()
    httpServer.close(() => {
      clearTimeout(forceExit)
      resolve()
    })
  })

  // 桌面应用退出约定：Windows/Linux 全部窗口关闭即退出；macOS 通常保留在 Dock。
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
