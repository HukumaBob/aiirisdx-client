/**
 * Minimal dependency-free ZIP writer: "stored" entries only (no compression -- the video is
 * already compressed, the rest is small), CRC-32, local headers, central directory, EOCD.
 * Output is a Blob assembled from Blob parts, so the (possibly large) video is not copied
 * into one big buffer: it is read once in slices to compute the CRC and then referenced.
 * ZIP64 is used only when needed (an entry size/offset, the central directory size/offset
 * exceeds the threshold, default 0xFFFFFFFF, or more than 65534 entries); small archives stay
 * plain ZIP. Blobs are referenced as parts, never copied into one buffer. The threshold is
 * injectable so tests can force ZIP64 on tiny inputs.
 */
export interface ZipEntry {
  name: string
  data: Blob | Uint8Array | string
}

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32Update(crc: number, buf: Uint8Array): number {
  let c = ~crc >>> 0
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

const SLICE = 4 * 1024 * 1024

async function blobBytes(b: Blob): Promise<Uint8Array> {
  if (typeof b.arrayBuffer === 'function') return new Uint8Array(await b.arrayBuffer())
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(new Uint8Array(r.result as ArrayBuffer))
    r.onerror = () => rej(r.error)
    r.readAsArrayBuffer(b)
  })
}

async function crcOf(data: Blob | Uint8Array): Promise<number> {
  if (data instanceof Uint8Array) return crc32Update(0, data)
  let crc = 0
  for (let off = 0; off < data.size; off += SLICE) crc = crc32Update(crc, await blobBytes(data.slice(off, off + SLICE)))
  return crc
}

function dosDateTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export interface ZipOptions {
  now?: Date
  type?: string
  /** sizes/offsets >= this need ZIP64 (default 0xFFFFFFFF); lowered by tests to force it */
  zip64Threshold?: number
}

const u8 = (dv: DataView) => new Uint8Array(dv.buffer)
const MAX32 = 0xffffffff

export async function createZip(entries: ZipEntry[], opts: ZipOptions = {}): Promise<Blob> {
  const T = opts.zip64Threshold ?? MAX32
  const enc = new TextEncoder()
  const { time, date } = dosDateTime(opts.now ?? new Date())
  const parts: BlobPart[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data
    const size = data instanceof Uint8Array ? data.length : data.size
    const crc = await crcOf(data)
    const bigSize = size >= T
    const bigOff = offset >= T

    // local header (+ ZIP64 extra with both sizes when the size is big)
    const lextra = bigSize ? 20 : 0
    const lh = new DataView(new ArrayBuffer(30))
    const lx = new DataView(new ArrayBuffer(lextra))
    lh.setUint32(0, 0x04034b50, true)
    lh.setUint16(4, bigSize ? 45 : 20, true) // version needed
    lh.setUint16(6, 0x0800, true) // flags: UTF-8 names
    lh.setUint16(8, 0, true) // method: stored
    lh.setUint16(10, time, true)
    lh.setUint16(12, date, true)
    lh.setUint32(14, crc, true)
    lh.setUint32(18, bigSize ? MAX32 : size, true)
    lh.setUint32(22, bigSize ? MAX32 : size, true)
    lh.setUint16(26, name.length, true)
    lh.setUint16(28, lextra, true)
    if (bigSize) {
      lx.setUint16(0, 1, true)
      lx.setUint16(2, 16, true)
      lx.setBigUint64(4, BigInt(size), true)
      lx.setBigUint64(12, BigInt(size), true)
    }
    parts.push(lh.buffer, name, lx.buffer, data as BlobPart)

    // central directory record; its ZIP64 extra carries only the saturated fields, in order
    const cextra = (bigSize ? 16 : 0) + (bigOff ? 8 : 0)
    const ch = new DataView(new ArrayBuffer(46 + name.length + (cextra ? 4 + cextra : 0)))
    ch.setUint32(0, 0x02014b50, true)
    ch.setUint16(4, 45, true) // version made by
    ch.setUint16(6, bigSize || bigOff ? 45 : 20, true)
    ch.setUint16(8, 0x0800, true)
    ch.setUint16(12, time, true)
    ch.setUint16(14, date, true)
    ch.setUint32(16, crc, true)
    ch.setUint32(20, bigSize ? MAX32 : size, true)
    ch.setUint32(24, bigSize ? MAX32 : size, true)
    ch.setUint16(28, name.length, true)
    ch.setUint16(30, cextra ? 4 + cextra : 0, true)
    ch.setUint32(42, bigOff ? MAX32 : offset, true)
    u8(ch).set(name, 46)
    if (cextra) {
      let p = 46 + name.length
      ch.setUint16(p, 1, true)
      ch.setUint16(p + 2, cextra, true)
      p += 4
      if (bigSize) {
        ch.setBigUint64(p, BigInt(size), true)
        ch.setBigUint64(p + 8, BigInt(size), true)
        p += 16
      }
      if (bigOff) ch.setBigUint64(p, BigInt(offset), true)
    }
    central.push(u8(ch))
    offset += 30 + lextra + name.length + size
  }
  const cdSize = central.reduce((n, r) => n + r.length, 0)
  const need64 = offset >= T || cdSize >= T || entries.length > 0xfffe
  const tail: BlobPart[] = []
  if (need64) {
    const z = new DataView(new ArrayBuffer(56 + 20))
    z.setUint32(0, 0x06064b50, true) // ZIP64 end of central directory
    z.setBigUint64(4, 44n, true)
    z.setUint16(12, 45, true)
    z.setUint16(14, 45, true)
    z.setBigUint64(24, BigInt(entries.length), true)
    z.setBigUint64(32, BigInt(entries.length), true)
    z.setBigUint64(40, BigInt(cdSize), true)
    z.setBigUint64(48, BigInt(offset), true)
    z.setUint32(56, 0x07064b50, true) // locator
    z.setBigUint64(64, BigInt(offset + cdSize), true)
    z.setUint32(72, 1, true)
    tail.push(z.buffer)
  }
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, need64 ? 0xffff : entries.length, true)
  eocd.setUint16(10, need64 ? 0xffff : entries.length, true)
  eocd.setUint32(12, need64 ? MAX32 : cdSize, true)
  eocd.setUint32(16, need64 ? MAX32 : offset, true)
  return new Blob([...parts, ...(central as BlobPart[]), ...tail, eocd.buffer], { type: opts.type ?? 'application/zip' })
}
