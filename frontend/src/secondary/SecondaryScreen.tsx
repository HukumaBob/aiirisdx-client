/**
 * Secondary screen (R6): a canvas that shows every frame released by the AlignmentBuffer
 * together with its own boxes, plus the findings signal. Rendering happens in onReady (no
 * requestVideoFrameCallback, no time-tolerance sync).
 *
 * Placement: `win` = a same-origin popup opened with window.open from the capture page
 * (openSecondaryWindow); the opener draws into the popup's canvas through a React portal.
 * If popups are blocked (or the popup is closed) the screen renders in-page instead.
 * The frame is the UNSTAMPED original (captureSource.onFrameBitmap), so normalized boxes map
 * 1:1 to canvas pixels; a session crop is only outlined (scaled from original-frame pixels
 * to the downscaled canvas via `sourceSize`).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AlignmentBuffer } from '../sync/alignmentBuffer'
import { AlertController, webAudioBeep, type AlertState, type DoctorProfile } from './alertLogic'
import { cropToCanvas, drawBoxes, drawCropOutline } from './boxRenderer'
import { alertBorder, FindingsAlert } from './FindingsAlert'

export interface SecondaryScreenProps {
  buffer: Pick<AlignmentBuffer, 'onReady'>
  profile: DoctorProfile
  /** crop in ORIGINAL frame pixels (outline only) */
  crop?: { x: number; y: number; w: number; h: number } | null
  /** size of the ORIGINAL capture frame the crop refers to; the canvas shows the frame
   * downscaled (R9), so the outline is scaled by canvas/source. Omitted = crop in canvas px */
  sourceSize?: { width: number; height: number } | null
  /** popup window to render into; null/closed = in-page */
  win?: Window | null
  beep?: () => void
}

const IDLE: AlertState = { active: false, anatomyWarning: false, maxConfidence: 0, classes: [] }

/** Opens the popup; returns null when blocked. Call from a user gesture. */
export function openSecondaryWindow(): Window | null {
  const w = window.open('', 'aiiris-secondary', 'popup,width=1280,height=720')
  if (!w) return null
  w.document.title = 'AIIRIS — вторичный экран'
  w.document.body.style.cssText = 'margin:0;background:#000;'
  return w
}

export function SecondaryScreen({ buffer, profile, crop, sourceSize, win, beep }: SecondaryScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [alert, setAlert] = useState<AlertState>(IDLE)
  const ctl = useMemo(() => new AlertController(profile, { beep: beep ?? webAudioBeep() }), []) // eslint-disable-line react-hooks/exhaustive-deps
  const cropRef = useRef(crop)
  cropRef.current = crop
  const sourceRef = useRef(sourceSize)
  sourceRef.current = sourceSize
  const usable = win && !win.closed ? win : null

  useEffect(() => ctl.setProfile(profile), [ctl, profile])

  useEffect(() => {
    return buffer.onReady((frame, result) => {
      const c = canvasRef.current
      const ctx = c?.getContext('2d')
      if (c && ctx) {
        const src = frame.bitmap as { width?: number; height?: number }
        const w = src.width ?? c.width
        const h = src.height ?? c.height
        if (c.width !== w || c.height !== h) {
          c.width = w
          c.height = h
        }
        ctx.drawImage(frame.bitmap as CanvasImageSource, 0, 0, w, h)
        if (result) drawBoxes(ctx, result.detections, w, h)
        if (cropRef.current) drawCropOutline(ctx, cropToCanvas(cropRef.current, sourceRef.current, w, h))
      }
      const next = ctl.update(result)
      setAlert((p) =>
        p.active === next.active && p.anatomyWarning === next.anatomyWarning &&
        p.maxConfidence === next.maxConfidence && p.classes.join() === next.classes.join()
          ? p
          : next,
      )
    })
  }, [buffer, ctl, usable])

  // the hold expires without new frames only if frames stop; every released frame re-evaluates

  const view = (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000', boxSizing: 'border-box', border: alertBorder(alert) }}>
      <canvas ref={canvasRef} data-testid="secondary-canvas" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
      <FindingsAlert state={alert} />
    </div>
  )
  return usable ? createPortal(<div style={{ position: 'fixed', inset: 0 }}>{view}</div>, usable.document.body) : <div style={{ width: '100%', aspectRatio: '16 / 9' }}>{view}</div>
}
