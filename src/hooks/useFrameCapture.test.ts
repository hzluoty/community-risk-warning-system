import { describe, expect, it } from 'vitest'
import { createCapturedFrame } from './useFrameCapture'

describe('createCapturedFrame', () => {
  it('increments the sequence and records capture metadata', () => {
    const frame = createCapturedFrame(0, 'data:image/jpeg;base64,a', true, 1234, 42)

    expect(frame.frameSequence).toBe(1)
    expect(frame.frameDataUrl).toBe('data:image/jpeg;base64,a')
    expect(frame.hasChanged).toBe(true)
    expect(frame.capturedAt).toBe(1234)
    expect(frame.capturedMonotonicAt).toBe(42)
  })

  it('uses Date.now() when capturedAt is omitted', () => {
    const before = Date.now()
    const frame = createCapturedFrame(5, 'data:', false)
    const after = Date.now()

    expect(frame.frameSequence).toBe(6)
    expect(frame.capturedAt).not.toBeNull()
    expect(frame.capturedAt!).toBeGreaterThanOrEqual(before)
    expect(frame.capturedAt!).toBeLessThanOrEqual(after)
  })

  it('rejects invalid previous sequences', () => {
    expect(() => createCapturedFrame(-1, 'data:', false)).toThrow(/out of range/)
    expect(() => createCapturedFrame(Number.NaN, 'data:', false)).toThrow(/out of range/)
    expect(() => createCapturedFrame(1.5, 'data:', false)).toThrow(/out of range/)
    expect(() => createCapturedFrame(Number.MAX_SAFE_INTEGER, 'data:', false)).toThrow(/out of range/)
  })
})
