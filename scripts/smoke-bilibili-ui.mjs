// Verify the Bilibili render/preview and publish page wiring. Publishing itself
// needs a real Bilibili login and would create a real submission, so this smoke
// mocks /api/bilibili/* while exercising the real renderer, page and record UI.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'bilibili-check')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.BILI_QA_PORT || 34262)
const base = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
assert.ok(chrome, 'Chrome missing')

const server = spawn(process.execPath, ['server/dist/index.js'], {
  cwd: root,
  env: { ...process.env, DATA_DIR: dataDir, WEB_DIST: path.join(root, 'web', 'dist'), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', MULTIPUSH_DESKTOP: '1', PUBLIC_BASE_URL: base, JWT_SECRET: 'bili-smoke' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (chunk) => { log += chunk })
server.stderr.on('data', (chunk) => { log += chunk })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message, timeout = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { const value = await check(); if (value) return value } catch {}
    await delay(200)
  }
  throw new Error(`${message}\n${log}`)
}

let browser
try {
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'server did not start')
  const account = `bili_${Date.now().toString(36)}`
  const password = 'BiliQA!2026'
  const registration = await (await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: account, email: `${account}@example.com`, password }) })).json()
  assert.ok(registration.token, JSON.stringify(registration))
  const token = registration.token
  const auth = { Authorization: `Bearer ${token}` }
  const content = (await (await fetch(`${base}/api/contents`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'B 站图文发布回归测试', kind: 'article', contentHtml: '<h2>第一节</h2><p>这是一篇用于验证 B 站专栏图文发布页的正文。</p><p>第二段内容，包含<strong>加粗</strong>和<a href="https://example.com">链接</a>。</p>' }) })).json()).content
  const render = (await (await fetch(`${base}/api/renders`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ contentId: content.id, platforms: ['bilibili'] }) })).json()).render
  assert.equal(render.results[0].platform, 'bilibili')

  const now = new Date().toISOString()
  let submitted = false
  let polls = 0
  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.route('**/api/bilibili/**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname.endsWith('/account')) {
      return route.fulfill({ json: { account: { status: 'connected', name: '测试 UP 主', checkedAt: now } } })
    }
    if (url.pathname.endsWith('/partitions')) {
      return route.fulfill({ json: { partitions: [{ id: 231, name: '科技 · 计算机技术' }] } })
    }
    if (url.pathname.endsWith('/publications') && method === 'GET') {
      polls += 1
      const published = submitted && polls > 1
      return route.fulfill({ json: { publications: submitted ? [{ id: 'pub-1', renderId: render.id, title: 'B 站图文发布回归测试', type: 'article', status: published ? 'published' : 'running', message: published ? '已发布为 B 站图文（opus 456）' : '正在写入 B 站图文编辑器', url: published ? 'https://www.bilibili.com/opus/456' : null, remoteId: published ? '456' : null, createdAt: now, updatedAt: now }] : [] } })
    }
    if (url.pathname.endsWith('/publications') && method === 'POST') {
      submitted = true
      return route.fulfill({ json: { publication: { id: 'pub-1', renderId: render.id, title: 'B 站图文发布回归测试', type: 'article', status: 'running', message: '正在写入 B 站图文编辑器', url: null, remoteId: null, createdAt: now, updatedAt: now } } })
    }
    if (url.pathname.includes('/login')) {
      return route.fulfill({ json: { login: { id: 'login-1', status: 'waiting', qrCode: null, message: 'waiting', expiresAt: now } } })
    }
    return route.fulfill({ json: {} })
  })

  await page.goto(`${base}/login`)
  await page.evaluate((value) => localStorage.setItem('multipush_token', value), token)
  await page.goto(`${base}/publish?platform=bilibili&renderId=${encodeURIComponent(render.id)}`)
  await page.waitForSelector('.bilibili-publish-page')
  await page.waitForTimeout(700)
  assert.equal(await page.getByText('测试 UP 主').count() > 0, true)
  assert.equal(await page.locator('.bilibili-publish-preview iframe').count(), 1)
  assert.match(await page.locator('.publish-article-title').innerText(), /B 站专栏图文/)
  await page.screenshot({ path: path.join(output, 'article-publish.png') })

  await page.getByRole('button', { name: '发布 B 站图文' }).click()
  await page.getByRole('button', { name: '确认公开发布' }).click()
  await until(async () => (await page.getByText('已发布').count()) > 0, 'publication did not become published', 15_000)
  assert.ok(submitted)
  await page.screenshot({ path: path.join(output, 'published.png') })

  const videoContent = (await (await fetch(`${base}/api/contents`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'B 站视频投稿回归测试', kind: 'video', contentHtml: '<p>这是一条视频简介。</p>' }) })).json()).content
  const videoRender = (await (await fetch(`${base}/api/renders`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ contentId: videoContent.id, platforms: ['bilibili'] }) })).json()).render
  await page.goto(`${base}/publish?platform=bilibili&renderId=${encodeURIComponent(videoRender.id)}`)
  await page.waitForSelector('.bilibili-publish-page')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(output, 'video-publish-debug.png') })
  assert.equal(await page.getByText('视频成片').count() > 0, true)
  assert.equal(await page.getByText('16:9 封面').count() > 0, true)
  assert.equal(await page.getByText('视频简介').count() > 0, true)
  await page.screenshot({ path: path.join(output, 'video-publish.png') })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', renderId: render.id, screenshots: output }))
} finally {
  await browser?.close()
  server.kill()
}
