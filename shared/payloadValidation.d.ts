export declare const DISALLOWED_TOKEN_LIMIT_FIELDS: readonly string[];

export interface PayloadValidationVerdict {
  ok: boolean;
  message?: string;
}

export declare function validateChatCompletionPayload(
  body?: Record<string, unknown>,
  config?: { maxChatMessages?: number; maxChatTokens?: number }
): PayloadValidationVerdict;

export declare function normalizeChatCompletionPayload(
  body?: Record<string, unknown>,
  config?: { maxChatTokens?: number }
): Record<string, unknown>;
