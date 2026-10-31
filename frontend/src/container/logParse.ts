/**
 * Tolerant parser for the server's JSON-lines session log (backend/app/contracts/log_schema.py):
 * header line, one `frame` line per frame, `footer` {complete, frames} on a clean close.
 * A dropped server leaves no footer and possibly a truncated last line -- that is not an
 * error here, it just means `complete = false`.
 */
export interface LogFrame {
  frame_id: number
  pts?: number
  dropped?: boolean
}

export interface ParsedLog {
  header: Record<string, unknown> | null
  frames: LogFrame[]
  footer: { complete: boolean; frames?: number } | null
  /** the LAST non-empty line is a footer with complete=true */
  complete: boolean
  /** some line did not parse (typically the truncated last one) */
  hadBadLine: boolean
}

export function parseLog(text: string | null): ParsedLog {
  const out: ParsedLog = { header: null, frames: [], footer: null, complete: false, hadBadLine: false }
  if (!text) return out
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  lines.forEach((line, i) => {
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      out.hadBadLine = true
      return
    }
    if (typeof o !== 'object' || o === null) return
    const r = o as Record<string, unknown>
    if (r.type === 'header') out.header = r
    else if (r.type === 'frame' && typeof r.frame_id === 'number') out.frames.push(r as unknown as LogFrame)
    else if (r.type === 'footer') {
      out.footer = { complete: r.complete === true, frames: typeof r.frames === 'number' ? r.frames : undefined }
      out.complete = i === lines.length - 1 && r.complete === true
    }
  })
  return out
}
