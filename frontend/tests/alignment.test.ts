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
// the buffer's default clock is performance.now (monotonic): fake it too
const FAKE = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] as const }
beforeEach(() => {
  vi.useFakeTimers(FAKE as never)
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
    vi.advanceTimersByTime(999)
    expect(out).toHaveLength(0) // nothing before the display delay
    // C1: 1 is a gap (a later result has been present > grace) -> released at ITS delay
    // deadline without boxes, strictly before 2, which follows with its own result
    vi.advanceTimersByTime(1)
    expect(out.map(([f]) => f.frameId)).toEqual([1, 2])
    expect(out[0][1]).toBeNull()
    expect(out[1][1]!.frame_id).toBe(2)
  })

  it('test_head_without_later_results_waits_for_timeout', () => {
    buf.pushFrame(1, bmp())
    vi.advanceTimersByTime(500)
    buf.pushFrame(2, bmp()) // no results at all (server silent): 1 waits up to timeoutMs
    vi.advanceTimersByTime(2499)
    expect(out).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(out.map(([f, r]) => [f.frameId, r])).toEqual([[1, null]])
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
    const b = new AlignmentBuffer(1000, 1000, { fps: 3 }) // max 3 (+2 slack) frames
    const got: Array<number | null> = []
    b.onReady((f, r) => got.push(r ? f.frameId : null))
    for (let i = 0; i < 7; i++) b.pushFrame(i, bmp())
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

  it('delay >= timeout: a frame with its result is still released WITH boxes', () => {
    const b = new AlignmentBuffer(4000, 3000)
    const got: Array<FrameResult | null> = []
    b.onReady((_f, r) => got.push(r))
    b.pushFrame(1, bmp())
    b.pushResult(1, res(1))
    vi.advanceTimersByTime(3999)
    expect(got).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(got).toHaveLength(1)
    expect(got[0]!.detections).toHaveLength(1)
    expect(b.stats.timedOut).toBe(0)
    // a frame WITHOUT a result still times out at timeoutMs
    b.pushFrame(2, bmp())
    vi.advanceTimersByTime(3000)
    expect(got).toHaveLength(2)
    expect(got[1]).toBeNull()
    b.dispose()
  })

  it('setDelay above timeout keeps boxes for frames that have results', () => {
    buf.pushFrame(1, bmp())
    buf.pushResult(1, res(1))
    buf.setDelay(5000)
    vi.advanceTimersByTime(4999)
    expect(out).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(out).toHaveLength(1)
    expect(out[0][1]!.detections).toHaveLength(1)
    expect(buf.stats.timedOut).toBe(0)
  })

  for (const [delay, timeout] of [[4000, 3000], [1000, 3000]]) {
    it(`streaming 60 fps, delay ${delay} / timeout ${timeout}: every frame with a result keeps its boxes`, () => {
      const b = new AlignmentBuffer(delay, timeout, { fps: 60 })
      const got: Array<[number, FrameResult | null]> = []
      b.onReady((f, r) => got.push([f.frameId, r]))
      const N = 660 // 11 s
      for (let i = 0; i < N; i++) {
        b.pushFrame(i, bmp())
        const id = i
        setTimeout(() => b.pushResult(id, res(id)), 30) // result shortly after the push
        vi.advanceTimersByTime(1000 / 60)
      }
      vi.advanceTimersByTime(delay + 1000)
      expect(got).toHaveLength(N)
      expect(got.every(([id, r]) => r !== null && r.frame_id === id)).toBe(true)
      expect(b.stats.overflow).toBe(0)
      expect(b.stats.timedOut).toBe(0)
      b.dispose()
    })
  }
})

describe('AlignmentBuffer: gaps (frames that never get a result) -- C1', () => {
  const FPS = 30
  const TICK = 1000 / FPS

  /**
   * Streams N frames at 30 fps; frames with id % gapEvery === gapEvery-1 never get a result,
   * the others get theirs `latency(id)` ms after their push. Returns release log.
   */
  function stream(opts: { delay: number; timeout: number; n: number; gapEvery: number; latency: (id: number) => number; grace?: number }) {
    const b = new AlignmentBuffer(opts.delay, opts.timeout, { fps: 60, gapGraceMs: opts.grace })
    const rel: Array<{ id: number; at: number; pushedAt: number; r: FrameResult | null }> = []
    b.onReady((f, r) => rel.push({ id: f.frameId, at: performance.now(), pushedAt: f.tMs, r }))
    const isGap = (id: number) => id % opts.gapEvery === opts.gapEvery - 1
    for (let i = 0; i < opts.n; i++) {
      b.pushFrame(i, bmp())
      const id = i
      if (!isGap(id)) setTimeout(() => b.pushResult(id, res(id)), opts.latency(id))
      vi.advanceTimersByTime(TICK)
    }
    vi.advanceTimersByTime(opts.timeout + opts.delay + 1000)
    return { b, rel, isGap }
  }

  it('every 4th frame missing: all frames released at their own delay deadline, steady cadence, never bunched', () => {
    const { b, rel, isGap } = stream({ delay: 1000, timeout: 3000, n: 302, gapEvery: 4, latency: (id) => 40 + (id % 5) * 30 })
    expect(rel.map((x) => x.id)).toEqual([...Array(302).keys()]) // strict order, nothing lost
    // each frame within one tick of its own deadline (pushedAt + delay)
    for (const x of rel) {
      expect(x.at - x.pushedAt).toBeGreaterThanOrEqual(1000)
      expect(x.at - x.pushedAt).toBeLessThanOrEqual(1000 + TICK)
    }
    // inter-release gaps never exceed ~2 ticks (no freeze, no burst)
    const gaps = rel.slice(1).map((x, i) => x.at - rel[i].at)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2 * TICK + 1)
    // never another frame's boxes; gaps without boxes, others with their own
    for (const x of rel) {
      if (isGap(x.id)) expect(x.r).toBeNull()
      else expect(x.r!.frame_id).toBe(x.id)
    }
    expect(b.stats.gapReleased).toBe(75)
    expect(b.stats.timedOut).toBe(0)
    b.dispose()
  })

  it('out-of-order result within the grace period still gets attached', () => {
    const b = new AlignmentBuffer(1000, 3000, { gapGraceMs: 200 })
    const got: Array<[number, FrameResult | null]> = []
    b.onReady((f, r) => got.push([f.frameId, r]))
    b.pushFrame(1, bmp())
    b.pushFrame(2, bmp())
    vi.advanceTimersByTime(900)
    b.pushResult(2, res(2)) // the later frame's result arrives first (other worker)
    vi.advanceTimersByTime(150) // t=1050: 1 is past its delay, but 2's result is only 150 ms old
    expect(got).toHaveLength(0)
    b.pushResult(1, res(1)) // arrives within the grace
    expect(got.map(([id, r]) => [id, r?.frame_id])).toEqual([[1, 1], [2, 2]])
    b.dispose()
  })

  it('a gap whose later result is young is released after the grace, without boxes', () => {
    const b = new AlignmentBuffer(1000, 3000, { gapGraceMs: 200 })
    const got: Array<[number, number | null, number]> = []
    b.onReady((f, r) => got.push([f.frameId, r?.frame_id ?? null, performance.now()]))
    b.pushFrame(1, bmp())
    b.pushFrame(2, bmp())
    vi.advanceTimersByTime(900)
    b.pushResult(2, res(2))
    vi.advanceTimersByTime(199)
    expect(got).toHaveLength(0)
    vi.advanceTimersByTime(1) // t=1100 = 2's result arrival + grace
    expect(got).toEqual([[1, null, 1100], [2, 2, 1100]])
    b.pushResult(1, res(1)) // too late: discarded, never attached elsewhere
    expect(b.stats.discardedResults).toBe(1)
    b.dispose()
  })

  it('early result (before its pushFrame) is kept and attached on push', () => {
    const b = new AlignmentBuffer(1000, 3000)
    const got: Array<[number, number | null]> = []
    b.onReady((f, r) => got.push([f.frameId, r?.frame_id ?? null]))
    b.pushResult(3, res(3)) // the bitmap resize is slower than the server
    vi.advanceTimersByTime(20)
    b.pushFrame(3, bmp())
    vi.advanceTimersByTime(1000)
    expect(got).toEqual([[3, 3]])
    expect(b.stats.discardedResults).toBe(0)
    b.dispose()
  })

  it('early results are bounded (window ahead of the last push) and expire after timeoutMs', () => {
    const b = new AlignmentBuffer(1000, 3000, { maxEarly: 4 })
    const got: Array<[number, number | null]> = []
    b.onReady((f, r) => got.push([f.frameId, r?.frame_id ?? null]))
    b.pushFrame(9, bmp())
    for (let i = 10; i < 16; i++) b.pushResult(i, res(i)) // window 10..13; 14, 15 discarded
    expect(b.stats.discardedResults).toBe(2)
    b.pushFrame(12, bmp()) // 10, 11 never pushed -> their early results are discarded
    expect(b.stats.discardedResults).toBe(4)
    vi.advanceTimersByTime(3001) // 13 expires unattached
    expect(b.stats.discardedResults).toBe(5)
    b.pushFrame(13, bmp())
    vi.advanceTimersByTime(5000)
    // 9: a gap (later results present) -> no boxes at its delay; 12 with its own; 13 none
    expect(got).toEqual([[9, null], [12, 12], [13, null]])
    b.dispose()
  })

  it('early dropped result attaches as "no boxes"', () => {
    const b = new AlignmentBuffer(1000, 3000)
    const got: Array<FrameResult | null> = []
    b.onReady((_f, r) => got.push(r))
    b.pushResult(1, res(1, { dropped: true }))
    b.pushFrame(1, bmp())
    vi.advanceTimersByTime(1000)
    expect(got).toEqual([null])
    expect(b.stats.dropped).toBe(1)
    b.dispose()
  })

  it('a result whose frame_id differs from the id it is pushed for is discarded', () => {
    const b = new AlignmentBuffer(1000, 3000)
    const got: Array<FrameResult | null> = []
    b.onReady((_f, r) => got.push(r))
    b.pushFrame(1, bmp())
    b.pushResult(1, res(2))
    vi.advanceTimersByTime(3000)
    expect(got).toEqual([null])
    expect(b.stats.discardedResults).toBe(1)
    b.dispose()
  })

  it('delay >= timeout with gaps: frames with results keep boxes, gaps released at timeout', () => {
    const { b, rel, isGap } = stream({ delay: 4000, timeout: 3000, n: 120, gapEvery: 4, latency: () => 50 })
    expect(rel.map((x) => x.id)).toEqual([...Array(120).keys()])
    for (const x of rel) {
      if (isGap(x.id)) expect(x.r).toBeNull()
      else expect(x.r!.frame_id).toBe(x.id)
      expect(x.at - x.pushedAt).toBeLessThanOrEqual(4000 + TICK)
    }
    expect(b.stats.overflow).toBe(0)
    b.dispose()
  })

  it('an onReady callback re-entering the buffer does not break ordering', () => {
    const b = new AlignmentBuffer(0, 3000)
    const got: number[] = []
    b.onReady((f) => {
      got.push(f.frameId)
      if (f.frameId === 1) b.pushFrame(5, bmp()) // re-entrant push
    })
    b.pushFrame(1, bmp())
    b.pushResult(1, res(1))
    b.pushResult(5, res(5))
    expect(got).toEqual([1, 5])
    b.dispose()
  })
})
