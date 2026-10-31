import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { StationPage } from '../src/station/StationPage'

function setup(fetchOk: boolean) {
  const source = { id: 'source' } as unknown as MediaStream
  const handle = {
    sendStream: {}, sourceStream: source, width: 640, height: 480, fps: 30, frameCount: 0, stop: vi.fn(),
    localRecorder: { start: vi.fn(), stop: vi.fn() },
  }
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(window, 'open').mockReturnValue(null)
  const deps = {
    fetch: vi.fn(async () => {
      if (!fetchOk) throw new TypeError('down')
      return { ok: true, status: 200, json: async () => ({ session_id: 'S', sdp: 'A', type: 'answer' }), text: async () => '' } as Response
    }),
    startCapture: vi.fn(async () => handle),
    connectSendStream: vi.fn(async () => ({ pc: {}, sender: {}, close: vi.fn() })),
    WebSocket: class { onopen = null; onmessage = null; onclose = null; onerror = null; close() {} },
  } as never
  return { source, play, deps }
}

async function start() {
  fireEvent.change(screen.getByPlaceholderText('stand-1'), { target: { value: 'stand-1' } })
  fireEvent.change(screen.getByPlaceholderText('новый врач'), { target: { value: 'Док' } })
  fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Старт' }))
  })
}

describe('preview video during a session', () => {
  afterEach(() => vi.restoreAllMocks())
  it('after Start the preview gets the capture source stream and play() is called', async () => {
    const { source, play, deps } = setup(true)
    const { container } = render(<StationPage deps={deps} />)
    await start()
    const v = container.querySelector('video')!
    await waitFor(() => expect(v.srcObject).toBe(source))
    expect(play).toHaveBeenCalled()
    expect(v.autoplay).toBe(true)
  })
  it('server lost at start (session creation fails): recording continues and the preview still shows the capture', async () => {
    const { source, play, deps } = setup(false)
    const { container } = render(<StationPage deps={deps} />)
    await start()
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('сервер потерян'))
    const v = container.querySelector('video')!
    expect(v.srcObject).toBe(source)
    expect(play).toHaveBeenCalled()
  })
})

describe('capture format on the stand page (C3)', () => {
  const stream = (w: number, h: number, fps: number) =>
    ({ getVideoTracks: () => [{ getSettings: () => ({ width: w, height: h, frameRate: fps }) }], getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream
  function mockMedia(s: MediaStream) {
    const getUserMedia = vi.fn(async () => s)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia,
        enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'card-1', label: 'Card' }],
        addEventListener: () => {}, removeEventListener: () => {},
      },
    })
    return getUserMedia
  }
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices
  })

  it('preview requests 1080p30 for the device and shows the negotiated size; Start passes the same format to the capture', async () => {
    const gum = mockMedia(stream(1920, 1080, 30))
    const { deps } = setup(true)
    render(<StationPage deps={deps} />)
    await waitFor(() => expect(gum).toHaveBeenCalledWith({ video: { deviceId: { exact: 'card-1' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false }))
    await waitFor(() => expect(screen.getByTestId('negotiated')).toHaveTextContent('1920×1080, 30 к/с'))
    expect(screen.getByTestId('negotiated').querySelector('.warn')).toBeNull()
    await start()
    const sc = (deps as unknown as { startCapture: ReturnType<typeof vi.fn> }).startCapture
    expect(sc).toHaveBeenCalledWith('card-1', expect.objectContaining({ width: 1920, height: 1080, fps: 30 }))
  })

  it('warns when the browser opened a small mode; a stand override is stored and used', async () => {
    const gum = mockMedia(stream(640, 480, 30))
    const { deps } = setup(true)
    render(<StationPage deps={deps} />)
    await waitFor(() => expect(screen.getByTestId('negotiated')).toHaveTextContent('640×480'))
    expect(screen.getByTestId('negotiated')).toHaveTextContent('< 1280')
    fireEvent.change(screen.getByTestId('capture-format'), { target: { value: '720p30' } })
    await waitFor(() => expect(gum).toHaveBeenLastCalledWith({ video: expect.objectContaining({ width: { ideal: 1280 }, height: { ideal: 720 } }), audio: false }))
    expect(JSON.parse(localStorage.getItem('aiiris.station')!).capture).toEqual({ width: 1280, height: 720, fps: 30 })
    await start()
    const sc = (deps as unknown as { startCapture: ReturnType<typeof vi.fn> }).startCapture
    expect(sc).toHaveBeenCalledWith('card-1', expect.objectContaining({ width: 1280, height: 720, fps: 30 }))
  })
})
