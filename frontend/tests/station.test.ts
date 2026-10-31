import { describe, expect, it, vi } from 'vitest'
import { contentRect, cropFromDrag, frameToScreen, rectFromPoints, screenToFrame, validateCrop } from '../src/station/cropRect'
import { DEFAULT_DOCTOR_PROFILE, migrate, safeStorage, StationStore, STORAGE_KEY, type SafeStorage } from '../src/station/profiles'
import { canStart, SERVER_LOST_MSG, SessionFlow, type FlowDeps, type StartParams } from '../src/station/sessionFlow'

// ---------------------------------------------------------------- crop
describe('test_crop_rect_validation', () => {
  it('accepts a rect inside the frame (rounded to integers)', () => {
    const r = validateCrop({ x: 10.4, y: 20.4, w: 100.2, h: 50.2 }, 1920, 1080)
    expect(r).toEqual({ ok: true, rect: { x: 10, y: 20, w: 101, h: 51 } }) // edges are rounded
  })
  it('accepts the full frame and a rect touching the edges', () => {
    expect(validateCrop({ x: 0, y: 0, w: 1920, h: 1080 }, 1920, 1080).ok).toBe(true)
    expect(validateCrop({ x: 1904, y: 1064, w: 16, h: 16 }, 1920, 1080).ok).toBe(true)
  })
  it('rejects zero-size', () => {
    expect(validateCrop({ x: 5, y: 5, w: 0, h: 50 }, 100, 100)).toMatchObject({ ok: false, reason: 'empty' })
    expect(validateCrop({ x: 5, y: 5, w: 50, h: 0 }, 100, 100)).toMatchObject({ ok: false, reason: 'empty' })
  })
  it('rejects below the minimum size 16x16', () => {
    expect(validateCrop({ x: 0, y: 0, w: 15, h: 50 }, 100, 100)).toMatchObject({ ok: false, reason: 'min-size' })
    expect(validateCrop({ x: 0, y: 0, w: 50, h: 15 }, 100, 100)).toMatchObject({ ok: false, reason: 'min-size' })
    expect(validateCrop({ x: 0, y: 0, w: 16, h: 16 }, 100, 100).ok).toBe(true)
  })
  it('rejects outside the frame', () => {
    expect(validateCrop({ x: -1, y: 0, w: 50, h: 50 }, 100, 100)).toMatchObject({ ok: false, reason: 'outside-frame' })
    expect(validateCrop({ x: 60, y: 0, w: 50, h: 50 }, 100, 100)).toMatchObject({ ok: false, reason: 'outside-frame' })
    expect(validateCrop({ x: 0, y: 60, w: 50, h: 50 }, 100, 100)).toMatchObject({ ok: false, reason: 'outside-frame' })
  })
  it('rejects negative size and NaN; a drag in any direction is ordered', () => {
    expect(validateCrop({ x: 50, y: 50, w: -20, h: 30 }, 100, 100)).toMatchObject({ ok: false, reason: 'negative-size' })
    expect(validateCrop({ x: NaN, y: 0, w: 30, h: 30 }, 100, 100)).toMatchObject({ ok: false, reason: 'not-finite' })
    expect(rectFromPoints({ x: 80, y: 90 }, { x: 20, y: 10 })).toEqual({ x: 20, y: 10, w: 60, h: 80 })
  })
})

describe('test_screen_to_frame_mapping_with_letterbox', () => {
  // 1920x1080 (16:9) frame shown in a 1000x1000 element: picture 1000x562.5, bars top/bottom
  const box = { w: 1000, h: 1000 }
  const frame = { w: 1920, h: 1080 }
  it('contentRect letterboxes (wide frame in square box) and pillarboxes (tall frame)', () => {
    expect(contentRect(box, frame)).toEqual({ x: 0, y: 218.75, w: 1000, h: 562.5 })
    expect(contentRect({ w: 1000, h: 500 }, { w: 500, h: 500 })).toEqual({ x: 250, y: 0, w: 500, h: 500 })
  })
  it('maps the picture corners and centre to original frame pixels', () => {
    expect(screenToFrame({ x: 0, y: 218.75 }, box, frame)).toMatchObject({ x: 0, y: 0, inside: true })
    expect(screenToFrame({ x: 1000, y: 781.25 }, box, frame)).toMatchObject({ x: 1920, y: 1080, inside: true })
    const c = screenToFrame({ x: 500, y: 500 }, box, frame)
    expect(c.x).toBeCloseTo(960)
    expect(c.y).toBeCloseTo(540)
  })
  it('clamps points in the bars to the picture edge and flags them', () => {
    expect(screenToFrame({ x: 500, y: 10 }, box, frame)).toMatchObject({ y: 0, inside: false })
    expect(screenToFrame({ x: 500, y: 990 }, box, frame)).toMatchObject({ y: 1080, inside: false })
  })
  it('pillarbox: x offset is removed', () => {
    const p = screenToFrame({ x: 250 + 125, y: 250 }, { w: 1000, h: 500 }, { w: 500, h: 500 })
    expect(p).toMatchObject({ x: 125, y: 250, inside: true })
  })
  it('round-trips with frameToScreen and drag -> validated crop in ORIGINAL pixels', () => {
    const r = cropFromDrag({ x: 100, y: 300 }, { x: 600, y: 600 }, box, frame)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = frameToScreen(r.rect, box, frame)
    expect(s.left).toBeCloseTo(100, 0)
    expect(s.top).toBeCloseTo(300, 0)
    expect(s.width).toBeCloseTo(500, 0)
    expect(r.rect.w).toBe(Math.round(500 * 1.92))
  })
  it('drag inside the bars only is rejected (empty)', () => {
    expect(cropFromDrag({ x: 10, y: 10 }, { x: 900, y: 100 }, box, frame).ok).toBe(false)
  })
})

// ---------------------------------------------------------------- profiles
function memStorage(): SafeStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => (map.set(k, v), true),
    remove: (k) => map.delete(k),
  }
}

describe('test_profile_thresholds_loaded_for_doctor', () => {
  it('defaults: 0.5 / sound on / 1000 ms', () => {
    const s = new StationStore(memStorage())
    s.addDoctor('Иванов')
    expect(s.getProfile('Иванов')).toEqual({ alertThreshold: 0.5, soundEnabled: true, bufferDelayMs: 1000 })
    expect(DEFAULT_DOCTOR_PROFILE.alertThreshold).toBe(0.5)
  })
  it('each doctor keeps his own thresholds across reloads; add/remove without password', () => {
    const st = memStorage()
    const a = new StationStore(st)
    a.setStand('stand-1')
    a.addDoctor('Иванов')
    a.addDoctor('  Петров ')
    a.setProfile('Иванов', { alertThreshold: 0.7, soundEnabled: false, bufferDelayMs: 2500 })
    a.setLastDoctor('Петров')
    const b = new StationStore(st)
    expect(b.stand).toBe('stand-1')
    expect(b.doctors).toEqual(['Иванов', 'Петров'])
    expect(b.getProfile('Иванов')).toEqual({ alertThreshold: 0.7, soundEnabled: false, bufferDelayMs: 2500 })
    expect(b.getProfile('Петров').alertThreshold).toBe(0.5)
    expect(b.lastDoctor).toBe('Петров')
    b.removeDoctor('Иванов')
    expect(new StationStore(st).doctors).toEqual(['Петров'])
    expect(b.addDoctor('Петров')).toBeNull() // duplicate
    expect(b.addDoctor('   ')).toBeNull()
  })
  it('sanitises out-of-range / corrupt values and migrates the v0 shape', () => {
    const d = migrate(JSON.stringify({ doctors: [{ name: 'A', alertThreshold: 7, bufferDelayMs: 'x' }, 'B', 5, { name: 'A' }] }))
    expect(d.doctors).toEqual(['A', 'B'])
    expect(d.profiles.A).toEqual({ alertThreshold: 1, soundEnabled: true, bufferDelayMs: 1000 })
    expect(migrate('{not json').doctors).toEqual([])
    expect(migrate(null).version).toBe(1)
  })
})

describe('test_profiles_survive_unavailable_storage', () => {
  it('getter that throws: reads give defaults, the store works in memory', () => {
    const st = safeStorage(() => {
      throw new Error('SecurityError')
    })
    expect(st.get('x')).toBeNull()
    expect(st.set('x', 'y')).toBe(false)
    expect(st.remove('x')).toBe(false)
    const s = new StationStore(st)
    expect(() => s.addDoctor('Иванов')).not.toThrow()
    s.setProfile('Иванов', { alertThreshold: 0.8 })
    s.setStand('s1')
    expect(s.getProfile('Иванов').alertThreshold).toBe(0.8)
    expect(s.stand).toBe('s1')
    expect(s.persisted).toBe(false)
  })
  it('setItem throwing (quota) does not throw out of the store', () => {
    const bad = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded') }, removeItem: () => {} } as unknown as Storage
    const s = new StationStore(safeStorage(() => bad))
    s.addDoctor('A')
    expect(s.doctors).toEqual(['A'])
    expect(s.persisted).toBe(false)
  })
  it('keeps the stand token across reloads', () => {
    const st = memStorage()
    new StationStore(st).setToken('  t0k ')
    expect(new StationStore(st).token).toBe('t0k')
  })
  it('uses the real key', () => {
    const st = memStorage()
    new StationStore(st).setStand('x')
    expect(st.map.has(STORAGE_KEY)).toBe(true)
  })
})

// ---------------------------------------------------------------- session flow
const params = (o: Partial<StartParams> = {}): StartParams => ({
  stand: 'stand-1',
  doctor: 'Иванов',
  deviceId: 'cam1',
  mode: 'live',
  crop: null,
  profile: { alertThreshold: 0.5, soundEnabled: true, bufferDelayMs: 1500 },
  ...o,
})

function setup(opts: { fetchImpl?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  const calls: { url: string; method: string; body?: unknown; headers?: Record<string, string> }[] = []
  const json = (b: unknown, ok = true, status = 200) => ({ ok, status, json: async () => b, text: async () => '' }) as unknown as Response
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> })
    if (opts.fetchImpl) return opts.fetchImpl(url, init)
    if (url.endsWith('/sessions')) return json({ session_id: 'stand-1_20260101T000000_abc' })
    if (url.endsWith('/offer')) return json({ sdp: 'ANSWER', type: 'answer' })
    if (url.endsWith('/stop')) return json({ frames: 42 })
    if (url.endsWith('/log')) return { ok: true, status: 200, text: async () => '{"header":1}\n{"frame":0}\n' } as unknown as Response
    if (url.endsWith('/file')) return json({ started: true })
    throw new Error('unexpected ' + url)
  })
  const recorder = {
    start: vi.fn(),
    stop: vi.fn(async () => ({ videoBlob: new Blob(['v']), mimeType: 'video/webm', frameTable: [{ frameId: 0, pts: 0 }], recordingStartOffset: 0, crop: null })),
  }
  const handle = { sendStream: { id: 'send' }, sourceStream: {}, localRecorder: recorder, width: 1920, height: 1080, fps: 30, frameCount: 5, stop: vi.fn() }
  let captureOpts: { onFrameBitmap?: (id: number, bm: ImageBitmap) => void } = {}
  const startCapture = vi.fn(async (_d: string, o: typeof captureOpts) => ((captureOpts = o), handle))
  let lost: ((s: string) => void) | undefined
  const connections: { close: ReturnType<typeof vi.fn> }[] = []
  const connectSendStream = vi.fn(async (_s: unknown, signal: (o: { type: string; sdp: string }) => Promise<unknown>, o: { onConnectionLost?: (s: string) => void }) => {
    lost = o.onConnectionLost
    await signal({ type: 'offer', sdp: 'OFFER' })
    const c = { pc: {}, sender: {}, close: vi.fn() }
    connections.push(c)
    return c
  })
  const buffer = { pushFrame: vi.fn(), pushResult: vi.fn(), setDelay: vi.fn(), onReady: vi.fn(() => () => {}), dispose: vi.fn(), stats: {} }
  const createBuffer = vi.fn(() => buffer)
  const resizeBitmap = vi.fn(async (bm: { width: number }, w: number) => ({ width: w, height: 540, close: vi.fn(), from: bm }))
  const sockets: FakeWS[] = []
  class FakeWS {
    onopen: (() => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    onclose: ((e: { code: number }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(public url: string) {
      sockets.push(this)
    }
    close() {}
  }
  // loadRtcConfig stubbed so the REST call sequence below stays create/offer/stop/log
  const deps = { fetch: fetchImpl, startCapture, connectSendStream, createBuffer, resizeBitmap, WebSocket: FakeWS, base: '/api', wsBase: 'ws://h/api', loadRtcConfig: async () => undefined } as unknown as FlowDeps
  return { deps, calls, fetchImpl, handle, recorder, startCapture, connectSendStream, connections, buffer, createBuffer, resizeBitmap, sockets, captureOpts: () => captureOpts, lost: (s: string) => lost?.(s) }
}

describe('test_start_requires_stand_and_doctor', () => {
  it('canStart lists the missing pieces', () => {
    expect(canStart(params({ stand: '', doctor: '' }))).toEqual({ ok: false, reasons: ['stand', 'doctor'] })
    expect(canStart(params({ stand: 'a_b' })).reasons).toEqual(['stand']) // '_' is not allowed by the server
    expect(canStart(params({ doctor: '  ' })).reasons).toEqual(['doctor'])
    expect(canStart(params({ mode: 'file', filePath: '' })).reasons).toEqual(['file'])
    expect(canStart(params()).ok).toBe(true)
  })
  it('start() with no stand / no doctor rejects without touching the network or the camera', async () => {
    const t = setup()
    const flow = new SessionFlow(t.deps)
    await expect(flow.start(params({ stand: '' }))).rejects.toThrow(/stand/)
    await expect(flow.start(params({ doctor: '' }))).rejects.toThrow(/doctor/)
    expect(t.fetchImpl).not.toHaveBeenCalled()
    expect(t.startCapture).not.toHaveBeenCalled()
  })
})

describe('session flow', () => {
  it('start: createSession(stand, doctor, crop) -> capture -> recorder(crop) -> offer -> results ws', async () => {
    const t = setup()
    const flow = new SessionFlow(t.deps)
    const crop = { x: 10, y: 20, w: 300, h: 200 }
    await flow.start(params({ crop }))
    expect(t.calls[0]).toMatchObject({ url: '/api/sessions', method: 'POST', body: { stand: 'stand-1', doctor: 'Иванов', crop } })
    expect(t.startCapture).toHaveBeenCalledOnce()
    expect(t.recorder.start).toHaveBeenCalledWith(crop)
    expect(t.calls.find((c) => c.url.endsWith('/offer'))).toMatchObject({ url: '/api/sessions/stand-1_20260101T000000_abc/offer', body: { sdp: 'OFFER', type: 'offer' } })
    expect(t.sockets[0].url).toBe('ws://h/api/sessions/stand-1_20260101T000000_abc/results')
    expect(flow.getStatus()).toMatchObject({ state: 'running', connection: 'connected', sessionId: 'stand-1_20260101T000000_abc' })
  })

  it('an invalid crop is refused before recording starts', async () => {
    const t = setup()
    const flow = new SessionFlow(t.deps)
    await expect(flow.start(params({ crop: { x: 1900, y: 0, w: 100, h: 100 } }))).rejects.toThrow(/crop/)
    expect(t.handle.stop).toHaveBeenCalled()
    expect(t.recorder.start).not.toHaveBeenCalled()
  })

  it('X-Stand-Token header is sent when a token is set', async () => {
    const t = setup()
    const flow = new SessionFlow({ ...t.deps, token: 'tok' })
    await flow.start(params())
    expect(t.calls[0].headers).toMatchObject({ 'X-Stand-Token': 'tok' })
  })

  it('encoder framesSent (outbound-rtp) is reported separately from stamped frames', async () => {
    const t = setup()
    let framesSent = 7
    const stats = () => ({ forEach: (cb: (r: Record<string, unknown>) => void) => [{ type: 'outbound-rtp', kind: 'video', framesSent }, { type: 'outbound-rtp', kind: 'audio', framesSent: 99 }].forEach(cb) })
    t.connectSendStream.mockImplementation(async (_s: unknown, signal: (o: { type: string; sdp: string }) => Promise<unknown>) => {
      await signal({ type: 'offer', sdp: 'OFFER' })
      return { pc: { getStats: async () => stats() }, sender: {}, close: vi.fn() }
    })
    const flow = new SessionFlow(t.deps)
    await flow.start(params())
    expect(flow.getStatus()).toMatchObject({ sent: 5, encoderSent: null }) // no poll yet
    framesSent = 4
    const fin = await flow.stop()
    expect(fin.sessionMeta).toMatchObject({ framesSent: 5, framesEncoderSent: 4 })
  })

  it('encoderSent stays null when the connection has no stats', async () => {
    const t = setup()
    const flow = new SessionFlow(t.deps)
    await flow.start(params())
    const fin = await flow.stop()
    expect(fin.sessionMeta.framesEncoderSent).toBeNull()
    expect(flow.getStatus().encoderSent).toBeNull()
  })

  it('a token in the start params wins over deps.token (header and results ws)', async () => {
    const t = setup()
    const flow = new SessionFlow({ ...t.deps, token: 'old' })
    await flow.start(params({ token: ' stand-tok ' }))
    expect(t.calls[0].headers).toMatchObject({ 'X-Stand-Token': 'stand-tok' })
    expect(t.calls.find((c) => c.url.endsWith('/offer'))?.headers).toMatchObject({ 'X-Stand-Token': 'stand-tok' })
  })

  it('default ICE config: GET /client-config -> RTCConfiguration for the send connection', async () => {
    const ice = [{ urls: ['turn:t.example:3478'], username: '1:stand', credential: 'c' }]
    const t = setup({
      fetchImpl: async (url) => {
        const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response
        if (url.includes('/client-config')) return json({ ice_servers: ice, require_token: false })
        if (url.endsWith('/sessions')) return json({ session_id: 'stand-1_20260101T000000_abc' })
        return json({ sdp: 'ANSWER', type: 'answer' })
      },
    })
    const { loadRtcConfig: _drop, ...deps } = t.deps
    void _drop
    await new SessionFlow(deps as FlowDeps).start(params({ token: 'tok-1' }))
    const cc = t.calls.find((c) => c.url.includes('/client-config'))
    expect(cc?.url).toBe('/api/client-config?stand=stand-1') // stand + token authorize TURN
    expect(cc?.headers).toMatchObject({ 'X-Stand-Token': 'tok-1' })
    expect(t.connectSendStream.mock.calls[0][2]).toMatchObject({ configuration: { iceServers: ice } })
  })

  it('client-config unavailable -> connects with browser defaults', async () => {
    const t = setup({
      fetchImpl: async (url) => {
        const json = (b: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => b }) as unknown as Response
        if (url.includes('/client-config')) return json({}, false)
        if (url.endsWith('/sessions')) return json({ session_id: 'stand-1_20260101T000000_abc' })
        return json({ sdp: 'ANSWER', type: 'answer' })
      },
    })
    const { loadRtcConfig: _drop, ...deps } = t.deps
    void _drop
    const flow = new SessionFlow(deps as FlowDeps)
    await flow.start(params())
    expect(t.connectSendStream.mock.calls[0][2]).toMatchObject({ configuration: undefined })
    expect(flow.getStatus().connection).toBe('connected')
  })

  it('file mode: createSession -> POST /file {path, realtime}, no capture', async () => {
    const t = setup()
    const flow = new SessionFlow(t.deps)
    await flow.start(params({ mode: 'file', filePath: 'a/b.mp4', realtime: false }))
    expect(t.startCapture).not.toHaveBeenCalled()
    expect(t.calls.find((c) => c.url.endsWith('/file'))).toMatchObject({ body: { path: 'a/b.mp4', realtime: false } })
    const fin = await flow.stop()
    expect(fin.video).toBeNull()
    expect(fin.log).toContain('header')
  })

  it('stop: stops recorder, POST /stop, GET /log, hands the recording to onFinished', async () => {
    const t = setup()
    const onFinished = vi.fn()
    const flow = new SessionFlow(t.deps, { onFinished })
    await flow.start(params())
    const fin = await flow.stop()
    expect(t.recorder.stop).toHaveBeenCalled()
    const order = t.calls.map((c) => c.url.replace('/api/sessions/stand-1_20260101T000000_abc', '').replace('/api/sessions', 'create'))
    expect(order).toEqual(['create', '/offer', '/stop', '/log'])
    expect(fin.video).toBeInstanceOf(Blob)
    expect(fin.frameTable).toEqual([{ frameId: 0, pts: 0 }])
    expect(fin.log).toBe('{"header":1}\n{"frame":0}\n')
    expect(fin.error).toBeNull()
    expect(fin.sessionMeta).toMatchObject({ sessionId: 'stand-1_20260101T000000_abc', stand: 'stand-1', doctor: 'Иванов', mode: 'live' })
    expect(onFinished).toHaveBeenCalledWith(fin)
    expect(t.buffer.dispose).toHaveBeenCalled()
    expect(flow.getStatus().state).toBe('finished')
  })

  it('test_session_flow_stop_returns_recording_when_server_down', async () => {
    const down = async () => {
      throw new TypeError('Failed to fetch')
    }
    const t = setup({ fetchImpl: down })
    const onFinished = vi.fn()
    const flow = new SessionFlow(t.deps, { onFinished })
    await flow.start(params()) // even the very first POST fails: the recorder still runs
    expect(t.recorder.start).toHaveBeenCalled()
    expect(flow.getStatus()).toMatchObject({ state: 'server-lost', message: SERVER_LOST_MSG })
    expect(SERVER_LOST_MSG).toBe('server lost — recording continues')
    const fin = await flow.stop()
    expect(fin.video).toBeInstanceOf(Blob)
    expect(fin.frameTable).toHaveLength(1)
    expect(fin.log).toBeNull()
    expect(fin.error).toMatch(/Failed to fetch|server/)
    expect(onFinished).toHaveBeenCalledWith(fin)
  })

  it('stop: /stop ok but /log fails -> recording kept, log=null, error set', async () => {
    const t = setup({
      fetchImpl: async (url) => {
        if (url.endsWith('/log')) return { ok: false, status: 500, text: async () => '' } as Response
        if (url.endsWith('/sessions')) return { ok: true, status: 200, json: async () => ({ session_id: 'S' }) } as Response
        if (url.endsWith('/offer')) return { ok: true, status: 200, json: async () => ({ sdp: 'A', type: 'answer' }) } as Response
        return { ok: true, status: 200, json: async () => ({ frames: 1 }) } as Response
      },
    })
    const flow = new SessionFlow(t.deps)
    await flow.start(params())
    const fin = await flow.stop()
    expect(fin.video).toBeInstanceOf(Blob)
    expect(fin.log).toBeNull()
    expect(fin.error).toMatch(/log/)
  })

  it('connection loss keeps recording; reconnect re-offers on the SAME session with the SAME capture', async () => {
    const t = setup()
    const flow = new SessionFlow(t.deps)
    await flow.start(params())
    t.lost('failed')
    expect(flow.getStatus()).toMatchObject({ state: 'server-lost', connection: 'lost', message: SERVER_LOST_MSG })
    expect(t.recorder.stop).not.toHaveBeenCalled()
    await flow.reconnect()
    expect(t.startCapture).toHaveBeenCalledOnce()
    expect(t.connectSendStream).toHaveBeenCalledTimes(2)
    expect(t.connectSendStream.mock.calls[0][0]).toBe(t.connectSendStream.mock.calls[1][0]) // same sendStream
    expect(t.connections[0].close).toHaveBeenCalled()
    const offers = t.calls.filter((c) => c.url.endsWith('/offer'))
    expect(offers).toHaveLength(2)
    expect(offers[0].url).toBe(offers[1].url)
    expect(t.calls.filter((c) => c.url.endsWith('/sessions') && c.method === 'POST')).toHaveLength(1)
    expect(flow.getStatus()).toMatchObject({ state: 'running', connection: 'connected' })
  })

  it('reconnect after the session could not be created creates it, same capture', async () => {
    let n = 0
    const t = setup({
      fetchImpl: async (url) => {
        if (url.endsWith('/sessions') && n++ === 0) throw new TypeError('down')
        if (url.endsWith('/sessions')) return { ok: true, status: 200, json: async () => ({ session_id: 'S2' }) } as Response
        return { ok: true, status: 200, json: async () => ({ sdp: 'A', type: 'answer' }) } as Response
      },
    })
    const flow = new SessionFlow(t.deps)
    await flow.start(params())
    expect(flow.getStatus().sessionId).toBeNull()
    await flow.reconnect()
    expect(t.startCapture).toHaveBeenCalledOnce()
    expect(flow.getStatus()).toMatchObject({ state: 'running', sessionId: 'S2' })
  })
})

describe('test_secondary_buffer_gets_downscaled_bitmaps_and_profile_delay', () => {
  it('buffer is created with the profile delay and capture fps; frames are downscaled to 960 and the original closed', async () => {
    const t = setup()
    const flow = new SessionFlow(t.deps)
    await flow.start(params())
    expect(t.createBuffer).toHaveBeenCalledWith(1500, expect.any(Number), 30) // delay from profile, fps upper bound
    const orig = { width: 1920, height: 1080, close: vi.fn() } as unknown as ImageBitmap
    t.captureOpts().onFrameBitmap!(7, orig)
    await vi.waitFor(() => expect(t.buffer.pushFrame).toHaveBeenCalled())
    expect(t.resizeBitmap).toHaveBeenCalledWith(orig, 960)
    const [id, bm] = t.buffer.pushFrame.mock.calls[0] as unknown as [number, { width: number }]
    expect(id).toBe(7)
    expect(bm.width).toBe(960)
    expect(bm).not.toBe(orig)
    expect(orig.close).toHaveBeenCalled()
  })
  it('keeps frame order even if resizes finish out of order; small bitmaps pass through', async () => {
    const t = setup()
    const rel: (() => void)[] = []
    ;(t.deps as unknown as { resizeBitmap: unknown }).resizeBitmap = (bm: { width: number; id: number }) =>
      new Promise((r) => rel.push(() => r({ width: 960, id: bm.id, close() {} })))
    const flow = new SessionFlow(t.deps)
    await flow.start(params())
    t.captureOpts().onFrameBitmap!(1, { width: 1920, id: 1, close() {} } as unknown as ImageBitmap)
    t.captureOpts().onFrameBitmap!(2, { width: 1920, id: 2, close() {} } as unknown as ImageBitmap)
    rel[1]() // 2 finishes first
    await Promise.resolve()
    expect(t.buffer.pushFrame).not.toHaveBeenCalled()
    rel[0]()
    await vi.waitFor(() => expect(t.buffer.pushFrame).toHaveBeenCalledTimes(2))
    expect(t.buffer.pushFrame.mock.calls.map((c) => c[0])).toEqual([1, 2])
  })
  it('unknown capture fps -> 60 upper bound; setDelay forwards to the buffer; results go to the buffer', async () => {
    const t = setup()
    t.handle.fps = 0
    const flow = new SessionFlow(t.deps)
    await flow.start(params())
    expect(t.createBuffer).toHaveBeenCalledWith(1500, expect.any(Number), 60)
    flow.setDelay(2200)
    expect(t.buffer.setDelay).toHaveBeenCalledWith(2200)
    t.sockets[0].onmessage?.({ data: JSON.stringify({ frame_id: 3, pts: 0, dropped: true, detections: [], classification: {}, anatomy: null }) })
    expect(t.buffer.pushResult).toHaveBeenCalledWith(3, expect.objectContaining({ frame_id: 3 }))
    expect(flow.getStatus()).toMatchObject({ received: 1, dropped: 1 })
  })
})
