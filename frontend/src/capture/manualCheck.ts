/**
 * Manual / automated real-browser check (capture-check.html, dev server only).
 *
 * `runCheck()` opens a source, stamps the marker on the send copy, records the original
 * locally, optionally sends the stamped copy to the backend over a real RTCPeerConnection
 * (POST /sessions, /sessions/{id}/offer), stops, and reports:
 * - the server's marker read rate = frames in GET /sessions/{id}/log whose id falls into the
 *   range sent while connected, divided by the size of that range;
 * - sender stats (codec, encoder, resolution, bitrate, quality limitation);
 * - the local recording (mime, size, frame table) and whether its first decoded frame
 *   carries a marker (it must not).
 * Exposed as `window.captureCheck.runCheck(opts)` for headless runs (scripts/chrome-e2e.cjs).
 */
import { startCapture, type CaptureHandle } from './captureSource'
import { readFrameId } from './frameId'
import type { CropRect } from './localRecorder'
import { connectSendStream, type BitrateHints, type SendConnection } from './sender'

export interface CheckOptions {
  deviceId?: string
  file?: File | string
  width?: number
  height?: number
  fps?: number
  crop?: CropRect | null
  seconds?: number
  send?: boolean
  base?: string
  stand?: string
  token?: string
  maxBitrateBps?: number
  /** Chrome H.264 bitrate hints (default: sender.ts DEFAULT_BITRATE_HINTS; null = none) */
  bitrateHints?: BitrateHints | null
  /** close and re-offer the WebRTC connection after this many seconds (same session) */
  reofferAtSec?: number
  onPreview?: (canvas: HTMLCanvasElement) => void
  signal?: AbortSignal
}

interface SenderSample {
  t: number
  codec?: string
  encoder?: string
  width?: number
  height?: number
  fps?: number
  kbps?: number
  qualityLimitation?: string
  degradationPreference?: string
  /** cumulative for this connection */
  framesEncoded?: number
  framesSent?: number
}

export interface CheckReport {
  source: { width: number; height: number; fps: number }
  framesStamped: number
  localMarkerReadOk: boolean
  server?: {
    sessionId: string
    sentRange: [number, number][]
    sent: number
    logged: number
    loggedInRange: number
    dropped: number
    readRate: number
    /** frames the encoder actually sent (sum over connections, outbound-rtp framesSent) */
    framesSentByEncoder: number
    /** logged / framesSentByEncoder: what the server read of what was put on the wire */
    readRateOfSent: number
    strictlyIncreasing: boolean
    outOfRange: number
  }
  senderStats: SenderSample[]
  recording: {
    mimeType: string
    bytes: number
    frameTable: number
    firstPts: number | null
    lastPts: number | null
    decodedWidth: number
    decodedHeight: number
    markerInRecording: number | null
    crop: CropRect | null
  }
  errors: string[]
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true })
  })

async function fileStream(file: File | string): Promise<{ stream: MediaStream; dispose(): void }> {
  const v = document.createElement('video')
  v.muted = true
  v.loop = true
  v.playsInline = true
  const url = typeof file === 'string' ? file : URL.createObjectURL(file)
  v.src = url
  await v.play()
  const stream = (v as HTMLVideoElement & { captureStream(): MediaStream }).captureStream()
  return {
    stream,
    dispose: () => {
      v.pause()
      if (typeof file !== 'string') URL.revokeObjectURL(url)
    },
  }
}

async function senderSample(conn: SendConnection, prev: { bytes: number; t: number } | null) {
  const stats = (await conn.sender.getStats()) as RTCStatsReport & Map<string, any>
  const s: SenderSample = { t: performance.now() }
  let bytes = 0
  stats.forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'video') {
      s.encoder = r.encoderImplementation
      s.width = r.frameWidth
      s.height = r.frameHeight
      s.fps = r.framesPerSecond
      s.qualityLimitation = r.qualityLimitationReason
      bytes = r.bytesSent
      s.framesEncoded = r.framesEncoded
      s.framesSent = r.framesSent
      const codec = r.codecId ? stats.get(r.codecId) : undefined
      s.codec = codec ? `${codec.mimeType} ${codec.sdpFmtpLine ?? ''}`.trim() : undefined
    }
  })
  if (prev) s.kbps = Math.round(((bytes - prev.bytes) * 8) / (s.t - prev.t))
  const p = conn.sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string }
  s.degradationPreference = p.degradationPreference
  return { sample: s, mark: { bytes, t: s.t } }
}

async function firstFrameOf(blob: Blob): Promise<{ w: number; h: number; id: number | null }> {
  const v = document.createElement('video')
  v.muted = true
  const url = URL.createObjectURL(blob)
  try {
    v.src = url
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res()
      v.onerror = () => rej(new Error('recording does not decode'))
    })
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(v, 0, 0)
    const id = c.width >= 640 && c.height > 16 ? readFrameId(ctx.getImageData(0, 0, c.width, 16 + 1)) : null
    return { w: c.width, h: c.height, id }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function runCheck(o: CheckOptions = {}): Promise<CheckReport> {
  const errors: string[] = []
  const base = o.base ?? '/api'
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (o.token) headers['X-Stand-Token'] = o.token
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`)
    return r.json()
  }

  const fileSrc = o.file ? await fileStream(o.file) : null
  const h: CaptureHandle = await startCapture(o.deviceId ?? '', {
    width: o.width,
    height: o.height,
    fps: o.fps,
    sourceStream: fileSrc?.stream,
  })
  o.onPreview?.(h.sendCanvas)
  const senderStats: SenderSample[] = []
  let report: CheckReport['server']
  let conn: SendConnection | null = null
  const ranges: [number, number][] = []
  let rangeStart: number | null = null
  try {
    h.localRecorder.start(o.crop ?? null)
    let sessionId = ''
    const connect = async () => {
      conn = await connectSendStream(
        h.sendStream,
        (offer) => post(`/sessions/${sessionId}/offer`, offer),
        {
          maxBitrateBps: o.maxBitrateBps,
          bitrateHints: o.bitrateHints,
          onConnectionLost: (s) => errors.push(`connection ${s} at frame ${h.frameCount}`),
        },
      )
      await new Promise<void>((res) => {
        const c = conn!.pc
        const ok = () => c.connectionState === 'connected' && (c.removeEventListener('connectionstatechange', ok), res())
        c.addEventListener('connectionstatechange', ok)
        ok()
        setTimeout(res, 10000)
      })
      rangeStart = h.frameCount
    }
    const closeRange = () => {
      if (rangeStart !== null) ranges.push([rangeStart, h.frameCount - 1])
      rangeStart = null
    }
    if (o.send !== false) {
      sessionId = (await post('/sessions', { stand: o.stand ?? 'stand-1', crop: o.crop ?? null })).session_id
      await connect()
    }
    const t0 = performance.now()
    let mark: { bytes: number; t: number } | null = null
    let reoffered = false
    let wireFrames = 0
    const finalSample = async () => {
      if (!conn) return
      const r = await senderSample(conn, mark).catch(() => null)
      if (r) {
        senderStats.push(r.sample)
        wireFrames += r.sample.framesSent ?? 0
      }
    }
    while (performance.now() - t0 < (o.seconds ?? 20) * 1000 && !o.signal?.aborted) {
      await sleep(2000, o.signal)
      if (conn) {
        const r = await senderSample(conn, mark).catch(() => null)
        if (r) {
          senderStats.push(r.sample)
          mark = r.mark
        }
      }
      if (conn && o.reofferAtSec && !reoffered && performance.now() - t0 > o.reofferAtSec * 1000) {
        reoffered = true
        await finalSample()
        closeRange()
        ;(conn as SendConnection).close()
        mark = null
        await connect()
      }
    }
    if (o.send !== false && sessionId) {
      // frames still in flight when we stop are not counted as sent
      const lastSent = h.frameCount - 1
      await finalSample()
      if (rangeStart !== null) ranges.push([rangeStart, lastSent])
      rangeStart = null
      await sleep(1500) // let in-flight frames arrive; ids after lastSent are not counted
      ;(conn as SendConnection | null)?.close()
      await post(`/sessions/${sessionId}/stop`, {})
      const r = await fetch(`${base}/sessions/${sessionId}/log`, { headers })
      const lines = (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
      const frames = lines.filter((l) => l.type === 'frame') as { frame_id: number; dropped: boolean }[]
      const ids = frames.map((f) => f.frame_id)
      const inRange = (id: number) => ranges.some(([a, b]) => id >= a && id <= b)
      const sent = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0)
      const loggedInRange = ids.filter(inRange).length
      report = {
        sessionId,
        sentRange: ranges,
        sent,
        logged: ids.length,
        loggedInRange,
        dropped: frames.filter((f) => f.dropped).length,
        readRate: sent ? loggedInRange / sent : 0,
        framesSentByEncoder: wireFrames,
        readRateOfSent: wireFrames ? loggedInRange / wireFrames : 0,
        strictlyIncreasing: ids.every((id, i) => i === 0 || id > ids[i - 1]),
        outOfRange: ids.filter((id) => !inRange(id) && id > h.frameCount - 1).length,
      }
    }
  } catch (e) {
    errors.push(String(e))
    ;(conn as SendConnection | null)?.close()
  }
  const res = await h.localRecorder.stop()
  const localMarkerReadOk = (() => {
    const ctx = h.sendCanvas.getContext('2d')!
    return readFrameId(ctx.getImageData(0, 0, h.width, 17)) === h.frameCount - 1
  })()
  let decoded = { w: 0, h: 0, id: null as number | null }
  try {
    decoded = await firstFrameOf(res.videoBlob)
  } catch (e) {
    errors.push(String(e))
  }
  const framesStamped = h.frameCount
  h.stop()
  fileSrc?.dispose()
  ;(window as unknown as { lastRecording?: Blob }).lastRecording = res.videoBlob
  return {
    source: { width: h.width, height: h.height, fps: h.fps },
    framesStamped,
    localMarkerReadOk,
    server: report,
    senderStats,
    recording: {
      mimeType: res.mimeType,
      bytes: res.videoBlob.size,
      frameTable: res.frameTable.length,
      firstPts: res.frameTable[0]?.pts ?? null,
      lastPts: res.frameTable.at(-1)?.pts ?? null,
      decodedWidth: decoded.w,
      decodedHeight: decoded.h,
      markerInRecording: decoded.id,
      crop: res.crop,
    },
    errors,
  }
}

// ---------------------------------------------------------------- page wiring
;(window as unknown as { captureCheck: unknown }).captureCheck = { runCheck }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

async function fillDevices() {
  const sel = $<HTMLSelectElement>('device')
  if (!sel || !navigator.mediaDevices?.enumerateDevices) return
  for (const d of await navigator.mediaDevices.enumerateDevices()) {
    if (d.kind !== 'videoinput') continue
    const opt = document.createElement('option')
    opt.value = d.deviceId
    opt.textContent = d.label || d.deviceId.slice(0, 12)
    sel.append(opt)
  }
}

function wire() {
  const run = $<HTMLButtonElement>('run')
  if (!run) return
  void fillDevices()
  let ctrl: AbortController | null = null
  $<HTMLButtonElement>('stopBtn')!.onclick = () => ctrl?.abort()
  run.onclick = async () => {
    const out = $<HTMLPreElement>('out')!
    const num = (id: string) => Number($<HTMLInputElement>(id)!.value) || undefined
    const cropTxt = $<HTMLInputElement>('crop')!.value.trim()
    const c = cropTxt ? cropTxt.split(',').map(Number) : null
    ctrl = new AbortController()
    run.disabled = true
    $<HTMLButtonElement>('stopBtn')!.disabled = false
    out.textContent = 'running...'
    try {
      const rep = await runCheck({
        deviceId: $<HTMLSelectElement>('device')!.value,
        file: $<HTMLInputElement>('file')!.files?.[0],
        width: num('w'),
        height: num('h'),
        fps: num('fps'),
        crop: c && c.length === 4 ? { x: c[0], y: c[1], w: c[2], h: c[3] } : null,
        stand: $<HTMLInputElement>('stand')!.value,
        token: $<HTMLInputElement>('token')!.value || undefined,
        maxBitrateBps: (num('kbps') ?? 0) * 1000 || undefined,
        send: $<HTMLInputElement>('send')!.checked,
        seconds: num('secs'),
        signal: ctrl.signal,
        onPreview: (cv) => {
          const p = $('preview')!
          p.replaceChildren(cv)
        },
      })
      out.textContent = JSON.stringify(rep, null, 2)
      const blob = (window as unknown as { lastRecording?: Blob }).lastRecording
      if (blob) {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `recording.${rep.recording.mimeType.includes('mp4') ? 'mp4' : 'webm'}`
        a.textContent = `download recording (${(blob.size / 1e6).toFixed(1)} MB)`
        $('download')!.replaceChildren(a)
      }
    } catch (e) {
      out.textContent = String(e)
    } finally {
      run.disabled = false
      $<HTMLButtonElement>('stopBtn')!.disabled = true
    }
  }
}
wire()
