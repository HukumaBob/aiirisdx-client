/**
 * Delivery of the container to an external EMR (configurable URL): POST application/zip with
 * `X-Session-Id`; retries with exponential backoff; per-attempt timeout via AbortController.
 * The file is never lost: after the last failure `onFallbackSave` runs (default: a browser
 * download). `deliver` never throws.
 *
 * Attempt timeout (I3): SIZE-SCALED, not a fixed whole-upload timeout (a fixed 30 s always
 * aborted GB-sized recordings, re-uploaded them 4x and fell back to a download). The deadline
 * is `baseTimeoutMs + size / minBytesPerSec` (default 30 s + size at an assumed worst-case
 * 1 MB/s, i.e. ~34 min for 2 GB), capped at `maxTimeoutMs` (4 h). Chosen over a stall timer
 * because fetch with a Blob body reports no upload progress; `timeoutMs` overrides it.
 * Retries: network errors, 408, 429 and 5xx. Other 4xx are final (the EMR rejected the
 * request; repeating the identical upload cannot help).
 */
export interface DeliverOpts {
  fetch?: typeof fetch
  /** retries AFTER the first attempt (default 3) */
  retries?: number
  /** first backoff; doubles each retry (default 1000 ms) */
  backoffMs?: number
  /** fixed per-attempt timeout; default: uploadTimeoutMs(size) */
  timeoutMs?: number
  /** worst-case upload rate the scaled timeout assumes (default 1e6 B/s) */
  minBytesPerSec?: number
  filename: string
  sessionId?: string
  onFallbackSave?: (blob: Blob, filename: string) => void
}

export interface DeliverResult {
  delivered: boolean
  error?: string
  /** the fallback save was actually handed to the download (only meaningful when delivered=false) */
  savedLocally?: boolean
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const BASE_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 4 * 3600_000

/** per-attempt deadline for an upload of `size` bytes */
export function uploadTimeoutMs(size: number, o: { minBytesPerSec?: number; baseMs?: number; maxMs?: number } = {}): number {
  const rate = o.minBytesPerSec && o.minBytesPerSec > 0 ? o.minBytesPerSec : 1e6
  const t = (o.baseMs ?? BASE_TIMEOUT_MS) + Math.ceil((Math.max(0, size) / rate) * 1000)
  return Math.min(o.maxMs ?? MAX_TIMEOUT_MS, t)
}

/** worth repeating the same upload? */
export function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function deliver(container: Blob, emrUrl: string, opts: DeliverOpts): Promise<DeliverResult> {
  if (!emrUrl.trim()) return { delivered: false, error: 'no EMR URL configured' }
  const doFetch = opts.fetch ?? ((i, init) => globalThis.fetch(i, init))
  const retries = Math.max(0, opts.retries ?? 3)
  const backoff = opts.backoffMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? uploadTimeoutMs(container.size, { minBytesPerSec: opts.minBytesPerSec })
  let lastErr = ''
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(backoff * 2 ** (attempt - 1))
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/zip' }
        if (opts.sessionId) headers['X-Session-Id'] = opts.sessionId
        const r = await doFetch(emrUrl, { method: 'POST', headers, body: container, signal: ac.signal })
        if (r.ok) return { delivered: true }
        lastErr = `EMR answered HTTP ${r.status}`
        if (!retryable(r.status)) break
      } catch (e) {
        lastErr = msg(e)
      } finally {
        clearTimeout(t)
      }
    }
  } catch (e) {
    lastErr = msg(e)
  }
  let savedLocally = false
  try {
    ;(opts.onFallbackSave ?? downloadBlob)(container, opts.filename)
    savedLocally = true
  } catch (e) {
    lastErr += `; local save failed: ${msg(e)}`
  }
  return { delivered: false, error: lastErr, savedLocally }
}
