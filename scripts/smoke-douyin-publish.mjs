import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'
const root = path.resolve(import.meta.dirname, '..'), time = new Date().toISOString()
const qrCode = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII='
const render = { id: 'render-1', contentTitle: '抖音测试', platforms: ['douyin'], results: [{ platform: 'douyin', title: '抖音测试', text: '测试正文 #测试' }], createdAt: time }
let connected = false, publications = [], submitted = null
const app = express()
app.use(express.json())
app.get('/api/auth/me', (_, res) => res.json({ user: { id: 'alice', username: 'alice', displayName: 'Alice' } }))
app.get('/api/renders', (_, res) => res.json({ renders: [render] }))
app.get('/api/renders/render-1', (_, res) => res.json({ render }))
app.get('/api/douyin/account', (_, res) => res.json({ account: { status: connected ? 'connected' : 'disconnected', name: connected ? '抖音测试账号' : null, checkedAt: time } }))
const login = { id: 'login-1', status: 'waiting', qrCode, message: '请扫码', expiresAt: new Date(Date.now() + 300000).toISOString() }
app.post('/api/douyin/login', (_, res) => res.status(202).json({ login }))
app.get('/api/douyin/login/login-1', (_, res) => { connected = true; res.json({ login: { ...login, status: 'connected', qrCode: null } }) })
app.get('/api/douyin/publications', (_, res) => res.json({ publications }))
app.post('/api/media', express.raw({ type: () => true }), (_, res) => res.json({ media: { id: 'video-1', kind: 'video', mimeType: 'video/mp4', url: '/uploads/video.mp4' } }))
app.post('/api/douyin/publications', (req, res) => {
  submitted = req.body
  publications = [{ id: 'job-1', title: render.contentTitle, status: 'uncertain', message: '请核实发布结果', createdAt: time }]
  res.status(202).json({ publication: publications[0] })
})
app.use(express.static(path.join(root, 'web/dist')))
app.get('*', (_, res) => res.sendFile(path.join(root, 'web/dist/index.html')))
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
let browser
try {
  const executablePath = process.env.CHROME_BIN || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync)
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('multipush_token', 'fixture'))
  await page.goto(`http://127.0.0.1:${server.address().port}/publish?platform=douyin&renderId=render-1`)
  await page.getByRole('heading', { name: '把内容发布到抖音' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '发布到抖音', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '扫码连接抖音', exact: true }).click()
  await page.getByAltText('抖音官方登录二维码').waitFor()
  await page.getByRole('heading', { name: '抖音测试账号' }).waitFor()
  await page.locator('input[type=file]').setInputFiles({ name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('0000ftypisom0000') })
  await page.getByText('已准备 1 个素材', { exact: true }).waitFor()
  await page.getByRole('button', { name: '发布到抖音', exact: true }).click()
  await page.getByRole('button', { name: '确认发布', exact: true }).click()
  await page.getByText('已核实未发布', { exact: true }).waitFor()
  assert.deepEqual(submitted, { renderId: 'render-1', mode: 'publish', videoMediaId: 'video-1' })
  assert.equal(await page.getByRole('button', { name: '发布到抖音', exact: true }).isDisabled(), true)
  assert.deepEqual(errors, [])
  mkdirSync(path.join(root, 'artifacts/douyin-ui-check'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'artifacts/douyin-ui-check/publish.png'), fullPage: true })
  console.log('Douyin UI smoke passed: login, media, confirmation, uncertain result protection')
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
