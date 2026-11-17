// Verify the editor cover picker: choose a body image, then replace it with a
// local upload. Uses an isolated data dir, a real server build and headless
// Chrome, matching the other UI smoke scripts.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'editor-cover-check')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.EDITOR_COVER_QA_PORT || 34241)
const base = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
assert.ok(chrome, 'Install Chrome or set CHROME_BIN')

// A valid 1×1 PNG; the bytes are only used to exercise the upload endpoints.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lPj3WQAAAABJRU5ErkJggg==',
  'base64',
)

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
    JWT_SECRET: 'editor-cover-ui-smoke',
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

  const account = `cover_${Date.now().toString(36)}`
  const registration = await (
    await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: account,
        email: `${account}@example.com`,
        password: 'CoverQA!2026',
      }),
    })
  ).json()
  assert.ok(registration.token, `registration failed: ${JSON.stringify(registration)}`)
  const token = registration.token
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  async function uploadImage(name) {
    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), name)
    const response = await fetch(`${base}/api/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const body = await response.json()
    assert.ok(response.ok && body.media?.url, `image upload failed: ${JSON.stringify(body)}`)
    return body.media.url
  }

  const bodyImageA = await uploadImage('body-a.png')
  const bodyImageB = await uploadImage('body-b.png')
  const embeddedImage =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lPj3WQAAAABJRU5ErkJggg=='
  const created = await (
    await fetch(`${base}/api/contents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: '正文图片封面验收',
        contentHtml:
          '<p>封面选择验收正文</p>' +
          `<figure><img src="${bodyImageA}" alt="正文图一"><figcaption>图：正文图一</figcaption></figure>` +
          `<p><img src="${bodyImageB}" alt="正文图二"></p>` +
          `<p><img src="${embeddedImage}" alt="内嵌图三"></p>`,
      }),
    })
  ).json()
  const contentId = created.content.id
  assert.ok(contentId, `content creation failed: ${JSON.stringify(created)}`)

  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.addInitScript((value) => {
    if (window === window.top) localStorage.setItem('multipush_token', value)
  }, token)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(`${base}/editor/${contentId}`)
  await until(async () => (await page.locator('.editor-title-input').inputValue()) === '正文图片封面验收', 'editor did not load')
  await page.getByRole('button', { name: /从正文选择/ }).first().waitFor({ timeout: 10_000 })
  await page.screenshot({ path: path.join(output, 'cover-empty.png') })

  // 1) Pick the first body image from the gallery.
  await page.getByRole('button', { name: /从正文选择/ }).first().click()
  const dialog = page.getByRole('dialog', { name: '从正文选择封面' })
  await dialog.waitFor({ timeout: 10_000 })
  const firstTile = page.getByRole('button', { name: /第 1 张正文图片/ })
  await firstTile.waitFor({ timeout: 10_000 })
  assert.match(await dialog.innerText(), /共 3 张正文图片/)
  await firstTile.click()
  await page.locator('.editor-cover-preview img').waitFor({ timeout: 10_000 })
  const selectedSrc = await page.locator('.editor-cover-preview img').getAttribute('src')
  assert.equal(selectedSrc, `${base}${bodyImageA}`)
  await until(async () => {
    const response = await fetch(`${base}/api/contents/${contentId}`, { headers })
    const body = await response.json()
    return body.content.coverImage === bodyImageA
  }, 'cover selection was not auto-saved')
  await page.screenshot({ path: path.join(output, 'cover-selected.png'), fullPage: true })

  // 2) Reopening the gallery marks the current cover.
  await page.getByRole('button', { name: '从正文选择' }).click()
  await page.getByRole('dialog', { name: '从正文选择封面' }).waitFor({ timeout: 10_000 })
  assert.equal(await page.getByRole('button', { name: /第 1 张正文图片/ }).getAttribute('aria-pressed'), 'true')
  assert.match(await page.getByRole('button', { name: /第 1 张正文图片/ }).innerText(), /当前封面/)
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(output, 'cover-current.png') })
  await page.getByRole('button', { name: '取消' }).click()

  // 3) Local upload still replaces the cover and persists.
  await page.locator('input[aria-label="上传封面图片"]').setInputFiles({
    name: 'local-cover.png',
    mimeType: 'image/png',
    buffer: png,
  })
  await until(async () => {
    const response = await fetch(`${base}/api/contents/${contentId}`, { headers })
    const body = await response.json()
    return body.content.coverImage && body.content.coverImage !== bodyImageA
  }, 'local cover upload was not saved')
  const saved = await (await fetch(`${base}/api/contents/${contentId}`, { headers })).json()
  assert.match(saved.content.coverImage, /^\/uploads\//)
  await until(async () => {
    const src = await page.locator('.editor-cover-preview img').getAttribute('src')
    return src === `${base}${saved.content.coverImage}`
  }, 'cover preview did not update after local upload')

  // 4) Reloading keeps the saved cover and the body image list.
  await page.reload()
  await until(async () => (await page.locator('.editor-title-input').inputValue()) === '正文图片封面验收', 'editor did not reload')
  await page.locator('.editor-cover-preview img').waitFor({ timeout: 10_000 })
  assert.equal(
    await page.locator('.editor-cover-preview img').getAttribute('src'),
    `${base}${saved.content.coverImage}`,
  )
  await page.getByRole('button', { name: '从正文选择' }).click()
  await page.getByRole('dialog', { name: '从正文选择封面' }).waitFor({ timeout: 10_000 })
  assert.match(await page.getByRole('dialog', { name: '从正文选择封面' }).innerText(), /共 3 张正文图片/)
  assert.match(await page.getByRole('button', { name: /第 3 张正文图片/ }).innerText(), /内嵌/)
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(output, 'cover-picker.png') })

  // 5) Embedded (base64) body images are uploaded before becoming the cover.
  await page.getByRole('button', { name: /第 3 张正文图片/ }).click()
  await until(async () => {
    const response = await fetch(`${base}/api/contents/${contentId}`, { headers })
    const body = await response.json()
    return body.content.coverImage && body.content.coverImage !== saved.content.coverImage
  }, 'embedded cover image was not transferred and saved')

  assert.deepEqual(errors, [], errors.join('; '))
  const finalContent = await (await fetch(`${base}/api/contents/${contentId}`, { headers })).json()
  console.log(JSON.stringify({ ok: true, contentId, bodyImages: [bodyImageA, bodyImageB, 'embedded'], cover: finalContent.content.coverImage, output }))
} finally {
  await browser?.close().catch(() => {})
  server.kill('SIGTERM')
  await new Promise((resolve) => server.once('exit', resolve))
}
