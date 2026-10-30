import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AlertController, type DoctorProfile } from '../src/secondary/alertLogic'
import type { FrameResult } from '../src/sync/alignmentBuffer'

const profile: DoctorProfile = { alertThreshold: 0.6, soundEnabled: true, bufferDelayMs: 1000 }
const r = (conf: number[], anatomy: FrameResult['anatomy'] = null, cls = 'polyp'): FrameResult => ({
  frame_id: 0, pts: 0, dropped: false, classification: {}, anatomy,
  detections: conf.map((c) => ({ bbox: [0, 0, 0.1, 0.1] as [number, number, number, number], class_name: cls, confidence: c })),
})

let beep: ReturnType<typeof vi.fn>
let ctl: AlertController
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  beep = vi.fn()
  ctl = new AlertController(profile, { beep, holdMs: 1000 })
})

describe('alertLogic', () => {
  it('signals only at or above threshold', () => {
    expect(ctl.update(r([0.59])).active).toBe(false)
    const s = ctl.update(r([0.2, 0.6]))
    expect(s.active).toBe(true)
    expect(s.maxConfidence).toBe(0.6)
    expect(s.classes).toEqual(['polyp'])
  })

  it('holds the signal then clears (no flicker)', () => {
    ctl.update(r([0.9]))
    vi.advanceTimersByTime(500)
    expect(ctl.update(r([])).active).toBe(true)
    vi.advanceTimersByTime(499)
    expect(ctl.update(null).active).toBe(true)
    vi.advanceTimersByTime(2)
    expect(ctl.update(r([])).active).toBe(false)
  })

  it('beeps once per rising edge, not every frame, and not when sound is off', () => {
    ctl.update(r([0.9]))
    vi.advanceTimersByTime(100)
    ctl.update(r([0.9]))
    expect(beep).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3000)
    ctl.update(r([]))
    ctl.update(r([0.9]))
    expect(beep).toHaveBeenCalledTimes(2)
    const quiet = new AlertController({ ...profile, soundEnabled: false }, { beep })
    quiet.update(r([0.9]))
    expect(beep).toHaveBeenCalledTimes(2)
  })

  it('per-class threshold overrides', () => {
    const c = new AlertController({ ...profile, classThresholds: { polyp: 0.9 } }, { beep })
    expect(c.update(r([0.8])).active).toBe(false)
    expect(c.update(r([0.8], null, 'other')).active).toBe(true)
  })

  it('anatomy warning is a distinct visual, no sound, own hold', () => {
    const s = ctl.update(r([], { status: 'warning' }))
    expect(s.active).toBe(false)
    expect(s.anatomyWarning).toBe(true)
    expect(beep).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1001)
    expect(ctl.update(r([], { status: 'ok' })).anatomyWarning).toBe(false)
  })

  it('profile can be updated live', () => {
    ctl.setProfile({ ...profile, alertThreshold: 0.95 })
    expect(ctl.update(r([0.9])).active).toBe(false)
  })
})
