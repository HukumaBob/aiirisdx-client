/**
 * Stand-page persistence (spec §3: no authorization -- the doctor is picked from a list
 * without a password; his settings are a profile). Everything lives in localStorage under one
 * versioned key, accessed through a wrapper that never throws: storage may be unavailable
 * (private mode, blocked site data, quota). Then the store keeps working in memory and
 * `persisted` is false.
 */
import type { DoctorProfile } from '../secondary/alertLogic'

export const STORAGE_KEY = 'aiiris.station'
export const STORAGE_VERSION = 1

export const DEFAULT_DOCTOR_PROFILE: DoctorProfile = { alertThreshold: 0.5, soundEnabled: true, bufferDelayMs: 1000 }

export interface SafeStorage {
  get(key: string): string | null
  set(key: string, value: string): boolean
  remove(key: string): boolean
}

export function safeStorage(getStorage: () => Storage = () => globalThis.localStorage): SafeStorage {
  return {
    get(k) {
      try {
        return getStorage().getItem(k)
      } catch {
        return null
      }
    },
    set(k, v) {
      try {
        getStorage().setItem(k, v)
        return true
      } catch {
        return false
      }
    },
    remove(k) {
      try {
        getStorage().removeItem(k)
        return true
      } catch {
        return false
      }
    },
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const clamp = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt

export function sanitizeProfile(raw: unknown): DoctorProfile {
  const o = isObj(raw) ? raw : {}
  const p: DoctorProfile = {
    alertThreshold: clamp(o.alertThreshold, 0, 1, DEFAULT_DOCTOR_PROFILE.alertThreshold),
    soundEnabled: typeof o.soundEnabled === 'boolean' ? o.soundEnabled : DEFAULT_DOCTOR_PROFILE.soundEnabled,
    bufferDelayMs: clamp(o.bufferDelayMs, 0, 10000, DEFAULT_DOCTOR_PROFILE.bufferDelayMs),
  }
  if (isObj(o.classThresholds)) {
    const ct: Record<string, number> = {}
    for (const [k, v] of Object.entries(o.classThresholds)) if (typeof v === 'number' && v >= 0 && v <= 1) ct[k] = v
    if (Object.keys(ct).length) p.classThresholds = ct
  }
  return p
}

export interface StationData {
  version: number
  stand: string
  doctors: string[]
  lastDoctor: string
  profiles: Record<string, DoctorProfile>
  /** EMR endpoint for the result container; empty = no delivery (download only) */
  emrUrl: string
}

export function emptyData(): StationData {
  return { version: STORAGE_VERSION, stand: '', doctors: [], lastDoctor: '', profiles: {}, emrUrl: '' }
}

export function cleanDoctorName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 64)
}

/** Parse + migrate whatever is stored (missing / corrupt / older shapes) into current data. */
export function migrate(raw: string | null): StationData {
  const d = emptyData()
  if (!raw) return d
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return d
  }
  if (!isObj(j)) return d
  if (typeof j.stand === 'string') d.stand = j.stand.trim().slice(0, 32)
  if (typeof j.emrUrl === 'string') d.emrUrl = j.emrUrl.trim().slice(0, 512)
  // v0 stored doctors as objects {name, ...profile}; v1 as names + a profiles map
  const profiles = isObj(j.profiles) ? j.profiles : {}
  if (Array.isArray(j.doctors)) {
    for (const item of j.doctors) {
      const name = cleanDoctorName(typeof item === 'string' ? item : isObj(item) && typeof item.name === 'string' ? item.name : '')
      if (!name || d.doctors.includes(name)) continue
      d.doctors.push(name)
      d.profiles[name] = sanitizeProfile(isObj(item) ? item : profiles[name])
    }
  }
  if (typeof j.lastDoctor === 'string' && d.doctors.includes(j.lastDoctor)) d.lastDoctor = j.lastDoctor
  return d
}

export class StationStore {
  private data: StationData
  /** false once a write failed (or storage unreadable at construction is not detectable) */
  persisted = true

  constructor(private storage: SafeStorage = safeStorage()) {
    this.data = migrate(storage.get(STORAGE_KEY))
  }

  private save() {
    this.persisted = this.storage.set(STORAGE_KEY, JSON.stringify(this.data))
  }

  get stand() {
    return this.data.stand
  }
  setStand(stand: string) {
    this.data.stand = stand.trim().slice(0, 32)
    this.save()
  }

  get emrUrl() {
    return this.data.emrUrl
  }
  setEmrUrl(url: string) {
    this.data.emrUrl = url.trim().slice(0, 512)
    this.save()
  }

  get doctors(): string[] {
    return [...this.data.doctors]
  }
  get lastDoctor() {
    return this.data.lastDoctor
  }
  setLastDoctor(name: string) {
    this.data.lastDoctor = this.data.doctors.includes(name) ? name : ''
    this.save()
  }

  /** returns the cleaned name, or null if empty / duplicate */
  addDoctor(name: string): string | null {
    const n = cleanDoctorName(name)
    if (!n || this.data.doctors.includes(n)) return null
    this.data.doctors.push(n)
    this.data.profiles[n] = { ...DEFAULT_DOCTOR_PROFILE }
    this.save()
    return n
  }

  removeDoctor(name: string) {
    this.data.doctors = this.data.doctors.filter((d) => d !== name)
    delete this.data.profiles[name]
    if (this.data.lastDoctor === name) this.data.lastDoctor = ''
    this.save()
  }

  getProfile(name: string): DoctorProfile {
    const p = this.data.profiles[name]
    return p ? { ...p } : { ...DEFAULT_DOCTOR_PROFILE }
  }

  setProfile(name: string, patch: Partial<DoctorProfile>) {
    if (!this.data.doctors.includes(name)) return
    this.data.profiles[name] = sanitizeProfile({ ...this.data.profiles[name], ...patch })
    this.save()
  }
}
