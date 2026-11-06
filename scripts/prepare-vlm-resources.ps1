#!/usr/bin/env pwsh
# Tauri 打包前置：准备 resources/vlm（llama-server 运行时 + GGUF 模型），
# 与 electron-builder 的 extraResources 语义对齐；产物映射进 tauri.conf.json
# 由 `npm run tauri:build` 消费（映射表在打包时注入，见 scripts/tauri-build.mjs）。
# 运行：powershell -File scripts/prepare-vlm-resources.ps1
# 依赖：npm run download-runtime / npm run download-model 已下载到 resources/vlm

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$vlmDir = Join-Path $repoRoot 'resources' 'vlm'

$requiredFiles = @(
  'llama-server.exe',
  'llama-server-impl.dll',
  'llama.dll',
  'llama-common.dll',
  'mtmd.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cpu-x64.dll'
)

Write-Host "[prepare-vlm] checking $vlmDir"
if (-not (Test-Path $vlmDir)) {
  Write-Warning "[prepare-vlm] $vlmDir 不存在 —— 先运行 npm run download-runtime 与 npm run download-model"
  exit 1
}

$missing = @()
foreach ($file in $requiredFiles) {
  if (-not (Test-Path (Join-Path $vlmDir $file))) {
    $missing += $file
  }
}

# GGUF 模型（主模型必需；mmproj 由 download-model 按配置提供）
$modelFiles = Get-ChildItem -Path $vlmDir -Filter '*.gguf' -ErrorAction SilentlyContinue
if ($modelFiles.Count -eq 0) {
  $missing += '<model>.gguf'
}

if ($missing.Count -gt 0) {
  Write-Warning "[prepare-vlm] 缺失文件：$($missing -join ', ')"
  Write-Warning "[prepare-vlm] 运行 npm run download-runtime / npm run download-model 后重试"
  exit 1
}

Write-Host "[prepare-vlm] resources/vlm 就绪（$($modelFiles.Count) 个 gguf + 运行时 DLL）"
