/**
 * Capture at the stand (spec §3, §5, §6): the capture card's signal is opened with
 * getUserMedia and split into two pipelines that are fed by the same source frames:
 *
 * 1. Send copy: every source frame is drawn onto a full-size canvas and the frame-id marker
 *    (frameId.ts) is stamped into rows 0..15; `sendStream = canvas.captureStream(fps)` is
 *    what goes to WebRTC (sender.ts). It is never cropped -- the server crops by the
 *    session's crop -- so the marker geometry holds.
 * 2. Local recording (localRecorder.ts): MediaRecorder on the ORIGINAL stream (or on a crop
 *    canvas drawn from the original frame) -- never contains the marker.
 *
 * Frames are pumped with `HTMLVideoElement.requestVideoFrameCallback` (one callback per
 * presented source frame); where it is missing, `requestAnimationFrame` is used (may stamp a
 * frame per display refresh rather than per source frame -- ids stay strictly increasing).
 *
 * Frame counter: strictly increasing integer per capture (per CaptureHandle), starting at 0.
 * It belongs to the capture, not to the WebRTC connection: re-offering / reconnecting reuses
 * `sendStream` and the numbering continues (the server accepts only increasing ids per
 * session). `pts` = seconds since capture start on the performance clock (the video-frame
 * callback's `now`), forced monotonic.
 */
import { videoConstraints } from './captureFormat'
import { drawFrameId, MAX_FRAME_ID } from './frameId'
import { LocalRecorder, type CropRect, type CropStream, type FrameInfo, type SinkFactory } from './localRecorder'

export type { CropRect, FrameInfo, RecordingResult } from './localRecorder'

/** Browser facilities used by the capture; injectable for tests. */
export interface CaptureEnv {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>
  createVideo(): HTMLVideoElement
  createCanvas(): HTMLCanvasElement
  /** ms, monotonic (performance.now) */
  now(): number
  MediaRecorder: typeof MediaRecorder
  /** snapshot of the current source frame (default: global createImageBitmap) */
  createImageBitmap?: (src: HTMLVideoElement) => Promise<ImageBitmap>
  requestAnimationFrame?: (cb: FrameRequestCallback) => number
  cancelAnimationFrame?: (id: number) => void
}

export function browserEnv(): CaptureEnv {
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    createVideo: () => document.createElement('video'),
    createCanvas: () => document.createElement('canvas'),
    now: () => performance.now(),
    MediaRecorder: globalThis.MediaRecorder,
    createImageBitmap:
      typeof globalThis.createImageBitmap === 'function' ? (v) => globalThis.createImageBitmap(v) : undefined,
    requestAnimationFrame: (cb) => requestAnimationFrame(cb),
    cancelAnimationFrame: (id) => cancelAnimationFrame(id),
  }
}

export interface CaptureOptions {
  /** requested (ideal) source size; default 1920x1080 (captureFormat.DEFAULT_CAPTURE_FORMAT) */
  width?: number
  height?: number
  /** requested (ideal) source frame rate (default 30) and captureStream rate (default: the
   * source's negotiated rate, else 30) */
  fps?: number
  env?: Partial<CaptureEnv>
  /** where recorded chunks go (default: OPFS if available, else memory) */
  sinkFactory?: SinkFactory
  /** recorder / sink failures (the recording continues; also in RecordingResult.error) */
  onRecorderError?: (message: string) => void
  recordingTimesliceMs?: number
  recordingBitsPerSecond?: number
  /** an already opened stream (e.g. a video file's captureStream) instead of getUserMedia */
  sourceStream?: MediaStream
  /**
   * Secondary screen feed: called (asynchronously) with an UNSTAMPED snapshot of each source
   * frame, taken BEFORE the marker is drawn, so detection boxes (normalized to the original
   * frame) line up exactly. The receiver owns the bitmap and must close() it.
   */
  onFrameBitmap?: (frameId: number, bitmap: ImageBitmap) => void
}

export type FrameListener = (f: FrameInfo) => void

/** `{frameId, pts}` per stamped frame: callback subscription or `for await`. */
export interface FrameStream extends AsyncIterable<FrameInfo> {
  subscribe(cb: FrameListener): () => void
}

export interface CaptureHandle {
  readonly sourceStream: MediaStream
  readonly sendStream: MediaStream
  readonly frames: FrameStream
  readonly localRecorder: LocalRecorder
  readonly width: number
  readonly height: number
  readonly fps: number
  /** next frame id to be assigned (= number of frames stamped so far) */
  readonly frameCount: number
  /** the canvas holding the stamped copy (for preview) */
  readonly sendCanvas: HTMLCanvasElement
  stop(): void
}

class Frames implements FrameStream {
  private listeners = new Set<FrameListener>()
  private ended = false

  subscribe(cb: FrameListener) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  emit(f: FrameInfo) {
    for (const cb of [...this.listeners]) cb(f)
  }

  end() {
    this.ended = true
    for (const cb of [...this.listeners]) cb(END)
    this.listeners.clear()
  }

  [Symbol.asyncIterator](): AsyncIterator<FrameInfo> {
    const queue: FrameInfo[] = []
    let wake: (() => void) | null = null
    let done = this.ended
    const unsub = this.subscribe((f) => {
      if (f === END) done = true
      else queue.push(f)
      wake?.()
    })
    return {
      next: async () => {
        while (!queue.length && !done) await new Promise<void>((r) => (wake = r))
        wake = null
        if (queue.length) return { value: queue.shift()!, done: false }
        unsub()
        return { value: undefined, done: true }
      },
      return: async () => {
        done = true
        unsub()
        return { value: undefined, done: true }
      },
    }
  }
}

const END: FrameInfo = { frameId: -1, pts: -1 }

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null
  if (!ctx) throw new Error('2D canvas not available')
  ctx.imageSmoothingEnabled = false
  return ctx
}

export async function startCapture(deviceId: string, opts: CaptureOptions = {}): Promise<CaptureHandle> {
  const env: CaptureEnv = { ...browserEnv(), ...opts.env } as CaptureEnv
  // '' = the browser's default camera (manual checks); a capture card is always given by id.
  // Same constraints as the stand page's preview (captureFormat.ts): 1080p30 unless overridden
  const video = videoConstraints(deviceId, { width: opts.width, height: opts.height, fps: opts.fps })
  const source = opts.sourceStream ?? (await env.getUserMedia({ video, audio: false }))
  try {
    return await buildPipeline(source, env, opts)
  } catch (e) {
    if (!opts.sourceStream) source.getTracks().forEach((t) => t.stop())
    throw e
  }
}

async function buildPipeline(source: MediaStream, env: CaptureEnv, opts: CaptureOptions): Promise<CaptureHandle> {
  const track = source.getVideoTracks()[0]
  if (!track) throw new Error('capture source has no video track')
  const settings = track.getSettings()
  const fps = opts.fps ?? settings.frameRate ?? 30

  const video = env.createVideo()
  video.muted = true
  video.playsInline = true
  video.srcObject = source
  await video.play()

  let width = settings.width ?? video.videoWidth
  let height = settings.height ?? video.videoHeight
  if (!width || !height) {
    width = video.videoWidth
    height = video.videoHeight
  }
  const canvas = env.createCanvas()
  canvas.width = width
  canvas.height = height
  const ctx = ctx2d(canvas)
  const sendStream = canvas.captureStream(fps)

  const frames = new Frames()
  let counter = 0
  let t0: number | null = null
  let lastPts = -Infinity
  let running = true

  const recorder = new LocalRecorder({
    MediaRecorder: env.MediaRecorder,
    sourceStream: source,
    sourceSize: () => ({ width, height }),
    sinkFactory: opts.sinkFactory,
    onError: opts.onRecorderError,
    timesliceMs: opts.recordingTimesliceMs,
    videoBitsPerSecond: opts.recordingBitsPerSecond,
    createCropStream: (crop: CropRect): CropStream => {
      const c = env.createCanvas()
      c.width = crop.w
      c.height = crop.h
      const cctx = ctx2d(c)
      const stream = c.captureStream(fps)
      return {
        stream,
        draw: () => cctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h),
        dispose: () => stream.getTracks().forEach((t) => t.stop()),
      }
    },
  })

  const onSourceFrame = (now: number) => {
    if (!running) return
    if (counter > MAX_FRAME_ID) return // ~4.5 years at 30 fps; never wrap
    if (t0 === null) t0 = now
    const pts = Math.max((now - t0) / 1000, lastPts + 1e-6)
    lastPts = pts
    const f: FrameInfo = { frameId: counter++, pts }
    if (opts.onFrameBitmap && env.createImageBitmap) {
      // createImageBitmap snapshots the video frame at call time; resolution order is FIFO
      const id = f.frameId
      env.createImageBitmap(video).then(
        (bm) => (running ? opts.onFrameBitmap!(id, bm) : bm.close?.()),
        () => {},
      )
    }
    ctx.drawImage(video, 0, 0, width, height)
    drawFrameId(ctx, width, height, f.frameId)
    recorder.onFrame(f)
    frames.emit(f)
  }

  type Rvfc = { requestVideoFrameCallback?: (cb: (now: number) => void) => number; cancelVideoFrameCallback?: (id: number) => void }
  const v = video as unknown as Rvfc
  let pending: number | null = null
  let cancel: () => void
  if (typeof v.requestVideoFrameCallback === 'function') {
    const loop = (now: number) => {
      onSourceFrame(now)
      if (running) pending = v.requestVideoFrameCallback!(loop)
    }
    pending = v.requestVideoFrameCallback(loop)
    cancel = () => pending !== null && v.cancelVideoFrameCallback?.(pending)
  } else {
    const raf = env.requestAnimationFrame
    const caf = env.cancelAnimationFrame
    if (!raf) throw new Error('neither requestVideoFrameCallback nor requestAnimationFrame available')
    let lastTime = -1
    const loop = (now: number) => {
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime
        onSourceFrame(now)
      }
      if (running) pending = raf(loop)
    }
    pending = raf(loop)
    cancel = () => pending !== null && caf?.(pending)
  }

  return {
    sourceStream: source,
    sendStream,
    frames,
    localRecorder: recorder,
    width,
    height,
    fps,
    sendCanvas: canvas,
    get frameCount() {
      return counter
    },
    stop() {
      if (!running) return
      running = false
      cancel()
      frames.end()
      sendStream.getTracks().forEach((t) => t.stop())
      if (!opts.sourceStream) source.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    },
  }
}
