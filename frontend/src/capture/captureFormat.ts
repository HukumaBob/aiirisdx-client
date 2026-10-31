/**
 * Capture format (C3): the ONE place that builds getUserMedia video constraints, used by both
 * the stand page's preview and startCapture, so the crop is drawn on the same geometry as the
 * recording / the send copy.
 *
 * Without explicit constraints Chrome opens a camera at the mode nearest 640x480: the
 * recording, the inference input and the crop would be VGA, and at 640 px the frame-id marker
 * fits only 1 copy instead of 3 (frameId.ts: copies = min(3, floor(width / 640))). The default
 * asks for the spec's 1080p30 signal (`ideal`, so a card that cannot do it still opens at its
 * nearest mode); a stand can override it in its settings. What was actually NEGOTIATED is read
 * back from track.getSettings() and shown on the page with a warning when it is too small.
 */

export interface CaptureFormat {
  width: number
  height: number
  fps: number
}

export const DEFAULT_CAPTURE_FORMAT: CaptureFormat = { width: 1920, height: 1080, fps: 30 }

/** stand-settings presets (label, format) */
export const CAPTURE_PRESETS: ReadonlyArray<{ id: string; label: string; format: CaptureFormat }> = [
  { id: '1080p30', label: '1920×1080, 30 к/с (по умолчанию)', format: DEFAULT_CAPTURE_FORMAT },
  { id: '1080p60', label: '1920×1080, 60 к/с', format: { width: 1920, height: 1080, fps: 60 } },
  { id: '720p30', label: '1280×720, 30 к/с', format: { width: 1280, height: 720, fps: 30 } },
  { id: '2160p30', label: '3840×2160, 30 к/с', format: { width: 3840, height: 2160, fps: 30 } },
]

export function presetId(f: CaptureFormat): string | null {
  return CAPTURE_PRESETS.find((p) => p.format.width === f.width && p.format.height === f.height && p.format.fps === f.fps)?.id ?? null
}

/** sanitize a stored / user-given format; anything invalid falls back to the default */
export function sanitizeFormat(raw: unknown): CaptureFormat {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const int = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : d
  return {
    width: int(o.width, 160, 7680, DEFAULT_CAPTURE_FORMAT.width),
    height: int(o.height, 120, 4320, DEFAULT_CAPTURE_FORMAT.height),
    fps: int(o.fps, 1, 120, DEFAULT_CAPTURE_FORMAT.fps),
  }
}

/** getUserMedia video constraints for a device ('' = the browser's default camera) */
export function videoConstraints(deviceId: string, format: Partial<CaptureFormat> = {}): MediaTrackConstraints {
  const f = { ...DEFAULT_CAPTURE_FORMAT, ...Object.fromEntries(Object.entries(format).filter(([, v]) => v)) } as CaptureFormat
  const c: MediaTrackConstraints = {
    width: { ideal: f.width },
    height: { ideal: f.height },
    frameRate: { ideal: f.fps },
  }
  if (deviceId) c.deviceId = { exact: deviceId }
  return c
}

export interface Negotiated {
  width: number
  height: number
  fps: number | null
}

/** what the browser actually opened (null if the stream has no video track / no size yet) */
export function negotiatedOf(stream: Pick<MediaStream, 'getVideoTracks'> | null | undefined): Negotiated | null {
  const t = stream?.getVideoTracks?.()[0]
  const s = t?.getSettings?.()
  if (!s?.width || !s?.height) return null
  return { width: s.width, height: s.height, fps: typeof s.frameRate === 'number' ? s.frameRate : null }
}

/** user-facing warning for a negotiated size, null if fine */
export function formatWarning(n: Negotiated | null): string | null {
  if (!n) return null
  if (n.width < 640) return `ширина ${n.width} < 640: метка номера кадра не помещается — сервер не сможет читать кадры`
  if (n.width < 1280) return `ширина ${n.width} < 1280: только 1 копия метки номера кадра (меньше устойчивость), низкое разрешение записи`
  return null
}
