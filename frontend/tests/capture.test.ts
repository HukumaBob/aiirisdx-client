import { afterEach, describe, expect, it } from 'vitest'
import vectors from '../../tests/fixtures/frame_id_vectors.json'
import { startCapture, type CaptureHandle } from '../src/capture/captureSource'
import {
  BLOCK,
  crc8,
  frameIdBits,
  markerCopies,
  readFrameId,
  stampFrameId,
  drawFrameId,
} from '../src/capture/frameId'
import { MemoryChunkSink } from '../src/capture/localRecorder'
import { applySenderParams, connectSendStream, preferH264, withBitrateHints } from '../src/capture/sender'
import {
  FakeCanvas,
  FakeMedia,
  FakeMediaRecorder,
  FakePeerConnection,
  FakeSender,
  FakeTransceiver,
  makeFrame,
  type Rgba,
} from './fakes'

type Vector = { frame_id: number; crc8: number; bits: string }

function luma(img: Rgba, x: number, y: number) {
  const o = (y * img.width + x) * 4
  return 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]
}

/** Pixel layout check per tests/fixtures/README.md: solid R=G=B blocks, exact geometry. */
function expectMarker(img: Rgba, v: Vector) {
  const copies = Math.min(3, Math.floor(img.width / 640))
  for (let c = 0; c < copies; c++) {
    for (let i = 0; i < 40; i++) {
      const want = v.bits[i] === '1' ? 255 : 0
      const x0 = (c * 40 + i) * 16
      for (let y = 0; y < 16; y++) {
        for (let x = x0; x < x0 + 16; x++) {
          const o = (y * img.width + x) * 4
          if (img.data[o] !== want || img.data[o + 1] !== want || img.data[o + 2] !== want) {
            throw new Error(`id ${v.frame_id}: copy ${c} bit ${i} pixel (${x},${y}) != ${want}`)
          }
        }
      }
    }
  }
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

let handle: CaptureHandle | null = null
afterEach(() => {
  handle?.stop()
  handle = null
})

async function capture(media: FakeMedia) {
  handle = await startCapture('card-1', { env: media.env() })
  return handle
}

describe('frame-id encoder (TS port)', () => {
  it('test_ts_encoder_matches_golden_vectors', () => {
    expect(vectors.length).toBeGreaterThan(5)
    expect(crc8(new TextEncoder().encode('123456789'))).toBe(0xa1)
    for (const v of vectors as Vector[]) {
      expect(frameIdBits(v.frame_id).join('')).toBe(v.bits)
      // ImageData path at several widths (copies = min(3, floor(W/640)))
      for (const [w, copies] of [[640, 1], [1280, 2], [1920, 3], [2560, 3]] as const) {
        expect(markerCopies(w)).toBe(copies)
        const img = makeFrame(w, 24, 1)
        const before = img.data.slice()
        stampFrameId(img, v.frame_id)
        expectMarker(img, v)
        // nothing outside the marker area changed
        for (let y = 0; y < 24; y++) {
          for (let x = 0; x < w; x++) {
            if (y < BLOCK && x < copies * 40 * BLOCK) continue
            const o = (y * w + x) * 4
            if (img.data[o] !== before[o]) throw new Error(`pixel (${x},${y}) changed`)
          }
        }
        expect(readFrameId(img)).toBe(v.frame_id)
      }
      // canvas path (fillRect) gives the same pixels
      const canvas = new FakeCanvas()
      canvas.width = 1920
      canvas.height = 24
      drawFrameId(canvas.getContext('2d') as unknown as CanvasRenderingContext2D, 1920, 24, v.frame_id)
      expectMarker(canvas.pixels(), v)
    }
    // geometry guards, as in Python
    expect(() => stampFrameId(makeFrame(639, 24, 0), 1)).toThrow()
    expect(() => stampFrameId(makeFrame(1920, 16, 0), 1)).toThrow()
    expect(() => frameIdBits(2 ** 32)).toThrow()
    expect(() => frameIdBits(-1)).toThrow()
  })
})

describe('capture pipeline', () => {
  it('test_frame_ids_strictly_increasing', async () => {
    const media = new FakeMedia()
    const h = await capture(media)
    expect(media.gumCalls[0].video).toMatchObject({ deviceId: { exact: 'card-1' } })
    const seen: { frameId: number; pts: number }[] = []
    const unsub = h.frames.subscribe((f) => seen.push(f))
    const iter = h.frames[Symbol.asyncIterator]()
    media.emitFrames(20)
    unsub()

    expect(seen.map((f) => f.frameId)).toEqual([...Array(20).keys()])
    for (let i = 1; i < seen.length; i++) expect(seen[i].pts).toBeGreaterThan(seen[i - 1].pts)
    expect(seen[0].pts).toBeGreaterThanOrEqual(0)
    // async-iterable view sees the same stream
    const first = await iter.next()
    expect(first.value).toEqual(seen[0])
    await iter.return?.()

    // the sent copy carries exactly that id
    const sendCanvas = media.canvases.find((c) => c.streams.some((s) => s === (h.sendStream as unknown)))!
    expect(readFrameId(sendCanvas.pixels())).toBe(19)
    expect(h.sendStream.getVideoTracks()).toHaveLength(1)
  })

  it('test_frame_counter_survives_reoffer', async () => {
    FakePeerConnection.instances = []
    const media = new FakeMedia()
    const h = await capture(media)
    const ids: number[] = []
    h.frames.subscribe((f) => ids.push(f.frameId))
    const signal = async () => ({ type: 'answer' as const, sdp: 'v=0 answer' })
    const opts = {
      RTCPeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection,
      capabilities: FakePeerConnection.capabilities as unknown as RTCRtpCapabilities,
      iceGatheringTimeoutMs: 0,
    }
    const c1 = await connectSendStream(h.sendStream, signal, opts)
    media.emitFrames(5)
    c1.close()
    const c2 = await connectSendStream(h.sendStream, signal, opts)
    media.emitFrames(5)
    c2.close()
    expect(FakePeerConnection.instances).toHaveLength(2)
    expect(ids).toEqual([...Array(10).keys()])
  })
})

describe('local recorder', () => {
  it('test_marker_not_in_local_recording', async () => {
    const media = new FakeMedia()
    const h = await capture(media)
    media.emitFrames(2)
    h.localRecorder.start()
    media.emitFrames(10)
    const res = await h.localRecorder.stop()

    const rec = FakeMediaRecorder.instances.find((r) => r.stream === (h.sourceStream as unknown))
    expect(rec, 'without crop the original (unstamped) stream is recorded').toBeDefined()
    expect(rec!.recorded).toHaveLength(10)
    rec!.recorded.forEach((img, i) => {
      expect(readFrameId(img)).toBeNull()
      expect(sameBytes(img.data, media.frames[2 + i].data)).toBe(true) // bit-exact original
    })
    // the sent copy, meanwhile, is stamped
    expect(media.canvases.some((c) => readFrameId(c.pixels()) === 11)).toBe(true)

    expect(res.mimeType).toBe('video/webm;codecs=vp9')
    expect(res.videoBlob.size).toBe(10 * 10)
    expect(res.videoBlob.type).toBe('video/webm;codecs=vp9')
    expect(rec!.timeslice).toBe(1000)
    // frame table: ids 2..11, in the recording timeline (first recorded frame at 0)
    expect(res.frameTable.map((f) => f.frameId)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(res.frameTable[0].pts).toBe(0)
    res.frameTable.forEach((f, i) => expect(f.pts).toBeCloseTo((i * 1) / 30, 6))
  })

  it('prefers H.264/MP4 when supported', async () => {
    const media = new FakeMedia()
    const h = await capture(media)
    FakeMediaRecorder.supported = new Set(['video/mp4;codecs=avc1.640028', 'video/webm'])
    try {
      h.localRecorder.start()
      media.emitFrames(3)
      const res = await h.localRecorder.stop()
      expect(res.mimeType).toBe('video/mp4;codecs=avc1.640028')
    } finally {
      FakeMediaRecorder.supported = new Set(['video/webm;codecs=vp9', 'video/webm'])
    }
  })

  it('test_crop_applied_to_recording', async () => {
    const media = new FakeMedia(1920, 64)
    const h = await capture(media)
    const crop = { x: 100, y: 8, w: 320, h: 40 }
    h.localRecorder.start(crop)
    media.emitFrames(4)
    const res = await h.localRecorder.stop()

    const rec = FakeMediaRecorder.instances.find((r) => r.stream !== (h.sourceStream as unknown))!
    expect(rec.recorded).toHaveLength(4)
    rec.recorded.forEach((img, i) => {
      const src = media.frames[i]
      expect([img.width, img.height]).toEqual([320, 40])
      for (const [x, y] of [[0, 0], [319, 0], [0, 39], [319, 39], [17, 5], [200, 20]]) {
        expect(luma(img, x, y)).toBeCloseTo(luma(src, crop.x + x, crop.y + y), 6)
      }
      expect(readFrameId(img)).toBeNull()
    })
    // the sent copy stays full-size (the server crops via the session's crop)
    const s = h.sendStream.getVideoTracks()[0].getSettings()
    expect([s.width, s.height]).toEqual([1920, 64])
    expect(res.crop).toEqual(crop)
    expect(res.frameTable.map((f) => f.frameId)).toEqual([0, 1, 2, 3])
  })

  it('test_recording_continues_when_server_connection_lost', async () => {
    FakePeerConnection.instances = []
    const media = new FakeMedia()
    const h = await capture(media)
    h.localRecorder.start()
    let lost = 0
    const conn = await connectSendStream(
      h.sendStream,
      async () => ({ type: 'answer', sdp: 'v=0 answer' }),
      {
        RTCPeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection,
        capabilities: FakePeerConnection.capabilities as unknown as RTCRtpCapabilities,
        iceGatheringTimeoutMs: 0,
        onConnectionLost: () => lost++,
      },
    )
    media.emitFrames(5)
    FakePeerConnection.instances[0].setState('failed') // server gone
    expect(lost).toBe(1)
    conn.close()
    media.emitFrames(7)
    expect(h.localRecorder.state).toBe('recording')
    const res = await h.localRecorder.stop()
    const rec = FakeMediaRecorder.instances[0]
    expect(rec.recorded).toHaveLength(12)
    expect(res.frameTable.map((f) => f.frameId)).toEqual([...Array(12).keys()])
    expect(res.videoBlob.size).toBe(120)

    // a signalling failure while connecting does not touch the recording either
    h.localRecorder.start()
    await expect(
      connectSendStream(h.sendStream, async () => {
        throw new Error('ECONNREFUSED')
      }, {
        RTCPeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection,
        capabilities: FakePeerConnection.capabilities as unknown as RTCRtpCapabilities,
        iceGatheringTimeoutMs: 0,
      }),
    ).rejects.toThrow('ECONNREFUSED')
    media.emitFrames(2)
    expect(h.localRecorder.state).toBe('recording')
    const res2 = await h.localRecorder.stop()
    expect(res2.frameTable.map((f) => f.frameId)).toEqual([12, 13])
  })

  it('test_recording_survives_sink_write_failure', async () => {
    const media = new FakeMedia()
    const errors: string[] = []
    const written: Blob[] = []
    let calls = 0
    const failingSink = {
      async write(b: Blob) {
        calls++
        if (calls === 2) throw new Error('QuotaExceededError: disk full')
        written.push(b)
      },
      async finish(mime: string) {
        return new Blob(written, { type: mime })
      },
    }
    handle = await startCapture('card-1', {
      env: media.env(),
      sinkFactory: () => failingSink,
      onRecorderError: (m) => errors.push(m),
    })
    const h = handle
    h.localRecorder.start()
    media.emitFrames(3) // chunk 1 -> ok
    await new Promise((r) => setTimeout(r, 0))
    media.emitFrames(3) // chunk 2 -> sink write fails
    await new Promise((r) => setTimeout(r, 0))
    media.emitFrames(6) // chunks 3, 4 -> must still be kept
    expect(h.localRecorder.state).toBe('recording')
    const res = await h.localRecorder.stop()
    expect(res.frameTable.map((f) => f.frameId)).toEqual([...Array(12).keys()])
    expect(res.recordingStartOffset).toBeGreaterThanOrEqual(0)
    expect(res.error).toMatch(/disk full/)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/disk full/)
    // chunk 1 from the failed sink + chunks 2..4 from the memory fallback, in order
    expect(res.videoBlob.size).toBe(120)
    expect(res.videoBlob.type).toBe('video/webm;codecs=vp9')
    // the recorder is reusable afterwards
    h.localRecorder.start()
    media.emitFrames(3)
    const res2 = await h.localRecorder.stop()
    expect(res2.error).toBeUndefined()
  })

  it('MemoryChunkSink accumulates chunks in order', async () => {
    const sink = new MemoryChunkSink()
    await sink.write(new Blob(['ab']))
    await sink.write(new Blob(['cd']))
    const blob = await sink.finish('video/webm')
    expect(blob.type).toBe('video/webm')
    const text = await new Promise<string>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.readAsText(blob)
    })
    expect(text).toBe('abcd')
  })
})

describe('sender helpers', () => {
  it('applySenderParams sets maintain-resolution and a bitrate hint', async () => {
    const s = new FakeSender({})
    await applySenderParams(s as unknown as RTCRtpSender, { maxBitrateBps: 4_000_000 })
    expect(s.params.degradationPreference).toBe('maintain-resolution')
    expect((s.params.encodings as { maxBitrate?: number }[])[0].maxBitrate).toBe(4_000_000)
  })

  it('preferH264 puts H.264 first', () => {
    const t = new FakeTransceiver({})
    preferH264(t as unknown as RTCRtpTransceiver, FakePeerConnection.capabilities as unknown as RTCRtpCapabilities)
    expect(t.codecPrefs![0].mimeType).toBe('video/H264')
    expect(t.codecPrefs).toHaveLength(4)
  })

  it('withBitrateHints adds x-google bitrate params to H.264 fmtp lines only', () => {
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96 102 103',
      'a=rtpmap:96 VP8/90000',
      'a=rtpmap:102 H264/90000',
      'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
      'a=rtpmap:103 H264/90000',
      '',
    ].join('\r\n')
    const out = withBitrateHints(sdp, { minKbps: 1000, startKbps: 2000 })
    const lines = out.split('\r\n')
    expect(lines[4]).toBe(
      'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f;x-google-min-bitrate=1000;x-google-start-bitrate=2000',
    )
    // an H.264 payload without fmtp gets one; VP8 untouched
    expect(lines).toContain('a=fmtp:103 x-google-min-bitrate=1000;x-google-start-bitrate=2000')
    expect(out).not.toMatch(/fmtp:96/)
    expect(withBitrateHints(out, { minKbps: 1000, startKbps: 2000 })).toBe(out) // idempotent
  })
})

describe('onFrameBitmap hook (secondary screen source)', () => {
  it('delivers an UNSTAMPED snapshot of the source frame per frame id', async () => {
    const media = new FakeMedia()
    const got: Array<[number, any]> = []
    const env = media.env()
    // snapshot = copy of the source video frame at call time (createImageBitmap semantics)
    ;(env as any).createImageBitmap = async (src: any) => ({ snapshot: src.frame, close() {} })
    const h = await startCapture('card-1', { env, onFrameBitmap: (id, bm) => got.push([id, bm]) })
    media.emitFrames(3)
    await new Promise((r) => setTimeout(r, 0))
    h.stop()
    expect(got.map((g) => g[0])).toEqual([0, 1, 2])
    // the snapshot is the source frame itself: no marker rows were drawn into it
    expect(got[0][1].snapshot).toBe(media.frames[0])
    expect(got[2][1].snapshot).toBe(media.frames[2])
  })
  it('without createImageBitmap or hook nothing changes', async () => {
    const media = new FakeMedia()
    const h = await startCapture('card-1', { env: media.env() })
    media.emitFrames(2)
    h.stop()
    expect(h.frameCount).toBe(2)
  })
})

describe('capture format (C3)', () => {
  it('startCapture asks for 1080p30 by default (Chrome would otherwise open ~640x480)', async () => {
    const media = new FakeMedia()
    await capture(media)
    expect(media.gumCalls[0].video).toEqual({
      deviceId: { exact: 'card-1' },
      width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 },
    })
  })
  it('a stand override is passed through; preview and capture build identical constraints', async () => {
    const { videoConstraints } = await import('../src/capture/captureFormat')
    const media = new FakeMedia()
    handle = await startCapture('card-1', { env: media.env(), width: 1280, height: 720, fps: 60 })
    expect(media.gumCalls[0].video).toEqual(videoConstraints('card-1', { width: 1280, height: 720, fps: 60 }))
    expect(media.gumCalls[0].video).toMatchObject({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } })
    expect(videoConstraints('')).toEqual({ width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } })
  })
  it('negotiated settings and warnings', async () => {
    const { negotiatedOf, formatWarning, sanitizeFormat } = await import('../src/capture/captureFormat')
    const st = (s: object) => ({ getVideoTracks: () => [{ getSettings: () => s }] }) as unknown as MediaStream
    expect(negotiatedOf(st({ width: 1920, height: 1080, frameRate: 30 }))).toEqual({ width: 1920, height: 1080, fps: 30 })
    expect(negotiatedOf(st({}))).toBeNull()
    expect(formatWarning({ width: 1920, height: 1080, fps: 30 })).toBeNull()
    expect(formatWarning({ width: 1280, height: 720, fps: 30 })).toBeNull()
    expect(formatWarning({ width: 640, height: 480, fps: 30 })).toMatch(/< 1280/)
    expect(formatWarning({ width: 320, height: 240, fps: 30 })).toMatch(/< 640/)
    expect(sanitizeFormat({ width: 1280, height: 720, fps: 60 })).toEqual({ width: 1280, height: 720, fps: 60 })
    expect(sanitizeFormat({ width: 'x', fps: 1000 })).toEqual({ width: 1920, height: 1080, fps: 30 })
  })
})
