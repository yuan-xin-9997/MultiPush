// Isolated UI fixture: no requests reach Xiaohongshu and no real content is published.
import assert from 'node:assert/strict'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'xiaohongshu-ui-check')
mkdirSync(output, { recursive: true })
const time = new Date().toISOString()
const article = { platform: 'xiaohongshu', title: '小红书发布测试', captionBody: '验证卡片、文案与发布记录。', html: '', videos: [], meta: { tags: ['测试'], summary: '测试', imageCount: 1, wordCount: 12 }, cards: [{ id: 'card-1', type: 'cover', index: 1, total: 1, title: '小红书发布测试', body: ['验证卡片发布'], images: [], footer: 'MultiPush' }], warnings: [] }
const render = { id: 'render-1', contentId: 'content-1', contentTitle: article.title, platforms: ['xiaohongshu'], results: [article], options: {}, createdAt: time }
let connected = false, uploads = 0, submitted = null, publications = []
const app = express()
app.use(express.json())
app.get('/api/auth/me', (_req, res) => res.json({ user: { id: 'alice', username: 'alice', email: 'a@example.com', displayName: 'Alice', createdAt: time } }))
app.get('/api/renders', (_req, res) => res.json({ renders: [render] }))
app.get('/api/renders/render-1', (_req, res) => res.json({ render }))
app.get('/api/xiaohongshu/account', (_req, res) => res.json({ account: { status: connected ? 'connected' : 'disconnected', name: connected ? '测试作者' : null, checkedAt: time } }))
app.post('/api/xiaohongshu/login', (_req, res) => res.status(202).json({ login: { id: 'login-1', status: 'waiting', qrCode: null, message: '请扫码', expiresAt: time } }))
app.get('/api/xiaohongshu/login/login-1', (_req, res) => { connected = true; res.json({ login: { id: 'login-1', status: 'connected', qrCode: null, message: '已连接', expiresAt: time } }) })
app.get('/api/xiaohongshu/publications', (_req, res) => res.json({ publications }))
app.post('/api/media', express.raw({ type: () => true, limit: '10mb' }), (req, res) => {
  assert.ok(req.body.length > 1000, 'PNG should actually be generated and uploaded')
  uploads++
  res.json({ media: { id: `media-${uploads}`, url: '/uploads/card.png', mimeType: 'image/png', kind: 'image' } })
})
app.post('/api/xiaohongshu/publications', (req, res) => {
  submitted = req.body
  publications = [{ id: 'publication-1', title: article.title, renderId: render.id, mode: 'publish', status: 'uncertain', message: '提交结果待核实', url: null, createdAt: time, updatedAt: time }]
  res.status(202).json({ publication: publications[0] })
})
app.post('/api/xiaohongshu/publications/publication-1/resolve', (req, res) => {
  assert.equal(req.body.action, 'published')
  Object.assign(publications[0], { status: 'published', url: req.body.articleUrl, message: '用户已核实发布成功' })
  res.json({ publication: publications[0] })
})
app.use(express.static(path.join(root, 'web', 'dist')))
app.get('*', (_req, res) => res.sendFile(path.join(root, 'web', 'dist', 'index.html')))
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let browser
try {
  const executablePath = process.env.XHS_BROWSER_PATH || process.env.CHROME_BIN || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync)
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  const failures = []
  page.on('pageerror', error => failures.push(error.message))
  await page.addInitScript(() => localStorage.setItem('multipush_token', 'fixture'))
  await page.goto(`${base}/publish?platform=xiaohongshu`)
  await page.getByRole('heading', { name: '把内容发布到小红书' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '正式发布到小红书', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '扫码连接小红书', exact: true }).click()
  await page.getByRole('heading', { name: '测试作者', exact: true }).waitFor()
  await page.getByRole('button', { name: '正式发布到小红书', exact: true }).click()
  await page.getByRole('button', { name: '确认发布到小红书', exact: true }).click()
  await page.getByText('提交结果待核实', { exact: true }).first().waitFor()
  assert.deepEqual(submitted, { renderId: render.id, mode: 'publish', imageMediaIds: ['media-1'] })
  assert.equal(uploads, 1)
  assert.equal(await page.getByRole('button', { name: '正式发布到小红书', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '核实结果', exact: true }).click()
  await page.getByRole('button', { name: '我已核实，已发布', exact: true }).click()
  await page.locator('input[type="url"]').fill('https://www.xiaohongshu.com/explore/1234567890abcdef12345678')
  await page.getByRole('button', { name: '确认已发布并关联', exact: true }).click()
  await page.getByText('用户已核实发布成功', { exact: true }).first().waitFor()
  await page.screenshot({ path: path.join(output, 'publish-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, 'publish-mobile.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile must not scroll horizontally')
  assert.deepEqual(failures, [])
  console.log('Xiaohongshu UI smoke passed: login, PNG upload, publication, uncertain result resolution, mobile layout')
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }

