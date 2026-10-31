/**
 * Stand page: stand number, doctor (picked from a list, no password), capture device, live
 * preview with an optional crop ROI, start/stop, status line, file mode and the secondary
 * screen. All logic lives in profiles.ts / cropRect.ts / sessionFlow.ts; this is the view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildAndDeliver, type ContainerOutcome } from '../container/finish'
import { downloadBlob } from '../container/deliver'
import { SecondaryScreen, openSecondaryWindow } from '../secondary/SecondaryScreen'
import { CropEditor } from './CropEditor'
import type { CropRect } from './cropRect'
import { StationStore } from './profiles'
import { canStart, defaultDeps, SessionFlow, type FinishedSession, type FlowDeps, type FlowStatus } from './sessionFlow'
import './station.css'

export interface StationPageProps {
  /** receives the recording + log + meta when a session is stopped (container assembly: Task 12) */
  onFinished?: (f: FinishedSession) => void
  deps?: Partial<FlowDeps>
}

const IDLE_STATUS: FlowStatus = {
  state: 'idle', connection: 'none', results: 'none', sessionId: null, sent: 0, received: 0, dropped: 0,
  serverError: null, recorderError: null, message: '',
}

const REASON_RU = { stand: 'номер стойки', doctor: 'врач', file: 'путь к файлу' } as const
const STATE_RU: Record<FlowStatus['state'], string> = {
  idle: 'ожидание', starting: 'запуск…', running: 'идёт сеанс', 'server-lost': 'сервер потерян — запись продолжается',
  stopping: 'остановка…', finished: 'сеанс завершён', error: 'ошибка',
}

export function StationPage({ onFinished, deps }: StationPageProps) {
  const store = useMemo(() => new StationStore(), [])
  const [stand, setStand] = useState(store.stand)
  const [doctors, setDoctors] = useState(store.doctors)
  const [doctor, setDoctor] = useState(store.lastDoctor)
  const [profile, setProfile] = useState(() => store.getProfile(store.lastDoctor))
  const [newDoctor, setNewDoctor] = useState('')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [mode, setMode] = useState<'live' | 'file'>('live')
  const [filePath, setFilePath] = useState('')
  const [realtime, setRealtime] = useState(true)
  const [cropOn, setCropOn] = useState(false)
  const [crop, setCrop] = useState<CropRect | null>(null)
  const [cropError, setCropError] = useState<string | null>(null)
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 })
  const [status, setStatus] = useState<FlowStatus>(IDLE_STATUS)
  const [error, setError] = useState<string | null>(null)
  const [finished, setFinished] = useState<FinishedSession | null>(null)
  const [emrUrl, setEmrUrl] = useState(store.emrUrl)
  const emrUrlRef = useRef(emrUrl)
  emrUrlRef.current = emrUrl
  const [outcome, setOutcome] = useState<ContainerOutcome | null>(null)
  const [win, setWin] = useState<Window | null>(null)
  const [showInPage, setShowInPage] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const previewRef = useRef<MediaStream | null>(null)

  const flow = useMemo(
    () =>
      new SessionFlow(defaultDeps(deps), {
        onStatus: setStatus,
        onFinished: (f) => {
          setFinished(f)
          setOutcome(null)
          void buildAndDeliver(f, emrUrlRef.current).then(setOutcome)
          onFinished?.(f)
        },
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // the live capture's source (set as soon as the capture exists, also when the server is lost)
  const captureStream = flow.capture?.sourceStream ?? null
  const active = ['starting', 'running', 'server-lost', 'stopping'].includes(status.state)

  // poll counters while a session is on
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setStatus(flow.getStatus()), 500)
    return () => clearInterval(t)
  }, [active, flow])

  // ---- devices
  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
      setDevices(list)
      setDeviceId((cur) => (cur && list.some((d) => d.deviceId === cur) ? cur : (list[0]?.deviceId ?? '')))
    } catch (e) {
      setError(`устройства: ${e instanceof Error ? e.message : e}`)
    }
  }, [])
  useEffect(() => {
    void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
  }, [refreshDevices])

  // ---- preview (own stream while idle; the capture's source while a session runs)
  const stopPreview = useCallback(() => {
    previewRef.current?.getTracks().forEach((t) => t.stop())
    previewRef.current = null
  }, [])
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (active) {
      stopPreview()
      // changing srcObject resets paused=true: play() again (also autoPlay on the element)
      v.srcObject = captureStream
      if (captureStream) void v.play?.()?.catch?.(() => {})
      return
    }
    if (mode !== 'live' || !navigator.mediaDevices?.getUserMedia) {
      v.srcObject = null
      return
    }
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        stopPreview()
        previewRef.current = s
        v.srcObject = s
        void v.play().catch(() => {})
        void refreshDevices() // labels appear once permission is granted
      })
      .catch((e) => !cancelled && setError(`камера: ${e instanceof Error ? e.message : e}`))
    return () => {
      cancelled = true
      stopPreview()
    }
  }, [active, mode, deviceId, flow, stopPreview, refreshDevices, captureStream])

  // ---- doctor / profile
  const chooseDoctor = (name: string) => {
    setDoctor(name)
    store.setLastDoctor(name)
    setProfile(store.getProfile(name))
  }
  const addDoctor = () => {
    const n = store.addDoctor(newDoctor)
    if (n) {
      setDoctors(store.doctors)
      setNewDoctor('')
      chooseDoctor(n)
    }
  }
  const removeDoctor = () => {
    if (!doctor || !window.confirm(`Удалить врача «${doctor}» и его профиль?`)) return
    store.removeDoctor(doctor)
    setDoctors(store.doctors)
    chooseDoctor('')
  }
  const patchProfile = (patch: Partial<typeof profile>) => {
    const next = { ...profile, ...patch }
    setProfile(next)
    if (doctor) store.setProfile(doctor, patch)
    if (patch.bufferDelayMs !== undefined && active) flow.setDelay(patch.bufferDelayMs)
  }

  const check = canStart({ stand, doctor, mode, filePath })
  const start = async () => {
    setError(null)
    setFinished(null)
    setOutcome(null)
    if (!check.ok) return setError(`Укажите: ${check.reasons.map((r) => REASON_RU[r]).join(', ')}`)
    stopPreview()
    // the secondary screen popup must be opened from the click
    if (!win || win.closed) setWin(openSecondaryWindow())
    try {
      await flow.start({
        stand, doctor, deviceId, mode, profile, filePath, realtime,
        crop: cropOn ? crop : null,
      })
      setStatus(flow.getStatus())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(flow.getStatus())
    }
  }
  const stop = async () => {
    try {
      await flow.stop()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setStatus(flow.getStatus())
  }
  const reconnect = () => flow.reconnect().then(() => setStatus(flow.getStatus()), (e) => setError(String(e)))

  const secondary = flow.buffer && active ? (
    <SecondaryScreen buffer={flow.buffer} profile={profile} crop={cropOn ? crop : null} win={win} />
  ) : null

  return (
    <div className="station">
      <header>
        <h1>aiirisdx-client</h1>
        <span className={`pill ${status.state}`} data-testid="state">{STATE_RU[status.state]}</span>
      </header>
      <div className="grid">
        <section className="video">
          <div className="stage">
            <video ref={videoRef} muted playsInline autoPlay onLoadedMetadata={(e) => setFrameSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })} />
            {cropOn && mode === 'live' && (
              <CropEditor frameW={frameSize.w} frameH={frameSize.h} crop={crop} onChange={setCrop} disabled={active} onError={setCropError} />
            )}
          </div>
          <div className="statusline" data-testid="statusline">
            <span>соединение: {status.connection}</span>
            <span>результаты: {status.results}</span>
            <span>отправлено: {status.sent}</span>
            <span>получено: {status.received}</span>
            <span>пропущено: {status.dropped}</span>
            {status.message && <strong className="warn">{status.message}</strong>}
            {status.serverError && <span className="err">сервер: {status.serverError}</span>}
            {status.recorderError && <span className="err">запись: {status.recorderError}</span>}
          </div>
          {error && <div className="err" role="alert">{error}</div>}
          {finished && (
            <div className="done" data-testid="finished">
              Запись: {finished.video ? `${(finished.video.size / 1e6).toFixed(1)} МБ` : 'нет'}, кадров в таблице: {finished.frameTable.length}, лог:{' '}
              {finished.log ? `${finished.log.split('\n').length - 1} строк` : 'недоступен'}
              {finished.error && <span className="err"> ({finished.error})</span>}
            </div>
          )}
          {finished && (
            <div className="done" data-testid="container-status">
              {!outcome ? 'Контейнер: сборка…' : outcome.delivery === 'no-recording' || (outcome.delivery === 'failed' && !outcome.blob) ? `Контейнер не собран и файлы не сохранены: ${outcome.error}` : (
                <>
                  {outcome.delivery === 'delivered' && 'Контейнер: доставлен в EMR'}
                  {outcome.delivery === 'ready' && 'Контейнер: готов (URL EMR не задан)'}
                  {outcome.delivery === 'failed' && (outcome.savedLocally ? `Контейнер: сохранён локально — доставка не удалась: ${outcome.error}` : `Контейнер: НЕ доставлен и НЕ сохранён автоматически — используйте кнопку «Сохранить контейнер»: ${outcome.error}`)}
                  {outcome.delivery === 'raw-saved' && `Контейнер не собран — сырые файлы сохранены (видео, таблица кадров, лог): ${outcome.error}`}
                  {!outcome.logComplete && <strong className="warn"> — лог неполный{finished.log === null ? ' (сервер потерян)' : ''}</strong>}
                  {outcome.blob && <> <button type="button" onClick={() => downloadBlob(outcome.blob!, outcome.filename)}>Сохранить контейнер</button></>}
                </>
              )}
            </div>
          )}
          {showInPage && secondary}
        </section>

        <aside className="controls">
          <label>Стойка
            <input value={stand} disabled={active} placeholder="stand-1" onChange={(e) => { setStand(e.target.value); store.setStand(e.target.value) }} />
          </label>
          <label>Врач
            <select value={doctor} disabled={active} onChange={(e) => chooseDoctor(e.target.value)}>
              <option value="">— выберите —</option>
              {doctors.map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
          {!active && (
            <div className="row">
              <input value={newDoctor} placeholder="новый врач" onChange={(e) => setNewDoctor(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addDoctor()} />
              <button type="button" onClick={addDoctor}>Добавить</button>
              <button type="button" onClick={removeDoctor} disabled={!doctor}>Удалить</button>
            </div>
          )}
          <label>URL EMR (пусто — без отправки)
            <input value={emrUrl} placeholder="https://emr.example/api/results" onChange={(e) => { setEmrUrl(e.target.value); store.setEmrUrl(e.target.value) }} />
          </label>
          <fieldset disabled={!doctor}>
            <legend>Профиль врача</legend>
            <label>Порог сигнала: {profile.alertThreshold.toFixed(2)}
              <input type="range" min={0} max={1} step={0.05} value={profile.alertThreshold} onChange={(e) => patchProfile({ alertThreshold: Number(e.target.value) })} />
            </label>
            <label className="inline"><input type="checkbox" checked={profile.soundEnabled} onChange={(e) => patchProfile({ soundEnabled: e.target.checked })} /> Звук</label>
            <label>Задержка вторичного экрана, мс
              <input type="number" min={0} max={10000} step={100} value={profile.bufferDelayMs} onChange={(e) => patchProfile({ bufferDelayMs: Number(e.target.value) })} />
            </label>
          </fieldset>

          <fieldset disabled={active}>
            <legend>Источник</legend>
            <label className="inline"><input type="radio" checked={mode === 'live'} onChange={() => setMode('live')} /> Видео со стойки</label>
            <label className="inline"><input type="radio" checked={mode === 'file'} onChange={() => setMode('file')} /> Видеофайл на сервере</label>
            {mode === 'live' ? (
              <label>Устройство захвата
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                  {devices.length === 0 && <option value="">нет устройств</option>}
                  {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Камера ${i + 1}`}</option>)}
                </select>
              </label>
            ) : (
              <>
                <label>Путь к файлу (относительно корня на сервере)
                  <input value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="video.mp4" />
                </label>
                <label className="inline"><input type="checkbox" checked={realtime} onChange={(e) => setRealtime(e.target.checked)} /> В реальном времени</label>
              </>
            )}
          </fieldset>

          {mode === 'live' && (
            <fieldset disabled={active}>
              <legend>Кадрирование</legend>
              <label className="inline">
                <input type="checkbox" checked={cropOn} onChange={(e) => { setCropOn(e.target.checked); if (!e.target.checked) setCrop(null) }} /> Включить (рамка мышью на превью)
              </label>
              {cropOn && (
                <div data-testid="crop-info">
                  {crop ? `x=${crop.x} y=${crop.y} ${crop.w}×${crop.h} (кадр ${frameSize.w}×${frameSize.h})` : 'рамка не задана — без кадрирования'}
                  {crop && <button type="button" onClick={() => setCrop(null)}>Сбросить</button>}
                </div>
              )}
              {cropError && <div className="err">{cropError}</div>}
            </fieldset>
          )}

          <div className="row">
            {!active || status.state === 'starting' ? (
              <button type="button" className="primary" onClick={start} disabled={status.state === 'starting'} title={check.ok ? '' : 'нужны номер стойки и врач'}>Старт</button>
            ) : (
              <button type="button" className="stop" onClick={stop} disabled={status.state === 'stopping'}>Стоп</button>
            )}
            {status.state === 'server-lost' && mode === 'live' && <button type="button" onClick={reconnect}>Переподключить</button>}
          </div>
          <div className="row">
            <button type="button" onClick={() => setWin(openSecondaryWindow())}>Вторичный экран (окно)</button>
            <label className="inline"><input type="checkbox" checked={showInPage} onChange={(e) => setShowInPage(e.target.checked)} /> на этой странице</label>
          </div>
          {!showInPage && secondary}
        </aside>
      </div>
    </div>
  )
}
