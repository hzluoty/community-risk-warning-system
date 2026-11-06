import { describe, expect, it } from 'vitest';
import { resolveOllamaHealthStatus } from '../shared/ollamaHealthStatus.js';

describe('ollamaHealthStatus', () => {
  it('centralizes ready/loading/error mapping for llama-server health responses', () => {
    expect(resolveOllamaHealthStatus(200)).toEqual({ ready: true, status: 'ready', gpu: 'unknown' });
    expect(resolveOllamaHealthStatus(204)).toEqual({ ready: true, status: 'ready', gpu: 'unknown' });
    expect(resolveOllamaHealthStatus(503)).toEqual({ ready: false, status: 'loading', gpu: 'unknown' });
    expect(resolveOllamaHealthStatus(500)).toEqual({ ready: false, status: 'error', gpu: 'unknown' });
  });
});
