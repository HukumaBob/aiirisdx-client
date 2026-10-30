/**
 * Findings signalling (pure logic, no DOM). Per released frame result decide whether to
 * signal: a finding = any detection with confidence >= threshold (profile.alertThreshold, or
 * profile.classThresholds[class]). The signal is HELD for `holdMs` after the last finding so
 * it does not flicker; the beep fires only on the rising edge. An anatomy warning
 * (anatomy.status === 'warning') is a separate visual-only state (never a sound).
 */
import type { FrameResult } from '../sync/alignmentBuffer'

export interface DoctorProfile {
  /** 0..1 */
  alertThreshold: number
  soundEnabled: boolean
  bufferDelayMs: number
  classThresholds?: Record<string, number>
}

export const DEFAULT_PROFILE: DoctorProfile = { alertThreshold: 0.5, soundEnabled: false, bufferDelayMs: 1000 }

export interface AlertState {
  active: boolean
  anatomyWarning: boolean
  maxConfidence: number
  classes: string[]
}

export interface AlertOptions {
  beep?: () => void
  holdMs?: number
  now?: () => number
}

const IDLE: AlertState = { active: false, anatomyWarning: false, maxConfidence: 0, classes: [] }

export class AlertController {
  private findingUntil = -Infinity
  private anatomyUntil = -Infinity
  private last = { maxConfidence: 0, classes: [] as string[] }
  private wasActive = false
  private readonly holdMs: number
  private readonly now: () => number

  constructor(private profile: DoctorProfile, private opts: AlertOptions = {}) {
    this.holdMs = opts.holdMs ?? 1500
    this.now = opts.now ?? (() => Date.now())
  }

  setProfile(p: DoctorProfile) {
    this.profile = p
  }

  /** call once per released frame (result null = no boxes for that frame) */
  update(result: FrameResult | null): AlertState {
    const t = this.now()
    if (result) {
      const hits = result.detections.filter(
        (d) => d.confidence >= (this.profile.classThresholds?.[d.class_name] ?? this.profile.alertThreshold),
      )
      if (hits.length) {
        this.findingUntil = t + this.holdMs
        this.last = {
          maxConfidence: Math.max(...hits.map((d) => d.confidence)),
          classes: [...new Set(hits.map((d) => d.class_name))],
        }
      }
      if (result.anatomy?.status === 'warning') this.anatomyUntil = t + this.holdMs
    }
    const active = t < this.findingUntil
    if (active && !this.wasActive && this.profile.soundEnabled) this.opts.beep?.()
    this.wasActive = active
    if (!active && t >= this.anatomyUntil) return { ...IDLE }
    return {
      active,
      anatomyWarning: t < this.anatomyUntil,
      maxConfidence: active ? this.last.maxConfidence : 0,
      classes: active ? this.last.classes : [],
    }
  }
}

/** WebAudio beep, no audio files. Returns a callback for AlertOptions.beep. */
export function webAudioBeep(freq = 880, ms = 150): () => void {
  let ctx: AudioContext | null = null
  return () => {
    try {
      ctx ??= new AudioContext()
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.frequency.value = freq
      g.gain.value = 0.15
      o.connect(g).connect(ctx.destination)
      o.start()
      o.stop(ctx.currentTime + ms / 1000)
    } catch {
      /* audio unavailable or blocked before a user gesture */
    }
  }
}
