/**
 * Crop ROI geometry (spec §4: manual rectangle drawn at the session start, optional, default
 * OFF). Pure functions. All rectangles handed to the capture / the server are in pixels of
 * the ORIGINAL frame; the preview is an element that shows the frame with object-fit:contain
 * (letterboxed), so screen coordinates are mapped through the displayed picture's rectangle.
 */
import type { CropRect } from '../capture/localRecorder'

export type { CropRect }

export const MIN_CROP = 16

export interface Size {
  w: number
  h: number
}
export interface Point {
  x: number
  y: number
}

export type CropValidation =
  | { ok: true; rect: CropRect }
  | { ok: false; reason: 'not-finite' | 'negative-size' | 'empty' | 'min-size' | 'outside-frame'; message: string }

const fail = (reason: Exclude<CropValidation, { ok: true }>['reason'], message: string): CropValidation => ({
  ok: false,
  reason,
  message,
})

/** Integer pixel rect, strictly inside the frame, at least MIN_CROP x MIN_CROP. */
export function validateCrop(rect: CropRect, frameW: number, frameH: number): CropValidation {
  const { x, y, w, h } = rect
  if (![x, y, w, h, frameW, frameH].every(Number.isFinite)) return fail('not-finite', 'crop is not a number')
  if (w < 0 || h < 0) return fail('negative-size', 'crop width/height must not be negative')
  const x0 = Math.round(x)
  const y0 = Math.round(y)
  const x1 = Math.round(x + w)
  const y1 = Math.round(y + h)
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return fail('empty', 'crop is empty')
  if (x1 - x0 < MIN_CROP || y1 - y0 < MIN_CROP) return fail('min-size', `crop must be at least ${MIN_CROP}x${MIN_CROP} px`)
  if (x0 < 0 || y0 < 0 || x1 > frameW || y1 > frameH) return fail('outside-frame', `crop is outside the ${frameW}x${frameH} frame`)
  return { ok: true, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
}

/** Where the frame is drawn inside an element of `box` size with object-fit: contain. */
export function contentRect(box: Size, frame: Size): { x: number; y: number; w: number; h: number } {
  if (!(box.w > 0 && box.h > 0 && frame.w > 0 && frame.h > 0)) return { x: 0, y: 0, w: 0, h: 0 }
  // exact on the limiting side (no float residue from scale * size)
  const widthLimited = box.w / frame.w <= box.h / frame.h
  const w = widthLimited ? box.w : (frame.w * box.h) / frame.h
  const h = widthLimited ? (frame.h * box.w) / frame.w : box.h
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h }
}

/**
 * Element-relative point (pixels from the element's top-left) -> ORIGINAL frame pixels.
 * Points in the letterbox bars are clamped to the picture edge (`inside` tells they were not
 * on the picture).
 */
export function screenToFrame(p: Point, box: Size, frame: Size): Point & { inside: boolean } {
  const c = contentRect(box, frame)
  if (!c.w || !c.h) return { x: 0, y: 0, inside: false }
  const u = (p.x - c.x) / c.w
  const v = (p.y - c.y) / c.h
  const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1
  const cl = (t: number) => Math.min(1, Math.max(0, t))
  return { x: cl(u) * frame.w, y: cl(v) * frame.h, inside }
}

/** ORIGINAL frame pixels -> element-relative position (for drawing the overlay). */
export function frameToScreen(r: CropRect, box: Size, frame: Size): { left: number; top: number; width: number; height: number } {
  const c = contentRect(box, frame)
  const sx = c.w / frame.w
  const sy = c.h / frame.h
  return { left: c.x + r.x * sx, top: c.y + r.y * sy, width: r.w * sx, height: r.h * sy }
}

/** Rectangle from two drag corners in ANY order (ordering is normalised: w,h >= 0). */
export function rectFromPoints(a: Point, b: Point): CropRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

/** Whole drag: two element-relative points -> validated crop in frame pixels. */
export function cropFromDrag(a: Point, b: Point, box: Size, frame: Size): CropValidation {
  const fa = screenToFrame(a, box, frame)
  const fb = screenToFrame(b, box, frame)
  return validateCrop(rectFromPoints(fa, fb), frame.w, frame.h)
}
