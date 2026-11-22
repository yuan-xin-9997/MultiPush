import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

// Verify library card rows stay left aligned and equal-width on wide/desktop/mobile.
const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'library-alignment')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = 34270
const base = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find(existsSync)
assert.ok(chrome, 'Chrome missing')
const server = spawn(process.execPath, ['server/dist/index.js'], {
  cwd: root,
  env: { ...process.env, DATA_DIR: dataDir, WEB_DIST: path.join(root, 'web', 'dist'), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', MULTIPUSH_DESKTOP: '1', PUBLIC_BASE_URL: base, JWT_SECRET: 'library-align' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', c => { log += c })
server.stderr.on('data', c => { log += c })
const delay = ms => new Promise(r => setTimeout(r, ms))
async function until(check, message, timeout = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { if (await check()) return } catch {}
    await delay(150)
  }
  throw new Error(`${message}\n${log}`)
}
let browser
try {
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'server did not start')
  const account = `grid_${Date.now().toString(36)}`
  const registration = await (await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: account, email: `${account}@example.com`, password: 'GridQA!2026' }) })).json()
  assert.ok(registration.token, JSON.stringify(registration))
  const auth = { Authorization: `Bearer ${registration.token}`, 'Content-Type': 'application/json' }
  for (let i = 1; i <= 12; i += 1) {
    const response = await fetch(`${base}/api/contents`, { method: 'POST', headers: auth, body: JSON.stringify({ title: `网格对齐测试文章 ${i}`, kind: 'article', contentHtml: `<p>第 ${i} 篇测试文章正文。</p>`, tags: ['测试'] }) })
    assert.ok(response.ok, await response.text())
  }
  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage({ viewport: { width: 3141, height: 1335 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`${base}/login`)
  await page.fill('input[name="account"], #account', account)
  await page.fill('input[type="password"]', 'GridQA!2026')
  await page.click('button[type="submit"]')
  await page.waitForURL(/library/, { timeout: 20_000 })
  await until(async () => (await page.locator('.document-card').count()) === 12, 'twelve cards should render')
  const boxes = await page.locator('.document-card').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } }))
  const rows = [...new Set(boxes.map(b => b.y))]
  assert.ok(rows.length >= 2, `expected at least two rows, got ${rows.length}`)
  const firstRowX = boxes.find(b => b.y === rows[0]).x
  const lastRowX = boxes.find(b => b.y === rows[rows.length - 1]).x
  console.log('rows', rows, 'firstRowX', firstRowX, 'lastRowX', lastRowX)
  assert.equal(lastRowX, firstRowX, 'last row should start at the same left edge as the first row')
  await page.screenshot({ path: path.join(output, 'library-wide.png') })

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.waitForTimeout(300)
  const desktopBoxes = await page.locator('.document-card').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) } }))
  const desktopRows = [...new Set(desktopBoxes.map(b => b.y))]
  assert.equal(desktopBoxes.find(b => b.y === desktopRows[desktopRows.length - 1]).x, desktopBoxes[0].x)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  await page.screenshot({ path: path.join(output, 'library-desktop.png') })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  await page.screenshot({ path: path.join(output, 'library-mobile.png') })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', screenshot: output }))
} finally {
  await browser?.close()
  server.kill()
}
