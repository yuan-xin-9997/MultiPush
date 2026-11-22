// Verify the video workspace UI: register, create a video content, upload two
// clips through the page, trim the first clip, reorder, then export and check
// the completed output. Uses an isolated data dir, a real server build and
// headless Chrome, matching the other UI smoke scripts.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'video-workspace-check')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.VIDEO_QA_PORT || 34243)
const base = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
assert.ok(chrome, 'Install Chrome or set CHROME_BIN')

const fixtureA = path.join(root, 'server', 'test', 'fixtures', 'clip_a.mp4')
const fixtureB = path.join(root, 'server', 'test', 'fixtures', 'clip_b.mp4')
assert.ok(existsSync(fixtureA) && existsSync(fixtureB), 'video fixtures missing; generate server/test/fixtures first')

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
    JWT_SECRET: 'video-workspace-ui-smoke',
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

  const account = `video_ui_${Date.now().toString(36)}`
  const registration = await (
    await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: account,
        email: `${account}@example.com`,
        password: 'VideoQA!2026',
      }),
    })
  ).json()
  assert.ok(registration.token, `registration failed: ${JSON.stringify(registration)}`)
  const token = registration.token

  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))

  // Log in through the UI to exercise the real session flow.
  await page.goto(`${base}/login`)
  await page.fill('input[name="account"], #account', account)
  await page.fill('input[type="password"]', 'VideoQA!2026')
  await page.click('button[type="submit"]')
  await page.waitForURL(/library/, { timeout: 20_000 })

  // Create a video content from the library.
  await page.getByRole('button', { name: /新建视频/ }).first().click()
  await page.waitForURL(/\/video\//, { timeout: 20_000 })
  const url = page.url()
  assert.match(url, /\/video\//, 'new video content should open the workspace')
  await page.waitForSelector('.video-workspace, .video-page', { timeout: 20_000 })

  // Upload two clips through the file input.
  const input = page.locator('input[type="file"][accept*="video"]')
  await input.setInputFiles([fixtureA, fixtureB])
  await until(async () => (await page.locator('.video-material-item').count()) === 2, 'two raw materials should appear')
  assert.equal(await page.locator('.video-strip-segment').count(), 2, 'material strip segments')

  // Materials start in material mode; enter edit mode to trim and reorder.
  await page.getByRole('tab', { name: /剪辑模式/ }).click()
  await until(async () => (await page.locator('.video-clip-item').count()) === 2, 'two clips should appear in edit mode')

  // Trim the second clip's out-point to 1s via the number input.
  const secondCard = page.locator('.video-clip-item').nth(1)
  const outInput = secondCard.locator('input[type="number"]').nth(1)
  await outInput.fill('1')
  await outInput.blur()
  await until(async () => /已保存/.test(await page.locator('.video-save-state').innerText()), 'timeline autosaves')

  // Move the second clip up: order becomes [clip_b(trimmed 0-1s), clip_a(full)]
  await secondCard.getByRole('button', { name: '上移片段' }).click()
  await until(async () => (await page.locator('.video-clip-item').first().innerText()).includes('clip_b'), 'clip_b should be first after move up')

  // Title editing persists (blur triggers autosave).
  const titleInput = page.locator('.video-title-input')
  await titleInput.fill('工作台冒烟视频')
  await titleInput.blur()
  await until(async () => /已保存/.test(await page.locator('.video-save-state').innerText()), 'title autosaves')

  await page.screenshot({ path: path.join(output, 'workspace-edit.png') })

  // Export the merged clip and wait for completion inside the export panel.
  await page.getByRole('button', { name: /导出成片/ }).click()
  await page.waitForSelector('.video-exports-panel', { timeout: 20_000 })
  await until(async () => (await page.locator('.video-export-status.is-completed').count()) === 1, 'export should complete', 90_000)
  const panelText = await page.locator('.video-exports-panel').innerText()
  assert.match(panelText, /下载成片/, 'export panel offers download')

  // Server side: the exported media exists (found via the API, since uploads
  // use random uuid filenames) and the timeline got persisted.
  const contentIdFromUrl = url.split('/').pop()
  const exportsData = await (await fetch(`${base}/api/contents/${contentIdFromUrl}/video/exports`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json()
  const completedExport = exportsData.exports?.find((item) => item.status === 'completed' && item.outputMedia)
  assert.ok(completedExport, 'expected a completed export with output media')
  const outputName = completedExport.outputMedia.filename
  const outputSize = statSync(path.join(dataDir, 'uploads', outputName)).size
  assert.ok(outputSize > 10_000, `exported file too small: ${outputSize}`)
  await page.screenshot({ path: path.join(output, 'workspace.png'), fullPage: false })

  // Render the video content: the exported cut must preview inside 渲染记录.
  await page.goto(`${base}/render?contentId=${contentIdFromUrl}`)
  await until(async () => (await page.locator('.render-stage .phone-shell video').count()) > 0, 'WeChat preview should embed the exported video', 60_000)
  await page.screenshot({ path: path.join(output, 'render-wechat.png') })
  const wechatVideo = page.locator('.render-stage .phone-shell video').first()
  const videoSrc = await wechatVideo.getAttribute('src')
  assert.ok(videoSrc && videoSrc.includes(outputName), `WeChat preview should use the exported cut, got ${videoSrc}`)

  // Douyin: switch to the video-note preview and check the player.
  await page.locator('.render-tab', { hasText: '抖音' }).click()
  await until(async () => (await page.locator('.douyin-media-video').count()) > 0, 'Douyin preview should show the exported video', 30_000)
  await page.screenshot({ path: path.join(output, 'render-douyin.png') })

  assert.equal(errors.length, 0, `page errors: ${errors.join(' | ')}`)

  console.log('✓ 视频工作台 UI 冒烟全部通过（含渲染记录视频预览）')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  server.kill('SIGTERM')
  await delay(500)
  server.kill('SIGKILL')
}
