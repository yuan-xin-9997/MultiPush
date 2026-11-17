// Local UI smoke for the Douban diary render/publish pages. It uses an isolated
// desktop-mode server and never contacts Douban.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'douban-ui-check')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.DOUBAN_QA_PORT || 34213)
const base = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN || process.env.WECHAT_BROWSER_PATH || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)

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
    JWT_SECRET: 'douban-ui-smoke',
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
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'Douban UI server did not start')
  const account = `douban_${Date.now().toString(36)}`
  const registration = await (await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account, email: `${account}@example.com`, password: 'DoubanQA!2026' }),
  })).json()
  const token = registration.token
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const created = await (await fetch(`${base}/api/contents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: '豆瓣日记验收',
      contentHtml: '<p>第一篇豆瓣日记的正文。</p><p><img src="/uploads/demo.png" alt="图"></p><p><em>图：图片说明：）</em></p>',
      contentJson: {},
    }),
  })).json()
  const rendered = await (await fetch(`${base}/api/renders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contentId: created.content.id, platforms: ['douban'], options: { authorName: '豆瓣作者' } }),
  })).json()
  const renderId = rendered.render.id
  assert.ok(rendered.render.results.some((item) => item.platform === 'douban'))

  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.addInitScript((value) => { if (window === window.top) localStorage.setItem('multipush_token', value) }, token)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/publish?platform=douban&renderId=${encodeURIComponent(renderId)}`)
  await page.getByRole('heading', { name: '把内容发布到豆瓣日记' }).waitFor()
  await page.getByText('豆瓣日记验收', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: '扫码连接豆瓣' }).waitFor()
  await page.getByRole('button', { name: '发布到豆瓣日记' }).waitFor()
  await page.screenshot({ path: path.join(output, 'publish-page.png'), fullPage: true })

  await page.goto(`${base}/render?renderId=${encodeURIComponent(renderId)}`)
  await page.getByText('豆瓣日记', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: '发布到豆瓣日记' }).waitFor()
  await page.screenshot({ path: path.join(output, 'render-page.png'), fullPage: false })
  assert.deepEqual(errors, [], errors.join('; '))
  console.log(JSON.stringify({ ok: true, renderId, output }))
} finally {
  await browser?.close().catch(() => {})
  server.kill('SIGTERM')
  await new Promise((resolve) => server.once('exit', resolve))
}
