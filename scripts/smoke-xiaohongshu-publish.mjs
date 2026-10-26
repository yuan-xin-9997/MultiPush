// Offline fixture: the disabled page must never request login, account checks or publishing.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'
const root = path.resolve(import.meta.dirname, '..'), app = express(), requests = []
app.get('/api/auth/me', (_, res) => res.json({ user: { id: 'alice', username: 'alice', displayName: 'Alice' } }))
app.use('/api/xiaohongshu', (req, res) => {
  requests.push(`${req.method} ${req.path}`)
  if (req.method === 'GET' && req.path === '/publications') return res.json({ publications: [{ id: 'old', title: '历史笔记', message: '历史记录保留', createdAt: new Date().toISOString() }] })
  res.status(410).json({ error: 'xiaohongshu_automation_disabled' })
})
app.use(express.static(path.join(root, 'web/dist')))
app.get('*', (_, res) => res.sendFile(path.join(root, 'web/dist/index.html')))
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
let browser
try {
  const executablePath = process.env.CHROME_BIN || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync)
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('multipush_token', 'fixture'))
  await page.goto(`http://127.0.0.1:${server.address().port}/publish?platform=xiaohongshu&renderId=render-1`)
  await page.getByRole('heading', { name: '小红书自动发布已停用' }).waitFor()
  await page.getByText('历史笔记', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: /扫码|正式发布|刷新状态/ }).count(), 0)
  const exportButton = page.getByRole('button', { name: '去渲染工作台导出' })
  await exportButton.waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'manual publishing page must fit mobile widths')
  assert.deepEqual(requests, ['GET /publications'])
  assert.deepEqual(errors, [])
  console.log('Xiaohongshu disabled UI passed: no login, account checks or publishing requests; manual export and local history retained')
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
