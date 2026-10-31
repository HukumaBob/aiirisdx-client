/**
 * Session orchestration at the stand (spec §3, §4, §6). Pure TypeScript with injected
 * dependencies (fetch, startCapture, connectSendStream, WebSocket, bitmap resize, buffer
 * factory), so it is testable with mocks and independent of React.
 *
 * start (live):  POST /sessions {stand, doctor, crop} -> startCapture -> local recording
 *                (with crop) -> results WebSocket -> WebRTC offer/answer (POST .../offer).
 * start (file):  POST /sessions -> POST .../file {path, realtime}; results WebSocket only.
 * reconnect:     the connection is disposable: same session id, SAME CaptureHandle (the frame
 *                counter and the recording continue), POST .../offer again.
 * stop:          stop the recorder (first: the recording is the thing that must not be lost),
 *                stop capture + connection, POST .../stop, GET .../log, hand the result to
 *                `onFinished`. A dead server never loses the recording: log = null + `error`.
 *
 * Server loss never touches the recorder: if the session cannot be created, the offer fails
 * or the connection drops, the status becomes "server lost -- recording continues".
 *
 * Secondary screen (R9): every source frame's bitmap (unstamped, from capture's
 * onFrameBitmap) is DOWNSCALED to 960 px width before AlignmentBuffer.pushFrame (boxes are
 * normalized, so unaffected) and the original is closed. Pushes keep frame order even when the
 * asynchronous resizes finish out of order. The buffer's fps is an UPPER BOUND for its
 * memory cap: the capture's fps, or 60 if unknown.
 */
import { startCapture as realStartCapture, type CaptureHandle, type CropRect } from '../capture/captureSource'
import type { RecordingResult } from '../capture/localRecorder'
import { connectSendStream as realConnect } from '../capture/sender'
import type { DoctorProfile } from '../secondary/alertLogic'
import { AlignmentBuffer, type FrameBitmap, type FrameResult } from '../sync/alignmentBuffer'
import { ResultsClient } from '../sync/resultsClient'
import { validateCrop } from './cropRect'

export const SERVER_LOST_MSG = 'server lost — recording continues'
export const SECONDARY_WIDTH = 960
/** default secondary-screen result timeout (profile.bufferTimeoutMs overrides) */
export const DEFAULT_BUFFER_TIMEOUT_MS = 3000
/** @deprecated use DEFAULT_BUFFER_TIMEOUT_MS / profile.bufferTimeoutMs */
export const BUFFER_TIMEOUT_MS = DEFAULT_BUFFER_TIMEOUT_MS
const bufferTimeout = (p: DoctorProfile) => p.bufferTimeoutMs ?? DEFAULT_BUFFER_TIMEOUT_MS
const STAND_RE = /^[A-Za-z0-9-]{1,32}$/

export type FlowState = 'idle' | 'starting' | 'running' | 'server-lost' | 'stopping' | 'finished' | 'error'
export type Connection = 'none' | 'connecting' | 'connected' | 'lost'

export interface StartParams {
  stand: string
  doctor: string
  deviceId: string
  mode: 'live' | 'file'
  /** ORIGINAL frame pixels; null/undefined = no crop (default) */
  crop?: CropRect | null
  profile: DoctorProfile
  filePath?: string
  realtime?: boolean
  width?: number
  height?: number
  fps?: number
  /** stand token (X-Stand-Token / ?token=) when the server requires one; overrides deps.token */
  token?: string
}

export function canStart(p: Pick<StartParams, 'stand' | 'doctor' | 'mode' | 'filePath'>): { ok: boolean; reasons: ('stand' | 'doctor' | 'file')[] } {
  const reasons: ('stand' | 'doctor' | 'file')[] = []
  if (!STAND_RE.test(p.stand.trim())) reasons.push('stand')
  if (!p.doctor.trim()) reasons.push('doctor')
  if (p.mode === 'file' && !(p.filePath ?? '').trim()) reasons.push('file')
  return { ok: reasons.length === 0, reasons }
}

export interface SessionMeta {
  sessionId: string | null
  stand: string
  doctor: string
  mode: 'live' | 'file'
  crop: CropRect | null
  /** ORIGINAL capture frame size (negotiated), the frame the crop and the log's normalized
   * bboxes refer to; null in file mode / if unknown */
  source?: { width: number; height: number } | null
  startedAt: string
  stoppedAt: string
  /** frames stamped by the capture (see FlowStatus.sent; not all are transmitted) */
  framesSent: number
  /** frames the browser encoder sent (outbound-rtp framesSent), null if unknown */
  framesEncoderSent: number | null
  framesReceived: number
  /** frames logged by the server (from POST /stop), null if unknown */
  serverFrames: number | null
}

export interface FinishedSession {
  /** local recording of the ORIGINAL signal (null in file mode / if the recorder failed) */
  video: Blob | null
  mimeType: string | null
  frameTable: RecordingResult['frameTable']
  recordingStartOffset: number
  /** the server's NDJSON session log (null if /stop or /log failed) */
  log: string | null
  sessionMeta: SessionMeta
  /** first server/recorder problem met while stopping, null if none */
  error: string | null
  recorderError: string | null
}

export interface FlowStatus {
  state: FlowState
  connection: Connection
  results: 'none' | 'connecting' | 'open' | 'closed'
  sessionId: string | null
  /**
   * frames stamped with a frame id by the capture (capture frameCount). NOT all of them are
   * transmitted: the canvas capture track / browser encoder may skip frames (measured in
   * Task 13: headless Chrome encoded 164 of 188 stamped frames), see `encoderSent`.
   */
  sent: number
  /** frames the browser's encoder actually sent (outbound-rtp framesSent, summed over
   * connections), null until known. The server receives ~these. */
  encoderSent: number | null
  /** result messages received over the results WebSocket (real + dropped) */
  received: number
  /** of those, results the server dropped under overload (dropped: true) */
  dropped: number
  /** last server / signalling error text, null if none */
  serverError: string | null
  recorderError: string | null
  message: string
}

export interface FlowDeps {
  fetch: typeof fetch
  startCapture: typeof realStartCapture
  connectSendStream: typeof realConnect
  WebSocket?: typeof WebSocket
  /** resize an ImageBitmap to `width` px (aspect kept); default createImageBitmap(resizeWidth) */
  resizeBitmap: (bm: ImageBitmap, width: number) => Promise<ImageBitmap>
  createBuffer: (delayMs: number, timeoutMs: number, fps: number) => AlignmentBuffer
  /** REST base ('/api' via the dev proxy / reverse proxy) */
  base: string
  /** ws(s) base matching `base` */
  wsBase: string
  token?: string
  fetchTimeoutMs?: number
  /**
   * WebRTC configuration (ICE servers: STUN/TURN) for the send connection. Default: GET
   * `${base}/client-config?stand=<stand>` with the stand token (server-issued, TURN credentials are time-limited); any failure
   * -> undefined (browser defaults, host candidates only -- fine inside the hospital LAN).
   */
  loadRtcConfig?: () => Promise<RTCConfiguration | undefined>
}

export function defaultDeps(over: Partial<FlowDeps> = {}): FlowDeps {
  const secure = typeof location !== 'undefined' && location.protocol === 'https:'
  const host = typeof location !== 'undefined' ? location.host : 'localhost'
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    startCapture: realStartCapture,
    connectSendStream: realConnect,
    resizeBitmap: (bm, w) => createImageBitmap(bm, { resizeWidth: w, resizeQuality: 'low' }),
    createBuffer: (d, t, fps) => new AlignmentBuffer(d, t, { fps }),
    base: '/api',
    wsBase: `${secure ? 'wss' : 'ws'}://${host}/api`,
    ...over,
  }
}

export interface FlowHooks {
  onStatus?: (s: FlowStatus) => void
  onFinished?: (f: FinishedSession) => void
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class SessionFlow {
  buffer: AlignmentBuffer | null = null
  private state: FlowState = 'idle'
  private connection: Connection = 'none'
  private resultsState: FlowStatus['results'] = 'none'
  private sessionId: string | null = null
  private params: StartParams | null = null
  private cap: CaptureHandle | null = null
  private conn: { close(): void; pc?: unknown } | null = null
  private encSentBase = 0 // framesSent of connections already closed
  private encSentCur = 0 // of the current connection
  private encSentKnown = false
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private rc: ResultsClient | null = null
  private connGen = 0
  private received = 0
  private dropped = 0
  private serverError: string | null = null
  private recorderError: string | null = null
  private startedAt = ''
  private pushChain: Promise<void> = Promise.resolve()
  private disposedBuffer = false

  constructor(
    private deps: FlowDeps,
    private hooks: FlowHooks = {},
  ) {}

  /** the live capture (for the preview), null in file mode / when idle */
  get capture(): CaptureHandle | null {
    return this.cap
  }

  getStatus(): FlowStatus {
    let message = ''
    if (this.state === 'server-lost') message = SERVER_LOST_MSG
    return {
      state: this.state,
      connection: this.connection,
      results: this.resultsState,
      sessionId: this.sessionId,
      sent: this.cap?.frameCount ?? 0,
      encoderSent: this.encSentKnown ? this.encSentBase + this.encSentCur : null,
      received: this.received,
      dropped: this.dropped,
      serverError: this.serverError,
      recorderError: this.recorderError,
      message,
    }
  }

  /** read outbound-rtp framesSent of the current connection (best effort) */
  private async pollEncoder(): Promise<void> {
    const pc = this.conn?.pc as { getStats?: () => Promise<{ forEach(cb: (r: Record<string, unknown>) => void): void }> } | undefined
    if (!pc?.getStats) return
    try {
      const st = await pc.getStats()
      let n = 0
      let seen = false
      st.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video' && typeof r.framesSent === 'number') {
          n += r.framesSent
          seen = true
        }
      })
      if (seen) {
        this.encSentCur = n
        this.encSentKnown = true
      }
    } catch {
      /* stats are diagnostics only */
    }
  }

  private dropConn() {
    this.encSentBase += this.encSentCur
    this.encSentCur = 0
    this.conn?.close()
    this.conn = null
  }

  private stopStatsTimer() {
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
  }

  private emit() {
    this.hooks.onStatus?.(this.getStatus())
  }

  private set(state: FlowState) {
    this.state = state
    this.emit()
  }

  private token(): string | undefined {
    return this.params?.token?.trim() || this.deps.token || undefined
  }

  private async rtcConfig(): Promise<RTCConfiguration | undefined> {
    if (this.deps.loadRtcConfig) return this.deps.loadRtcConfig().catch(() => undefined)
    try {
      // the stand + its token (X-Stand-Token via http()) authorize this when the server
      // requires tokens; TURN credentials are not given to anonymous callers
      const stand = encodeURIComponent(this.params?.stand ?? '')
      const r = await this.http(`/client-config?stand=${stand}`, { method: 'GET', timeoutMs: 5000 })
      const j = (await r.json()) as { ice_servers?: RTCIceServer[] }
      return Array.isArray(j?.ice_servers) && j.ice_servers.length ? { iceServers: j.ice_servers } : undefined
    } catch {
      return undefined
    }
  }

  private async http(path: string, init: { method: string; body?: unknown; timeoutMs?: number } ): Promise<Response> {
    const headers: Record<string, string> = {}
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    const token = this.token()
    if (token) headers['X-Stand-Token'] = token
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
    const t = ac ? setTimeout(() => ac.abort(), init.timeoutMs ?? this.deps.fetchTimeoutMs ?? 10000) : null
    try {
      const r = await this.deps.fetch(this.deps.base + path, {
        method: init.method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ac?.signal,
      })
      if (!r.ok) throw new Error(`${init.method} ${path}: HTTP ${r.status}`)
      return r
    } finally {
      if (t) clearTimeout(t)
    }
  }

  private async createSession(): Promise<string> {
    const p = this.params!
    const body: Record<string, unknown> = { stand: p.stand.trim(), doctor: p.doctor.trim() }
    if (p.crop) body.crop = p.crop
    const r = await this.http('/sessions', { method: 'POST', body })
    const j = (await r.json()) as { session_id: string }
    if (!j?.session_id) throw new Error('POST /sessions: no session_id')
    return j.session_id
  }

  async start(p: StartParams): Promise<void> {
    const chk = canStart(p)
    if (!chk.ok) throw new Error(`cannot start: missing/invalid ${chk.reasons.join(', ')}`)
    if (this.state === 'starting' || this.state === 'running' || this.state === 'server-lost' || this.state === 'stopping') {
      throw new Error('a session is already running')
    }
    this.params = { ...p, stand: p.stand.trim(), doctor: p.doctor.trim(), crop: p.crop ?? null }
    this.sessionId = null
    this.connection = 'none'
    this.resultsState = 'none'
    this.received = this.dropped = 0
    this.encSentBase = this.encSentCur = 0
    this.encSentKnown = false
    this.stopStatsTimer()
    this.serverError = this.recorderError = null
    this.buffer = null
    this.disposedBuffer = false
    this.pushChain = Promise.resolve()
    this.startedAt = new Date().toISOString()
    this.set('starting')
    try {
      await this.startInner()
    } catch (e) {
      this.cleanupAfterFailedStart()
      this.serverError = this.serverError ?? errText(e)
      this.set('error')
      throw e
    }
  }

  private async startInner() {
    const p = this.params!
    try {
      this.sessionId = await this.createSession()
    } catch (e) {
      this.serverError = errText(e)
      if (p.mode === 'file') throw e // nothing to record without the server
    }
    if (p.mode === 'file') {
      this.buffer = this.deps.createBuffer(p.profile.bufferDelayMs, bufferTimeout(p.profile), 30)
      this.startResults()
      await this.http(`/sessions/${this.sessionId}/file`, { method: 'POST', body: { path: p.filePath, realtime: p.realtime ?? true } })
      this.set('running')
      return
    }
    const cap = await this.deps.startCapture(p.deviceId, {
      width: p.width,
      height: p.height,
      fps: p.fps,
      onRecorderError: (m) => {
        this.recorderError = m
        this.emit()
      },
      onFrameBitmap: (id, bm) => this.onBitmap(id, bm),
    })
    this.cap = cap
    if (p.crop) {
      const v = validateCrop(p.crop, cap.width, cap.height)
      if ('message' in v) throw new Error(`crop invalid: ${v.message}`)
    }
    this.buffer = this.deps.createBuffer(p.profile.bufferDelayMs, bufferTimeout(p.profile), cap.fps > 0 ? cap.fps : 60)
    cap.localRecorder.start(p.crop ?? null)
    if (this.sessionId) {
      this.startResults()
      await this.connect()
    } else {
      this.connection = 'lost'
      this.set('server-lost')
    }
  }

  private cleanupAfterFailedStart() {
    this.rc?.stop()
    this.rc = null
    this.stopStatsTimer()
    this.dropConn()
    this.cap?.stop()
    this.cap = null
    this.disposeBuffer()
    this.connection = 'none'
  }

  private startResults() {
    if (!this.sessionId || !this.buffer) return
    this.rc?.stop()
    const sink = {
      pushResult: (id: number, r: FrameResult) => {
        this.received++
        if (r.dropped) this.dropped++
        this.buffer?.pushResult(id, r)
      },
    }
    this.rc = new ResultsClient({
      url: `${this.deps.wsBase}/sessions/${this.sessionId}/results`,
      token: this.token(),
      buffer: sink,
      WebSocket: this.deps.WebSocket,
      onState: (s) => {
        this.resultsState = s
      },
      onRejected: (code) => {
        this.serverError = code === 4401 ? 'results: stand token rejected (4401)' : 'results: session unknown or stopped on the server (4404)'
        this.emit()
      },
    })
    this.rc.start()
  }

  private async connect() {
    const cap = this.cap!
    const gen = ++this.connGen
    this.connection = 'connecting'
    this.emit()
    try {
      const configuration = await this.rtcConfig()
      if (gen !== this.connGen) return
      const c = await this.deps.connectSendStream(
        cap.sendStream,
        async (offer) => {
          const r = await this.http(`/sessions/${this.sessionId}/offer`, { method: 'POST', body: { sdp: offer.sdp, type: offer.type } })
          return (await r.json()) as RTCSessionDescriptionInit
        },
        { configuration, onConnectionLost: (s) => gen === this.connGen && this.lost(`connection ${s}`) },
      )
      if (gen !== this.connGen) return c.close()
      this.conn = c
      this.encSentCur = 0
      if (!this.statsTimer && typeof setInterval !== 'undefined') {
        this.statsTimer = setInterval(() => void this.pollEncoder().then(() => this.emit()), 1000)
      }
      this.connection = 'connected'
      this.serverError = null
      this.set('running')
    } catch (e) {
      if (gen === this.connGen) this.lost(errText(e))
    }
  }

  private lost(why: string) {
    if (this.state === 'stopping' || this.state === 'finished' || this.state === 'idle') return
    this.connection = 'lost'
    this.serverError = why
    this.set('server-lost')
  }

  /** Re-offer on the same session with the same capture (frame counter and recording continue). */
  async reconnect(): Promise<void> {
    if (!this.cap || !this.params || (this.state !== 'server-lost' && this.state !== 'running')) {
      throw new Error('nothing to reconnect')
    }
    this.dropConn()
    if (!this.sessionId) {
      try {
        this.sessionId = await this.createSession()
        this.startResults()
      } catch (e) {
        this.lost(errText(e))
        return
      }
    }
    await this.connect()
  }

  setDelay(ms: number) {
    if (this.params) this.params.profile = { ...this.params.profile, bufferDelayMs: ms }
    this.buffer?.setDelay(ms)
  }

  // ---- secondary screen feed (R9)
  private onBitmap(id: number, bm: ImageBitmap) {
    const buf = this.buffer
    if (!buf || this.disposedBuffer) return bm.close?.()
    const small = bm.width <= SECONDARY_WIDTH ? Promise.resolve(bm) : this.deps.resizeBitmap(bm, SECONDARY_WIDTH)
    // pushes happen strictly in capture order, whatever order the resizes finish in
    this.pushChain = this.pushChain.then(async () => {
      let out: ImageBitmap
      try {
        out = await small
      } catch {
        bm.close?.()
        return
      }
      if (out !== bm) bm.close?.()
      if (this.disposedBuffer || this.buffer !== buf) return out.close?.()
      buf.pushFrame(id, out as FrameBitmap)
    }).catch((e) => {
      // one failing push must not reject the chain (every later frame would be lost)
      console.error('secondary screen: pushFrame failed', e)
    })
  }

  private disposeBuffer() {
    this.disposedBuffer = true
    this.buffer?.dispose()
  }

  async stop(): Promise<FinishedSession> {
    if (this.state === 'idle' || this.state === 'finished' || this.state === 'stopping' || !this.params) {
      throw new Error('no running session')
    }
    this.set('stopping')
    this.connGen++ // ignore late connection-lost callbacks
    const p = this.params
    let video: Blob | null = null
    let mimeType: string | null = null
    let frameTable: FinishedSession['frameTable'] = []
    let offset = 0
    let error: string | null = null
    const cap = this.cap
    if (cap) {
      try {
        const rec = await cap.localRecorder.stop()
        video = rec.videoBlob
        mimeType = rec.mimeType
        frameTable = rec.frameTable
        offset = rec.recordingStartOffset
        if (rec.error) this.recorderError = rec.error
      } catch (e) {
        this.recorderError = `recording: ${errText(e)}`
        error = this.recorderError
      }
    }
    const framesSent = cap?.frameCount ?? 0
    this.stopStatsTimer()
    await this.pollEncoder()
    const framesEncoderSent = this.encSentKnown ? this.encSentBase + this.encSentCur : null
    cap?.stop()
    this.dropConn()

    let log: string | null = null
    let serverFrames: number | null = null
    if (this.sessionId) {
      try {
        const r = await this.http(`/sessions/${this.sessionId}/stop`, { method: 'POST', timeoutMs: 20000 })
        serverFrames = ((await r.json().catch(() => null)) as { frames?: number } | null)?.frames ?? null
        const l = await this.http(`/sessions/${this.sessionId}/log`, { method: 'GET', timeoutMs: 60000 })
        log = await l.text()
      } catch (e) {
        error = error ?? `server: ${errText(e)}`
        this.serverError = errText(e)
        log = null
      }
    } else {
      error = error ?? `server: no session (${this.serverError ?? 'not created'})`
    }
    this.rc?.stop()
    this.rc = null
    this.disposeBuffer()
    this.cap = null
    this.connection = 'none'

    const fin: FinishedSession = {
      video,
      mimeType,
      frameTable,
      recordingStartOffset: offset,
      log,
      sessionMeta: {
        sessionId: this.sessionId,
        stand: p.stand,
        doctor: p.doctor,
        mode: p.mode,
        crop: p.crop ?? null,
        source: cap && cap.width > 0 && cap.height > 0 ? { width: cap.width, height: cap.height } : null,
        startedAt: this.startedAt,
        stoppedAt: new Date().toISOString(),
        framesSent,
        framesEncoderSent,
        framesReceived: this.received,
        serverFrames,
      },
      error,
      recorderError: this.recorderError,
    }
    this.set('finished')
    this.hooks.onFinished?.(fin)
    return fin
  }
}
