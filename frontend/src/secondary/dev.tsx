/**
 * Dev / manual check page (secondary-dev.html, dev server only). No backend needed:
 * a synthetic source (canvas, a red square moving on a gradient, optionally a looped video via
 * ?video=URL) goes through the REAL startCapture -> onFrameBitmap -> AlignmentBuffer ->
 * SecondaryScreen path. A fake "detector" reads the actual frame bitmap (finds the red
 * square), and delivers a result for that frame_id after a random 100..900 ms latency; some
 * results are dropped (dropped:true), some never arrive (-> timeout, no boxes).
 * Query: ?delay=1000&timeout=3000&threshold=0.5&video=URL&sound=1.
 * window.secondaryDev exposes stats and the last released frame for headless checks.
 */
import { createRoot } from 'react-dom/client'
import { startCapture } from '../capture/captureSource'
import { AlignmentBuffer, type FrameResult } from '../sync/alignmentBuffer'
import type { DoctorProfile } from './alertLogic'
import { SecondaryScreen } from './SecondaryScreen'

const q = new URLSearchParams(location.search)
const W = 1280, H = 720
const profile: DoctorProfile = {
  alertThreshold: Number(q.get('threshold') ?? 0.5),
  soundEnabled: q.get('sound') === '1',
  bufferDelayMs: Number(q.get('delay') ?? 1000),
}
const buffer = new AlignmentBuffer(profile.bufferDelayMs, Number(q.get('timeout') ?? 3000))

function findSquare(bm: ImageBitmap): [number, number, number, number] | null {
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 180
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bm, 0, 0, c.width, c.height)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      const o = (y * c.width + x) * 4
      if (d[o] > 200 && d[o + 1] < 60 && d[o + 2] < 60) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
      }
    }
  if (x1 < 0) return null
  return [x0 / c.width, y0 / c.height, (x1 - x0 + 1) / c.width, (y1 - y0 + 1) / c.height]
}

const log: { shown: number; withBoxes: number; sent: number; lateOrder: number; [k: string]: unknown } = {
  shown: 0, withBoxes: 0, sent: 0, lateOrder: 0,
}
let lastShown = -1
buffer.onReady((f, r) => {
  log.shown++
  if (r) log.withBoxes++
  if (f.frameId <= lastShown) log.lateOrder++
  lastShown = f.frameId
  log.lastFrameId = f.frameId
  log.lastResult = r
})
;(window as unknown as { secondaryDev: unknown }).secondaryDev = { log, buffer }

async function main() {
  const src = document.createElement('canvas')
  src.width = W
  src.height = H
  const sctx = src.getContext('2d')!
  let t = 0
  const video = q.get('video')
  let vid: HTMLVideoElement | null = null
  if (video) {
    vid = document.createElement('video')
    vid.src = video; vid.loop = true; vid.muted = true
    await vid.play()
  }
  const squareAt = (n: number) => ({ x: 100 + ((n * 7) % (W - 300)), y: 80 + Math.abs(Math.sin(n / 40)) * (H - 300), s: 160 })
  setInterval(() => {
    t++
    if (vid) sctx.drawImage(vid, 0, 0, W, H)
    else {
      const g = sctx.createLinearGradient(0, 0, W, H)
      g.addColorStop(0, '#234'); g.addColorStop(1, '#8a6')
      sctx.fillStyle = g
      sctx.fillRect(0, 0, W, H)
    }
    const p = squareAt(t)
    sctx.fillStyle = '#f00'
    sctx.fillRect(p.x, p.y, p.s, p.s)
  }, 1000 / 30)
  const stream = src.captureStream(30)
  const h = await startCapture('', {
    sourceStream: stream,
    fps: 30,
    onFrameBitmap: (id, bm) => {
      const box = findSquare(bm)
      buffer.pushFrame(id, bm)
      const roll = Math.random()
      if (roll < 0.05) return // result never arrives -> timeout
      log.sent++
      const res: FrameResult = {
        type: 'frame', frame_id: id, pts: id / 30, dropped: roll < 0.1,
        detections: box ? [{ bbox: box, class_name: 'test_square', confidence: 0.9 }] : [],
        classification: {}, anatomy: null,
      }
      setTimeout(() => buffer.pushResult(id, res), 100 + Math.random() * 800)
    },
  })
  log.size = [h.width, h.height]
}

createRoot(document.getElementById('root')!).render(<SecondaryScreen buffer={buffer} profile={profile} />)
main().catch((e) => { log.error = String(e); console.error(e) })
