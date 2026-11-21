// Build first. Isolated UI fixtures only; never calls the real WeChat API.
import assert from 'node:assert/strict'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'wechatpic-ui-check')
mkdirSync(output, { recursive: true })
const time = new Date().toISOString(), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
const user = { id: 'alice', username: 'alice', email: 'alice@example.com', displayName: 'Alice', createdAt: time }
const sticker = {
  platform: 'wechatpic',
  title: '公众号贴图联调',
  html: '<div data-mp-wechatpic="1"><img src="/uploads/test.png"><p>这是一条贴图配文。</p></div>',
  markdown: null,
  text: '公众号贴图联调\n\n这是一条贴图配文。\n\n#内容创作',
  previewMode: 'vertical',
  themeColor: '#07c160',
  meta: { wordCount: 10, imageCount: 1, videoCount: 0, readMinutes: 1, tags: ['内容创作'], titleLength: 8, titleLimit: 32, summary: '这是一条贴图配文。' },
  cards: [],
  assets: [{ filename: 'test.png', url: '/uploads/test.png', kind: 'image' }],
  videos: [],
  warnings: [],
  downloads: [],
  generatedAt: time,
  sourceUpdatedAt: time,
  captionBody: '这是一条贴图配文。',
}
const render = { id: 'render-1', contentId: 'content-1', contentTitle: sticker.title, platforms: ['wechatpic'], results: [sticker], options: {}, createdAt: time }
let connected = false, mode = 'normal', submissions = [], publications = []
const app = express()
app.use(express.json())
app.get('/api/auth/me', (_req, res) => res.json({ user }))
app.get('/api/renders', (_req, res) => res.json({ renders: [render] }))
app.get('/api/renders/render-1', (_req, res) => res.json({ render }))
app.get('/api/contents/content-1', (_req, res) => res.json({ content: { id: 'content-1', title: sticker.title, coverImage: null } }))
app.get('/api/media', (_req, res) => res.json({ media: [] }))
app.get('/uploads/test.png', (_req, res) => res.type('png').send(png))
app.get('/api/wechatpic/account', (_req, res) => res.json({ account: { status: connected ? 'connected' : 'disconnected', name: connected ? '测试公众号' : null, appId: connected ? 'wx1234567890abcdef' : null, checkedAt: connected ? time : null } }))
app.post('/api/wechatpic/connect', (req, res) => {
  if (req.body?.appId !== 'wx1234567890abcdef' || req.body?.appSecret?.length !== 32) { res.status(400).json({ error: 'wechatpic_auth_failed', message: 'AppID 或 AppSecret 无效，请核对后重新连接' }); return }
  connected = true
  res.json({ account: { status: 'connected', name: '测试公众号', appId: 'wx1234567890abcdef', checkedAt: time } })
})
app.delete('/api/wechatpic/account', (_req, res) => { connected = false; res.json({ ok: true }) })
app.post('/api/wechatpic/publications', (req, res) => {
  if (!connected) { res.status(409).json({ error: 'wechatpic_auth_failed', message: '请先在系统中连接公众号（AppID / AppSecret）' }); return }
  if (mode === 'ip') { res.status(409).json({ error: 'wechatpic_ip_not_allowed', message: '本机出口 IP 不在公众号 IP 白名单（当前 IP：203.0.113.7）。请在微信开发者平台「我的业务 → 公众号/服务号 → 基础信息 → 开发密钥 → API IP 白名单」添加后重试。' }); return }
  submissions.push(req.body)
  const item = { id: `pub-${submissions.length}`, renderId: render.id, title: sticker.title, mode: 'draft', status: 'running', message: '正在上传贴图图片并创建草稿', url: null, remoteId: null, createdAt: time, updatedAt: time }
  publications.unshift(item); res.status(202).json({ publication: item })
})
app.get('/api/wechatpic/publications', (_req, res) => {
  for (const item of publications) if (item.status === 'running') Object.assign(item, { status: 'draft', message: '已创建公众号贴图草稿，请在公众号后台手动发表', remoteId: `draft-${item.id}` })
  res.json({ publications })
})
app.get('/api/wechatpic/publications/:id', (req, res) => {
  const item = publications.find(p => p.id === req.params.id)
  if (!item) { res.status(404).json({ error: 'not_found', message: '贴图发布记录不存在' }); return }
  res.json({ publication: item })
})
app.delete('/api/wechatpic/publications/:id', (req, res) => {
  publications = publications.filter(p => p.id !== req.params.id)
  res.json({ ok: true, remoteDeleted: true })
})
app.use(express.static(path.join(root, 'web', 'dist')))
app.get('*', (_req, res) => res.sendFile(path.join(root, 'web', 'dist', 'index.html')))
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let browser
try {
  const executablePath = process.env.CHROME_BIN || [chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync)
  assert.ok(executablePath, 'Install Chromium or set CHROME_BIN')
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('multipush_token', 'isolated-test-token') })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/publish?platform=wechatpic`)
  await page.getByRole('heading', { name: '把内容保存为公众号贴图草稿' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '保存为贴图草稿', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '连接公众号', exact: true }).click()
  await page.getByLabel('AppID').fill('wx1234567890abcdef')
  await page.getByLabel('AppSecret').fill('a'.repeat(32))
  await page.getByRole('button', { name: '连接并验证', exact: true }).click()
  await page.getByText('已连接', { exact: true }).waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await page.getByText('贴图图片（1 / 20）').count(), 1)
  await page.getByRole('button', { name: '保存为贴图草稿', exact: true }).click()
  await page.getByRole('button', { name: '确认创建草稿', exact: true }).click()
  await page.getByText('草稿已创建，待手动发表', { exact: true }).waitFor()
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].renderId, 'render-1')
  assert.equal(await page.getByRole('button', { name: '删除草稿' }).count(), 1)
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true })
  mode = 'ip'
  await page.getByRole('button', { name: '保存为贴图草稿', exact: true }).click()
  await page.getByRole('button', { name: '确认创建草稿', exact: true }).click()
  await page.locator('.publish-error').filter({ hasText: 'IP 白名单' }).waitFor()
  mode = 'normal'
  await page.getByRole('button', { name: '删除草稿' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除草稿' }).click()
  await page.getByText('还没有贴图发布记录').waitFor()
  assert.equal(await page.getByRole('button', { name: '保存为贴图草稿', exact: true }).isEnabled(), true)
  // Mobile viewport sanity check (PWA / 手机端访问要求).
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true })
  await page.goto(`${base}/render`)
  await page.waitForTimeout(1500)
  assert.deepEqual(errors, [], `页面错误：${errors.join('；')}`)
  console.log('[smoke-wechatpic] ok')
} finally {
  await browser?.close()
  server.close()
}
