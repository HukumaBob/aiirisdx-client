/**
 * Local recording at the stand (spec §5/§6, RF2): MediaRecorder on the ORIGINAL capture-card
 * signal -- never on the stamped send copy, so the frame-id marker is not in the recording.
 *
 * - Without crop the original MediaStream is recorded directly. With crop `{x,y,w,h}` (pixels
 *   of the original frame) a second canvas draws only that rectangle of the original video
 *   frame on every frame (no marker) and its captureStream is recorded.
 * - Container/codec: H.264 in MP4 if `MediaRecorder.isTypeSupported`, otherwise WebM VP9
 *   (then VP8, then plain WebM); the mimeType actually used is returned.
 * - Chunks: `start(timeslice = 1000 ms)`; every chunk goes to a `ChunkSink` -- OPFS (written
 *   incrementally to disk) when available, otherwise in memory. If a sink write fails (quota,
 *   disk full, handle error) the failure is surfaced (`onError`, `RecordingResult.error`) and
 *   the rest of the recording continues into memory; `stop()` still returns the result.
 * - Nothing here knows about signalling or WebRTC: losing the server connection cannot stop
 *   or alter the recording.
 *
 * Frame table (frameId -> pts in the RECORDING timeline). The recording and the stamped send
 * canvas are different pipelines fed by the same source frames, so the table is built from
 * the capture pipeline's per-frame callback: `recordingStartOffset` is the capture pts of the
 * first frame delivered after `start()`, and every later frame gets `pts - offset` (seconds).
 * Assumption: the first frame the MediaRecorder encodes is that same frame, and the recorder
 * timestamps follow source frame times (Chrome/Firefox both start the file at 0 on the first
 * encoded frame). Inaccuracy bound: about one frame interval (±33 ms at 30 fps) for the start
 * alignment, plus per-frame jitter between the video-frame callback time and the recorder's
 * own capture timestamp (a few ms; with the rAF fallback up to one display refresh).
 * With crop the recorder sees the crop canvas, which is drawn in the same callback -- same
 * bound. To map a frame precisely, seek to the nearest frame to `pts` in the recording.
 */

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export interface FrameInfo {
  frameId: number
  /** seconds since capture start (monotonic) */
  pts: number
}

export interface RecordingResult {
  videoBlob: Blob
  mimeType: string
  /** frameId -> pts (seconds) in the recording timeline */
  frameTable: FrameInfo[]
  /** capture-timeline pts (seconds) that corresponds to recording time 0 */
  recordingStartOffset: number
  crop: CropRect | null
  /** MediaRecorder error message, if one occurred (the result holds what was recorded) */
  error?: string
}

/** Where recorded chunks go. Writes are issued in order and awaited before `finish`. */
export interface ChunkSink {
  write(chunk: Blob): Promise<void>
  finish(mimeType: string): Promise<Blob>
}

export class MemoryChunkSink implements ChunkSink {
  private chunks: Blob[] = []
  async write(chunk: Blob) {
    this.chunks.push(chunk)
  }
  async finish(mimeType: string) {
    const b = new Blob(this.chunks, { type: mimeType })
    this.chunks = []
    return b
  }
}

/** Origin Private File System sink: each chunk is appended to a file as it arrives. */
export class OpfsChunkSink implements ChunkSink {
  private constructor(
    private handle: FileSystemFileHandle,
    private writable: FileSystemWritableFileStream,
  ) {}

  static available(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.storage?.getDirectory === 'function' &&
      typeof FileSystemFileHandle !== 'undefined' &&
      'createWritable' in FileSystemFileHandle.prototype
    )
  }

  static async create(name: string): Promise<OpfsChunkSink> {
    const dir = await navigator.storage.getDirectory()
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable({ keepExistingData: false })
    return new OpfsChunkSink(handle, writable)
  }

  async write(chunk: Blob) {
    await this.writable.write(chunk)
  }

  async finish(mimeType: string) {
    await this.writable.close()
    const file = await this.handle.getFile()
    return file.type === mimeType ? file : new Blob([file], { type: mimeType })
  }
}

export type SinkFactory = () => ChunkSink | Promise<ChunkSink>

/** OPFS if available (falls back to memory if it cannot be opened), else memory. */
export const defaultSinkFactory: SinkFactory = async () => {
  if (OpfsChunkSink.available()) {
    try {
      return await OpfsChunkSink.create(`recording-${Date.now()}.bin`)
    } catch {
      /* fall through */
    }
  }
  return new MemoryChunkSink()
}

export const RECORDING_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028', // H.264 High 4.0 (1080p30)
  'video/mp4;codecs=avc1.4d0028',
  'video/mp4;codecs=avc1.42E01F',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

export function pickRecordingMime(MR: typeof MediaRecorder): string | undefined {
  return RECORDING_MIME_CANDIDATES.find((m) => {
    try {
      return MR.isTypeSupported(m)
    } catch {
      return false
    }
  })
}

/** Provided by the capture pipeline: a stream showing only the crop of the original frame. */
export interface CropStream {
  stream: MediaStream
  /** draw the crop of the current original frame (called once per source frame) */
  draw(): void
  dispose(): void
}

export interface LocalRecorderDeps {
  MediaRecorder: typeof MediaRecorder
  sourceStream: MediaStream
  sourceSize: () => { width: number; height: number }
  createCropStream(crop: CropRect): CropStream
  sinkFactory?: SinkFactory
  timesliceMs?: number
  videoBitsPerSecond?: number
  /** called for every recorder/sink failure; the recording keeps going where possible */
  onError?: (message: string) => void
}

export function validateCrop(crop: CropRect, width: number, height: number): CropRect {
  const r = {
    x: Math.round(crop.x),
    y: Math.round(crop.y),
    w: Math.round(crop.w),
    h: Math.round(crop.h),
  }
  if (r.w <= 0 || r.h <= 0 || r.x < 0 || r.y < 0 || r.x + r.w > width || r.y + r.h > height) {
    throw new RangeError(`crop ${JSON.stringify(crop)} outside the ${width}x${height} frame`)
  }
  return r
}

export class LocalRecorder {
  private rec: MediaRecorder | null = null
  private crop: CropRect | null = null
  private cropStream: CropStream | null = null
  private sink: Promise<ChunkSink> | null = null
  /** takes over (in memory) after the first failed write to `sink` */
  private fallback: MemoryChunkSink | null = null
  private writes: Promise<void> = Promise.resolve()
  private table: FrameInfo[] = []
  private offset: number | null = null
  private mimeType = ''
  private error: string | undefined
  private stopped: Promise<void> | null = null

  constructor(private deps: LocalRecorderDeps) {}

  get state(): RecordingState {
    return this.rec?.state ?? 'inactive'
  }

  start(crop?: CropRect | null): void {
    if (this.rec && this.rec.state !== 'inactive') throw new Error('recording already running')
    const { MediaRecorder: MR } = this.deps
    this.crop = null
    this.cropStream = null
    let stream = this.deps.sourceStream
    if (crop) {
      const { width, height } = this.deps.sourceSize()
      this.crop = validateCrop(crop, width, height)
      this.cropStream = this.deps.createCropStream(this.crop)
      stream = this.cropStream.stream
    }
    const mimeType = pickRecordingMime(MR)
    const opts: MediaRecorderOptions = {}
    if (mimeType) opts.mimeType = mimeType
    if (this.deps.videoBitsPerSecond) opts.videoBitsPerSecond = this.deps.videoBitsPerSecond
    const rec = new MR(stream, opts)
    this.mimeType = rec.mimeType || mimeType || 'video/webm'
    this.table = []
    this.offset = null
    this.error = undefined
    this.writes = Promise.resolve()
    this.fallback = null
    try {
      this.sink = Promise.resolve((this.deps.sinkFactory ?? defaultSinkFactory)())
    } catch (e) {
      this.sink = Promise.reject(e)
    }
    this.sink.catch(() => undefined) // handled in writeChunk / stop
    rec.addEventListener('dataavailable', (ev) => {
      const data = (ev as BlobEvent).data
      if (!data || data.size === 0) return
      // writeChunk never rejects, so one failed write cannot poison the chain
      this.writes = this.writes.then(() => this.writeChunk(data))
    })
    rec.addEventListener('error', (ev) => {
      const e = (ev as Event & { error?: { message?: string } }).error
      this.fail(e?.message ?? 'MediaRecorder error')
    })
    this.stopped = new Promise((resolve) => rec.addEventListener('stop', () => resolve()))
    this.rec = rec
    rec.start(this.deps.timesliceMs ?? 1000)
  }

  private fail(message: string): void {
    this.error = this.error ? `${this.error}; ${message}` : message
    try {
      this.deps.onError?.(message)
    } catch {
      /* a listener bug must not break the recording */
    }
  }

  /**
   * Write one chunk to the sink. On the first failure (OPFS quota, disk full, handle error)
   * the error is surfaced and this and all later chunks go to an in-memory fallback, so no
   * chunk is lost; `stop()` concatenates the sink's part and the fallback's part in order.
   */
  private async writeChunk(data: Blob): Promise<void> {
    if (!this.fallback) {
      try {
        await (await this.sink!).write(data)
        return
      } catch (e) {
        this.fail(`recording sink write failed, continuing in memory: ${errMsg(e)}`)
        this.fallback = new MemoryChunkSink()
      }
    }
    await this.fallback.write(data)
  }

  /** Called by the capture pipeline once per source frame (after the crop canvas is drawn). */
  onFrame(f: FrameInfo): void {
    if (!this.rec || this.rec.state !== 'recording') return
    this.cropStream?.draw()
    if (this.offset === null) this.offset = f.pts
    this.table.push({ frameId: f.frameId, pts: f.pts - this.offset })
  }

  async stop(): Promise<RecordingResult> {
    const rec = this.rec
    if (!rec || !this.sink || !this.stopped) throw new Error('recording not started')
    const parts: Blob[] = []
    try {
      if (rec.state !== 'inactive') rec.stop()
      await this.stopped
      await this.writes
      try {
        parts.push(await (await this.sink).finish(this.mimeType))
      } catch (e) {
        this.fail(`recording sink finish failed: ${errMsg(e)}`)
      }
      if (this.fallback) parts.push(await this.fallback.finish(this.mimeType))
    } finally {
      this.cropStream?.dispose()
      this.cropStream = null
      this.rec = null
      this.fallback = null
    }
    const videoBlob = new Blob(parts, { type: this.mimeType })
    const res: RecordingResult = {
      videoBlob,
      mimeType: this.mimeType,
      frameTable: this.table,
      recordingStartOffset: this.offset ?? 0,
      crop: this.crop,
    }
    if (this.error) res.error = this.error
    return res
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
