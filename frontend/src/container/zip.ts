/**
 * Minimal dependency-free ZIP writer: "stored" entries only (no compression -- the video is
 * already compressed, the rest is small), CRC-32, local headers, central directory, EOCD.
 * Output is a Blob assembled from Blob parts, so the (possibly large) video is not copied
 * into one big buffer: it is read once in slices to compute the CRC and then referenced.
 * Limits: no ZIP64 -- an entry or the archive >= 4 GiB throws (a ~4 GiB video is far beyond
 * a session recording; the caller then falls back to offering the raw recording).
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
const LIMIT = 0xffffffff

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

export async function createZip(entries: ZipEntry[], now: Date = new Date(), type = 'application/zip'): Promise<Blob> {
  const enc = new TextEncoder()
  const { time, date } = dosDateTime(now)
  const parts: BlobPart[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data
    const size = data instanceof Uint8Array ? data.length : data.size
    if (size >= LIMIT || offset >= LIMIT) throw new Error('zip: entry too large (no ZIP64 support)')
    const crc = await crcOf(data)

    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true)
    lh.setUint16(4, 20, true) // version needed
    lh.setUint16(6, 0x0800, true) // flags: UTF-8 names
    lh.setUint16(8, 0, true) // method: stored
    lh.setUint16(10, time, true)
    lh.setUint16(12, date, true)
    lh.setUint32(14, crc, true)
    lh.setUint32(18, size, true)
    lh.setUint32(22, size, true)
    lh.setUint16(26, name.length, true)
    lh.setUint16(28, 0, true)
    parts.push(lh.buffer, name, data as BlobPart)

    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, 0x02014b50, true)
    ch.setUint16(4, 20, true) // version made by
    ch.setUint16(6, 20, true)
    ch.setUint16(8, 0x0800, true)
    ch.setUint16(10, 0, true)
    ch.setUint16(12, time, true)
    ch.setUint16(14, date, true)
    ch.setUint32(16, crc, true)
    ch.setUint32(20, size, true)
    ch.setUint32(24, size, true)
    ch.setUint16(28, name.length, true)
    ch.setUint32(42, offset, true) // local header offset (extra/comment/attrs stay 0)
    const rec = new Uint8Array(46 + name.length)
    rec.set(new Uint8Array(ch.buffer), 0)
    rec.set(name, 46)
    central.push(rec)
    offset += 30 + name.length + size
  }
  const cdSize = central.reduce((n, r) => n + r.length, 0)
  if (offset + cdSize >= LIMIT) throw new Error('zip: archive too large (no ZIP64 support)')
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, entries.length, true)
  eocd.setUint16(10, entries.length, true)
  eocd.setUint32(12, cdSize, true)
  eocd.setUint32(16, offset, true)
  return new Blob([...parts, ...(central as BlobPart[]), eocd.buffer], { type })
}
