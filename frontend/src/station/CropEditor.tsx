/**
 * Crop ROI editor: a transparent layer over the preview <video> (object-fit: contain). Drag
 * with the mouse to draw a rectangle; coordinates are mapped to ORIGINAL frame pixels through
 * the letterboxed picture (cropRect.ts). Optional: no rectangle = no crop (default).
 */
import { useRef, useState } from 'react'
import { cropFromDrag, frameToScreen, validateCrop, type CropRect, type Point } from './cropRect'

export interface CropEditorProps {
  /** frame size in pixels (videoWidth/Height of the preview), 0 when unknown */
  frameW: number
  frameH: number
  crop: CropRect | null
  onChange: (crop: CropRect | null) => void
  disabled?: boolean
  onError?: (message: string | null) => void
}

export function CropEditor({ frameW, frameH, crop, onChange, disabled, onError }: CropEditorProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ a: Point; b: Point } | null>(null)
  const ready = !disabled && frameW > 0 && frameH > 0

  const local = (e: React.PointerEvent): Point => {
    const r = ref.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const box = () => {
    const r = ref.current!.getBoundingClientRect()
    return { w: r.width, h: r.height }
  }

  const shown = drag
    ? (() => {
        const v = cropFromDrag(drag.a, drag.b, box(), { w: frameW, h: frameH })
        return v.ok ? v.rect : null
      })()
    : crop
  const style = shown && ref.current ? frameToScreen(shown, box(), { w: frameW, h: frameH }) : null

  return (
    <div
      ref={ref}
      className="crop-layer"
      data-testid="crop-layer"
      style={{ cursor: ready ? 'crosshair' : 'default' }}
      onPointerDown={(e) => {
        if (!ready) return
        e.currentTarget.setPointerCapture?.(e.pointerId)
        const p = local(e)
        setDrag({ a: p, b: p })
        onError?.(null)
      }}
      onPointerMove={(e) => drag && setDrag({ a: drag.a, b: local(e) })}
      onPointerUp={(e) => {
        if (!drag) return
        const v = cropFromDrag(drag.a, local(e), box(), { w: frameW, h: frameH })
        setDrag(null)
        if (v.ok) {
          onChange(validateCrop(v.rect, frameW, frameH).ok ? v.rect : null)
          onError?.(null)
        } else if ('reason' in v && v.reason !== 'empty') onError?.(v.message)
        // a plain click (empty) keeps the previous crop
      }}
    >
      {style && <div className="crop-rect" style={style} />}
    </div>
  )
}
