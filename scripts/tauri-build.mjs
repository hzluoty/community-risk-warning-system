/**
 * Tauri 打包装配：
 * 1. 用 overlay 配置（tauri.bundle.conf.json，gitignore）注入 bundle.resources ——
 *    主配置 tauri.conf.json 全程不被改写（Ctrl-C 不会留脏受控文件）；
 * 2. VLM 打包白名单单一来源：shared/vlmBundleFiles.js（与 Electron
 *    extraResources.filter 同 glob 语义 —— ggml-cpu-*.dll 家族全收）。
 *
 * 运行：node scripts/tauri-build.mjs（npm run tauri:build）
 * 前置：resources/vlm 已就绪（scripts/prepare-vlm-resources.ps1 校验）
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { matchesVlmBundleFile } from '../shared/vlmBundleFiles.js'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')
const vlmDir = join(repoRoot, 'resources', 'vlm')
const overlayPath = join(repoRoot, 'src-tauri', 'tauri.bundle.conf.json')

if (!existsSync(join(vlmDir, 'llama-server.exe'))) {
  console.error('[tauri-build] resources/vlm 缺 llama-server.exe —— 先运行 npm run download-runtime')
  process.exit(1)
}

// overlay 资源映射：白名单（含 ggml-cpu-*.dll glob）→ vlm/ 平铺（与 Electron 同层语义）
const resourceMap = {}
for (const file of readdirSync(vlmDir)) {
  if (matchesVlmBundleFile(file)) {
    resourceMap[`../resources/vlm/${file}`] = `vlm/${file}`
  }
}
const overlay = { bundle: { resources: resourceMap } }
writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, 'utf8')
console.log(`[tauri-build] overlay 已生成（${Object.keys(resourceMap).length} 个 VLM 运行时文件，白名单 = shared/vlmBundleFiles.js）`)

try {
  execSync(`npx tauri build --config "${overlayPath}"`, {
    cwd: repoRoot,
    stdio: 'inherit'
  })
} finally {
  // overlay 是临时文件（不入库）：无论如何都清理，主配置从未被改写
  rmSync(overlayPath, { force: true })
  console.log('[tauri-build] overlay 已清理（主配置未改写）')
}
