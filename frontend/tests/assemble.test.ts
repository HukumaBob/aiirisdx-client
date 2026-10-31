// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assembleContainer, containerFilename, type ContainerMeta } from '../src/container/assemble'
import { deliver } from '../src/container/deliver'
import { parseLog } from '../src/container/logParse'

const header = JSON.stringify({ type: 'header', schema_version: '1.0', session: { stand: 's1', started_at: '2026-10-30T10:00:00', uuid: 'u-1' }, doctor: 'Иванов', crop: null, models: {}, taxonomy_version: 't' })
const frame = (id: number, dropped = false) => JSON.stringify({ type: 'frame', frame_id: id, pts: id / 30, detections: [], classification: {}, dropped })
const footer = (complete: boolean, frames: number) => JSON.stringify({ type: 'footer', complete, frames })
const goodLog = [header, frame(0), frame(1), frame(2), footer(true, 3)].join('\n') + '\n'

const meta = (over: Partial<ContainerMeta> = {}): ContainerMeta => ({
  sessionId: 's1_20261030T100000_u-1', stand: 's1', startedAt: '2026-10-30T10:00:00', doctor: 'Иванов',
  crop: null, mimeType: 'video/mp4;codecs=avc1', recordingStartOffset: 0.5, errors: [], ...over,
})
const table = (ids: number[]) => ids.map((frameId) => ({ frameId, pts: frameId / 30 }))
const video = () => new Blob([new Uint8Array(1000).map((_, i) => i % 251)], { type: 'video/mp4' })

async function bytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer())
}
async function manifestOf(b: Blob): Promise<any> {
  return JSON.parse(pyRead(await bytes(b), 'manifest.json'))
}
/** independent reader: Python zipfile (also verifies CRCs via testzip) */
function pyRead(zip: Uint8Array, name: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'zipt-'))
  const p = join(dir, 'c.zip')
  writeFileSync(p, zip)
  const code = `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
n = sys.argv[2]
if n == '-': print('\\n'.join(f'{i.filename}:{i.file_size}:{i.compress_type}' for i in z.infolist()))
else: sys.stdout.buffer.write(z.read(n))`
  return execFileSync('python3', ['-I', '-c', code, p, name ?? '-'], { encoding: 'utf8', maxBuffer: 1 << 26 })
}

describe('test_zip_readable_by_independent_reader', () => {
  it('Python zipfile lists the entries, CRCs are valid, content is intact', async () => {
    const v = video()
    const z = await assembleContainer(v, table([0, 1, 2]), goodLog, meta())
    const zb = await bytes(z)
    expect(pyRead(zb, null).trim().split('\n')).toEqual([
      'video.mp4:1000:0', expect.stringMatching(/^frame_table\.json:\d+:0$/), expect.stringMatching(/^log\.jsonl:\d+:0$/), expect.stringMatching(/^manifest\.json:\d+:0$/),
    ])
    expect(pyRead(zb, 'log.jsonl')).toBe(goodLog)
    expect(JSON.parse(pyRead(zb, 'frame_table.json'))).toEqual(table([0, 1, 2]))
    const out = execFileSync('python3', ['-I', '-c', `import sys,zipfile,hashlib;sys.stdout.write(hashlib.sha256(zipfile.ZipFile(sys.argv[1]).read('video.mp4')).hexdigest())`, (() => { const d = mkdtempSync(join(tmpdir(), 'zipt-')); const p = join(d, 'c.zip'); writeFileSync(p, zb); return p })()], { encoding: 'utf8' })
    const { createHash } = await import('node:crypto')
    expect(out).toBe(createHash('sha256').update(await bytes(v)).digest('hex'))
  })
  it('webm recording gets video.webm; log null omits log.jsonl', async () => {
    const z = await assembleContainer(video(), table([0]), null, meta({ mimeType: 'video/webm;codecs=vp9' }))
    const names = pyRead(await bytes(z), null).trim().split('\n').map((l) => l.split(':')[0])
    expect(names).toEqual(['video.webm', 'frame_table.json', 'manifest.json'])
  })
})

describe('test_log_complete_detection_variants', () => {
  const body = [header, frame(0), frame(1)].join('\n')
  it('footer true => complete', () => expect(parseLog(`${body}\n${footer(true, 2)}\n`).complete).toBe(true))
  it('footer false => incomplete', () => expect(parseLog(`${body}\n${footer(false, 2)}\n`).complete).toBe(false))
  it('no footer => incomplete', () => expect(parseLog(`${body}\n`).complete).toBe(false))
  it('truncated last line => incomplete, earlier frames kept', () => {
    const r = parseLog(`${body}\n{"type":"frame","frame_id":2,"pt`)
    expect(r.complete).toBe(false)
    expect(r.frames.map((f) => f.frame_id)).toEqual([0, 1])
  })
  it('truncated footer => incomplete', () => expect(parseLog(`${body}\n{"type":"footer","comple`).complete).toBe(false))
  it('footer not last => incomplete', () => expect(parseLog(`${body}\n${footer(true, 2)}\n${frame(5)}\n`).complete).toBe(false))
  it('null / empty => incomplete', () => {
    expect(parseLog(null).complete).toBe(false)
    expect(parseLog('').complete).toBe(false)
  })
})

describe('test_manifest_marks_incomplete_log', () => {
  it('RF2: no footer -> log.complete=false, container still holds the recording', async () => {
    const trunc = [header, frame(0), frame(1)].join('\n') + '\n{"type":"fra'
    const z = await assembleContainer(video(), table([0, 1]), trunc, meta())
    const m = await manifestOf(z)
    expect(m.log).toMatchObject({ file: 'log.jsonl', complete: false, frames: 2 })
    expect(m.video.file).toBe('video.mp4')
    expect(m.errors.join(' ')).toMatch(/incomplete/)
  })
  it('null log: file null, complete false, error recorded', async () => {
    const m = await manifestOf(await assembleContainer(video(), table([0]), null, meta({ errors: ['server: down'] })))
    expect(m.log).toEqual({ file: null, complete: false, frames: null })
    expect(m.errors).toEqual(expect.arrayContaining(['server: down', expect.stringMatching(/log missing/)]))
  })
  it('complete log: complete=true, manifest shape', async () => {
    const m = await manifestOf(await assembleContainer(video(), table([0, 1, 2]), goodLog, meta()))
    expect(m).toMatchObject({
      schema_version: '1.0', container_version: '1',
      session: { stand: 's1', started_at: '2026-10-30T10:00:00', uuid: 'u-1', session_id: 's1_20261030T100000_u-1' },
      doctor: 'Иванов', crop: null,
      video: { file: 'video.mp4', mimeType: 'video/mp4;codecs=avc1', recording_start_offset: 0.5, frame_count: 3, frames_without_pts: [] },
      log: { file: 'log.jsonl', complete: true, frames: 3 }, errors: [],
    })
    expect(typeof m.created_at).toBe('string')
  })
})

describe('test_frame_table_covers_log_frame_ids', () => {
  it('non-dropped log frames without a pts are listed, never ignored; dropped ones are exempt', async () => {
    const log = [header, frame(0), frame(1), frame(2, true), frame(3), footer(true, 4)].join('\n')
    const m = await manifestOf(await assembleContainer(video(), table([0, 3]), log, meta()))
    expect(m.video.frames_without_pts).toEqual([1])
    expect(m.errors.join(' ')).toMatch(/frame_table_missing: \[1\]/)
  })
  it('full coverage -> empty list, no error', async () => {
    const m = await manifestOf(await assembleContainer(video(), table([0, 1, 2]), goodLog, meta()))
    expect(m.video.frames_without_pts).toEqual([])
    expect(m.errors).toEqual([])
  })
})

describe('test_no_patient_fields', () => {
  it('no manifest key (recursively) looks like patient data; doctor is the only free-form label', async () => {
    const m = await manifestOf(await assembleContainer(video(), table([0, 1, 2]), goodLog, meta({ crop: { x: 1, y: 2, w: 30, h: 40 } })))
    const keys: string[] = []
    const walk = (o: unknown) => {
      if (Array.isArray(o)) o.forEach(walk)
      else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { keys.push(k); walk(v) }
    }
    walk(m)
    expect(keys.length).toBeGreaterThan(10)
    const bad = /patient|birth|dob|mrn|ssn|snils|polis|passport|address|phone|fio|surname|first_?name|last_?name|^name$|gender|sex|age/i
    expect(keys.filter((k) => bad.test(k))).toEqual([])
    expect(Object.keys(m).sort()).toEqual(['container_version', 'created_at', 'crop', 'doctor', 'errors', 'log', 'schema_version', 'session', 'video'])
  })
})

describe('test_filename_has_no_doctor_name', () => {
  it('filename is <session_id>.zip', () => {
    expect(containerFilename(meta({ doctor: 'Иванов Иван' }))).toBe('s1_20261030T100000_u-1.zip')
  })
  it('sanitizes odd characters and never contains the doctor', () => {
    const f = containerFilename(meta({ sessionId: null, stand: 's1', doctor: 'Иванов' }))
    expect(f).toMatch(/^s1_\d{8}T\d{6}_[A-Za-z0-9-]+\.zip$/)
    expect(f).not.toContain('Иванов')
  })
})

describe('deliver', () => {
  const blob = new Blob(['zip'], { type: 'application/zip' })
  const ok = () => ({ ok: true, status: 200 }) as Response
  it('test_deliver_retries_then_keeps_file: 3 retries (4 attempts), then fallback save, delivered=false', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503 }) as Response)
    const save = vi.fn()
    const r = await deliver(blob, 'http://emr/x', { fetch: f as never, backoffMs: 1, filename: 'a.zip', onFallbackSave: save })
    expect(f).toHaveBeenCalledTimes(4)
    expect(r.delivered).toBe(false)
    expect(r.error).toMatch(/503/)
    expect(save).toHaveBeenCalledWith(blob, 'a.zip')
  })
  it('success after a failure: headers + no fallback', async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError('net')).mockResolvedValueOnce(ok())
    const save = vi.fn()
    const r = await deliver(blob, 'http://emr/x', { fetch: f as never, backoffMs: 1, filename: 'S1.zip', sessionId: 'S1', onFallbackSave: save })
    expect(r).toEqual({ delivered: true })
    expect(save).not.toHaveBeenCalled()
    const [url, init] = f.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('http://emr/x')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/zip', 'X-Session-Id': 'S1' })
    expect(init.body).toBe(blob)
  })
  it('backoff is exponential', async () => {
    vi.useFakeTimers()
    const f = vi.fn(async () => ({ ok: false, status: 500 }) as Response)
    const p = deliver(blob, 'u', { fetch: f as never, retries: 2, backoffMs: 100, filename: 'a.zip', onFallbackSave: () => {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(f).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(f).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(f).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(f).toHaveBeenCalledTimes(3)
    await p
    vi.useRealTimers()
  })
  it('test_deliver_never_throws: fetch throws, save throws, empty url', async () => {
    const f = vi.fn(async () => { throw new Error('boom') })
    const r = await deliver(blob, 'u', { fetch: f as never, retries: 1, backoffMs: 1, filename: 'a.zip', onFallbackSave: () => { throw new Error('disk') } })
    expect(r.delivered).toBe(false)
    expect(r.error).toMatch(/boom/)
    expect(r.error).toMatch(/disk/)
    await expect(deliver(blob, '', { filename: 'a.zip', onFallbackSave: () => {} })).resolves.toMatchObject({ delivered: false })
  })
  it('timeout aborts a hanging request via AbortController', async () => {
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))))
    const save = vi.fn()
    const r = await deliver(blob, 'u', { fetch: f as never, retries: 0, timeoutMs: 20, filename: 'a.zip', onFallbackSave: save })
    expect(r.delivered).toBe(false)
    expect(save).toHaveBeenCalled()
  })
})

describe('buildAndDeliver', () => {
  const fin = (over: object = {}) => ({
    video: video(), mimeType: 'video/webm', frameTable: table([0, 1, 2]), recordingStartOffset: 0, log: goodLog,
    sessionMeta: { sessionId: 's1_20261030T100000_u-1', stand: 's1', doctor: 'Иванов', mode: 'live', crop: null, startedAt: '2026-10-30T10:00:00', stoppedAt: '', framesSent: 3, framesReceived: 3, serverFrames: 3 },
    error: null, recorderError: null, ...over,
  }) as never
  it('server lost: log null -> container still built, logComplete false, saved without EMR url', async () => {
    const { buildAndDeliver } = await import('../src/container/finish')
    const r = await buildAndDeliver(fin({ log: null, error: 'server: down' }), '')
    expect(r).toMatchObject({ delivery: 'saved', logComplete: false, filename: 's1_20261030T100000_u-1.zip' })
    expect((await manifestOf(r.blob!)).errors).toEqual(expect.arrayContaining(['server: down']))
  })
  it('delivery failure reports failed and keeps the blob', async () => {
    const { buildAndDeliver } = await import('../src/container/finish')
    const save = vi.fn()
    const f = vi.fn(async () => ({ ok: false, status: 500 }) as Response)
    const r = await buildAndDeliver(fin(), 'http://emr', { fetch: f as never, retries: 0, onFallbackSave: save })
    expect(r).toMatchObject({ delivery: 'failed', logComplete: true })
    expect(r.blob).not.toBeNull()
    expect(save).toHaveBeenCalled()
  })
})
