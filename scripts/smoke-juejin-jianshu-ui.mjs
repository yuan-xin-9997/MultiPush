// Local UI smoke for the Juejin/Jianshu draft+publish pages. No platform login.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'juejin-jianshu-ui-check')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.JJ_QA_PORT || 34215)
const base = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN || process.env.WECHAT_BROWSER_PATH || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
assert.ok(chrome, 'Install Chrome or set CHROME_BIN')

const server = spawn(process.execPath, ['server/dist/index.js'], {
  cwd: root,
  env: { ...process.env, DATA_DIR: dataDir, WEB_DIST: path.join(root, 'web', 'dist'), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', MULTIPUSH_DESKTOP: '1', PUBLIC_BASE_URL: base, JWT_SECRET: 'juejin-jianshu-ui-smoke' },
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
  const account = `jj_${Date.now().toString(36)}`
  const registration = await (await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: account, email: `${account}@example.com`, password: 'JJQA!2026' }) })).json()
  const token = registration.token
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const created = await (await fetch(`${base}/api/contents`, { method: 'POST', headers, body: JSON.stringify({ title: '掘金简书验收', contentHtml: '<h2>小节</h2><p>正文内容</p><p><img src="/uploads/demo.png" alt="图"></p><p><em>图：说明</em></p>', contentJson: {} }) })).json()
  const rendered = await (await fetch(`${base}/api/renders`, { method: 'POST', headers, body: JSON.stringify({ contentId: created.content.id, platforms: ['juejin', 'jianshu'], options: { authorName: '测试作者' } }) })).json()
  assert.ok(rendered.render.results.some((item) => item.platform === 'juejin'))
  assert.ok(rendered.render.results.some((item) => item.platform === 'jianshu'))

  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.addInitScript((value) => { if (window === window.top) localStorage.setItem('multipush_token', value) }, token)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(`${base}/publish?platform=juejin&renderId=${encodeURIComponent(rendered.render.id)}`)
  await page.getByRole('heading', { name: '把内容发布到掘金' }).waitFor()
  await page.getByRole('button', { name: '保存草稿' }).waitFor()
  await page.getByRole('button', { name: '直接发布' }).waitFor()
  await page.getByRole('button', { name: '扫码连接掘金' }).waitFor()
  await page.screenshot({ path: path.join(output, 'juejin-publish-page.png'), fullPage: true })

  await page.goto(`${base}/publish?platform=jianshu&renderId=${encodeURIComponent(rendered.render.id)}`)
  await page.getByRole('heading', { name: '把内容发布到简书' }).waitFor()
  await page.getByRole('button', { name: '保存草稿' }).waitFor()
  await page.getByRole('button', { name: '直接发布' }).waitFor()
  await page.getByRole('button', { name: '连接简书' }).waitFor()
  await page.screenshot({ path: path.join(output, 'jianshu-publish-page.png'), fullPage: true })

  await page.goto(`${base}/render?renderId=${encodeURIComponent(rendered.render.id)}`)
  await page.getByText('掘金', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: '发布到掘金' }).waitFor()
  await page.screenshot({ path: path.join(output, 'render-page.png'), fullPage: false })
  assert.deepEqual(errors, [], errors.join('; '))
  console.log(JSON.stringify({ ok: true, renderId: rendered.render.id, output }))
} finally {
  await browser?.close().catch(() => {})
  server.kill('SIGTERM')
  await new Promise((resolve) => server.once('exit', resolve))
}
