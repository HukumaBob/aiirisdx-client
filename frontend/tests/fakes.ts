/**
 * Lightweight fakes for the browser media APIs used by src/capture (jsdom has none of them):
 * a video element with requestVideoFrameCallback, a pixel-accurate 2D canvas (drawImage,
 * fillRect, getImageData, captureStream), MediaStreams that can be "read" as RGBA frames,
 * MediaRecorder that samples its stream on every frame, and a minimal RTCPeerConnection.
 *
 * A `FakeMedia` harness drives time: `emitFrame()` sets a new source frame, runs the video
 * frame callbacks (the capture pipeline draws), then lets every recording MediaRecorder
 * sample what its stream shows at that moment.
 */
import type { CaptureEnv } from '../src/capture/captureSource'

export interface Rgba {
  width: number
  height: number
  data: Uint8ClampedArray
}

export function makeFrame(width: number, height: number, seed: number): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      // mid-grey texture, never a clean black/white block pattern
      data[o] = 90 + ((x * 7 + y * 13 + seed * 31) % 60)
      data[o + 1] = 100 + ((x * 3 + y * 5 + seed * 17) % 50)
      data[o + 2] = 110 + ((x + y * 11 + seed * 7) % 40)
      data[o + 3] = 255
    }
  }
  return { width, height, data }
}

function cropRgba(src: Rgba, sx: number, sy: number, sw: number, sh: number): Rgba {
  const out = new Uint8ClampedArray(sw * sh * 4)
  for (let y = 0; y < sh; y++) {
    const from = ((sy + y) * src.width + sx) * 4
    out.set(src.data.subarray(from, from + sw * 4), y * sw * 4)
  }
  return { width: sw, height: sh, data: out }
}

function parseColor(style: string): [number, number, number] {
  const s = style.trim().toLowerCase()
  if (s === 'white') return [255, 255, 255]
  if (s === 'black') return [0, 0, 0]
  const m = /^#([0-9a-f]{6})$/.exec(s)
  if (m) {
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const r = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(s)
  if (r) return [+r[1], +r[2], +r[3]]
  throw new Error(`fake canvas: unsupported fillStyle ${style}`)
}

export class FakeTrack extends EventTarget {
  kind = 'video'
  readyState = 'live'
  constructor(private settings: { width: number; height: number; frameRate: number }) {
    super()
  }
  /** the device vanished: the browser ends the track and fires 'ended' */
  end() {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
  getSettings() {
    return { ...this.settings }
  }
  stop() {
    this.readyState = 'ended'
  }
}

/** A MediaStream whose current picture can be read back as RGBA. */
export class FakeStream {
  readonly track: FakeTrack
  constructor(
    readonly label: string,
    readonly read: () => Rgba,
    settings: { width: number; height: number; frameRate: number },
  ) {
    this.track = new FakeTrack(settings)
  }
  getVideoTracks() {
    return [this.track]
  }
  getTracks() {
    return [this.track]
  }
}

export class FakeVideo {
  srcObject: FakeStream | null = null
  muted = false
  playsInline = false
  frame: Rgba | null = null
  private cbs = new Map<number, (now: number, meta: { mediaTime: number }) => void>()
  private nextId = 1
  get videoWidth() {
    return this.frame?.width ?? 0
  }
  get videoHeight() {
    return this.frame?.height ?? 0
  }
  async play() {}
  pause() {}
  requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number }) => void) {
    const id = this.nextId++
    this.cbs.set(id, cb)
    return id
  }
  cancelVideoFrameCallback(id: number) {
    this.cbs.delete(id)
  }
  fire(now: number) {
    const cbs = [...this.cbs.values()]
    this.cbs.clear()
    for (const cb of cbs) cb(now, { mediaTime: now / 1000 })
  }
}

export class FakeContext2D {
  fillStyle = '#000000'
  imageSmoothingEnabled = true
  constructor(private canvas: FakeCanvas) {}

  drawImage(src: FakeVideo | FakeCanvas, ...a: number[]) {
    const img: Rgba | null = src instanceof FakeVideo ? src.frame : src.pixels()
    if (!img) return
    let sx = 0, sy = 0, sw = img.width, sh = img.height, dx = 0, dy = 0, dw = sw, dh = sh
    if (a.length === 2) [dx, dy] = a
    else if (a.length === 4) [dx, dy, dw, dh] = a
    else if (a.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = a
    else throw new Error('fake drawImage: bad args')
    if (sw !== dw || sh !== dh) throw new Error('fake drawImage: scaling not supported')
    const part = cropRgba(img, sx, sy, sw, sh)
    this.putRect(part, dx, dy)
  }

  fillRect(x: number, y: number, w: number, h: number) {
    const [r, g, b] = parseColor(this.fillStyle)
    const c = this.canvas
    for (let yy = Math.max(0, y); yy < Math.min(c.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(c.width, x + w); xx++) {
        const o = (yy * c.width + xx) * 4
        c.data[o] = r
        c.data[o + 1] = g
        c.data[o + 2] = b
        c.data[o + 3] = 255
      }
    }
  }

  getImageData(x: number, y: number, w: number, h: number) {
    return cropRgba(this.canvas.pixels(), x, y, w, h)
  }

  putImageData(img: Rgba, dx: number, dy: number) {
    this.putRect(img, dx, dy)
  }

  private putRect(part: Rgba, dx: number, dy: number) {
    const c = this.canvas
    for (let y = 0; y < part.height; y++) {
      const ty = dy + y
      if (ty < 0 || ty >= c.height) continue
      for (let x = 0; x < part.width; x++) {
        const tx = dx + x
        if (tx < 0 || tx >= c.width) continue
        const s = (y * part.width + x) * 4
        const t = (ty * c.width + tx) * 4
        c.data[t] = part.data[s]
        c.data[t + 1] = part.data[s + 1]
        c.data[t + 2] = part.data[s + 2]
        c.data[t + 3] = part.data[s + 3]
      }
    }
  }
}

export class FakeCanvas {
  private _w = 300
  private _h = 150
  data = new Uint8ClampedArray(300 * 150 * 4)
  private ctx = new FakeContext2D(this)
  streams: FakeStream[] = []
  get width() {
    return this._w
  }
  set width(v: number) {
    this._w = v
    this.data = new Uint8ClampedArray(this._w * this._h * 4)
  }
  get height() {
    return this._h
  }
  set height(v: number) {
    this._h = v
    this.data = new Uint8ClampedArray(this._w * this._h * 4)
  }
  getContext(kind: string) {
    if (kind !== '2d') return null
    return this.ctx
  }
  pixels(): Rgba {
    return { width: this._w, height: this._h, data: this.data.slice() }
  }
  captureStream(fps?: number) {
    const s = new FakeStream('canvas', () => this.pixels(), {
      width: this._w,
      height: this._h,
      frameRate: fps ?? 30,
    })
    this.streams.push(s)
    return s
  }
}

export class FakeMediaRecorder extends EventTarget {
  static supported = new Set<string>(['video/webm;codecs=vp9', 'video/webm'])
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported(m: string) {
    return FakeMediaRecorder.supported.has(m)
  }
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  readonly mimeType: string
  timeslice = 0
  /** Every frame this recorder "encoded", as it was seen in its stream. */
  readonly recorded: Rgba[] = []
  private sinceChunk = 0

  constructor(
    readonly stream: FakeStream,
    opts?: { mimeType?: string; videoBitsPerSecond?: number },
  ) {
    super()
    this.mimeType = opts?.mimeType ?? 'video/webm'
    FakeMediaRecorder.instances.push(this)
  }
  start(timeslice?: number) {
    this.state = 'recording'
    this.timeslice = timeslice ?? 0
    this.dispatchEvent(new Event('start'))
  }
  sample() {
    if (this.state !== 'recording') return
    this.recorded.push(this.stream.read())
    this.sinceChunk++
    if (this.sinceChunk >= 3) this.flush()
  }
  private flush() {
    if (this.sinceChunk === 0) return
    const ev = new Event('dataavailable') as Event & { data: Blob }
    ev.data = new Blob([new Uint8Array(this.sinceChunk * 10)], { type: this.mimeType })
    this.sinceChunk = 0
    this.dispatchEvent(ev)
  }
  requestData() {
    this.flush()
  }
  stop() {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    setTimeout(() => {
      this.flush()
      this.dispatchEvent(new Event('stop'))
    }, 0)
  }
}

export class FakeMedia {
  now = 1000
  video = new FakeVideo()
  canvases: FakeCanvas[] = []
  frames: Rgba[] = []
  gumCalls: MediaStreamConstraints[] = []
  constructor(
    readonly width = 1920,
    readonly height = 32,
    readonly frameMs = 1000 / 30,
  ) {
    FakeMediaRecorder.instances = []
  }

  env(): CaptureEnv {
    return {
      getUserMedia: async (c: MediaStreamConstraints) => {
        this.gumCalls.push(c)
        return new FakeStream(
          'camera',
          () => {
            if (!this.video.frame) throw new Error('no frame yet')
            return { ...this.video.frame, data: this.video.frame.data.slice() }
          },
          { width: this.width, height: this.height, frameRate: 30 },
        ) as unknown as MediaStream
      },
      createVideo: () => this.video as unknown as HTMLVideoElement,
      createCanvas: () => {
        const c = new FakeCanvas()
        this.canvases.push(c)
        return c as unknown as HTMLCanvasElement
      },
      now: () => this.now,
      MediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
    }
  }

  /** Deliver one source frame: pipeline callbacks first, then recorders sample. */
  emitFrame(): Rgba {
    const f = makeFrame(this.width, this.height, this.frames.length)
    this.frames.push(f)
    this.video.frame = f
    this.now += this.frameMs
    this.video.fire(this.now)
    for (const r of FakeMediaRecorder.instances) r.sample()
    return f
  }

  emitFrames(n: number) {
    for (let i = 0; i < n; i++) this.emitFrame()
  }
}

/** Minimal RTCPeerConnection: enough for applySenderParams / preferH264 / offer flow. */
export class FakeSender {
  params: Record<string, unknown> = { encodings: [{}] }
  constructor(readonly track: unknown) {}
  getParameters() {
    return structuredClone(this.params)
  }
  async setParameters(p: Record<string, unknown>) {
    this.params = p
  }
}

export class FakeTransceiver {
  codecPrefs: { mimeType: string }[] | null = null
  readonly sender: FakeSender
  constructor(track: unknown) {
    this.sender = new FakeSender(track)
  }
  setCodecPreferences(c: { mimeType: string }[]) {
    this.codecPrefs = c
  }
}

export class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = []
  static capabilities = {
    codecs: [
      { mimeType: 'video/VP8', clockRate: 90000 },
      { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=42e01f' },
      { mimeType: 'video/VP9', clockRate: 90000 },
      { mimeType: 'video/rtx', clockRate: 90000 },
    ],
  }
  connectionState = 'new'
  transceivers: FakeTransceiver[] = []
  localDescription: { type: string; sdp: string } | null = null
  remoteDescription: { type: string; sdp: string } | null = null
  constructor() {
    super()
    FakePeerConnection.instances.push(this)
  }
  addTransceiver(track: unknown) {
    const t = new FakeTransceiver(track)
    this.transceivers.push(t)
    return t
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 fake' }
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d
    this.setState('connected')
  }
  setState(s: string) {
    this.connectionState = s
    this.dispatchEvent(new Event('connectionstatechange'))
  }
  close() {
    this.connectionState = 'closed'
  }
}
