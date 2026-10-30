/**
 * Alignment buffer (spec §1, §5): shows each frame on the secondary screen together with ITS
 * OWN result, after a constant display delay.
 *
 * Release rule, per frame, strictly in frameId order (head-of-line):
 * - result arrived and `delayMs` passed since the frame was pushed -> released with the result
 *   (constant latency => smooth playback even when results come early);
 * - `dropped:true` result -> same timing, released with result=null (no boxes);
 * - `timeoutMs` passed since the frame was pushed WITHOUT a result -> released with result=null.
 *   The timeout only bounds the wait for a missing result: a frame whose result is present is
 *   always released with it once `delayMs` has passed, even if delayMs >= timeoutMs.
 * Results for frames that are not buffered (late, duplicate, unknown) are discarded and
 * counted -- a result is NEVER attached to another frame. A released frame's bitmap is
 * closed right after the onReady callbacks return, so callbacks must draw synchronously.
 */

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
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface BufferStats {
  released: number
  withResult: number
  timedOut: number
  dropped: number
  overflow: number
  discardedResults: number
  ignoredFrames: number
}

interface Entry {
  frame: ReadyFrame
  result?: FrameResult | null // undefined = waiting; null = dropped (ready, no boxes)
}

export class AlignmentBuffer {
  readonly stats: BufferStats = {
    released: 0, withResult: 0, timedOut: 0, dropped: 0, overflow: 0, discardedResults: 0, ignoredFrames: 0,
  }
  private queue: Entry[] = []
  private callbacks = new Set<(f: ReadyFrame, r: FrameResult | null) => void>()
  private timer: unknown = null
  private lastPushed = -1
  private disposed = false
  private maxFrames: number
  private readonly fps: number
  private readonly clock: BufferClock

  constructor(
    private delayMs: number,
    private timeoutMs: number,
    opts: { fps?: number; clock?: BufferClock } = {},
  ) {
    this.clock = opts.clock ?? defaultClock
    this.fps = opts.fps ?? 60
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
    this.queue.push({ frame: { frameId, bitmap, tMs: tMs ?? this.clock.now() } })
    while (this.queue.length > this.maxFrames) {
      this.stats.overflow++
      this.release(this.queue.shift()!, null)
    }
    this.pump()
  }

  pushResult(frameId: number, result: FrameResult) {
    const e = this.queue.find((q) => q.frame.frameId === frameId)
    if (this.disposed || !e || e.result !== undefined) {
      this.stats.discardedResults++
      return
    }
    if (result.dropped) {
      e.result = null
      this.stats.dropped++
    } else {
      e.result = result
    }
    this.pump()
  }

  dispose() {
    this.disposed = true
    this.clearTimer()
    for (const e of this.queue) e.frame.bitmap.close?.()
    this.queue = []
    this.callbacks.clear()
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
    this.clearTimer()
    if (this.disposed) return
    const now = this.clock.now()
    while (this.queue.length) {
      const e = this.queue[0]
      const age = now - e.frame.tMs
      if (e.result !== undefined && age >= this.delayMs) {
        this.queue.shift()
        this.release(e, e.result)
      } else if (e.result === undefined && age >= this.timeoutMs) {
        this.queue.shift()
        this.stats.timedOut++
        this.release(e, null)
      } else {
        const wait = (e.result !== undefined ? this.delayMs : this.timeoutMs) - age
        this.timer = this.clock.setTimeout(this.pump, Math.max(0, wait))
        return
      }
    }
  }
}
