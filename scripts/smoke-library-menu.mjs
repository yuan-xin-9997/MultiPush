// Build first. All API data is isolated; no real documents are changed.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'library-menu-check')
mkdirSync(output, { recursive: true })
const time = new Date().toISOString()
const user = { id: 'alice', username: 'alice', displayName: 'Alice', email: 'alice@example.com', avatarUrl: null, createdAt: time }
const items = Array.from({ length: 9 }, (_, index) => ({ id: `doc-${index}`, title: `菜单测试文档 ${index}`, excerpt: '测试卡片底部菜单', bookId: null, bookName: null,
  coverImage: null, tags: [], favorite: false, status: 'ready', wordCount: 59, imageCount: 0, videoCount: 0, createdAt: time, updatedAt: time, deletedAt: null }))
const app = express()
app.get('/api/auth/me', (_req, res) => res.json({ user }))
app.get('/api/books', (_req, res) => res.json({ books: [] }))
app.get('/api/contents', (req, res) => res.json({ items, total: items.length, page: 1, pageSize: Number(req.query.pageSize) || 24 }))
app.get('/api/contents/:id', (req, res) => res.json({ content: { ...items.find((item) => item.id === req.params.id), contentHtml: '<p>测试正文</p>', contentJson: {} } }))
app.use(express.static(path.join(root, 'web', 'dist')))
app.get('*', (_req, res) => res.sendFile(path.join(root, 'web', 'dist', 'index.html')))
const server = app.listen(0, '127.0.0.1')
await new Promise((done) => server.once('listening', done))
let browser
try {
  const chrome = process.env.CHROME_BIN || [chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
  assert.ok(chrome, 'Install Chromium or set CHROME_BIN')
  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(10000)
  await page.addInitScript(() => localStorage.setItem('multipush_token', 'isolated-test-token'))
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const base = `http://127.0.0.1:${server.address().port}`
  await page.goto(`${base}/library`)
  const trigger = page.getByRole('button', { name: '「菜单测试文档 0」更多操作', exact: true })
  async function openMenu(button = trigger) {
    await button.scrollIntoViewIfNeeded()
    await button.click()
    const item = page.getByRole('menuitem', { name: '打开编辑', exact: true })
    await item.waitFor()
    await page.waitForTimeout(180)
    const lastItem = page.getByRole('menuitem', { name: '删除文档', exact: true })
    for (const target of [item, lastItem]) assert.ok(await target.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    }), 'Menu must be visible and clickable, not clipped by the card')
    assert.equal(new URL(page.url()).pathname, '/library', 'Opening menu must not open document')
  }
  await openMenu()
  await page.screenshot({ path: path.join(output, 'desktop.png') })
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('menu').count(), 0)
  await openMenu()
  await page.getByRole('menuitem', { name: '移动知识库', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  assert.equal(await page.getByRole('menu').count(), 0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '列表视图', exact: true }).click()
  await openMenu()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '卡片视图', exact: true }).click()
  await page.getByRole('button', { name: '打开用户菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await openMenu()
  await page.locator('.library-heading h1').click()
  assert.equal(await page.getByRole('menu').count(), 0)
  await openMenu(page.getByRole('button', { name: '「菜单测试文档 8」更多操作', exact: true }))
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  await openMenu()
  await page.getByRole('menuitem', { name: '导出', exact: true }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /^HTML/ }).click(),
  ])
  assert.ok(download.suggestedFilename().endsWith('.html'))
  assert.equal(await page.getByRole('menu').count(), 0)
  await openMenu()
  await page.screenshot({ path: path.join(output, 'mobile.png') })
  await page.getByRole('menuitem', { name: '删除文档', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  assert.equal(new URL(page.url()).pathname, '/library')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', screenshots: output }))
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
