import { describe, expect, it, vi } from 'vitest'
import { boxToPixels, drawBoxes, labelFor } from '../src/secondary/boxRenderer'
import { ResultsClient } from '../src/sync/resultsClient'

describe('boxRenderer', () => {
  it('maps normalized xywh of the ORIGINAL frame to pixels of the full frame', () => {
    expect(boxToPixels([0.25, 0.5, 0.5, 0.25], 1920, 1080)).toEqual({ x1: 480, y1: 540, x2: 1440, y2: 810 })
  })
  it('label shows class (underscores removed) and confidence percent', () => {
    expect(labelFor({ bbox: [0, 0, 1, 1], class_name: 'ulcer_deep', confidence: 0.874 })).toBe('ulcer deep 87%')
  })
  it('draws nothing for no detections / null', () => {
    const ctx = { beginPath: vi.fn(), stroke: vi.fn() } as unknown as CanvasRenderingContext2D
    drawBoxes(ctx, [], 100, 100)
    expect((ctx.beginPath as any).mock.calls).toHaveLength(0)
  })
})

class FakeWS {
  static all: FakeWS[] = []
  onopen: any; onmessage: any; onclose: any; onerror: any
  closed = false
  constructor(public url: string) { FakeWS.all.push(this) }
  close() { this.closed = true; this.onclose?.({ code: 1000 }) }
}

describe('ResultsClient', () => {
  it('pushes messages into the buffer, reconnects with backoff, closes cleanly', () => {
    vi.useFakeTimers()
    const buf = { pushResult: vi.fn() }
    const c = new ResultsClient({ url: 'ws://x/sessions/1/results', token: 't', buffer: buf, WebSocket: FakeWS as any, backoffMs: [100, 200] })
    c.start()
    expect(FakeWS.all[0].url).toBe('ws://x/sessions/1/results?token=t')
    FakeWS.all[0].onmessage({ data: JSON.stringify({ type: 'frame', frame_id: 7, pts: 0, dropped: false, detections: [], classification: {}, anatomy: null }) })
    expect(buf.pushResult).toHaveBeenCalledWith(7, expect.objectContaining({ frame_id: 7 }))
    FakeWS.all[0].onmessage({ data: 'not json' })
    expect(buf.pushResult).toHaveBeenCalledTimes(1)
    FakeWS.all[0].onclose({ code: 1006 })
    vi.advanceTimersByTime(99)
    expect(FakeWS.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWS.all).toHaveLength(2)
    FakeWS.all[1].onclose({ code: 1006 })
    vi.advanceTimersByTime(200)
    expect(FakeWS.all).toHaveLength(3)
    c.stop()
    expect(FakeWS.all[2].closed).toBe(true)
    vi.advanceTimersByTime(10000)
    expect(FakeWS.all).toHaveLength(3)
    // session stopped by server (1000) -> no reconnect
  })
  it('does not reconnect after a normal close 1000 or auth/unknown (4401/4404)', () => {
    vi.useFakeTimers()
    FakeWS.all = []
    const c = new ResultsClient({ url: 'ws://x', buffer: { pushResult: vi.fn() }, WebSocket: FakeWS as any })
    c.start()
    FakeWS.all[0].onclose({ code: 4404 })
    vi.advanceTimersByTime(60000)
    expect(FakeWS.all).toHaveLength(1)
  })
})

describe('crop outline on the downscaled secondary canvas (I1)', () => {
  it('cropToCanvas scales ORIGINAL pixels to the canvas size', async () => {
    const { cropToCanvas } = await import('../src/secondary/boxRenderer')
    // 1080p capture shown on a 960x540 canvas
    expect(cropToCanvas({ x: 420, y: 0, w: 1080, h: 1080 }, { width: 1920, height: 1080 }, 960, 540)).toEqual({ x: 210, y: 0, w: 540, h: 540 })
    expect(cropToCanvas({ x: 1, y: 2, w: 3, h: 4 }, null, 960, 540)).toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })
  it('SecondaryScreen strokes the outline inside the 960-px canvas for a 1080p crop', async () => {
    const React = await import('react')
    const { render, act } = await import('@testing-library/react')
    const { SecondaryScreen } = await import('../src/secondary/SecondaryScreen')
    const strokeRect = vi.fn()
    const ctx = { drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), strokeRect, beginPath: vi.fn(), stroke: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
    let cb: ((f: { frameId: number; bitmap: unknown; tMs: number }, r: null) => void) | undefined
    const buffer = { onReady: (f: typeof cb) => ((cb = f), () => {}) }
    render(React.createElement(SecondaryScreen, {
      buffer: buffer as never, profile: { alertThreshold: 0.5, soundEnabled: false, bufferDelayMs: 1000 },
      crop: { x: 420, y: 0, w: 1080, h: 1080 }, sourceSize: { width: 1920, height: 1080 }, beep: () => {},
    }))
    act(() => cb!({ frameId: 1, bitmap: { width: 960, height: 540 }, tMs: 0 }, null))
    expect(strokeRect).toHaveBeenCalledWith(210, 0, 540, 540)
    vi.restoreAllMocks()
  })
})

describe('ResultsClient against the server rejection sequence (accept, then close 4401/4404)', () => {
  for (const code of [4401, 4404]) {
    it(`open then close ${code}: no reconnect, state closed, reason reported`, () => {
      vi.useFakeTimers()
      FakeWS.all = []
      const states: string[] = []
      const rejected = vi.fn()
      const c = new ResultsClient({ url: 'ws://x', buffer: { pushResult: vi.fn() }, WebSocket: FakeWS as any, onState: (s) => states.push(s), onRejected: rejected })
      c.start()
      FakeWS.all[0].onopen?.()
      FakeWS.all[0].onclose({ code })
      vi.advanceTimersByTime(60000)
      expect(FakeWS.all).toHaveLength(1)
      expect(states).toEqual(['connecting', 'open', 'closed'])
      expect(rejected).toHaveBeenCalledWith(code)
      vi.useRealTimers()
    })
  }
})

describe('segment look', () => {
  const rec = () => {
    const calls: string[] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : (..._a: unknown[]) => { calls.push(k) }),
      set: (t, k: string, v) => { t[k] = v; return true },
    }) as unknown as CanvasRenderingContext2D
    ;(ctx as unknown as { measureText: () => { width: number } }).measureText = () => ({ width: 40 })
    return { ctx, calls }
  }
  const tri: [number, number][] = [[0.2, 0.2], [0.5, 0.2], [0.35, 0.5]]

  it('a finding with an outline is filled and stroked as a smooth path, not as brackets', () => {
    const { ctx, calls } = rec()
    drawBoxes(ctx, [{ bbox: [0.2, 0.2, 0.3, 0.3], class_name: 'polyp', confidence: 0.8, polygon: tri }], 960, 540)
    expect(calls.filter((c) => c === 'quadraticCurveTo')).toHaveLength(3) // one curve per vertex
    expect(calls).toContain('fill')
    expect(calls.filter((c) => c === 'stroke').length).toBeGreaterThanOrEqual(2) // rim + bright line
    expect(calls).not.toContain('arcTo') // the box brackets use arcTo
    expect(calls).toContain('fillText') // label plate
  })
  it('a box without an outline (or with fewer than 3 points) keeps the bracket look', () => {
    for (const polygon of [undefined, null, [[0.1, 0.1], [0.2, 0.2]] as [number, number][]]) {
      const { ctx, calls } = rec()
      drawBoxes(ctx, [{ bbox: [0.2, 0.2, 0.3, 0.3], class_name: 'polyp', confidence: 0.8, polygon }], 960, 540)
      expect(calls).toContain('arcTo')
      expect(calls).not.toContain('quadraticCurveTo')
    }
  })
  it('the segment style does not leak into the next box', () => {
    // a context with a real save/restore stack, recording the line width at every arcTo
    const state: Record<string, unknown> = { lineWidth: 1, strokeStyle: '#000', fillStyle: '#000' }
    const stack: Record<string, unknown>[] = []
    const widths: unknown[] = []
    const styles: unknown[] = []
    const ctx = new Proxy(state, {
      get: (t, k: string) => {
        if (k === 'save') return () => stack.push({ ...t })
        if (k === 'restore') return () => Object.assign(t, stack.pop())
        if (k === 'measureText') return () => ({ width: 40 })
        if (k === 'arcTo') return () => { widths.push(t.lineWidth); styles.push(t.strokeStyle) }
        return k in t ? t[k] : () => {}
      },
      set: (t, k: string, v) => { t[k] = v; return true },
    }) as unknown as CanvasRenderingContext2D
    drawBoxes(ctx, [
      { bbox: [0.2, 0.2, 0.3, 0.3], class_name: 'polyp', confidence: 0.8, polygon: tri },
      { bbox: [0.6, 0.6, 0.2, 0.2], class_name: 'polyp', confidence: 0.7 },
    ], 960, 540)
    const scale = 540 / 500
    expect(widths.length).toBeGreaterThan(0)
    expect(widths.every((w) => w === 1.5 * scale)).toBe(true)
    expect(styles.every((c) => c === '#00ffef')).toBe(true)
  })
  it('smoothClosedPath starts at an edge midpoint and ends closed', async () => {
    const { smoothClosedPath } = await import('../src/secondary/boxRenderer')
    const moves: number[][] = []
    const ctx = { beginPath() {}, moveTo: (x: number, y: number) => moves.push([x, y]), quadraticCurveTo() {}, closePath() {} } as unknown as CanvasRenderingContext2D
    smoothClosedPath(ctx, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
    expect(moves).toEqual([[5, 5]]) // midpoint of the closing edge (last -> first)
  })
})
