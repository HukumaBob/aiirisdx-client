/**
 * Bounding-box rendering look, ported (re-implemented, small) from the prototype's
 * BoundingBoxRenderer.js: rounded corner brackets with a 33% cutout in the middle of every
 * side, 1.5px line scaled by min(w,h)/500, label "class name NN%" on a 50% black plate above
 * the box (inside if it does not fit), findings colour #00ffef.
 * Boxes are normalized xywh of the ORIGINAL frame; the canvas shows the full original frame,
 * so pixel = norm * canvas size. Crop (if any) is only outlined, never applied.
 */
import type { DetectionMsg } from '../sync/alignmentBuffer'

export const BOX_COLOR = '#00ffef'
export const CROP_COLOR = 'rgba(255,255,255,0.5)'
const CUTOUT = 0.33

export function boxToPixels(b: [number, number, number, number], w: number, h: number) {
  const [x, y, bw, bh] = b
  return { x1: x * w, y1: y * h, x2: (x + bw) * w, y2: (y + bh) * h }
}

export function labelFor(d: DetectionMsg): string {
  return `${d.class_name.replace(/_/g, ' ')} ${Math.round(d.confidence * 100)}%`
}

export function drawBoxes(ctx: CanvasRenderingContext2D, dets: DetectionMsg[], width: number, height: number) {
  if (!dets.length) return
  const scale = Math.min(width, height) / 500
  const fontSize = 12 * scale
  const r = 5 * scale
  const pad = 4 * scale
  ctx.save()
  ctx.lineWidth = 1.5 * scale
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = BOX_COLOR
  for (const d of dets) {
    const { x1, y1, x2, y2 } = boxToPixels(d.bbox, width, height)
    const w = x2 - x1
    const h = y2 - y1
    const cx0 = x1 + (w - w * CUTOUT) / 2
    const cx1 = cx0 + w * CUTOUT
    const cy0 = y1 + (h - h * CUTOUT) / 2
    const cy1 = cy0 + h * CUTOUT
    const rr = Math.min(r, w / 2, h / 2)
    // top-left, top-right, bottom-left, bottom-right brackets
    ctx.beginPath(); ctx.moveTo(cx0, y1); ctx.lineTo(x1 + rr, y1); ctx.arcTo(x1, y1, x1, y1 + rr, rr); ctx.lineTo(x1, cy0); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx1, y1); ctx.lineTo(x2 - rr, y1); ctx.arcTo(x2, y1, x2, y1 + rr, rr); ctx.lineTo(x2, cy0); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(x1, cy1); ctx.lineTo(x1, y2 - rr); ctx.arcTo(x1, y2, x1 + rr, y2, rr); ctx.lineTo(cx0, y2); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(x2, cy1); ctx.lineTo(x2, y2 - rr); ctx.arcTo(x2, y2, x2 - rr, y2, rr); ctx.lineTo(cx1, y2); ctx.stroke()

    ctx.font = `${fontSize}px Arial`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    const text = labelFor(d)
    const lineH = fontSize * 1.2
    const rw = ctx.measureText(text).width + pad * 2
    const ly = y1 - pad - lineH > 0 ? y1 - pad - lineH : y1 + pad
    let lx = x1 + pad
    if (lx + rw > width) lx = Math.max(pad, x2 - pad - rw)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
    ctx.fillRect(lx, ly, rw, lineH + pad)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, lx + pad, ly + pad / 2 + lineH / 2)
  }
  ctx.restore()
}

export function drawCropOutline(
  ctx: CanvasRenderingContext2D,
  crop: { x: number; y: number; w: number; h: number },
) {
  ctx.save()
  ctx.strokeStyle = CROP_COLOR
  ctx.setLineDash([6, 6])
  ctx.lineWidth = 1
  ctx.strokeRect(crop.x, crop.y, crop.w, crop.h)
  ctx.restore()
}
