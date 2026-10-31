/** FinishedSession -> container + delivery outcome (the glue between sessionFlow and the EMR). */
import type { FinishedSession } from '../station/sessionFlow'
import { assembleContainer, containerFilename, videoExt, type ContainerMeta } from './assemble'
import { parseLog } from './logParse'
import { deliver, downloadBlob, type DeliverOpts } from './deliver'

export interface ContainerOutcome {
  blob: Blob | null
  filename: string
  /**
   * 'delivered' | 'ready' (no EMR url, offered for download) | 'failed' (delivery failed; see savedLocally)
   * | 'raw-saved' (container assembly failed, raw files handed to download) | 'no-recording'
   */
  delivery: 'delivered' | 'ready' | 'failed' | 'raw-saved' | 'no-recording'
  /** a file was actually handed to the download (fallback after a failed delivery / raw files) */
  savedLocally: boolean
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

export async function buildAndDeliver(
  f: FinishedSession,
  emrUrl: string,
  opts: Partial<DeliverOpts> & { assemble?: typeof assembleContainer } = {},
): Promise<ContainerOutcome> {
  const meta = metaOf(f)
  const filename = containerFilename(meta)
  if (!f.video) return { blob: null, filename, delivery: 'no-recording', savedLocally: false, logComplete: false, error: f.error ?? 'no recording (file mode or recorder failed)' }
  let blob: Blob
  try {
    blob = await (opts.assemble ?? assembleContainer)(f.video, f.frameTable, f.log, meta)
  } catch (e) {
    return saveRaw(f, filename, meta, e, opts.onFallbackSave ?? downloadBlob)
  }
  const logComplete = parseLog(f.log).complete
  if (!emrUrl.trim()) return { blob, filename, delivery: 'ready', savedLocally: false, logComplete, error: null }
  const { assemble: _a, ...dopts } = opts
  const r = await deliver(blob, emrUrl, { filename, sessionId: meta.sessionId ?? undefined, ...dopts })
  return { blob, filename, delivery: r.delivered ? 'delivered' : 'failed', savedLocally: !!r.savedLocally, logComplete, error: r.error ?? null }
}

/** Last resort when the container cannot be built: hand the raw pieces to the download, one file at a time. */
function saveRaw(f: FinishedSession, filename: string, meta: ContainerMeta, cause: unknown, save: (b: Blob, name: string) => void): ContainerOutcome {
  const base = filename.replace(/\.zip$/, '')
  const files: [Blob, string][] = [
    [f.video!, `${base}.video.${videoExt(meta.mimeType ?? f.video!.type)}`],
    [new Blob([JSON.stringify(f.frameTable)], { type: 'application/json' }), `${base}.frame_table.json`],
  ]
  if (f.log !== null) files.push([new Blob([f.log], { type: 'application/x-ndjson' }), `${base}.log.jsonl`])
  const failures: string[] = []
  let saved = 0
  for (const [b, name] of files) {
    try {
      save(b, name)
      saved++
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : e}`)
    }
  }
  const why = `container: ${cause instanceof Error ? cause.message : cause}`
  return {
    blob: null, filename, delivery: saved > 0 ? 'raw-saved' : 'failed', savedLocally: saved > 0, logComplete: parseLog(f.log).complete,
    error: failures.length ? `${why}; raw save failed: ${failures.join('; ')}` : why,
  }
}
