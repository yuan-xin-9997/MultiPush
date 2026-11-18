// Build first. Isolated UI fixtures only; never calls a real LLM.
import assert from 'node:assert/strict'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'ai-attachments-check')
mkdirSync(output, { recursive: true })
const time = new Date().toISOString()
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
writeFileSync(path.join(output, 'fixture.png'), png)
writeFileSync(path.join(output, 'fixture.md'), '# 旅行资料\n\n第一段：关于青海湖的旅行记录。\n\n第二段：推荐的拍摄机位。\n')
const user = { id: 'alice', username: 'alice', email: 'alice@example.com', displayName: 'Alice', createdAt: time }
const settings = { configured: true, baseUrl: 'https://ai.example.com/v1', model: 'test-model', temperature: 0.7, hasApiKey: true, label: '测试模型' }
const sessionDetail = () => ({ id: 'session-1', title: '附件会话', createdAt: time, updatedAt: time, messages: [...messages] })
const messages = []
let providerBodies = []
const app = express()
app.use(express.json({ limit: '4mb' }))
app.get('/api/auth/me', (_req, res) => res.json({ user }))
app.get('/api/ai/settings', (_req, res) => res.json({ settings }))
app.get('/api/ai/sessions', (_req, res) => res.json({ sessions: [{ id: 'session-1', title: '附件会话', createdAt: time, updatedAt: time }] }))
app.post('/api/ai/sessions', (_req, res) => res.status(201).json({ session: { id: 'session-1', title: '附件会话', createdAt: time, updatedAt: time } }))
app.get('/api/ai/sessions/session-1', (_req, res) => res.json({ session: sessionDetail() }))
app.delete('/api/ai/sessions/:id', (_req, res) => res.json({ ok: true }))
const upload = multer({ storage: multer.memoryStorage() })
app.post('/api/media', upload.single('file'), (req, res) => {
  assert.ok(req.file, 'expected a multipart file upload')
  const isImage = (req.file.mimetype || '').startsWith('image/')
  res.json({ media: { id: `media-${messages.length + 1}`, kind: isImage ? 'image' : 'video', filename: 'fixture.bin', originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, url: '/uploads/fixture.png', width: 32, height: 32, duration: null, createdAt: time } })
})
app.post('/api/ai/sessions/session-1/messages', (req, res) => {
  providerBodies.push(req.body)
  messages.push({ id: `user-${messages.length + 1}`, role: 'user', content: req.body.message || '（消息包含附件）', createdAt: time, ...(req.body.mediaIds?.length || req.body.documents?.length ? { attachments: [ ...(req.body.mediaIds ?? []).map((mediaId, index) => ({ kind: 'image', name: `图片-${index}`, mimeType: 'image/png', size: 100, mediaId, url: '/uploads/fixture.png', width: 32, height: 32 })), ...(req.body.documents ?? []).map(document => ({ kind: 'document', name: document.name, mimeType: document.mimeType, size: document.size ?? 0, text: document.text })) ] } : {}) })
  messages.push({ id: `assistant-${messages.length + 1}`, role: 'assistant', content: '已收到你的附件，我会按意图创建内容。', createdAt: time })
  res.json({ session: sessionDetail(), reply: messages[messages.length - 1] })
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
  await page.goto(`${base}/ai`)
  await page.getByRole('heading', { name: '创作助手' }).waitFor()
  // Attach an image and a document via the composer.
  await page.getByLabel('上传附件').setInputFiles([path.join(output, 'fixture.png'), path.join(output, 'fixture.md')])
  await page.getByText('fixture.md').waitFor()
  await page.getByText('fixture.png').waitFor()
  assert.equal(await page.locator('.ai-attachment-chip').count(), 2)
  await page.screenshot({ path: path.join(output, 'composer.png'), fullPage: false })
  // Send with both attachments; the placeholder note shows in the optimistic bubble.
  await page.getByPlaceholder(/告诉 AI 你想写什么/).fill('根据资料写一篇游记，把图片放进正文')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByText('已收到你的附件，我会按意图创建内容。').waitFor()
  assert.equal(await page.locator('.ai-attachment.is-image').count(), 1, 'image thumbnail should render in the user bubble')
  assert.equal(await page.locator('.ai-message.is-user .ai-attachment').count(), 2)
  assert.equal(await page.locator('.ai-attachment-chip').count(), 0, 'chips clear after send')
  assert.deepEqual(providerBodies[0].mediaIds, ['media-1'])
  assert.equal(providerBodies[0].documents.length, 1)
  assert.ok(providerBodies[0].documents[0].text.includes('青海湖'), 'document text should be read client-side and sent')
  assert.equal(providerBodies[0].message, '根据资料写一篇游记，把图片放进正文')
  await page.screenshot({ path: path.join(output, 'chat.png'), fullPage: true })
  // Mobile viewport sanity check.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true })
  assert.deepEqual(errors, [], `页面错误：${errors.join('；')}`)
  console.log('[smoke-ai-attachments] ok')
} finally {
  await browser?.close()
  server.close()
}
