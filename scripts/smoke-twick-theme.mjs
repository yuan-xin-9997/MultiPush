// Regression: Twick Studio's global dark stylesheet must be removed when the
// studio route unmounts, otherwise library cards stay dark after SPA navigation.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'twick-theme-check')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.TWICK_THEME_QA_PORT || 34272)
const base = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
assert.ok(chrome, 'Install Chrome or set CHROME_BIN')

const server = spawn(process.execPath, ['server/dist/index.js'], {
  cwd: root,
  env: { ...process.env, DATA_DIR: dataDir, WEB_DIST: path.join(root, 'web', 'dist'), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', MULTIPUSH_DESKTOP: '1', PUBLIC_BASE_URL: base, JWT_SECRET: 'twick-theme' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', chunk => { log += chunk })
server.stderr.on('data', chunk => { log += chunk })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, message, timeout = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { if (await check()) return } catch { /* retry */ }
    await delay(150)
  }
  throw new Error(`${message}\n${log}`)
}

let browser
try {
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'server did not start')
  const account = `theme_${Date.now().toString(36)}`
  const registration = await (await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account, email: `${account}@example.com`, password: 'ThemeQA!2026' }),
  })).json()
  assert.ok(registration.token, JSON.stringify(registration))
  const auth = { Authorization: `Bearer ${registration.token}`, 'Content-Type': 'application/json' }
  const content = (await (await fetch(`${base}/api/contents`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ title: 'Twick 主题回归', kind: 'video', contentHtml: '<p>测试</p>' }),
  })).json()).content

  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(`${base}/login`)
  await page.fill('input[name="account"], #account', account)
  await page.fill('input[type="password"]', 'ThemeQA!2026')
  await page.click('button[type="submit"]')
  await page.waitForURL(/library/, { timeout: 20_000 })
  await until(async () => (await page.locator('.document-card').count()) === 1, 'one library card should render')

  const cardColor = () => page.locator('.document-card').first().evaluate(element => getComputedStyle(element).backgroundColor)
  assert.equal(await cardColor(), 'rgb(255, 255, 255)')

  // Use in-app navigation so Twick's lazy-loaded CSS stays in this document.
  await page.goto(`${base}/video/${content.id}`)
  await page.getByRole('button', { name: /新版剪辑（试验）/ }).click()
  await page.waitForSelector('.studio-container', { timeout: 90_000 })
  assert.equal(await page.locator('.studio-container').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(23, 23, 23)')
  await page.getByRole('button', { name: /旧版工作台/ }).click()
  await page.waitForURL(/\/video\//, { timeout: 20_000 })
  await page.getByRole('button', { name: /内容库/ }).click()
  await page.waitForURL(/\/library/, { timeout: 20_000 })
  await until(async () => (await page.locator('.document-card').count()) === 1, 'library card should return')
  await page.waitForTimeout(300)
  assert.equal(await cardColor(), 'rgb(255, 255, 255)', 'Twick dark .card style must not leak after exiting studio')
  assert.notEqual(await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(23, 23, 23)', 'Twick body background must not leak')
  await page.screenshot({ path: path.join(output, 'library-after-studio.png') })
  console.log(JSON.stringify({ status: 'passed', screenshot: output }))
} finally {
  await browser?.close()
  server.kill()
}
