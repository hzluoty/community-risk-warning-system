/**
 * VLM 打包白名单（单一事实源，两壳共用）：llama-server 运行时 + CPU DLL。
 * 模型 gguf 与 CUDA-only DLL 不进安装包（下载器获取）—— 与 CI 的
 * "Verify portable package VLM resources" 断言语义一致。
 * glob 语义对齐 electron-builder 的 extraResources.filter（ggml-cpu-*.dll 通配）。
 */
export const VLM_BUNDLE_FILES = Object.freeze([
  'llama-server.exe',
  'llama-server-impl.dll',
  'llama.dll',
  'llama-common.dll',
  'mtmd.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-rpc.dll',
  'libomp140.x86_64.dll'
]);

/** glob 通配（electron-builder filter 语义）：ggml-cpu-*.dll 家族全收。 */
export function matchesVlmBundleFile(fileName) {
  if (VLM_BUNDLE_FILES.includes(fileName)) return true;
  return fileName.startsWith('ggml-cpu-') && fileName.endsWith('.dll');
}

/** 完整匹配表（含 glob 展开）：Electron filter 数组 = 精确清单 + 通配一条。 */
export const VLM_BUNDLE_FILTER = Object.freeze([
  ...VLM_BUNDLE_FILES,
  'ggml-cpu-*.dll'
]);
