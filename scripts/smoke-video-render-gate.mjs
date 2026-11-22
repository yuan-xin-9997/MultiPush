// Verify the video render gate: an unedited video with raw materials must ask
// before rendering, can be cancelled, and can be simple-concatenated on confirm.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'video-render-gate-check')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.VIDEO_GATE_QA_PORT || 34244)
const base = `http://127.0.0.1:${port}`
const fixture = path.join(root, 'server', 'test', 'fixtures', 'clip_a.mp4')
assert.ok(existsSync(fixture), 'video fixture missing')
const chrome = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
assert.ok(chrome, 'Install Chrome or set CHROME_BIN')

const server = spawn(process.execPath, ['server/dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    WEB_DIST: path.join(root, 'web', 'dist'),
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    MULTIPUSH_DESKTOP: '1',
    PUBLIC_BASE_URL: base,
    JWT_SECRET: 'video-gate-ui-smoke',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (chunk) => { log += chunk })
server.stderr.on('data', (chunk) => { log += chunk })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message, timeout = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { const value = await check(); if (value) return value } catch { /* retry */ }
    await delay(150)
  }
  throw new Error(`${message}\n${log}`)
}

let browser
try {
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'server did not start')
  const account = `video_gate_${Date.now().toString(36)}`
  const registration = await (await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account, email: `${account}@example.com`, password: 'VideoGate!2026' }),
  })).json()
  assert.ok(registration.token, JSON.stringify(registration))
  const token = registration.token
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const content = (await (await fetch(`${base}/api/contents`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ title: '未剪辑视频渲染门禁', kind: 'video', contentHtml: '<p>未剪辑视频素材。</p>' }),
  })).json()).content
  assert.ok(content.id)

  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${base}/login`)
  await page.fill('input[name="account"], #account', account)
  await page.fill('input[type="password"]', 'VideoGate!2026')
  await page.click('button[type="submit"]')
  await page.waitForURL(/library/, { timeout: 20_000 })

  await page.goto(`${base}/video/${content.id}`)
  await page.waitForSelector('.video-mode-switch', { timeout: 20_000 })
  assert.match(await page.locator('body').innerText(), /素材模式/)
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(fixture)
  await until(async () => (await page.locator('.video-material-item').count()) === 1, 'one raw material should appear')
  await until(async () => /已保存/.test(await page.locator('.video-save-state').innerText()), 'material timeline autosaves')
  await page.waitForTimeout(3500)
  await page.screenshot({ path: path.join(output, 'material-mode.png') })

  // The render workbench should ask before rendering an unedited video.
  await page.goto(`${base}/render?contentId=${content.id}&platforms=wechat`)
  await page.waitForSelector('.confirm-dialog', { timeout: 20_000 })
  const gateText = await page.locator('.confirm-dialog').innerText()
  assert.match(gateText, /视频素材未剪辑/)
  assert.match(gateText, /简单拼接输出视频/)
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(output, 'render-gate.png') })
  await page.getByRole('button', { name: '否，取消渲染' }).click()
  await until(async () => (await page.locator('.confirm-dialog').count()) === 0, 'gate closes after cancel')
  assert.equal(await page.locator('.render-stage').count(), 0, 'cancelled render must not create a result')

  // Re-run and confirm the simple concatenation + render.
  await page.getByRole('button', { name: /生成渲染/ }).first().click()
  await page.waitForSelector('.confirm-dialog', { timeout: 20_000 })
  await page.getByRole('button', { name: '是，简单拼接并渲染' }).click()
  await until(async () => (await page.locator('.render-stage .phone-shell video').count()) > 0, 'render should embed the simple-concatenated cut', 90_000)
  const videoSrc = await page.locator('.render-stage .phone-shell video').first().getAttribute('src')
  assert.ok(videoSrc && videoSrc.includes('/uploads/'), `expected uploaded export, got ${videoSrc}`)
  const exportsData = await (await fetch(`${base}/api/contents/${content.id}/video/exports`, { headers: { Authorization: `Bearer ${token}` } })).json()
  const completed = exportsData.exports?.find((item) => item.status === 'completed' && item.outputMedia)
  assert.ok(completed, 'simple concat should create a completed export')
  assert.ok(videoSrc.includes(completed.outputMedia.filename), 'render should use the simple-concatenated export')
  await page.screenshot({ path: path.join(output, 'render-after-concat.png') })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', contentId: content.id, screenshots: output }))
} finally {
  await browser?.close()
  server.kill()
}
