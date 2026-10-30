/**
 * Sending the stamped copy to the server over WebRTC (backend/app/ingest/webrtc.py).
 *
 * Server-side requirements met here:
 * - `degradationPreference = "maintain-resolution"` on the video sender: otherwise WebRTC
 *   scales the picture down under bandwidth pressure, the 16x16 marker grid no longer lines
 *   up and every frame reads as "no id".
 * - H.264 preferred via `setCodecPreferences` before the offer (the marker was validated
 *   against H.264; the server may restrict to it with AIIRIS_VIDEO_CODECS).
 * - Non-trickle offer/answer: ICE gathering is awaited (bounded) before the offer is sent.
 *
 * The connection is disposable: on loss (`failed` / `disconnected` / `closed`) call
 * `connectSendStream` again with the same `sendStream`; the frame counter lives in the
 * capture (captureSource.ts) and continues. Nothing here touches the local recording.
 */

export interface SenderParamsOptions {
  /** bitrate cap (bps) for the encoder; also raises the default (~2.5 Mbps for 1080p) */
  maxBitrateBps?: number
}

export async function applySenderParams(sender: RTCRtpSender, opts: SenderParamsOptions = {}): Promise<void> {
  const p = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string }
  p.degradationPreference = 'maintain-resolution'
  if (!p.encodings || p.encodings.length === 0) p.encodings = [{}] as RTCRtpEncodingParameters[]
  for (const e of p.encodings) {
    if (opts.maxBitrateBps) e.maxBitrate = opts.maxBitrateBps
    ;(e as RTCRtpEncodingParameters & { scaleResolutionDownBy?: number }).scaleResolutionDownBy = 1
  }
  await sender.setParameters(p)
}

/** Order the transceiver's codecs so that H.264 comes first (others kept as fallback). */
export function preferH264(
  transceiver: RTCRtpTransceiver,
  capabilities: RTCRtpCapabilities | null = typeof RTCRtpSender !== 'undefined'
    ? RTCRtpSender.getCapabilities('video')
    : null,
): boolean {
  if (!capabilities || typeof transceiver.setCodecPreferences !== 'function') return false
  const codecs = capabilities.codecs
  const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264')
  if (!h264.length) return false
  // packetization-mode=1 + constrained baseline first (what every receiver decodes)
  const score = (c: RTCRtpCodec) =>
    (/packetization-mode=1/.test(c.sdpFmtpLine ?? '') ? 0 : 2) + (/42e01f/i.test(c.sdpFmtpLine ?? '') ? 0 : 1)
  h264.sort((a, b) => score(a) - score(b))
  transceiver.setCodecPreferences([...h264, ...codecs.filter((c) => !h264.includes(c))])
  return true
}

export interface BitrateHints {
  minKbps?: number
  startKbps?: number
  maxKbps?: number
}

/**
 * Add Chrome's `x-google-{min,start,max}-bitrate` fmtp parameters to every H.264 payload of
 * an SDP (applied to the server's answer before setRemoteDescription: Chrome's sender reads
 * them from the negotiated codec). Without them Chrome starts at ~300 kbit/s and follows the
 * receiver's (aiortc REMB) estimate, which for detailed 1080p content keeps the encoder at a
 * few hundred kbit/s and ~1 fps under `maintain-resolution`. Other browsers ignore them.
 * Idempotent; non-H.264 payloads are untouched.
 */
export function withBitrateHints(sdp: string, hints: BitrateHints): string {
  const params = [
    hints.minKbps ? `x-google-min-bitrate=${Math.round(hints.minKbps)}` : '',
    hints.startKbps ? `x-google-start-bitrate=${Math.round(hints.startKbps)}` : '',
    hints.maxKbps ? `x-google-max-bitrate=${Math.round(hints.maxKbps)}` : '',
  ].filter(Boolean)
  if (!params.length) return sdp
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(eol)
  const h264 = new Set<string>()
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) H264\//i.exec(l)
    if (m) h264.add(m[1])
  }
  const withFmtp = new Set<string>()
  const out = lines.map((l) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(l)
    if (!m || !h264.has(m[1])) return l
    withFmtp.add(m[1])
    return /x-google-(min|start|max)-bitrate/.test(m[2]) ? l : `${l};${params.join(';')}`
  })
  const res: string[] = []
  for (const l of out) {
    res.push(l)
    const m = /^a=rtpmap:(\d+) H264\//i.exec(l)
    if (m && !withFmtp.has(m[1])) res.push(`a=fmtp:${m[1]} ${params.join(';')}`)
  }
  return res.join(eol)
}

/** LAN defaults: the marker was validated down to 500 kbit/s; 1080p needs ~1-4 Mbit/s. */
export const DEFAULT_BITRATE_HINTS: BitrateHints = { minKbps: 1000, startKbps: 2500 }

export type Signal = (offer: RTCSessionDescriptionInit) => Promise<RTCSessionDescriptionInit>

export interface ConnectOptions extends SenderParamsOptions {
  /** Chrome bitrate hints for H.264 (see withBitrateHints); default DEFAULT_BITRATE_HINTS */
  bitrateHints?: BitrateHints | null
  RTCPeerConnection?: typeof RTCPeerConnection
  configuration?: RTCConfiguration
  capabilities?: RTCRtpCapabilities | null
  /** max wait for ICE gathering before sending the offer anyway (default 3000 ms) */
  iceGatheringTimeoutMs?: number
  /** called once when the connection fails / disconnects / closes on its own */
  onConnectionLost?: (state: RTCPeerConnectionState) => void
}

export interface SendConnection {
  pc: RTCPeerConnection
  sender: RTCRtpSender
  close(): void
}

function iceGathered(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === undefined || pc.iceGatheringState === 'complete' || timeoutMs <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => pc.iceGatheringState === 'complete' && done()
    const t = setTimeout(done, timeoutMs)
    pc.addEventListener('icegatheringstatechange', check)
  })
}

/** Create a peer connection that sends `sendStream`, negotiate through `signal`. */
export async function connectSendStream(
  sendStream: MediaStream,
  signal: Signal,
  opts: ConnectOptions = {},
): Promise<SendConnection> {
  const PC = opts.RTCPeerConnection ?? globalThis.RTCPeerConnection
  const pc = new PC(opts.configuration)
  let closedByUs = false
  let lostReported = false
  pc.addEventListener('connectionstatechange', () => {
    const s = pc.connectionState
    if (!closedByUs && !lostReported && (s === 'failed' || s === 'disconnected' || s === 'closed')) {
      lostReported = true
      opts.onConnectionLost?.(s)
    }
  })
  const close = () => {
    closedByUs = true
    pc.close()
  }
  try {
    const track = sendStream.getVideoTracks()[0]
    if (!track) throw new Error('send stream has no video track')
    const tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [sendStream] })
    preferH264(tr, opts.capabilities)
    // set before the offer (so the first frames already keep resolution) and again after
    // negotiation, when every browser accepts it
    await applySenderParams(tr.sender, opts).catch(() => undefined)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await iceGathered(pc, opts.iceGatheringTimeoutMs ?? 3000)
    const local = pc.localDescription ?? offer
    const answer = await signal({ type: local.type, sdp: local.sdp })
    const hints = opts.bitrateHints === undefined ? DEFAULT_BITRATE_HINTS : opts.bitrateHints
    if (hints && answer.sdp) answer.sdp = withBitrateHints(answer.sdp, hints)
    await pc.setRemoteDescription(answer)
    await applySenderParams(tr.sender, opts)
    return { pc, sender: tr.sender, close }
  } catch (e) {
    close()
    throw e
  }
}
