export interface QwenEndpoint {
  key: string;
  baseUrl: string;
  chatCompletionsUrl: string;
}

export const QWEN_ENDPOINT_KEYS: Record<string, string>;
export const QWEN_ENDPOINTS: Record<string, QwenEndpoint>;

export function deriveChatCompletionsUrl(baseUrl: string): string;
export function findQwenEndpointByKey(endpointKey: string): QwenEndpoint | null;
