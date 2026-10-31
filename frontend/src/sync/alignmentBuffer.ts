/**
 * Alignment buffer (spec §1, §5): shows each frame on the secondary screen together with ITS
 * OWN result, after a constant display delay.
 *
 * Release rule, per frame, strictly in frameId order (head-of-line):
 * - result arrived and `delayMs` passed since the frame was pushed -> released with the result
 *   (constant latency => smooth playback even when results come early);
 * - `dropped:true` result -> same timing, released with result=null (no boxes);
 * - GAP: no result, `delayMs` passed, AND a result for a LATER frame has been present for at
 *   least `gapGraceMs` -> released with result=null. Results come back in frame order per
 *   worker; the grace absorbs reordering across workers. A frame that never reaches the
 *   server (canvas track / encoder skipped it, unreadable marker -- 13-28 % of stamped frames
 *   measured) therefore does not hold back the frames behind it: they keep their cadence.
 * - `timeoutMs` passed since the frame was pushed WITHOUT a result -> released with
 *   result=null (the server is silent: no later result to prove a gap).
 *   The timeout only bounds the wait for a missing result: a frame whose result is present is
 *   always released with it once `delayMs` has passed, even if delayMs >= timeoutMs.
 * Results for frames not pushed YET (the bitmap resize was slower than the server) are kept
 * in a small map (ids at most `maxEarly` ahead of the last pushed frame, expire after
 * `timeoutMs`) and attached on push. Results
 * for frames that are no longer buffered (late, duplicate, skipped) are discarded and counted
 * -- a result is NEVER attached to another frame. A released frame's bitmap is closed right
 * after the onReady callbacks return, so callbacks must draw synchronously.
 * Clock: performance.now (monotonic) by default.
 */

/** default wait after a later frame's result before a result-less head is declared a gap */
export const DEFAULT_GAP_GRACE_MS = 200
export const DEFAULT_MAX_EARLY = 64

export interface DetectionMsg {
  bbox: [number, number, number, number] // xywh, normalized 0..1 of the ORIGINAL frame
  class_name: string
  confidence: number // 0..1
}

export interface FrameResult {
  type?: string
  frame_id: number
  pts: number
  dropped: boolean
  detections: DetectionMsg[]
  classification: Record<string, string>
  anatomy: { status?: string } | null
}

export type FrameBitmap = (ImageBitmap | CanvasImageSource) & { close?: () => void }

export interface ReadyFrame {
  frameId: number
  bitmap: FrameBitmap
  /** push time, ms on the buffer clock */
  tMs: number
}

export interface BufferClock {
  now(): number
  setTimeout(cb: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}

const defaultClock: BufferClock = {
  now: () => performance.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface BufferStats {
  released: number
  withResult: number
  timedOut: number
  /** released without boxes because later frames already had results (C1) */
  gapReleased: number
  dropped: number
  overflow: number
  discardedResults: number
  ignoredFrames: number
}

interface Entry {
  frame: ReadyFrame
  result?: FrameResult | null // undefined = waiting; null = dropped (ready, no boxes)
  /** buffer-clock time the result (or dropped marker) arrived */
  resultAt?: number
}

interface Early {
  result: FrameResult
  at: number
}

export interface BufferOptions {
  /** UPPER bound on the stream rate (memory cap), default 60 */
  fps?: number
  clock?: BufferClock
  gapGraceMs?: number
  maxEarly?: number
}

export class AlignmentBuffer {
  readonly stats: BufferStats = {
    released: 0, withResult: 0, timedOut: 0, gapReleased: 0, dropped: 0, overflow: 0, discardedResults: 0, ignoredFrames: 0,
  }
  private queue: Entry[] = []
  private early = new Map<number, Early>()
  private callbacks = new Set<(f: ReadyFrame, r: FrameResult | null) => void>()
  private timer: unknown = null
  private lastPushed = -1
  private disposed = false
  private pumping = false
  private repump = false
  private maxFrames: number
  private readonly fps: number
  private readonly clock: BufferClock
  private readonly gapGraceMs: number
  private readonly maxEarly: number

  constructor(
    private delayMs: number,
    private timeoutMs: number,
    opts: BufferOptions = {},
  ) {
    this.clock = opts.clock ?? defaultClock
    this.fps = opts.fps ?? 60
    this.gapGraceMs = Math.max(0, opts.gapGraceMs ?? DEFAULT_GAP_GRACE_MS)
    this.maxEarly = Math.max(0, opts.maxEarly ?? DEFAULT_MAX_EARLY)
    this.maxFrames = this.cap()
  }

  setDelay(delayMs: number) {
    this.delayMs = delayMs
    this.maxFrames = this.cap()
    this.pump()
  }

  /** memory bound: frames that can legitimately wait = max(delay, timeout) * fps */
  private cap() {
    // +2: timer jitter / a push landing just before the head is due must not evict it
    return Math.max(1, Math.ceil((Math.max(this.delayMs, this.timeoutMs) / 1000) * this.fps) + 2)
  }

  onReady(cb: (frame: ReadyFrame, result: FrameResult | null) => void): () => void {
    this.callbacks.add(cb)
    return () => this.callbacks.delete(cb)
  }

  pushFrame(frameId: number, bitmap: FrameBitmap, tMs?: number) {
    if (this.disposed || frameId <= this.lastPushed) {
      // duplicate / out-of-order id: ordering is by id, never reorder
      this.stats.ignoredFrames++
      bitmap.close?.()
      return
    }
    this.lastPushed = frameId
    const e: Entry = { frame: { frameId, bitmap, tMs: tMs ?? this.clock.now() } }
    for (const [id, x] of this.early) {
      if (id < frameId) {
        // that frame was never pushed (skipped): its result has no frame to go to
        this.early.delete(id)
        this.stats.discardedResults++
      } else if (id === frameId) {
        this.early.delete(id)
        this.attach(e, x.result, x.at)
      }
    }
    this.queue.push(e)
    while (this.queue.length > this.maxFrames) {
      this.stats.overflow++
      this.release(this.queue.shift()!, null)
    }
    this.pump()
  }

  pushResult(frameId: number, result: FrameResult) {
    if (this.disposed || result.frame_id !== frameId) {
      this.stats.discardedResults++
      return
    }
    if (frameId > this.lastPushed) {
      this.keepEarly(frameId, result)
      this.pump() // a result for a later frame can unblock a gap at the head
      return
    }
    const e = this.find(frameId)
    if (!e || e.result !== undefined) {
      this.stats.discardedResults++
      return
    }
    this.attach(e, result, this.clock.now())
    this.pump()
  }

  dispose() {
    this.disposed = true
    this.clearTimer()
    for (const e of this.queue) e.frame.bitmap.close?.()
    this.queue = []
    this.early.clear()
    this.callbacks.clear()
  }

  private attach(e: Entry, result: FrameResult, at: number) {
    e.resultAt = at
    if (result.dropped) {
      e.result = null
      this.stats.dropped++
    } else {
      e.result = result
    }
  }

  private keepEarly(frameId: number, result: FrameResult) {
    // only a few frames ahead is plausible (resize lag); anything further is bogus. The window
    // also bounds the map: ids in (lastPushed, lastPushed + maxEarly], older ones are removed
    // on push
    if (this.early.has(frameId) || frameId - this.lastPushed > this.maxEarly) {
      this.stats.discardedResults++
      return
    }
    this.expireEarly(this.clock.now())
    this.early.set(frameId, { result, at: this.clock.now() })
  }

  private expireEarly(now: number) {
    for (const [id, x] of this.early) {
      if (now - x.at >= this.timeoutMs) {
        this.early.delete(id)
        this.stats.discardedResults++
      }
    }
  }

  /** queue is sorted by frameId (pushes are strictly increasing) */
  private find(frameId: number): Entry | undefined {
    let lo = 0
    let hi = this.queue.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const id = this.queue[mid].frame.frameId
      if (id === frameId) return this.queue[mid]
      if (id < frameId) lo = mid + 1
      else hi = mid - 1
    }
    return undefined
  }

  private clearTimer() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private release(e: Entry, result: FrameResult | null) {
    this.stats.released++
    if (result) this.stats.withResult++
    try {
      for (const cb of [...this.callbacks]) {
        try {
          cb(e.frame, result)
        } catch (err) {
          console.error('AlignmentBuffer onReady callback failed', err)
        }
      }
    } finally {
      e.frame.bitmap.close?.()
    }
  }

  private pump = () => {
    if (this.pumping) {
      // re-entered from an onReady callback: run again once the current pass is done
      this.repump = true
      return
    }
    this.pumping = true
    try {
      do {
        this.repump = false
        this.pumpOnce()
      } while (this.repump && !this.disposed)
    } finally {
      this.pumping = false
    }
  }

  private pumpOnce() {
    this.clearTimer()
    if (this.disposed) return
    const now = this.clock.now()
    this.expireEarly(now)
    // earliest arrival of a result for any frame AFTER index i (suffix minimum); early results
    // belong to frames after every queued one
    let earlyAt = Infinity
    for (const x of this.early.values()) earlyAt = Math.min(earlyAt, x.at)
    const n = this.queue.length
    const laterAt = new Array<number>(n)
    let m = earlyAt
    for (let i = n - 1; i >= 0; i--) {
      laterAt[i] = m
      const r = this.queue[i].resultAt
      if (r !== undefined && r < m) m = r
    }
    let i = 0
    let wakeAt = Infinity
    while (i < n && !this.disposed && !this.repump) {
      const e = this.queue[0]
      const t0 = e.frame.tMs
      if (e.result !== undefined) {
        if (now - t0 >= this.delayMs) {
          this.queue.shift()
          i++
          this.release(e, e.result)
          continue
        }
        wakeAt = t0 + this.delayMs
        break
      }
      if (now - t0 >= this.timeoutMs) {
        this.queue.shift()
        i++
        this.stats.timedOut++
        this.release(e, null)
        continue
      }
      const gapAt = laterAt[i] === Infinity ? Infinity : Math.max(t0 + this.delayMs, laterAt[i] + this.gapGraceMs)
      if (now >= gapAt) {
        this.queue.shift()
        i++
        this.stats.gapReleased++
        this.release(e, null)
        continue
      }
      wakeAt = Math.min(t0 + this.timeoutMs, gapAt)
      break
    }
    if (this.disposed || this.repump) return
    if (wakeAt !== Infinity) {
      this.timer = this.clock.setTimeout(this.pump, Math.max(0, wakeAt - now))
    } else if (this.early.size) {
      // nothing queued: wake to expire early results
      let first = Infinity
      for (const x of this.early.values()) first = Math.min(first, x.at)
      this.timer = this.clock.setTimeout(this.pump, Math.max(0, first + this.timeoutMs - now))
    }
  }
}
