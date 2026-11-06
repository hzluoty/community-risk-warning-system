import { useCallback, useEffect, useRef, useState } from 'react'
import { computeFrameDiff, toGrayscale } from '@/utils/frameDiff'

interface FrameCaptureOptions {
  quality?: number
  maxWidth?: number
  maxHeight?: number
  enabled?: boolean
  frameDiffThreshold?: number
  /** Fast interval when motion is detected (ms) */
  activeIntervalMs?: number
  /** Slow interval when scene is idle (ms) */
  idleIntervalMs?: number
  /** Number of consecutive unchanged frames before switching to idle interval */
  idleAfterFrames?: number
}

interface FrameCaptureResult {
  frameDataUrl: string | null
  frameSequence: number
  capturedAt: number | null
  capturedMonotonicAt: number | null
  isProcessing: boolean
  captureCount: number
  error: string | null
  hasChanged: boolean
  markConsumed: () => void
}

interface CapturedFrame {
  frameDataUrl: string | null
  frameSequence: number
  capturedAt: number | null
  capturedMonotonicAt: number | null
  hasChanged: boolean
}

export function createCapturedFrame(
  previousSequence: number,
  frameDataUrl: string,
  hasChanged: boolean,
  capturedAt = Date.now(),
  capturedMonotonicAt = performance.now()
): CapturedFrame {
  if (!Number.isSafeInteger(previousSequence) || previousSequence < 0 || previousSequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Frame sequence is out of range')
  }

  return {
    frameDataUrl,
    frameSequence: previousSequence + 1,
    capturedAt,
    capturedMonotonicAt,
    hasChanged
  }
}

const DIFF_WIDTH = 160
const DIFF_HEIGHT = 120

export function useFrameCapture(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  options: FrameCaptureOptions = {}
): FrameCaptureResult {
  const {
    quality = 0.6,
    maxWidth = 480,
    maxHeight = 360,
    enabled = true,
    frameDiffThreshold = 0.05,
    activeIntervalMs = 500,
    idleIntervalMs = 5000,
    idleAfterFrames = 6
  } = options

  const [capturedFrame, setCapturedFrame] = useState<CapturedFrame>({
    frameDataUrl: null,
    frameSequence: 0,
    capturedAt: null,
    capturedMonotonicAt: null,
    hasChanged: false
  })
  const [isProcessing, setIsProcessing] = useState(false)
  const [captureCount, setCaptureCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const isProcessingRef = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const diffCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const prevGrayRef = useRef<Uint8ClampedArray | null>(null)
  const lastVideoFrameRef = useRef<{ video: HTMLVideoElement; source: string; stream: HTMLVideoElement['srcObject']; time: number } | null>(null)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  // Adaptive interval state
  const unchangedCountRef = useRef(0)
  const currentIntervalRef = useRef(activeIntervalMs)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    canvasRef.current = document.createElement('canvas')
    const diffCanvas = document.createElement('canvas')
    diffCanvas.width = DIFF_WIDTH
    diffCanvas.height = DIFF_HEIGHT
    diffCanvasRef.current = diffCanvas
    return () => {
      canvasRef.current = null
      diffCanvasRef.current = null
    }
  }, [])

  const markConsumed = useCallback(() => {
    isProcessingRef.current = false
    setIsProcessing(false)
  }, [])

  useEffect(() => {
    if (!enabled) return

    function scheduleCapture() {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = setInterval(captureLoop, currentIntervalRef.current)
    }

    function captureLoop() {
      const video = videoRef.current
      const canvas = canvasRef.current
      const diffCanvas = diffCanvasRef.current
      if (!video || !canvas || !diffCanvas || !enabledRef.current) return
      if (video.readyState < 2) return
      if (isProcessingRef.current) return

      try {
        const sourceTime = video.currentTime
        const previousVideoFrame = lastVideoFrameRef.current
        // A paused/stalled decoder is not a new observation, even if a timer fires.
        if (!Number.isFinite(sourceTime) || (
          previousVideoFrame?.video === video &&
          previousVideoFrame.source === video.currentSrc &&
          previousVideoFrame.stream === video.srcObject &&
          previousVideoFrame.time === sourceTime
        )) return

        const vw = video.videoWidth
        const vh = video.videoHeight
        if (!vw || !vh) return
        if (!previousVideoFrame || previousVideoFrame.video !== video ||
          previousVideoFrame.source !== video.currentSrc || previousVideoFrame.stream !== video.srcObject ||
          sourceTime < previousVideoFrame.time) {
          prevGrayRef.current = null
          unchangedCountRef.current = 0
        }

        const diffCtx = diffCanvas.getContext('2d')
        if (!diffCtx) return

        diffCtx.drawImage(video, 0, 0, DIFF_WIDTH, DIFF_HEIGHT)
        const imageData = diffCtx.getImageData(0, 0, DIFF_WIDTH, DIFF_HEIGHT)
        const gray = toGrayscale(imageData.data)

        const changed = prevGrayRef.current
          ? computeFrameDiff(gray, prevGrayRef.current) >= frameDiffThreshold
          : true
        prevGrayRef.current = gray

        // Adaptive interval: fast when motion, slow when idle
        if (changed) {
          unchangedCountRef.current = 0
          if (currentIntervalRef.current !== activeIntervalMs) {
            currentIntervalRef.current = activeIntervalMs
            scheduleCapture()
          }
        } else {
          unchangedCountRef.current++
          if (unchangedCountRef.current >= idleAfterFrames && currentIntervalRef.current !== idleIntervalMs) {
            currentIntervalRef.current = idleIntervalMs
            scheduleCapture()
          }
        }

        const scale = Math.min(maxWidth / vw, maxHeight / vh, 1)
        const w = Math.round(vw * scale)
        const h = Math.round(vh * scale)
        canvas.width = w
        canvas.height = h

        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const capturedAt = Date.now()
        const capturedMonotonicAt = performance.now()
        ctx.drawImage(video, 0, 0, w, h)
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        lastVideoFrameRef.current = { video, source: video.currentSrc, stream: video.srcObject, time: sourceTime }

        isProcessingRef.current = true
        setIsProcessing(true)
        setCapturedFrame((previous) => createCapturedFrame(
          previous.frameSequence,
          dataUrl,
          changed,
          capturedAt,
          capturedMonotonicAt
        ))
        setCaptureCount((c) => c + 1)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Frame capture failed')
      }
    }

    // Initial schedule with active interval
    currentIntervalRef.current = activeIntervalMs
    scheduleCapture()

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [enabled, quality, maxWidth, maxHeight, frameDiffThreshold, activeIntervalMs, idleIntervalMs, idleAfterFrames, videoRef])

  return {
    ...capturedFrame,
    isProcessing,
    captureCount,
    error,
    markConsumed
  }
}
