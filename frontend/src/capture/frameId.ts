/**
 * Frame-id marker: TypeScript port of backend/app/contracts/frame_id.py (encode side, plus a
 * reader used by tests and the manual check page). Verified byte-for-byte against
 * tests/fixtures/frame_id_vectors.json.
 *
 * Layout (docs/superpowers/specs/frame-id-experiment.md, tests/fixtures/README.md):
 * - codeword = 32-bit frame_id MSB first, then CRC8 MSB first = 40 bits;
 *   CRC-8/I-432-1 (poly 0x07, init 0, no reflection, xorout 0x55) over the id as 4 BE bytes.
 * - bit i of copy c is a solid 16x16 block at x = (c*40 + i)*16, y = 0..15;
 *   1 = white (255,255,255), 0 = black (0,0,0), alpha 255.
 * - copies = min(3, floor(width / 640)); width < 640 or height <= 16 is rejected.
 * - reading: mean luma of the inner 8x8 (inset 4) per block, (mean-128) averaged over
 *   copies; bit = avg > 0; any |avg| < 40 or CRC mismatch -> null.
 */

export const BLOCK = 16
export const ID_BITS = 32
export const CRC_BITS = 8
export const CODE_BITS = ID_BITS + CRC_BITS
export const MAX_COPIES = 3
export const INSET = 4
export const THRESHOLD = 128
export const MIN_MARGIN = 40
export const MAX_FRAME_ID = 0xffffffff

/** Anything with RGBA pixels: ImageData, or a plain object of the same shape. */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

export function crc8(data: Uint8Array): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc ^ 0x55
}

function idBytes(id: number): Uint8Array {
  return new Uint8Array([(id >>> 24) & 255, (id >>> 16) & 255, (id >>> 8) & 255, id & 255])
}

/** 40-bit codeword: id MSB-first, then CRC8 MSB-first. */
export function frameIdBits(frameId: number): number[] {
  if (!Number.isInteger(frameId) || frameId < 0 || frameId > MAX_FRAME_ID) {
    throw new RangeError(`frame_id out of range: ${frameId}`)
  }
  const bits: number[] = []
  for (let i = ID_BITS - 1; i >= 0; i--) bits.push(Math.floor(frameId / 2 ** i) % 2)
  const c = crc8(idBytes(frameId))
  for (let i = CRC_BITS - 1; i >= 0; i--) bits.push((c >> i) & 1)
  return bits
}

/** Number of codeword copies for a frame of this size (throws if it cannot hold one). */
export function markerCopies(width: number, height = BLOCK + 1): number {
  if (height <= BLOCK) throw new RangeError(`frame too short for marker: height ${height}`)
  const n = Math.min(MAX_COPIES, Math.floor(width / (CODE_BITS * BLOCK)))
  if (n < 1) throw new RangeError(`frame too narrow for marker: width ${width}`)
  return n
}

export interface MarkerBlock {
  x: number
  white: boolean
}

/** The blocks to paint (all at y = 0, BLOCK x BLOCK). Single source of geometry. */
export function markerBlocks(width: number, height: number, frameId: number): MarkerBlock[] {
  const bits = frameIdBits(frameId)
  const copies = markerCopies(width, height)
  const out: MarkerBlock[] = []
  for (let c = 0; c < copies; c++) {
    bits.forEach((b, i) => out.push({ x: (c * CODE_BITS + i) * BLOCK, white: b === 1 }))
  }
  return out
}

/** Stamp the marker in place into RGBA pixels (ImageData-like). Returns the same image. */
export function stampFrameId<T extends RgbaImage>(img: T, frameId: number): T {
  const { width, data } = img
  for (const blk of markerBlocks(width, img.height, frameId)) {
    const v = blk.white ? 255 : 0
    for (let y = 0; y < BLOCK; y++) {
      let o = (y * width + blk.x) * 4
      for (let x = 0; x < BLOCK; x++, o += 4) {
        data[o] = v
        data[o + 1] = v
        data[o + 2] = v
        data[o + 3] = 255
      }
    }
  }
  return img
}

/** Stamp the marker onto a 2D canvas context (solid fillRects, integer-aligned). */
export function drawFrameId(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frameId: number,
): void {
  const blocks = markerBlocks(width, height, frameId)
  for (const white of [true, false]) {
    ctx.fillStyle = white ? '#ffffff' : '#000000'
    for (const blk of blocks) if (blk.white === white) ctx.fillRect(blk.x, 0, BLOCK, BLOCK)
  }
}

/** Per-bit average (luma - 128) over all copies, or null if the frame cannot hold a marker. */
export function markerDeviations(img: RgbaImage): number[] | null {
  let copies: number
  try {
    copies = markerCopies(img.width, img.height)
  } catch {
    return null
  }
  const dev = new Array<number>(CODE_BITS).fill(0)
  const n = (BLOCK - 2 * INSET) ** 2
  for (let c = 0; c < copies; c++) {
    for (let i = 0; i < CODE_BITS; i++) {
      const x0 = (c * CODE_BITS + i) * BLOCK
      let sum = 0
      for (let y = INSET; y < BLOCK - INSET; y++) {
        for (let x = x0 + INSET; x < x0 + BLOCK - INSET; x++) {
          const o = (y * img.width + x) * 4
          sum += 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]
        }
      }
      dev[i] += sum / n - THRESHOLD
    }
  }
  return dev.map((d) => d / copies)
}

export function readFrameId(img: RgbaImage): number | null {
  const dev = markerDeviations(img)
  if (!dev || Math.min(...dev.map(Math.abs)) < MIN_MARGIN) return null
  let id = 0
  for (let i = 0; i < ID_BITS; i++) id = id * 2 + (dev[i] > 0 ? 1 : 0)
  let crc = 0
  for (let i = ID_BITS; i < CODE_BITS; i++) crc = (crc << 1) | (dev[i] > 0 ? 1 : 0)
  return crc8(idBytes(id)) === crc ? id : null
}
