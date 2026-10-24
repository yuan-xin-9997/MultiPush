// Build first. Isolated UI fixtures only; never logs in to or publishes on Zhihu.
import assert from 'node:assert/strict'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'zhihu-ui-check')
mkdirSync(output, { recursive: true })
const time = new Date().toISOString(), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
const user = { id: 'alice', username: 'alice', email: 'alice@example.com', displayName: 'Alice', createdAt: time }
const article = { platform: 'zhihu', title: '知乎联调文章', html: '<h2>标题</h2><p>这是一篇知乎测试文章。</p><figure><img src="/uploads/test.png"><figcaption>图 1：说明</figcaption></figure><ul><li>第一项</li><li><a href="https://github.com/example/repo">项目源码</a></li></ul>', meta: { summary: '摘要' }, warnings: [] }
const render = { id: 'render-1', contentId: 'content-1', contentTitle: article.title, platforms: ['zhihu'], results: [article], options: {}, createdAt: time }
let connected = false, loginPolls = 0, mode = 'normal', submissions = [], publications = []
let initialGatewayError = true
const gatewayHtml = '<!doctype html><html><title>Cloudflare 502</title><body>gateway-internal-detail</body></html>'
const app = express()
app.use(express.json())
app.get('/api/auth/me', (_req, res) => res.json({ user }))
app.get('/api/renders', (_req, res) => res.json({ renders: [render] }))
app.get('/api/renders/render-1', (_req, res) => res.json({ render }))
app.get('/api/contents/content-1', (_req, res) => res.json({ content: { id: 'content-1', title: article.title, coverImage: null } }))
app.get('/api/media', (_req, res) => res.json({ media: [] }))
app.get('/uploads/test.png', (_req, res) => res.type('png').send(png))
app.get('/api/zhihu/account', (_req, res) => res.json({ account: { status: connected ? 'connected' : 'disconnected', name: connected ? '测试知乎作者' : null, checkedAt: time } }))
app.post('/api/zhihu/login', (_req, res) => {
  if (initialGatewayError) { initialGatewayError = false; res.status(502).type('html').send(gatewayHtml); return }
  loginPolls = 0
  res.status(202).json({ login: { id: 'login-1', status: 'waiting', qrCode: null, message: '正在准备二维码', expiresAt: time } })
})
app.get('/api/zhihu/login/login-1', (_req, res) => {
  loginPolls++
  if (loginPolls === 1) { res.status(502).type('html').send(gatewayHtml); return }
  if (loginPolls >= 4) connected = true
  res.json({ login: { id: 'login-1', status: connected ? 'connected' : 'waiting', qrCode: connected ? null : `data:image/png;base64,${png.toString('base64')}`, message: connected ? '登录成功' : '请扫码', expiresAt: time } })
})
app.delete('/api/zhihu/account', (_req, res) => { connected = false; res.json({ ok: true }) })
app.post('/api/zhihu/publications', (req, res) => {
  if (mode === 'failure') { res.status(400).json({ error: 'zhihu_image_upload', message: '知乎图片上传失败，请重试' }); return }
  submissions.push(req.body)
  const item = { id: `pub-${submissions.length}`, renderId: render.id, title: article.title, mode: req.body.mode, status: mode === 'uncertain' ? 'uncertain' : 'running', message: '正在处理', url: null, remoteId: '123', createdAt: time, updatedAt: time }
  publications.unshift(item); res.status(202).json({ publication: item })
})
app.get('/api/zhihu/publications', (_req, res) => {
  for (const item of publications) if (item.status === 'running') Object.assign(item, { status: item.mode === 'draft' ? 'draft' : 'published', message: '已核对知乎保存的正文', url: `https://zhuanlan.zhihu.com/p/123${item.mode === 'draft' ? '/edit' : ''}` })
  res.json({ publications })
})
app.use(express.static(path.join(root, 'web', 'dist')))
app.get('*', (_req, res) => res.sendFile(path.join(root, 'web', 'dist', 'index.html')))
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let browser
try {
  const executablePath = process.env.ZHIHU_BROWSER_PATH || process.env.CHROME_BIN || [chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync)
  assert.ok(executablePath, 'Install Chromium or set CHROME_BIN')
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('multipush_token', 'isolated-test-token') })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/publish?platform=zhihu`)
  await page.getByRole('heading', { name: '把内容发布到知乎' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '正式发布到知乎', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '扫码连接知乎', exact: true }).click()
  await page.getByText('服务连接暂时异常（HTTP 502），请稍后重试。', { exact: true }).waitFor()
  assert.equal((await page.locator('body').innerText()).includes('gateway-internal-detail'), false, 'Never display an upstream HTML error page')
  await page.getByRole('button', { name: '重新连接', exact: true }).click()
  await page.getByText('正在获取知乎官方登录二维码…', { exact: true }).waitFor()
  await page.getByAltText('知乎官方登录二维码').waitFor()
  await page.getByText('已连接', { exact: true }).waitFor({ timeout: 15000 })
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.getByRole('button', { name: '保存到知乎草稿', exact: true }).click()
  await page.getByText('已保存草稿', { exact: true }).waitFor()
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].mode, 'draft')
  await page.getByRole('button', { name: '正式发布到知乎', exact: true }).click()
  assert.equal(submissions.length, 1, 'Opening confirmation must not publish')
  await page.getByRole('button', { name: '确认发布到知乎', exact: true }).click()
  await page.getByText('已发布', { exact: true }).waitFor()
  assert.equal(submissions[1].mode, 'publish')
  assert.equal(await page.getByRole('link', { name: '查看知乎文章' }).getAttribute('href'), 'https://zhuanlan.zhihu.com/p/123')
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true })
  mode = 'failure'
  await page.getByRole('button', { name: '保存到知乎草稿', exact: true }).click()
  await page.locator('.publish-error').filter({ hasText: '知乎图片上传失败' }).waitFor()
  mode = 'uncertain'
  await page.getByRole('button', { name: '保存到知乎草稿', exact: true }).click()
  await page.getByText('结果待核实', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '正式发布到知乎', exact: true }).isDisabled(), true)
  await page.reload()
  await page.getByText('结果待核实', { exact: true }).waitFor()
  assert.equal(submissions.length, 3)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.frameLocator('iframe').getByText('这是一篇知乎测试文章。').waitFor()
  await page.locator('iframe').scrollIntoViewIfNeeded()
  await page.waitForTimeout(350)
  await page.locator('iframe').screenshot({ path: path.join(output, 'mobile-preview.png') })
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile layout must not overflow')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', submissions: submissions.length, loginPolls, screenshots: output }))
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
