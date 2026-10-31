/** FinishedSession -> container + delivery outcome (the glue between sessionFlow and the EMR). */
import type { FinishedSession } from '../station/sessionFlow'
import { assembleContainer, containerFilename, type ContainerMeta } from './assemble'
import { parseLog } from './logParse'
import { deliver, type DeliverOpts } from './deliver'

export interface ContainerOutcome {
  blob: Blob | null
  filename: string
  /** 'delivered' | 'saved' (no EMR url, offered for download) | 'failed' (delivery failed, fallback save done) | 'no-recording' */
  delivery: 'delivered' | 'saved' | 'failed' | 'no-recording'
  logComplete: boolean
  error: string | null
}

export function metaOf(f: FinishedSession): ContainerMeta {
  const m = f.sessionMeta
  const errors: string[] = []
  if (f.error) errors.push(f.error)
  if (f.recorderError && f.recorderError !== f.error) errors.push(`recorder: ${f.recorderError}`)
  return {
    sessionId: m.sessionId, stand: m.stand, startedAt: m.startedAt, doctor: m.doctor || null,
    crop: m.crop, mimeType: f.mimeType, recordingStartOffset: f.recordingStartOffset, errors,
  }
}

export async function buildAndDeliver(f: FinishedSession, emrUrl: string, opts: Partial<DeliverOpts> = {}): Promise<ContainerOutcome> {
  const meta = metaOf(f)
  const filename = containerFilename(meta)
  if (!f.video) return { blob: null, filename, delivery: 'no-recording', logComplete: false, error: f.error ?? 'no recording (file mode or recorder failed)' }
  let blob: Blob
  try {
    blob = await assembleContainer(f.video, f.frameTable, f.log, meta)
  } catch (e) {
    return { blob: null, filename, delivery: 'failed', logComplete: false, error: `container: ${e instanceof Error ? e.message : e}` }
  }
  const logComplete = parseLog(f.log).complete
  if (!emrUrl.trim()) return { blob, filename, delivery: 'saved', logComplete, error: null }
  const r = await deliver(blob, emrUrl, { filename, sessionId: meta.sessionId ?? undefined, ...opts })
  return { blob, filename, delivery: r.delivered ? 'delivered' : 'failed', logComplete, error: r.error ?? null }
}
