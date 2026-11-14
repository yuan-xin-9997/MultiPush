// Build first. Isolated UI fixtures only; never connects to or publishes on a real Halo blog.
import assert from 'node:assert/strict'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'blog-ui-check')
mkdirSync(output, { recursive: true })
const time = new Date().toISOString(), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
const user = { id: 'alice', username: 'alice', email: 'alice@example.com', displayName: 'Alice', createdAt: time }
const article = { platform: 'blog', title: '个人博客联调文章', html: '<h2>标题</h2><p>这是一篇个人博客测试文章。</p><figure><img src="/uploads/test.png"><figcaption>图 1：说明</figcaption></figure><ul><li>第一项</li><li><a href="https://github.com/example/repo">项目源码</a></li></ul>', meta: { summary: '摘要', tags: ['效率', '工具'] }, warnings: [] }
const render = { id: 'render-1', contentId: 'content-1', contentTitle: article.title, platforms: ['blog'], results: [article], options: {}, createdAt: time }
let connected = false, mode = 'normal', submissions = [], publications = []
const app = express()
app.use(express.json())
app.get('/api/auth/me', (_req, res) => res.json({ user }))
app.get('/api/renders', (_req, res) => res.json({ renders: [render] }))
app.get('/api/renders/render-1', (_req, res) => res.json({ render }))
app.get('/api/contents/content-1', (_req, res) => res.json({ content: { id: 'content-1', title: article.title, coverImage: null } }))
app.get('/api/media', (_req, res) => res.json({ media: [] }))
app.get('/uploads/test.png', (_req, res) => res.type('png').send(png))
app.get('/api/blog/account', (_req, res) => res.json({ account: { status: connected ? 'connected' : 'disconnected', name: connected ? '测试个人博客' : null, baseUrl: connected ? 'https://blog.example.com' : null, checkedAt: connected ? time : null } }))
app.post('/api/blog/connect', (req, res) => {
  if (!req.body?.baseUrl || !req.body?.token) { res.status(400).json({ error: 'blog_token_invalid', message: '请输入个人令牌' }); return }
  if (req.body.token === 'bad_token') { res.status(409).json({ error: 'blog_auth_failed', message: '个人博客令牌无效或权限不足，请重新连接' }); return }
  connected = true
  res.json({ account: { status: 'connected', name: '测试个人博客', baseUrl: 'https://blog.example.com', checkedAt: time } })
})
app.delete('/api/blog/account', (_req, res) => { connected = false; res.json({ ok: true }) })
app.post('/api/blog/publications', (req, res) => {
  if (!connected) { res.status(409).json({ error: 'blog_auth_failed', message: '请先在系统中连接个人博客' }); return }
  if (mode === 'failure') { res.status(400).json({ error: 'blog_image_invalid', message: '个人博客图片上传失败，请重试' }); return }
  submissions.push(req.body)
  const item = { id: `pub-${submissions.length}`, renderId: render.id, title: article.title, mode: req.body.mode, status: mode === 'uncertain' ? 'uncertain' : 'running', message: '正在处理', url: null, remoteId: 'post-1', createdAt: time, updatedAt: time }
  publications.unshift(item); res.status(202).json({ publication: item })
})
app.post('/api/blog/publications/:id/resolve', (req, res) => {
  const item = publications.find(p => p.id === req.params.id)
  assert.equal(item.status, 'uncertain')
  if (req.body.action === 'check') Object.assign(item, { status: 'running', checking: true })
  else {
    Object.assign(item, { status: req.body.action === 'published' ? 'published' : 'failed', message: req.body.action === 'published' ? '用户已人工核实文章发布成功' : '用户已核实未发布，已解除限制', ...(req.body.action === 'published' ? { url: req.body.articleUrl } : {}) })
    item.resolutions = [{ id: `resolution-${Date.now()}`, action: req.body.action, message: item.message, articleUrl: req.body.articleUrl || null, createdAt: time }, ...(item.resolutions || [])]
  }
  res.json({ publication: item })
})
app.get('/api/blog/publications', (_req, res) => {
  for (const item of publications) if (item.status === 'running') {
    if (item.checking) Object.assign(item, { status: 'uncertain', checking: false, message: '仍有草稿，请人工核实' })
    else Object.assign(item, { status: item.mode === 'draft' ? 'draft' : 'published', message: '已核对个人博客保存的正文', url: item.mode === 'draft' ? 'https://blog.example.com/console/posts/post-1' : 'https://blog.example.com/archives/post-1' })
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
  const executablePath = process.env.CHROME_BIN || [chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync)
  assert.ok(executablePath, 'Install Chromium or set CHROME_BIN')
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('multipush_token', 'isolated-test-token') })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/publish?platform=blog`)
  await page.getByRole('heading', { name: '把内容发布到个人博客' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '发布到个人博客', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '连接个人博客', exact: true }).click()
  await page.getByLabel('博客地址').fill('https://blog.example.com')
  await page.getByLabel('个人令牌').fill('pat_isolated_test')
  await page.getByRole('button', { name: '连接并验证', exact: true }).click()
  await page.getByText('已连接', { exact: true }).waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.getByRole('button', { name: '保存到博客草稿', exact: true }).click()
  await page.getByText('已保存草稿', { exact: true }).waitFor()
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].mode, 'draft')
  await page.getByRole('button', { name: '发布到个人博客', exact: true }).click()
  assert.equal(submissions.length, 1, 'Opening confirmation must not publish')
  await page.getByRole('button', { name: '确认发布到个人博客', exact: true }).click()
  await page.getByText('已发布', { exact: true }).waitFor()
  assert.equal(submissions[1].mode, 'publish')
  assert.equal(await page.getByRole('link', { name: '查看博客文章' }).getAttribute('href'), 'https://blog.example.com/archives/post-1')
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true })
  mode = 'failure'
  await page.getByRole('button', { name: '保存到博客草稿', exact: true }).click()
  await page.locator('.publish-error').filter({ hasText: '个人博客图片上传失败' }).waitFor()
  mode = 'uncertain'
  await page.getByRole('button', { name: '保存到博客草稿', exact: true }).click()
  await page.getByText('结果待核实', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '发布到个人博客', exact: true }).isDisabled(), true)
  await page.reload()
  await page.getByText('结果待核实', { exact: true }).waitFor()
  assert.equal(submissions.length, 3)
  await page.getByRole('button', { name: '核实并继续', exact: true }).click()
  await page.getByRole('button', { name: '重新自动核实', exact: true }).click()
  await page.getByText('仍有草稿，请人工核实', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '发布到个人博客', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '核实并继续', exact: true }).click()
  await page.getByRole('button', { name: '我已核实，未发布', exact: true }).click()
  assert.equal(submissions.length, 3, 'Selecting a resolution must not publish')
  await page.getByRole('button', { name: '确认未发布，解除限制', exact: true }).click()
  await page.getByRole('dialog', { name: '核实个人博客发布结果' }).waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '发布到个人博客', exact: true }).isEnabled(), true)
  await page.reload()
  await page.getByText('用户已核实未发布，已解除限制', { exact: true }).first().waitFor()
  mode = 'uncertain'
  await page.getByRole('button', { name: '保存到博客草稿', exact: true }).click()
  await page.getByRole('button', { name: '核实并继续', exact: true }).click()
  await page.getByRole('button', { name: '我已核实，已发布', exact: true }).click()
  await page.getByLabel('已发布文章链接').fill('https://blog.example.com/archives/x')
  await page.getByRole('button', { name: '确认已发布并关联', exact: true }).click()
  await page.locator('a[href="https://blog.example.com/archives/x"]').waitFor()
  assert.equal(submissions.length, 4)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.frameLocator('iframe').getByText('这是一篇个人博客测试文章。').waitFor()
  await page.locator('iframe').scrollIntoViewIfNeeded()
  await page.waitForTimeout(350)
  await page.locator('iframe').screenshot({ path: path.join(output, 'mobile-preview.png') })
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile layout must not overflow')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', submissions: submissions.length, screenshots: output }))
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
