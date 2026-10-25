// Isolated UI fixture: no requests reach Xiaohongshu and no real content is published.
import assert from 'node:assert/strict'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'xiaohongshu-ui-check')
mkdirSync(output, { recursive: true })
const time = new Date().toISOString(), expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
const qrCode = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII='
const article = { platform: 'xiaohongshu', title: '小红书发布测试', captionBody: '验证卡片、文案与发布记录。', html: '', videos: [], meta: { tags: ['测试'], summary: '测试', imageCount: 1, wordCount: 12 }, cards: [{ id: 'card-1', type: 'cover', index: 1, total: 1, title: '小红书发布测试', body: ['验证卡片发布'], images: [], footer: 'MultiPush' }], warnings: [] }
const longCards = process.argv.includes('--long-cards')
const longBody = Array.from({ length: 26 }, (_, i) => `第 ${i + 1} 段：文件被占用时，先找到对应进程，再决定是否结束。🙂`)
if (longCards) article.cards.push({ id: 'long-content', type: 'content', index: 2, total: 2, title: '解除占用的操作步骤', body: longBody, images: ['/uploads/test.png'], footer: 'MultiPush' })
const render = { id: 'render-1', contentId: 'content-1', contentTitle: article.title, platforms: ['xiaohongshu'], results: [article], options: {}, createdAt: time }
let loginPolls = 0, connected = false, uploads = 0, submitted = null, publications = []
const app = express()
app.use(express.json())
app.get('/uploads/test.png', (_req, res) => res.type('png').send(Buffer.from(qrCode.split(',')[1], 'base64')))
app.get('/api/auth/me', (_req, res) => res.json({ user: { id: 'alice', username: 'alice', email: 'a@example.com', displayName: 'Alice', createdAt: time } }))
app.get('/api/renders', (_req, res) => res.json({ renders: [render] }))
app.get('/api/renders/render-1', (_req, res) => res.json({ render }))
app.get('/api/xiaohongshu/account', (_req, res) => res.json({ account: { status: connected ? 'connected' : 'disconnected', name: connected ? '测试作者' : null, checkedAt: time } }))
app.post('/api/xiaohongshu/login', (_req, res) => res.status(202).json({ login: { id: 'login-1', status: 'waiting', qrCode: null, message: '请扫码', expiresAt } }))
app.get('/api/xiaohongshu/login/login-1', (_req, res) => {
  loginPolls++
  if (loginPolls === 1) { res.json({ login: { id: 'login-1', status: 'waiting', qrCode, message: '请扫码', expiresAt } }); return }
  if (loginPolls < 4) { res.json({ login: { id: 'login-1', status: loginPolls === 2 ? 'waiting' : 'scanned', qrCode: null, message: '二维码已关闭，正在确认登录状态', expiresAt } }); return }
  connected = true
  res.json({ login: { id: 'login-1', status: 'connected', qrCode: null, message: '已连接', expiresAt } })
})
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
  await page.getByAltText('小红书官方登录二维码').waitFor()
  await page.getByText('二维码已关闭，正在确认登录状态', { exact: true }).waitFor()
  assert.equal(await page.getByText('正在获取小红书官方登录二维码…', { exact: true }).count(), 0)
  await page.getByRole('heading', { name: '测试作者', exact: true }).waitFor()
  await page.getByRole('button', { name: '正式发布到小红书', exact: true }).waitFor()
  const preparedCount = await page.locator('.xhs-card').count()
  if (longCards) {
    assert.ok(preparedCount > 2, 'long content must automatically split into more pages')
    assert.equal((await page.locator('.xhs-content-lines p').allTextContents()).join(''), longBody.join(''), 'every character must survive automatic pagination')
    assert.equal(await page.locator('.xhs-content-photo').count(), 1, 'the source image must appear exactly once')
    assert.match(await page.locator('.publish-page').innerText(), /由 2 张自动分页/)
  }
  await page.getByRole('button', { name: '正式发布到小红书', exact: true }).click()
  await page.getByRole('button', { name: '确认发布到小红书', exact: true }).click()
  await page.getByText('提交结果待核实', { exact: true }).first().waitFor()
  assert.deepEqual(submitted, { renderId: render.id, mode: 'publish', imageMediaIds: Array.from({ length: preparedCount }, (_, i) => `media-${i + 1}`) })
  assert.equal(uploads, preparedCount)
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
  if (longCards) {
    article.cards = Array.from({ length: 22 }, (_, i) => ({ id: `excess-${i}`, type: 'content', index: i + 1, total: 22, title: `测试 ${i}`, body: [`正文 ${i}`], images: [], footer: 'MultiPush' }))
    await page.reload()
    await page.getByLabel('精选卡片说明').waitFor()
    await page.getByText('已准备 18 张卡片，按预览顺序发布', { exact: true }).waitFor()
    assert.match(await page.getByLabel('精选卡片说明').innerText(), /省略 4 张/)
    assert.equal(await page.locator('.xhs-card').count(), 18)
    assert.equal(await page.locator('.xhs-content-lines').first().innerText(), '正文 0')
    assert.equal(await page.locator('.xhs-content-lines').last().innerText(), '正文 21')
    assert.equal(await page.getByRole('button', { name: '正式发布到小红书', exact: true }).isDisabled(), false)
    assert.equal(uploads, preparedCount, 'selection preview must not upload anything')
    await page.getByRole('button', { name: '正式发布到小红书', exact: true }).click()
    await page.getByRole('button', { name: '确认发布到小红书', exact: true }).click()
    await page.getByText('提交结果待核实', { exact: true }).first().waitFor()
    assert.equal(submitted.imageMediaIds.length, 18)
    assert.equal(uploads, preparedCount + 18)
    assert.equal(article.cards.length, 22, 'the stored full-card version must stay unchanged')
  }
  assert.deepEqual(failures, [])
  console.log('Xiaohongshu UI smoke passed: login, PNG upload, publication, uncertain result resolution, mobile layout')
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }

