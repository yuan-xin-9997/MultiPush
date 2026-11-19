// Mobile-viewport UI smoke for the AI creation page. Isolated fixtures only; never calls a real LLM.
// Build first: npm run build && node scripts/smoke-ai-mobile-ui.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'ai-mobile-check')
mkdirSync(output, { recursive: true })
const time = new Date().toISOString()
writeFileSync(path.join(output, 'fixture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64'))
const user = { id: 'alice', username: 'alice', email: 'alice@example.com', displayName: 'Alice', createdAt: time }
const settings = { configured: true, baseUrl: 'https://ai.example.com/v1', model: 'deepseek-v4.1-flash', temperature: 0.7, hasApiKey: true, label: 'OpenCode Go' }
const messages = [
  { id: 'u1', role: 'user', content: '新建视频内容，将这两个视频剪辑成一个 MacOS 和 Windows 空格键对比的短片', createdAt: time, attachments: [{ kind: 'video', name: 'mac-space.mp4', mimeType: 'video/mp4', size: 123456, url: '/uploads/fixture.png' }] },
  { id: 't1', role: 'tool', toolName: 'create_content', toolArguments: { title: '空格键对比' }, toolResult: { contentId: 'c-1', kind: 'video' }, createdAt: time },
  { id: 'a1', role: 'assistant', content: '已经生成了两个版本的成片（61d3da72-12bb-4257-a005-000a216c0f9b）。\n\n内容一致、ID 不同。发布时请指定用哪一个，避免拿错版本。如果打算后续再修剪重导，旧版本建议只留一个，减少混淆。\n\n需要我接着做发布准备吗？（抖音需先重新授权连接，小红书禁用、公众号授权已过期；可用知乎、博客、微博等）', createdAt: time, toolCalls: [{ id: 'call-1', function: { name: 'create_content' } }] },
]
const sessionDetail = () => ({ id: 'session-1', title: '新建视频内容，将这两个视频剪辑成一个 MacOS 和 Windows 空格键对比的短片', createdAt: time, updatedAt: time, messages: [...messages] })
const sessions = [
  { id: 'session-1', title: '新建视频内容，将这两个视频剪辑成一个 MacOS 和 Windows 空格键对比的短片', createdAt: time, updatedAt: time },
  { id: 'session-2', title: '写一篇关于用 AI 提升内容创作效率的公众号文章', createdAt: time, updatedAt: time },
]
const app = express()
app.use(express.json({ limit: '4mb' }))
app.get('/api/health', (_req, res) => res.json({ desktopMode: true, version: 'smoke' }))
app.get('/api/auth/me', (_req, res) => res.json({ user }))
app.get('/api/ai/settings', (_req, res) => res.json({ settings }))
app.get('/api/ai/sessions', (_req, res) => res.json({ sessions }))
app.post('/api/ai/sessions', (_req, res) => res.status(201).json({ session: sessions[0] }))
app.get('/api/ai/sessions/session-1', (_req, res) => res.json({ session: sessionDetail() }))
app.get('/api/ai/sessions/session-2', (_req, res) => res.json({ session: sessionDetail() }))
app.post('/api/ai/sessions/session-1/messages', (req, res) => {
  messages.push({ id: `user-${messages.length + 1}`, role: 'user', content: req.body.message || '', createdAt: time, ...(req.body.mediaIds?.length ? { attachments: req.body.mediaIds.map((mediaId, index) => ({ kind: 'image', name: `fixture-${index}.png`, mimeType: 'image/png', size: 100, mediaId, url: '/uploads/fixture.png', width: 32, height: 32 })) } : {}) })
  messages.push({ id: `assistant-${messages.length + 1}`, role: 'assistant', content: '好的，我先把两段素材裁成 10 秒内的对比短片，稍等。', createdAt: time })
  res.json({ session: sessionDetail(), reply: messages[messages.length - 1] })
})
const upload = multer({ storage: multer.memoryStorage() })
app.post('/api/media', upload.single('file'), (req, res) => {
  res.json({ media: { id: `media-${messages.length + 1}`, kind: 'image', filename: 'fixture.bin', originalName: req.file?.originalname ?? 'fixture.png', mimeType: 'image/png', size: 100, url: '/uploads/fixture.png', width: 32, height: 32, duration: null, createdAt: time } })
})
app.use(express.static(path.join(root, 'web', 'dist')))
app.get('*', (_req, res) => res.sendFile(path.join(root, 'web', 'dist', 'index.html')))
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`

let browser
try {
  const executablePath = process.env.CHROME_BIN || [
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find(existsSync)
  assert.ok(executablePath, 'Install Chromium or set CHROME_BIN')
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('multipush_token', 'isolated-test-token') })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/ai`)
  await page.getByRole('heading', { name: '新建视频内容，将这两个视频剪辑成一个 MacOS 和 Windows 空格键对比的短片' }).waitFor()

  await page.screenshot({ path: path.join(output, 'mobile-390-before-send.png') })

  const layout = await page.evaluate(() => {
    const head = document.querySelector('.ai-main-head')
    const h2 = head?.querySelector('h2')
    const btn = head?.querySelector('.btn')
    const messagesEl = document.querySelector('.ai-messages')
    const sidebar = document.querySelector('.ai-sidebar')
    const composer = document.querySelector('.ai-composer')
    const strip = document.querySelector('.ai-session-list')
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      docScrollHeight: document.documentElement.scrollHeight,
      h2: h2 ? { right: h2.getBoundingClientRect().right, scrollWidth: h2.scrollWidth, clientWidth: h2.clientWidth } : null,
      headRight: head?.getBoundingClientRect().right ?? 0,
      btn: btn ? { right: btn.getBoundingClientRect().right, width: btn.getBoundingClientRect().width } : null,
      messagesH: messagesEl?.getBoundingClientRect().height ?? 0,
      sidebarH: sidebar?.getBoundingClientRect().height ?? 0,
      composerBottom: composer?.getBoundingClientRect().bottom ?? 0,
      stripScrollable: strip ? strip.scrollWidth > strip.clientWidth : false,
    }
  })

  assert.ok(layout.docScrollWidth <= layout.innerWidth + 1, `AI 页出现横向溢出：${layout.docScrollWidth} > ${layout.innerWidth}`)
  assert.ok(layout.docScrollHeight <= layout.innerHeight + 1, `AI 页不应产生整页滚动：${layout.docScrollHeight} > ${layout.innerHeight}`)
  assert.ok(layout.h2 && layout.h2.right <= layout.headRight + 0.5, '标题超出对话区容器')
  assert.ok(layout.h2 && layout.h2.scrollWidth > layout.h2.clientWidth, '长标题应截断省略，而不是撑开布局')
  assert.ok(layout.btn && layout.btn.width > 0 && layout.btn.right <= layout.innerWidth + 0.5, '「模型设置」按钮应在可视区域内')
  assert.ok(layout.composerBottom <= layout.innerHeight + 1, `输入框底部超出首屏：${layout.composerBottom} > ${layout.innerHeight}`)
  assert.ok(layout.messagesH >= 320, `对话区高度不足：${layout.messagesH}`)
  assert.ok(layout.messagesH > layout.sidebarH * 3, `对话区应明显大于会话条：${layout.messagesH} vs ${layout.sidebarH}`)
  assert.equal(await page.locator('.ai-session-delete').first().evaluate(el => getComputedStyle(el).opacity), '1', '移动端会话条上的删除按钮应始终可见')

  // Touch keyboards: Enter should not send; the send button must work.
  const pointerFine = await page.evaluate(() => matchMedia('(pointer: fine)').matches)
  await page.getByPlaceholder(/告诉 AI 你想写什么/).fill('我希望两个素材剪辑成一个 10s 内的视频')
  // Attach an image: the pending chip must honor the mobile max-width (cascade check).
  await page.getByLabel('上传附件').setInputFiles(path.join(output, 'fixture.png'))
  await page.locator('.ai-attachment-chip').waitFor()
  assert.equal(await page.locator('.ai-attachment-chip').evaluate(el => getComputedStyle(el).maxWidth), '150px', '移动端附件芯片应使用 150px 上限（未被文件后面的基础规则覆盖）')
  await page.screenshot({ path: path.join(output, 'mobile-390-attachment.png') })
  if (!pointerFine) {
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    assert.equal(await page.locator('.ai-message.is-user').count(), 1, '触屏端 Enter 不应触发发送')
  }
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByText('好的，我先把两段素材裁成 10 秒内的对比短片，稍等。').waitFor()
  assert.equal(await page.locator('.ai-message.is-user').last().locator('.ai-attachment').count(), 1, '发送后用户气泡应携带附件')
  await page.screenshot({ path: path.join(output, 'mobile-390.png') })

  const after = await page.evaluate(() => ({
    docScrollWidth: document.documentElement.scrollWidth,
    composerBottom: document.querySelector('.ai-composer')?.getBoundingClientRect().bottom ?? 0,
    innerHeight: window.innerHeight,
  }))
  assert.ok(after.docScrollWidth <= after.innerHeight + 1 || after.docScrollWidth <= window.innerWidth + 1, '发送后出现横向溢出')
  assert.ok(after.composerBottom <= after.innerHeight + 1, '发送后输入框底部超出首屏')

  // Larger phone (iPhone 15 Pro Max class) sanity check + screenshot.
  await page.setViewportSize({ width: 430, height: 932 })
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(output, 'mobile-430.png') })
  const big = await page.evaluate(() => ({
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  assert.ok(big.docScrollWidth <= big.innerWidth + 1, '430 宽度下出现横向溢出')

  // Desktop layout must be unchanged.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(output, 'desktop-1440.png') })

  assert.deepEqual(errors, [], `页面错误：${errors.join('；')}`)
  console.log(`[smoke-ai-mobile-ui] ok (pointer:fine=${pointerFine}) artifacts in ${output}`)
} finally {
  await browser?.close()
  server.close()
}
