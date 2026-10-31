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
