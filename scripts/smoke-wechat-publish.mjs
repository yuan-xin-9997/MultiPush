// Build first. Uses an isolated local API fixture; never logs in to or publishes on WeChat.
import assert from 'node:assert/strict'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'publish-ui-check')
mkdirSync(output, { recursive: true })
const time = new Date().toISOString()
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
const qrCode = `data:image/png;base64,${png.toString('base64')}`
const user = { id: 'alice', username: 'alice', email: 'alice@example.com', displayName: 'Alice', avatarUrl: null, createdAt: time }
const content = { id: 'content-1', title: '公众号联调文章', excerpt: '这是摘要', coverImage: null, contentHtml: '<p>这是一篇测试文章。</p>' }
const article = { platform: 'wechat', title: '公众号联调文章', html: '<section><p style="line-height:1.8">这是一篇测试文章。</p></section>', meta: { summary: '这是摘要' }, warnings: [] }
const render = { id: 'render-1', contentId: content.id, contentTitle: content.title, platforms: ['wechat'], results: [article], options: { authorName: '测试作者' }, createdAt: time }
const media = { id: 'cover-1', kind: 'image', url: '/uploads/cover.png', filename: 'cover.png', originalName: 'cover.png', mimeType: 'image/png', size: png.length, createdAt: time }
let connected = false
let loginPolls = 0
let mode = 'normal'
let submissions = []
let publications = []
const app = express()
app.use(express.json())
app.get('/api/auth/me', (_req, res) => res.json({ user }))
app.get('/api/wechat/account', (_req, res) => res.json({ account: { status: connected ? 'connected' : 'disconnected', name: connected ? '测试公众号' : null, checkedAt: connected ? time : null } }))
app.post('/api/wechat/login', (_req, res) => { loginPolls = 0; res.json({ login: { id: 'login-1', status: 'waiting', qrCode, message: '请扫描二维码登录', expiresAt: new Date(Date.now() + 300000).toISOString() } }) })
app.get('/api/wechat/login/login-1', (_req, res) => { loginPolls++; if (loginPolls >= 2) connected = true; res.json({ login: { id: 'login-1', status: connected ? 'connected' : 'scanned', qrCode: connected ? null : qrCode, message: connected ? '登录成功' : '已扫码，请在手机确认', expiresAt: new Date(Date.now() + 300000).toISOString() } }) })
app.delete('/api/wechat/account', (_req, res) => { connected = false; res.json({ ok: true }) })
app.get('/api/renders', (_req, res) => res.json({ renders: [render] }))
app.get('/api/renders/render-1', (_req, res) => res.json({ render }))
app.get('/api/contents/content-1', (_req, res) => res.json({ content }))
app.get('/api/media', (_req, res) => res.json({ media: [] }))
app.post('/api/media', (_req, res) => res.json({ media }))
app.get('/uploads/cover.png', (_req, res) => res.type('png').send(png))
app.get('/api/wechat/publications', (_req, res) => res.json({ publications }))
app.post('/api/wechat/publications', (req, res) => {
  submissions.push(req.body)
  const publication = { id: `publication-${submissions.length}`, renderId: render.id, title: article.title, mode: req.body.mode, status: mode === 'uncertain' ? 'uncertain' : 'running', message: '正在处理', qrCode: null, url: null, remoteId: 'draft-1', createdAt: time, updatedAt: time, polls: 0 }
  publications.unshift(publication)
  res.status(202).json({ publication })
})
app.get('/api/wechat/publications/:id', (req, res) => {
  const publication = publications.find((item) => item.id === req.params.id)
  publication.polls++
  if (publication.mode === 'draft') Object.assign(publication, { status: 'draft', message: '已保存到公众号草稿箱' })
  else if (publication.polls === 1) Object.assign(publication, { status: 'awaiting_confirmation', message: '请管理员扫码确认发表', qrCode })
  else Object.assign(publication, { status: 'published', message: '微信已确认发表成功', qrCode: null, url: 'https://mp.weixin.qq.com/s/test-article' })
  res.json({ publication })
})
app.use(express.static(path.join(root, 'web', 'dist')))
app.get('*', (_req, res) => res.sendFile(path.join(root, 'web', 'dist', 'index.html')))
const server = app.listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let browser
try {
  const chrome = process.env.WECHAT_BROWSER_PATH || process.env.CHROME_BIN || [chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync)
  assert.ok(chrome, 'Install Chromium or set CHROME_BIN to a browser executable')
  browser = await chromium.launch({ executablePath: chrome, headless: true, chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('multipush_token', 'isolated-test-token') })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/publish?renderId=render-1`)
  await page.getByRole('button', { name: '扫码连接', exact: true }).click()
  await page.getByAltText('微信公众号登录二维码，请使用管理员微信扫码').waitFor()
  await page.getByText('已连接', { exact: true }).waitFor({ timeout: 15000 })
  assert.equal(await page.getByRole('dialog').count(), 0, 'Login dialog should close after connection')
  await page.getByLabel('上传公众号封面').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png })
  await page.getByRole('button', { name: '保存到草稿箱', exact: true }).click()
  await page.getByText('已保存草稿', { exact: true }).waitFor({ timeout: 10000 })
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].mode, 'draft')
  await page.getByRole('button', { name: '正式发表', exact: true }).click()
  await page.getByRole('dialog', { name: '正式发表到微信公众号？' }).waitFor()
  assert.equal(submissions.length, 1, 'Opening confirmation must not submit')
  await page.getByRole('button', { name: '确认正式发表', exact: true }).click()
  await page.getByAltText('请使用公众号管理员微信扫描此二维码确认发表').waitFor({ timeout: 10000 })
  await page.getByText('已发表', { exact: true }).waitFor({ timeout: 12000 })
  assert.equal(submissions.length, 2)
  assert.equal(submissions[1].mode, 'publish')
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true })
  mode = 'uncertain'
  await page.getByRole('button', { name: '保存到草稿箱', exact: true }).click()
  await page.getByText('结果待核实', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '正式发表', exact: true }).isDisabled(), true)
  await page.reload()
  await page.getByText('结果待核实', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '正式发表', exact: true }).isDisabled(), true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.frameLocator('iframe').getByText('这是一篇测试文章。').waitFor()
  await page.waitForTimeout(350)
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile layout should not overflow')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', submissions: submissions.length, loginPolls, screenshots: output }))
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
