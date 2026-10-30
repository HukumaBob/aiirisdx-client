#!/usr/bin/env node
/*
 * Real-browser end-to-end check of the capture pipeline against the running backend.
 *
 * Opens capture-check.html (served by `npm run dev`, which proxies /api to the backend) in
 * headless Chrome with a fake camera, sends the stamped copy over a real RTCPeerConnection,
 * and prints the report of window.captureCheck.runCheck(): the server's marker read rate
 * (from GET /sessions/{id}/log), sender stats and the local recording check.
 *
 * Not part of `npm test` and playwright is deliberately NOT a devDependency: run it with any
 * installed playwright (e.g. the npx cache) on NODE_PATH:
 *
 *   NODE_PATH=$(dirname $(dirname $(npx -y playwright@1.64.1 --version >/dev/null; \
 *     find ~/.npm/_npx -path '*node_modules/playwright/package.json' | head -1))) \
 *   node scripts/chrome-e2e.cjs --url http://localhost:5173/capture-check.html \
 *     --chrome /usr/bin/google-chrome --width 1920 --height 1080 --seconds 30 [--y4m f.y4m]
 *
 * Options: --url, --chrome (executable; default: playwright's chromium), --width, --height,
 * --fps, --seconds, --kbps (max bitrate), --crop x,y,w,h, --reoffer SEC, --y4m FILE (fake
 * camera content from a .y4m file instead of Chrome's built-in pattern), --minkbps N
 * --startkbps N (H.264 bitrate hints; default sender.ts DEFAULT_BITRATE_HINTS), --nohints,
 * --headed.
 */
const { chromium } = require('playwright')

function args() {
  const a = process.argv.slice(2)
  const o = {}
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue
    const k = a[i].slice(2)
    const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true
    o[k] = v
  }
  return o
}

async function main() {
  const o = args()
  const launchArgs = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ]
  if (o.y4m) launchArgs.push(`--use-file-for-fake-video-capture=${o.y4m}`)
  const browser = await chromium.launch({
    headless: !o.headed,
    executablePath: typeof o.chrome === 'string' ? o.chrome : undefined,
    args: launchArgs,
  })
  try {
    const page = await browser.newPage()
    page.on('console', (m) => process.stderr.write(`[page] ${m.text()}\n`))
    page.on('pageerror', (e) => process.stderr.write(`[pageerror] ${e}\n`))
    await page.goto(o.url || 'http://localhost:5173/capture-check.html')
    await page.waitForFunction(() => window.captureCheck)
    const crop = typeof o.crop === 'string' ? o.crop.split(',').map(Number) : null
    const opts = {
      width: Number(o.width || 1920),
      height: Number(o.height || 1080),
      fps: Number(o.fps || 30),
      seconds: Number(o.seconds || 20),
      maxBitrateBps: o.kbps ? Number(o.kbps) * 1000 : undefined,
      bitrateHints: o.nohints
        ? null
        : o.minkbps || o.startkbps
          ? { minKbps: Number(o.minkbps || 0) || undefined, startKbps: Number(o.startkbps || 0) || undefined }
          : undefined,
      reofferAtSec: o.reoffer ? Number(o.reoffer) : undefined,
      crop: crop ? { x: crop[0], y: crop[1], w: crop[2], h: crop[3] } : null,
    }
    const info = await page.evaluate(() => ({
      ua: navigator.userAgent,
      h264: RTCRtpSender.getCapabilities('video').codecs.filter((c) => /h264/i.test(c.mimeType)).length,
      rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
      mp4: MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.640028'),
    }))
    const report = await page.evaluate((opts) => window.captureCheck.runCheck(opts), opts)
    console.log(JSON.stringify({ browser: info, options: opts, report }, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
