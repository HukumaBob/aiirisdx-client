import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlignmentBuffer, type FrameResult, type ReadyFrame } from '../src/sync/alignmentBuffer'

const res = (frame_id: number, extra: Partial<FrameResult> = {}): FrameResult => ({
  frame_id,
  pts: frame_id / 30,
  dropped: false,
  detections: [{ bbox: [0.1, 0.1, 0.2, 0.2], class_name: `c${frame_id}`, confidence: 0.9 }],
  classification: {},
  anatomy: null,
  ...extra,
})
const bmp = () => ({ close: vi.fn() }) as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> }

let buf: AlignmentBuffer
let out: Array<[ReadyFrame, FrameResult | null]>
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  buf = new AlignmentBuffer(1000, 3000)
  out = []
  buf.onReady((f, r) => out.push([f, r]))
})
afterEach(() => {
  buf.dispose()
  vi.useRealTimers()
})

describe('AlignmentBuffer', () => {
  it('test_frame_shown_with_own_result', () => {
    const b = bmp()
    buf.pushFrame(5, b)
    buf.pushResult(5, res(5))
    vi.advanceTimersByTime(999)
    expect(out).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(out).toHaveLength(1)
    expect(out[0][0].frameId).toBe(5)
    expect(out[0][0].bitmap).toBe(b)
    expect(out[0][1]!.frame_id).toBe(5)
    expect(b.close).toHaveBeenCalledTimes(1)
  })

  it('test_timeout_shows_frame_without_boxes (RF1)', () => {
    buf.pushFrame(1, bmp())
    vi.advanceTimersByTime(2999)
    expect(out).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(out).toHaveLength(1)
    expect(out[0][1]).toBeNull()
    expect(buf.stats.timedOut).toBe(1)
  })

  it('test_late_result_discarded_after_timeout', () => {
    buf.pushFrame(1, bmp())
    vi.advanceTimersByTime(3000)
    buf.pushResult(1, res(1))
    vi.advanceTimersByTime(5000)
    expect(out).toHaveLength(1)
    expect(out[0][1]).toBeNull()
    expect(buf.stats.discardedResults).toBe(1)
  })

  it('test_duplicate_and_unknown_frame_id_ignored (RF3)', () => {
    buf.pushFrame(1, bmp())
    buf.pushResult(99, res(99)) // unknown
    buf.pushResult(1, res(1))
    buf.pushResult(1, res(1, { detections: [] })) // duplicate result
    const dup = bmp()
    buf.pushFrame(1, dup) // duplicate frame id
    expect(dup.close).toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(out).toHaveLength(1)
    expect(out[0][1]!.detections).toHaveLength(1)
    expect(buf.stats.discardedResults).toBe(2)
    expect(buf.stats.ignoredFrames).toBe(1)
    vi.advanceTimersByTime(10000)
    expect(out).toHaveLength(1)
  })

  it('test_dropped_result_shows_without_boxes', () => {
    buf.pushFrame(1, bmp())
    buf.pushResult(1, res(1, { dropped: true }))
    vi.advanceTimersByTime(1000)
    expect(out).toHaveLength(1)
    expect(out[0][1]).toBeNull()
    expect(buf.stats.dropped).toBe(1)
  })

  it('test_release_in_order', () => {
    buf.pushFrame(1, bmp())
    buf.pushFrame(2, bmp())
    buf.pushResult(2, res(2)) // result for 2 first, 1 has none
    vi.advanceTimersByTime(1500)
    expect(out).toHaveLength(0) // 2 must wait for 1
    vi.advanceTimersByTime(1500) // 1 times out at 3000, then 2 follows
    expect(out.map(([f]) => f.frameId)).toEqual([1, 2])
    expect(out[0][1]).toBeNull()
    expect(out[1][1]!.frame_id).toBe(2)
  })

  it('test_constant_delay_when_results_early', () => {
    const shown: number[] = []
    buf.onReady((f) => shown.push(Date.now() - f.tMs))
    for (let i = 0; i < 10; i++) {
      buf.pushFrame(i, bmp())
      buf.pushResult(i, res(i)) // result immediately
      vi.advanceTimersByTime(33)
    }
    vi.advanceTimersByTime(1500)
    expect(out).toHaveLength(10)
    expect(shown.every((d) => d >= 1000 && d <= 1000 + 33)).toBe(true)
  })

  it('bounds memory: overflow releases oldest with null', () => {
    const b = new AlignmentBuffer(1000, 1000, { fps: 3 }) // max 3 frames
    const got: Array<number | null> = []
    b.onReady((f, r) => got.push(r ? f.frameId : null))
    for (let i = 0; i < 5; i++) b.pushFrame(i, bmp())
    expect(got).toEqual([null, null])
    expect(b.stats.overflow).toBe(2)
    b.dispose()
  })

  it('dispose closes pending bitmaps and stops callbacks', () => {
    const b1 = bmp()
    buf.pushFrame(1, b1)
    buf.dispose()
    expect(b1.close).toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    expect(out).toHaveLength(0)
  })
})
