// Verify that article, gallery and video content can add existing assets from
// the material library after creation. The assets are seeded through the API,
// then each workspace uses the shared MediaPicker.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'media-picker-check')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.PICKER_QA_PORT || 34246)
const base = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
assert.ok(chrome, 'Install Chrome or set CHROME_BIN')
const videoFixture = path.join(root, 'server', 'test', 'fixtures', 'clip_a.mp4')
assert.ok(existsSync(videoFixture), 'video fixture missing')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4fy0NAAUTAjz/apfHAAAAAElFTkSuQmCC', 'base64')

const server = spawn(process.execPath, ['server/dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    WEB_DIST: path.join(root, 'web', 'dist'),
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    MULTIPUSH_DESKTOP: '1',
    PUBLIC_BASE_URL: base,
    JWT_SECRET: 'media-picker-ui-smoke',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (chunk) => { log += chunk })
server.stderr.on('data', (chunk) => { log += chunk })

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message, timeout = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const value = await check()
      if (value) return value
    } catch {
      // Retry until the timeout.
    }
    await delay(150)
  }
  throw new Error(`${message}\n${log}`)
}

let browser
try {
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'server did not start')

  const account = `picker_ui_${Date.now().toString(36)}`
  const password = 'PickerQA!2026'
  const registration = await (await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account, email: `${account}@example.com`, password }),
  })).json()
  const token = registration.token
  assert.ok(token, `registration failed: ${JSON.stringify(registration)}`)
  const auth = { Authorization: `Bearer ${token}` }

  async function uploadAsset(name, buffer, mimeType) {
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mimeType }), name)
    const response = await fetch(`${base}/api/media`, { method: 'POST', headers: auth, body: form })
    const body = await response.json()
    assert.ok(response.ok, `upload ${name} failed: ${JSON.stringify(body)}`)
    return body.media
  }

  async function createContent(title, kind) {
    const response = await fetch(`${base}/api/contents`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, kind }),
    })
    const body = await response.json()
    assert.ok(response.ok, `create ${kind} failed: ${JSON.stringify(body)}`)
    return body.content
  }

  const imageAsset = await uploadAsset('picker-image.png', PNG, 'image/png')
  const videoAsset = await uploadAsset('picker-video.mp4', readFileSync(videoFixture), 'video/mp4')
  const documentAsset = await uploadAsset('picker-doc.md', Buffer.from('# 文档\n\n素材库文档。\n', 'utf8'), 'text/markdown')

  const article = await createContent('素材插入测试文章', 'article')
  const gallery = await createContent('素材插入测试图文', 'gallery')
  const video = await createContent('素材插入测试视频', 'video')

  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.setDefaultTimeout(20_000)

  await page.goto(`${base}/login`)
  await page.fill('input[name="account"], #account', account)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')
  await page.waitForURL(/library/)

  // Article: insert one image and one document from the library.
  await page.goto(`${base}/editor/${article.id}`)
  await page.locator('.tiptap').waitFor()
  await page.getByRole('button', { name: '从素材库插入', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('button', { name: `选择 ${imageAsset.originalName}`, exact: true }).click()
  await page.getByRole('tab', { name: '文档', exact: true }).click()
  await page.getByRole('button', { name: `选择 ${documentAsset.originalName}`, exact: true }).click()
  await page.getByRole('button', { name: '添加 2 个素材', exact: true }).click()
  await page.waitForFunction(() => {
    const editor = document.querySelector('.tiptap')
    return Boolean(editor?.querySelector('img')) && Boolean(editor.textContent?.includes('附件：picker-doc.md'))
  })
  await page.waitForFunction(() => /已保存/.test(document.querySelector('.editor-save-state')?.textContent || ''))
  const articleDetail = await (await fetch(`${base}/api/contents/${article.id}`, { headers: auth })).json()
  assert.match(articleDetail.content.contentHtml, /<img /)
  assert.match(articleDetail.content.contentHtml, /picker-doc\.md/)
  await page.screenshot({ path: path.join(output, 'article.png') })

  // Gallery: add an image from the library.
  await page.goto(`${base}/gallery/${gallery.id}`)
  await page.locator('.gallery-page').waitFor()
  await page.getByRole('button', { name: '从素材库添加', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('button', { name: `选择 ${imageAsset.originalName}`, exact: true }).click()
  await page.getByRole('button', { name: '添加 1 个素材', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.gallery-image-card').length === 1)
  await page.waitForFunction(() => /已保存/.test(document.querySelector('.gallery-save-state')?.textContent || ''))
  await page.screenshot({ path: path.join(output, 'gallery.png') })

  // Video: add a clip from the library.
  await page.goto(`${base}/video/${video.id}`)
  await page.locator('.video-page, .video-workspace').first().waitFor()
  await page.getByRole('button', { name: '从素材库添加视频', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('button', { name: `选择 ${videoAsset.originalName}`, exact: true }).click()
  await page.getByRole('button', { name: '添加 1 个素材', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.video-clip-item').length === 1)
  await page.waitForFunction(() => /已保存/.test(document.querySelector('.video-save-state')?.textContent || ''))
  const videoProject = await (await fetch(`${base}/api/contents/${video.id}/video`, { headers: auth })).json()
  assert.equal(videoProject.project.clips.length, 1)
  await page.screenshot({ path: path.join(output, 'video.png') })

  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', screenshots: output }))
} finally {
  await browser?.close()
  server.kill()
}
