import { describe, expect, it, vi } from 'vitest'
import {
  VLM_CONNECTION_ERROR_MESSAGE,
  canCaptureVlmFrames,
  checkVlmConnectionStatus,
  consumeUnchangedVlmFrame,
  finalizeVlmFrame,
  getDetectorRetryDelayMs,
  getVlmAnalysisFailure,
  isCurrentVlmAnalysisRun,
  isFreshVlmObservation,
  isRequestCanceled,
  planVlmDispatch,
  resetVlmAnalysisContext,
  shouldHandleFrameSequence,
  shouldResetVlmStatusAfterConnectionReady
} from './useVlmAnalysis'
import { createCapturedFrame } from './useFrameCapture'
import { VlmResponseError } from '@/services/llm/ollamaClient'

describe('finalizeVlmFrame', () => {
  it('releases the analysis lock and consumes the frame even after cancellation', () => {
    const markConsumed = vi.fn()
    const releaseAnalysisLock = vi.fn()

    finalizeVlmFrame({
      markConsumed,
      releaseAnalysisLock
    })

    expect(markConsumed).toHaveBeenCalledTimes(1)
    expect(releaseAnalysisLock).toHaveBeenCalledTimes(1)
  })
})

describe('VLM connection and capture state', () => {
  it('keeps connection checks enabled while camera capture is unavailable', () => {
    expect(canCaptureVlmFrames(true, false, true)).toBe(false)
    expect(canCaptureVlmFrames(true, true, true)).toBe(true)
    expect(canCaptureVlmFrames(false, true, true)).toBe(false)
  })

  it('clears only connection-originated errors when a ready status is observed', () => {
    expect(shouldResetVlmStatusAfterConnectionReady(
      'error',
      VLM_CONNECTION_ERROR_MESSAGE,
      false
    )).toBe(true)
    expect(shouldResetVlmStatusAfterConnectionReady('error', 'VLM 接口请求超时', false)).toBe(false)
    expect(shouldResetVlmStatusAfterConnectionReady('error', '旧连接错误', true)).toBe(true)
    expect(shouldResetVlmStatusAfterConnectionReady('response-error', '格式异常', true)).toBe(false)
  })
})

describe('frame sequencing and context lifecycle', () => {
  it('publishes a new sequence for byte-identical frames', () => {
    const first = createCapturedFrame(0, 'data:image/jpeg;base64,same', false, 100)
    const second = createCapturedFrame(first.frameSequence, first.frameDataUrl!, false, 200)

    expect(first.frameDataUrl).toBe(second.frameDataUrl)
    expect(first.frameSequence).toBe(1)
    expect(second.frameSequence).toBe(2)
    expect(shouldHandleFrameSequence(second.frameSequence, first.frameSequence)).toBe(true)
    expect(shouldHandleFrameSequence(first.frameSequence, first.frameSequence)).toBe(false)
  })

  it('rejects work invalidated while asynchronous detection is still running', () => {
    const startedRun = 7

    expect(isCurrentVlmAnalysisRun(startedRun, startedRun, false)).toBe(true)
    expect(isCurrentVlmAnalysisRun(startedRun, startedRun + 1, false)).toBe(false)
    expect(isCurrentVlmAnalysisRun(startedRun, startedRun, true)).toBe(false)
  })

  it('aborts and invalidates the prior request when analysis context changes', () => {
    const controller = new AbortController()
    const invalidateAnalysisRun = vi.fn()
    const resetDispatchClock = vi.fn()
    const markConsumed = vi.fn()
    const releaseAnalysisLock = vi.fn()

    resetVlmAnalysisContext({
      controller,
      invalidateAnalysisRun,
      resetDispatchClock,
      markConsumed,
      releaseAnalysisLock
    })

    expect(controller.signal.aborted).toBe(true)
    expect(invalidateAnalysisRun).toHaveBeenCalledTimes(1)
    expect(resetDispatchClock).toHaveBeenCalledTimes(1)
    expect(markConsumed).toHaveBeenCalledTimes(1)
    expect(releaseAnalysisLock).toHaveBeenCalledTimes(1)
  })
})

describe('isRequestCanceled', () => {
  it('recognizes browser and axios cancellation errors', () => {
    expect(isRequestCanceled(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true)
    expect(isRequestCanceled(Object.assign(new Error('canceled'), { name: 'CanceledError' }))).toBe(true)
    expect(isRequestCanceled({ code: 'ERR_CANCELED' })).toBe(true)
  })

  it('does not hide real VLM failures', () => {
    expect(isRequestCanceled(new Error('model failed'))).toBe(false)
    expect(isRequestCanceled(null)).toBe(false)
  })
})

describe('getVlmAnalysisFailure', () => {
  it('keeps malformed model output separate from connection failures', () => {
    expect(getVlmAnalysisFailure(new VlmResponseError('缺少必填字段'))).toEqual({
      status: 'response-error',
      message: 'VLM 在线，但响应格式异常：缺少必填字段'
    })
  })

  it('keeps transport failures as connection errors', () => {
    expect(getVlmAnalysisFailure(new Error('connect ECONNREFUSED'))).toEqual({
      status: 'error',
      message: 'connect ECONNREFUSED'
    })
  })
})

describe('consumeUnchangedVlmFrame', () => {
  it('consumes unchanged frames so capture loops do not stay locked', () => {
    const markConsumed = vi.fn()

    expect(consumeUnchangedVlmFrame({
      frameDataUrl: 'data:image/jpeg;base64,abc',
      hasChanged: false,
      markConsumed
    })).toBe(true)

    expect(markConsumed).toHaveBeenCalledTimes(1)
  })

  it('keeps changed or missing frames for normal processing', () => {
    const markConsumed = vi.fn()

    expect(consumeUnchangedVlmFrame({
      frameDataUrl: 'data:image/jpeg;base64,abc',
      hasChanged: true,
      markConsumed
    })).toBe(false)
    expect(consumeUnchangedVlmFrame({
      frameDataUrl: null,
      hasChanged: false,
      markConsumed
    })).toBe(false)

    expect(markConsumed).not.toHaveBeenCalled()
  })

  it('lets unchanged frames through when the idle VLM probe is due', () => {
    const markConsumed = vi.fn()

    expect(consumeUnchangedVlmFrame({
      frameDataUrl: 'data:image/jpeg;base64,abc',
      hasChanged: false,
      markConsumed,
      now: 20_000,
      lastVlmTime: 5_000,
      idleProbeIntervalMs: 12_000
    })).toBe(false)

    expect(markConsumed).not.toHaveBeenCalled()
  })

  it('still consumes unchanged frames before the idle probe window elapses', () => {
    const markConsumed = vi.fn()

    expect(consumeUnchangedVlmFrame({
      frameDataUrl: 'data:image/jpeg;base64,abc',
      hasChanged: false,
      markConsumed,
      now: 10_000,
      lastVlmTime: 5_000,
      idleProbeIntervalMs: 12_000
    })).toBe(true)

    expect(markConsumed).toHaveBeenCalledTimes(1)
  })
})

describe('planVlmDispatch', () => {
  it('dispatches immediately when lightweight detection has failed', () => {
    expect(planVlmDispatch({
      detectorFailed: true,
      detections: [],
      now: 1_000,
      lastVlmTime: 900,
      fallbackIntervalMs: 6_000
    })).toEqual({
      shouldSendVlm: true,
      reason: 'detector-failed'
    })
  })

  it('dispatches detected objects without claiming in-flight preemption', () => {
    expect(planVlmDispatch({
      detectorFailed: false,
      detections: [{ label: 'bicycle', score: 0.42, bbox: [0, 0, 1, 1] }],
      now: 1_000,
      lastVlmTime: 900,
      fallbackIntervalMs: 6_000
    })).toEqual({
      shouldSendVlm: true,
      reason: 'object'
    })
  })

  it('dispatches non-priority candidate objects without escalation', () => {
    expect(planVlmDispatch({
      detectorFailed: false,
      detections: [{ label: 'backpack', score: 0.36, bbox: [0, 0, 1, 1] }],
      now: 1_000,
      lastVlmTime: 900,
      fallbackIntervalMs: 6_000
    })).toEqual({
      shouldSendVlm: true,
      reason: 'object'
    })
  })

  it('uses the fallback interval when no objects are detected', () => {
    expect(planVlmDispatch({
      detectorFailed: false,
      detections: [],
      now: 10_000,
      lastVlmTime: 3_000,
      fallbackIntervalMs: 6_000
    })).toEqual({
      shouldSendVlm: true,
      reason: 'fallback'
    })
  })

  it('skips empty detections inside the fallback window', () => {
    expect(planVlmDispatch({
      detectorFailed: false,
      detections: [],
      now: 8_000,
      lastVlmTime: 3_000,
      fallbackIntervalMs: 6_000
    })).toEqual({
      shouldSendVlm: false,
      reason: 'skip'
    })
  })
})

describe('detector retry backoff', () => {
  it('backs off exponentially and caps retries at 30 seconds', () => {
    expect(getDetectorRetryDelayMs(1)).toBe(2_000)
    expect(getDetectorRetryDelayMs(2)).toBe(4_000)
    expect(getDetectorRetryDelayMs(5)).toBe(30_000)
    expect(getDetectorRetryDelayMs(20)).toBe(30_000)
  })
})

describe('checkVlmConnectionStatus', () => {
  it('uses proxy cloud fallback status when Electron local VLM is still starting', async () => {
    const httpGet = vi.fn().mockResolvedValue({
      data: {
        ready: true,
        status: 'ready'
      }
    })

    await expect(checkVlmConnectionStatus({
      electronApi: {
        getApiBase: async () => 'http://127.0.0.1:1234',
        getOllamaStatus: async () => ({
          ready: false,
          status: 'starting',
          baseUrl: 'http://127.0.0.1:11434',
          gpu: 'unknown'
        })
      },
      httpGet
    })).resolves.toEqual({
      ready: true,
      status: 'ready',
      source: 'proxy'
    })

    expect(httpGet).toHaveBeenCalledWith('/api/ollama/status', { timeout: 3000 })
  })

  it('keeps Electron status when neither local nor proxy fallback is ready', async () => {
    const httpGet = vi.fn().mockResolvedValue({
      data: {
        ready: false,
        status: 'error'
      }
    })

    await expect(checkVlmConnectionStatus({
      electronApi: {
        getApiBase: async () => 'http://127.0.0.1:1234',
        getOllamaStatus: async () => ({
          ready: false,
          status: 'starting',
          baseUrl: 'http://127.0.0.1:11434',
          gpu: 'unknown'
        })
      },
      httpGet
    })).resolves.toEqual({
      ready: false,
      status: 'starting',
      source: 'electron'
    })
  })
})


describe('monotonic observation freshness', () => {
  it('accepts exactly the configured age boundary', () => {
    expect(isFreshVlmObservation(100, 30100, 30000)).toBe(true)
  })

  it('rejects responses beyond the capture-based age limit', () => {
    expect(isFreshVlmObservation(100, 30100.001, 30000)).toBe(false)
  })

  it('rejects missing and invalid monotonic timestamps', () => {
    expect(isFreshVlmObservation(null, 100, 30000)).toBe(false)
    expect(isFreshVlmObservation(NaN, 100, 30000)).toBe(false)
    expect(isFreshVlmObservation(0, Infinity, 30000)).toBe(false)
  })

  it('rejects future captures and invalid freshness limits', () => {
    expect(isFreshVlmObservation(101, 100, 30000)).toBe(false)
    expect(isFreshVlmObservation(0, 100, 0)).toBe(false)
    expect(isFreshVlmObservation(0, 100, NaN)).toBe(false)
  })
})

describe('mandatory first and periodic VLM observations', () => {
  it('dispatches a due probe even when fallback is configured longer than idle probing', () => {
    expect(planVlmDispatch({
      detectorFailed: false, detections: [], now: 12000,
      lastVlmTime: 1000, fallbackIntervalMs: 60000, periodicProbeDue: true
    })).toEqual({ shouldSendVlm: true, reason: 'periodic-probe' })
  })

  it('does not change ordinary skip behavior when no probe is due', () => {
    expect(planVlmDispatch({
      detectorFailed: false, detections: [], now: 12000,
      lastVlmTime: 1000, fallbackIntervalMs: 60000, periodicProbeDue: false
    }).shouldSendVlm).toBe(false)
  })
})
