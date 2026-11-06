/**
 * 云端 Qwen 上游端点表 —— 单一事实源（key + baseUrl）。
 * chatCompletionsUrl 一律由 baseUrl 派生，消除表内重复；
 * JS 服务端、Rust 端（经 shared/contract.json 的 qwenEndpoints 段）共用这张表，
 * 任何一侧不得再私持第二份 URL 清单。
 */

export const QWEN_ENDPOINT_KEYS = {
  LOCAL_LM_STUDIO: 'local-lm-studio',
  LOCAL_LM_STUDIO_HOSTNAME: 'local-lm-studio-hostname',
  LOCAL_OLLAMA: 'local-ollama',
  LOCAL_OLLAMA_HOSTNAME: 'local-ollama-hostname',
  DASHSCOPE_CN: 'dashscope-cn',
  DASHSCOPE_INTL: 'dashscope-intl',
  DASHSCOPE_US: 'dashscope-us',
  BIGMODEL: 'bigmodel'
};

/** 仅存 key + baseUrl；chatCompletionsUrl 运行时派生。 */
const ENDPOINT_TABLE = {
  LOCAL_LM_STUDIO: {
    key: QWEN_ENDPOINT_KEYS.LOCAL_LM_STUDIO,
    baseUrl: 'http://127.0.0.1:1234/v1'
  },
  LOCAL_LM_STUDIO_HOSTNAME: {
    key: QWEN_ENDPOINT_KEYS.LOCAL_LM_STUDIO_HOSTNAME,
    baseUrl: 'http://localhost:1234/v1'
  },
  LOCAL_OLLAMA: {
    key: QWEN_ENDPOINT_KEYS.LOCAL_OLLAMA,
    baseUrl: 'http://127.0.0.1:11434/v1'
  },
  LOCAL_OLLAMA_HOSTNAME: {
    key: QWEN_ENDPOINT_KEYS.LOCAL_OLLAMA_HOSTNAME,
    baseUrl: 'http://localhost:11434/v1'
  },
  DASHSCOPE_CN: {
    key: QWEN_ENDPOINT_KEYS.DASHSCOPE_CN,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  },
  DASHSCOPE_INTL: {
    key: QWEN_ENDPOINT_KEYS.DASHSCOPE_INTL,
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
  },
  DASHSCOPE_US: {
    key: QWEN_ENDPOINT_KEYS.DASHSCOPE_US,
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1'
  },
  BIGMODEL: {
    key: QWEN_ENDPOINT_KEYS.BIGMODEL,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4'
  }
};

export function deriveChatCompletionsUrl(baseUrl) {
  return `${baseUrl}/chat/completions`;
}

export const QWEN_ENDPOINTS = Object.fromEntries(
  Object.entries(ENDPOINT_TABLE).map(([name, endpoint]) => [
    name,
    { ...endpoint, chatCompletionsUrl: deriveChatCompletionsUrl(endpoint.baseUrl) }
  ])
);

/** 按 key 查端点（含派生 URL）。 */
export function findQwenEndpointByKey(endpointKey) {
  return Object.values(QWEN_ENDPOINTS).find((endpoint) => endpoint.key === endpointKey) ?? null;
}
