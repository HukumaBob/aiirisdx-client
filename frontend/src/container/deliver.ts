/**
 * Delivery of the container to an external EMR (configurable URL): POST application/zip with
 * `X-Session-Id`; retries with exponential backoff; per-attempt timeout via AbortController.
 * The file is never lost: after the last failure `onFallbackSave` runs (default: a browser
 * download). `deliver` never throws.
 */
export interface DeliverOpts {
  fetch?: typeof fetch
  /** retries AFTER the first attempt (default 3) */
  retries?: number
  /** first backoff; doubles each retry (default 1000 ms) */
  backoffMs?: number
  timeoutMs?: number
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

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function deliver(container: Blob, emrUrl: string, opts: DeliverOpts): Promise<DeliverResult> {
  if (!emrUrl.trim()) return { delivered: false, error: 'no EMR URL configured' }
  const doFetch = opts.fetch ?? ((i, init) => globalThis.fetch(i, init))
  const retries = Math.max(0, opts.retries ?? 3)
  const backoff = opts.backoffMs ?? 1000
  let lastErr = ''
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(backoff * 2 ** (attempt - 1))
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000)
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/zip' }
        if (opts.sessionId) headers['X-Session-Id'] = opts.sessionId
        const r = await doFetch(emrUrl, { method: 'POST', headers, body: container, signal: ac.signal })
        if (r.ok) return { delivered: true }
        lastErr = `EMR answered HTTP ${r.status}`
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
