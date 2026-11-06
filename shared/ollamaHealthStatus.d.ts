export type OllamaRuntimeStatus = 'starting' | 'loading' | 'ready' | 'error';
export type GpuAvailability = 'unknown';

export interface OllamaHealthStatus {
  ready: boolean;
  status: OllamaRuntimeStatus;
  gpu: GpuAvailability;
}

export declare const GPU_AVAILABILITY_UNKNOWN: GpuAvailability;
export declare function resolveOllamaHealthStatus(statusCode: number): OllamaHealthStatus;
