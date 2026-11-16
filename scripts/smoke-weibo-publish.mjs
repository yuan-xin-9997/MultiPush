// Build first. Isolated UI fixtures only; never logs in to or publishes on Weibo.
import assert from 'node:assert/strict'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'weibo-ui-check')
mkdirSync(output, { recursive: true })
const time = new Date().toISOString(), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
const user = { id: 'alice', username: 'alice', email: 'alice@example.com', displayName: 'Alice', createdAt: time }
const article = { platform: 'weibo', title: '微博联调文章', html: '<p>这是一条微博测试内容。</p>', text: '微博联调文章\n\n这是一条微博测试内容。\n\n#效率# #工具#', captionBody: '这是一条微博测试内容。', assets: [{ url: '/uploads/test.png', kind: 'image', filename: 'test.png' }], meta: { summary: '摘要', tags: ['效率', '工具'] }, warnings: [] }
const render = { id: 'render-1', contentId: 'content-1', contentTitle: article.title, platforms: ['weibo'], results: [article], options: {}, createdAt: time }
let connected = false, loginPolls = 0, mode = 'normal', submissions = [], publications = []
const app = express()
app.use(express.json())
app.get('/api/auth/me', (_req, res) => res.json({ user }))
app.get('/api/renders', (_req, res) => res.json({ renders: [render] }))
app.get('/api/renders/render-1', (_req, res) => res.json({ render }))
app.get('/api/contents/content-1', (_req, res) => res.json({ content: { id: 'content-1', title: article.title, coverImage: null } }))
app.get('/api/media', (_req, res) => res.json({ media: [] }))
app.get('/uploads/test.png', (_req, res) => res.type('png').send(png))
app.get('/api/weibo/account', (_req, res) => res.json({ account: { status: connected ? 'connected' : 'disconnected', name: connected ? '测试微博作者' : null, checkedAt: time } }))
app.post('/api/weibo/login', (_req, res) => { loginPolls = 0; res.status(202).json({ login: { id: 'login-1', status: 'waiting', qrCode: `data:image/png;base64,${png.toString('base64')}`, message: '请扫码', expiresAt: time } }) })
app.get('/api/weibo/login/login-1', (_req, res) => { loginPolls++; if (loginPolls >= 2) connected = true; res.json({ login: { id: 'login-1', status: connected ? 'connected' : 'waiting', qrCode: connected ? null : `data:image/png;base64,${png.toString('base64')}`, message: connected ? '登录成功' : '请扫码', expiresAt: time } }) })
app.delete('/api/weibo/account', (_req, res) => { connected = false; res.json({ ok: true }) })
app.post('/api/weibo/publications', (req, res) => {
  if (mode === 'failure') { res.status(400).json({ error: 'weibo_rejected', message: '微博发布被拒绝，请稍后重试' }); return }
  submissions.push(req.body)
  const item = { id: `pub-${submissions.length}`, renderId: render.id, title: article.title, mode: 'publish', status: mode === 'uncertain' ? 'uncertain' : 'running', message: '正在处理', url: null, remoteId: '5000000000000001', createdAt: time, updatedAt: time }
  publications.unshift(item); res.status(202).json({ publication: item })
})
app.post('/api/weibo/publications/:id/resolve', (req, res) => {
  const item = publications.find(p => p.id === req.params.id)
  assert.equal(item.status, 'uncertain')
  if (req.body.action === 'check') Object.assign(item, { status: 'running', checking: true })
  else Object.assign(item, { status: req.body.action === 'published' ? 'published' : 'failed', message: req.body.action === 'published' ? '用户已人工核实微博发布成功' : '用户已核实未发布，已解除限制', ...(req.body.action === 'published' ? { url: req.body.articleUrl } : {}) })
  res.json({ publication: item })
})
app.get('/api/weibo/publications', (_req, res) => {
  for (const item of publications) if (item.status === 'running') {
    if (item.checking) Object.assign(item, { status: 'uncertain', checking: false, message: '请人工核实微博发布结果' })
    else Object.assign(item, { status: 'published', message: '微博已发布', url: 'https://weibo.com/1234567890/5000000000000001' })
  }
  res.json({ publications })
})
app.use(express.static(path.join(root, 'web', 'dist')))
app.get('*', (_req, res) => res.sendFile(path.join(root, 'web', 'dist', 'index.html')))
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let browser
try {
  const executablePath = process.env.WEIBO_BROWSER_PATH || process.env.CHROME_BIN || [chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync)
  assert.ok(executablePath, 'Install Chromium or set CHROME_BIN')
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('multipush_token', 'isolated-test-token') })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/publish?platform=weibo`)
  await page.getByRole('heading', { name: '把内容发布到微博' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '发布到微博', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '扫码连接微博', exact: true }).click()
  await page.getByAltText('微博官方登录二维码').waitFor()
  await page.getByText('已连接', { exact: true }).waitFor({ timeout: 15000 })
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.getByRole('button', { name: '发布到微博', exact: true }).click()
  await page.getByRole('button', { name: '确认发布到微博', exact: true }).click()
  await page.getByText('已发布', { exact: true }).waitFor()
  assert.equal(submissions.length, 1)
  assert.equal(await page.getByRole('link', { name: '查看微博' }).getAttribute('href'), 'https://weibo.com/1234567890/5000000000000001')
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true })
  mode = 'failure'
  await page.getByRole('button', { name: '发布到微博', exact: true }).click()
  await page.getByRole('button', { name: '确认发布到微博', exact: true }).click()
  await page.locator('.publish-error').filter({ hasText: '微博发布被拒绝' }).waitFor()
  mode = 'uncertain'
  await page.getByRole('button', { name: '发布到微博', exact: true }).click()
  await page.getByRole('button', { name: '确认发布到微博', exact: true }).click()
  await page.getByText('结果待核实', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '发布到微博', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '核实结果', exact: true }).first().click()
  await page.getByRole('button', { name: '重新自动核实', exact: true }).click()
  await page.getByText('请人工核实微博发布结果', { exact: true }).waitFor()
  await page.getByRole('button', { name: '核实结果', exact: true }).first().click()
  await page.getByRole('button', { name: '我已核实，未发布', exact: true }).click()
  await page.getByRole('button', { name: '确认未发布，解除限制', exact: true }).click()
  await page.getByRole('dialog', { name: '核实微博发布结果' }).waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '发布到微博', exact: true }).isEnabled(), true)
  assert.equal(submissions.length, 2)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile layout must not overflow')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', submissions: submissions.length, loginPolls, screenshots: output }))
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
