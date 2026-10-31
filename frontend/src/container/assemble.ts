/**
 * Result container (spec §6): a ZIP assembled AT THE STAND from the local recording, the frame
 * table and the server's JSON-lines log.
 *
 *   video.<mp4|webm>   recording of the ORIGINAL signal (no burned-in boxes)
 *   frame_table.json   [{frameId, pts}] frame id -> pts in the recording timeline
 *   log.jsonl          server log (omitted when it could not be fetched)
 *   manifest.json      versioned description; NO patient data, only stand/time/uuid + the
 *                      doctor label (the single allowed free-form field)
 *
 * The container is assembled even if the server was lost (RF2): `log.complete` says whether
 * the log is whole (derived by parsing it), and every problem goes to `errors`.
 * Frames present (not dropped) in the log but with no pts in the frame table are listed in
 * `video.frames_without_pts` and in an `errors` entry `frame_table_missing: [ids]`.
 */
import type { CropRect } from '../capture/localRecorder'
import { parseLog } from './logParse'
import { createZip } from './zip'

export const MANIFEST_SCHEMA_VERSION = '1.0'
export const CONTAINER_VERSION = '1'

export interface ContainerMeta {
  /** server session id `<stand>_<YYYYmmddTHHMMSS>_<uuid>`; null if the server never created one */
  sessionId: string | null
  stand: string
  startedAt: string
  /** free-form doctor label (not a patient identifier) or null */
  doctor: string | null
  crop: CropRect | null
  mimeType: string | null
  recordingStartOffset: number
  /** problems met so far (recorder error, /stop failure, ...) */
  errors: string[]
  createdAt?: string
}

const SAFE = /[^A-Za-z0-9-]/g
const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\..*$/, '').replace(/Z$/, '').slice(0, 15)

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
}

/** [stand, time, uuid] of the session; synthesized locally if the server gave no id */
function sessionParts(meta: ContainerMeta): { stand: string; time: string; uuid: string; id: string } {
  if (meta.sessionId) {
    const m = /^(.*)_(\d{8}T\d{6})_(.+)$/.exec(meta.sessionId)
    if (m) return { stand: m[1], time: m[2], uuid: m[3], id: meta.sessionId }
  }
  const stand = meta.stand.replace(SAFE, '') || 'stand'
  const time = stamp(meta.startedAt).padEnd(15, '0').slice(0, 15)
  const uuid = randomId().replace(SAFE, '')
  return { stand, time, uuid, id: `${stand}_${time}_${uuid}` }
}

const sessionCache = new WeakMap<ContainerMeta, ReturnType<typeof sessionParts>>()
function partsOf(meta: ContainerMeta) {
  let p = sessionCache.get(meta)
  if (!p) sessionCache.set(meta, (p = sessionParts(meta)))
  return p
}

/** `<session_id>.zip` -- never contains the doctor's name */
export function containerFilename(meta: ContainerMeta): string {
  return `${partsOf(meta).id.replace(/[^A-Za-z0-9_-]/g, '')}.zip`
}

export function videoExt(mimeType: string | null): 'mp4' | 'webm' {
  return /mp4/i.test(mimeType ?? '') ? 'mp4' : 'webm'
}

export async function assembleContainer(
  video: Blob,
  frameTable: { frameId: number; pts: number }[],
  log: string | null,
  meta: ContainerMeta,
): Promise<Blob> {
  const sp = partsOf(meta)
  const errors = [...meta.errors]
  const videoFile = `video.${videoExt(meta.mimeType ?? video.type)}`
  const parsed = parseLog(log)

  const have = new Set(frameTable.map((f) => f.frameId))
  const without = log === null ? [] : parsed.frames.filter((f) => !f.dropped && !have.has(f.frame_id)).map((f) => f.frame_id)
  if (log === null) errors.push('log missing: server log could not be fetched')
  else if (!parsed.complete) errors.push('log incomplete: no valid closing footer (server lost mid-session or log truncated)')
  if (without.length) errors.push(`frame_table_missing: [${without.join(', ')}]`)

  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    container_version: CONTAINER_VERSION,
    session: { stand: meta.stand, started_at: meta.startedAt, uuid: sp.uuid, session_id: sp.id },
    doctor: meta.doctor,
    crop: meta.crop,
    video: {
      file: videoFile,
      mimeType: meta.mimeType ?? video.type,
      recording_start_offset: meta.recordingStartOffset,
      frame_count: frameTable.length,
      frames_without_pts: without,
    },
    log: {
      file: log === null ? null : 'log.jsonl',
      complete: log !== null && parsed.complete,
      frames: log === null ? null : (parsed.footer?.frames ?? parsed.frames.length),
    },
    errors,
    created_at: meta.createdAt ?? new Date().toISOString(),
  }
  return createZip([
    { name: videoFile, data: video },
    { name: 'frame_table.json', data: JSON.stringify(frameTable) },
    ...(log === null ? [] : [{ name: 'log.jsonl', data: log }]),
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
  ])
}
