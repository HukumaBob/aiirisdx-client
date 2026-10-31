#!/usr/bin/env node
/*
 * Headless-Chrome check of the stand page (src/station) against the running backend
 * (vite dev server proxying /api). Usage (playwright on NODE_PATH, see chrome-e2e.cjs):
 *   node scripts/station-e2e.cjs --url http://localhost:5173/ --chrome /usr/bin/google-chrome [--seconds 8] [--crop] [--save DIR] [--emr URL]
 * Fake camera; adds a doctor, optionally draws a crop with the mouse, Start, waits, Stop,
 * prints the status line and the "finished" summary.
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
    await page.getByRole('button', { name: 'Стоп' }).click()
    await page.getByTestId('finished').waitFor({ timeout: 60000 })
    out.finished = await page.getByTestId('finished').innerText()
    out.state = await page.getByTestId('state').innerText()
    await page.getByTestId('container-status').filter({ hasText: 'Контейнер' }).waitFor({ timeout: 60000 })
    await page.waitForFunction(() => !document.querySelector('[data-testid=container-status]')?.textContent?.includes('сборка'), null, { timeout: 60000 })
    out.containerStatus = await page.getByTestId('container-status').innerText()
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
