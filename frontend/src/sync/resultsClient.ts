/**
 * Results WebSocket client: `WS /sessions/{id}/results` -> AlignmentBuffer.pushResult.
 * Messages are pushed under their OWN frame_id (never relabelled). On an abnormal close it
 * reconnects with backoff and the buffer is kept (frames keep timing out meanwhile, which
 * shows them without boxes). No reconnect after a normal close 1000 (session stopped) or
 * 4401/4404 (bad token / unknown session). `?token=` is the stand-token convention.
 */
import type { FrameResult } from './alignmentBuffer'

export interface ResultsClientOptions {
  /** full ws(s):// URL of /sessions/{id}/results (no token) */
  url: string
  token?: string
  buffer: { pushResult(frameId: number, r: FrameResult): void }
  WebSocket?: typeof WebSocket
  backoffMs?: number[]
  onState?: (s: 'connecting' | 'open' | 'closed') => void
}

const NO_RECONNECT = new Set([1000, 4401, 4404])

export class ResultsClient {
  private ws: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private stopped = true
  private readonly backoff: number[]

  constructor(private o: ResultsClientOptions) {
    this.backoff = o.backoffMs ?? [500, 1000, 2000, 4000]
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.onmessage = null
      ws.close()
    }
    this.o.onState?.('closed')
  }

  private connect() {
    const WS = this.o.WebSocket ?? WebSocket
    const url = this.o.token
      ? `${this.o.url}${this.o.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.o.token)}`
      : this.o.url
    this.o.onState?.('connecting')
    const ws = new WS(url)
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.o.onState?.('open')
    }
    ws.onmessage = (ev: MessageEvent) => {
      let m: FrameResult
      try {
        m = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (typeof m?.frame_id !== 'number') return
      this.o.buffer.pushResult(m.frame_id, m)
    }
    ws.onclose = (ev: CloseEvent) => {
      this.ws = null
      this.o.onState?.('closed')
      if (this.stopped || NO_RECONNECT.has(ev.code)) return
      const d = this.backoff[Math.min(this.attempt++, this.backoff.length - 1)]
      this.timer = setTimeout(() => {
        this.timer = null
        if (!this.stopped) this.connect()
      }, d)
    }
    ws.onerror = () => {}
  }
}
