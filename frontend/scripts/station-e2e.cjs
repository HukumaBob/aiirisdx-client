#!/usr/bin/env node
/*
 * Headless-Chrome check of the stand page (src/station) against the running backend
 * (vite dev server proxying /api). Usage (playwright on NODE_PATH, see chrome-e2e.cjs):
 *   node scripts/station-e2e.cjs --url http://localhost:5173/ --chrome /usr/bin/google-chrome [--seconds 8] [--crop] [--save DIR] [--emr URL]
 * Fake camera; adds a doctor, optionally draws a crop with the mouse, Start, waits, Stop,
 * prints the status line and the "finished" summary.
 * --accounting: also prints where the frames went -- capture counter ("отправлено"), the
 * sender's outbound-rtp stats (framesEncoded / framesSent, via a wrapped RTCPeerConnection),
 * the server's ingest counters (GET /api/sessions/{id}: received / delivered / skipped) and
 * the log (frame lines, dropped), so sent = encoder-skipped + received + ... can be checked.
 */
const { chromium } = require('playwright')
const a = process.argv.slice(2)
const o = {}
for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: typeof o.chrome === 'string' ? o.chrome : undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    page.on('console', (m) => process.stderr.write(`[page] ${m.text()}\n`))
    page.on('pageerror', (e) => process.stderr.write(`[pageerror] ${e}\n`))
    let sessionId = null
    if (o.accounting) {
      await page.addInitScript(() => {
        const PC = window.RTCPeerConnection
        window.__pcs = []
        window.RTCPeerConnection = function (...args) {
          const pc = new PC(...args)
          window.__pcs.push(pc)
          return pc
        }
        window.RTCPeerConnection.prototype = PC.prototype
        Object.assign(window.RTCPeerConnection, PC)
      })
      page.on('response', async (r) => {
        if (r.request().method() === 'POST' && /\/api\/sessions$/.test(r.url())) sessionId = (await r.json().catch(() => ({}))).session_id ?? null
      })
    }
    await page.goto(o.url || 'http://localhost:5173/')
    await page.getByPlaceholder('stand-1').fill('stand-1')
    if (o.emr) await page.getByPlaceholder('https://emr.example/api/results').fill(String(o.emr))
    await page.getByPlaceholder('новый врач').fill('Тест')
    await page.getByRole('button', { name: 'Добавить' }).click()
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
    const out = { startWithoutDoctorBlocked: null }
    if (o.crop) {
      await page.getByLabel('Включить').check()
      const box = await page.locator('[data-testid=crop-layer]').boundingBox()
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 5 })
      await page.mouse.up()
      out.cropInfo = await page.getByTestId('crop-info').innerText()
    }
    await page.getByRole('button', { name: 'Старт' }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid=state]')?.textContent === 'идёт сеанс', null, { timeout: 20000 })
    await page.waitForTimeout(Number(o.seconds || 8) * 1000)
    const t0 = await page.evaluate(() => { const v = document.querySelector('video'); return { paused: v.paused, t: v.currentTime } })
    await page.waitForTimeout(1500)
    const t1 = await page.evaluate(() => { const v = document.querySelector('video'); return { paused: v.paused, t: v.currentTime } })
    out.previewPlaying = !t1.paused && t1.t > t0.t
    out.previewTimes = [t0.t, t1.t]
    out.runningStatus = await page.getByTestId('statusline').innerText()
    if (o.accounting) {
      out.senderAtStop = await page.evaluate(async () => {
        const rows = []
        for (const pc of window.__pcs) {
          const st = await pc.getStats().catch(() => null)
          st?.forEach((r) => {
            if (r.type === 'outbound-rtp' && r.kind === 'video') rows.push({ framesEncoded: r.framesEncoded, framesSent: r.framesSent, keyFramesEncoded: r.keyFramesEncoded, frameWidth: r.frameWidth, frameHeight: r.frameHeight, framesPerSecond: r.framesPerSecond, qualityLimitationReason: r.qualityLimitationReason, encoderImplementation: r.encoderImplementation, targetBitrate: r.targetBitrate })
            if (r.type === 'media-source' && r.kind === 'video') rows.push({ mediaSourceFrames: r.frames, mediaSourceFps: r.framesPerSecond })
          })
        }
        return rows
      })
      out.statusAtStop = await page.getByTestId('statusline').innerText()
    }
    await page.getByRole('button', { name: 'Стоп' }).click()
    await page.getByTestId('finished').waitFor({ timeout: 60000 })
    out.finished = await page.getByTestId('finished').innerText()
    out.state = await page.getByTestId('state').innerText()
    await page.getByTestId('container-status').filter({ hasText: 'Контейнер' }).waitFor({ timeout: 60000 })
    await page.waitForFunction(() => !document.querySelector('[data-testid=container-status]')?.textContent?.includes('сборка'), null, { timeout: 60000 })
    out.containerStatus = await page.getByTestId('container-status').innerText()
    if (o.accounting && sessionId) {
      const base = new URL('/api', o.url || 'http://localhost:5173/').href
      out.serverStatus = await (await fetch(`${base}/sessions/${sessionId}`)).json()
      const lines = (await (await fetch(`${base}/sessions/${sessionId}/log`)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
      const fr = lines.filter((l) => l.type === 'frame')
      const ids = fr.map((f) => f.frame_id)
      out.serverLog = { frameLines: fr.length, dropped: fr.filter((f) => f.dropped).length, minId: Math.min(...ids), maxId: Math.max(...ids), footer: lines.at(-1) }
    }
    if (o.save) {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Сохранить контейнер' }).click()])
      const path = require('path').join(String(o.save), dl.suggestedFilename())
      await dl.saveAs(path)
      out.savedContainer = path
    }
    console.log(JSON.stringify(out, null, 2))
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
