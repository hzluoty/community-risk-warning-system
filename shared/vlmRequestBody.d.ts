export function buildQwenRequestBody(
  body?: Record<string, unknown>,
  defaultModel?: string
): Record<string, unknown>;

export function buildQwenFallbackRequestBody(
  body?: Record<string, unknown>,
  model?: string
): Record<string, unknown>;

export function buildOllamaRequestBody(
  body?: Record<string, unknown>,
  model?: string
): Record<string, unknown>;
