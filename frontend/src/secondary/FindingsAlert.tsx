/** Presentational findings signal: frame border colour + badge. Logic lives in alertLogic.ts. */
import type { AlertState } from './alertLogic'

export const FINDING_COLOR = '#ff3b30'
export const ANATOMY_WARNING_COLOR = '#ffb300'

export function alertBorder(s: AlertState): string {
  if (s.active) return `4px solid ${FINDING_COLOR}`
  if (s.anatomyWarning) return `4px dashed ${ANATOMY_WARNING_COLOR}`
  return '4px solid transparent'
}

export function FindingsAlert({ state }: { state: AlertState }) {
  if (!state.active && !state.anatomyWarning) return null
  const base = {
    position: 'absolute' as const,
    left: 12,
    padding: '4px 10px',
    borderRadius: 6,
    font: 'bold 16px Arial, sans-serif',
    color: '#fff',
  }
  return (
    <>
      {state.active && (
        <div role="alert" data-testid="finding-badge" style={{ ...base, top: 12, background: FINDING_COLOR }}>
          Находка {Math.round(state.maxConfidence * 100)}% · {state.classes.map((c) => c.replace(/_/g, ' ')).join(', ')}
        </div>
      )}
      {state.anatomyWarning && (
        <div
          data-testid="anatomy-badge"
          style={{ ...base, top: state.active ? 52 : 12, background: ANATOMY_WARNING_COLOR, color: '#000' }}
        >
          Проверьте зону осмотра
        </div>
      )}
    </>
  )
}
