// Verify the image-first gallery workspace end to end: register, create a
// gallery from the library, upload images, edit captions/body, reorder, let it
// autosave, reload, then render it as 公众号贴图 / 小红书 / 抖音图文.
// Uses an isolated data dir and the real production build, matching the other
// UI smoke scripts. Run `npm run build` first (or use `npm run smoke:gallery`).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'gallery-check')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.GALLERY_QA_PORT || 34244)
const base = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
assert.ok(chrome, 'Install Chrome or set CHROME_BIN')

// 1x1 PNGs are enough for the functional flow; the grid stretches them.
const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4fy0NAAUTAjz/apfHAAAAAElFTkSuQmCC', 'base64')
const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNo3vcfAAQIAkGUzusFAAAAAElFTkSuQmCC', 'base64')

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
    JWT_SECRET: 'gallery-ui-smoke',
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

  const account = `gallery_ui_${Date.now().toString(36)}`
  const password = 'GalleryQA!2026'
  const registration = await (await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account, email: `${account}@example.com`, password }),
  })).json()
  assert.ok(registration.token, `registration failed: ${JSON.stringify(registration)}`)
  const token = registration.token

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

  const labels = (await page.locator('.library-head-actions .btn').allInnerTexts()).map((text) => text.trim())
  assert.deepEqual(labels, ['导入', '新建图文', '新建视频', '新建文章'])

  await page.getByRole('button', { name: '新建图文', exact: true }).first().click()
  await page.waitForURL(/\/gallery\//)
  const contentId = page.url().split('/gallery/')[1]
  assert.ok(contentId, 'gallery id in URL')
  await page.locator('.gallery-dropzone').waitFor()

  const input = page.locator('input[type="file"][accept*="image"]')
  await input.setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: PNG_A },
    { name: 'second.png', mimeType: 'image/png', buffer: PNG_B },
  ])
  await page.waitForFunction(() => document.querySelectorAll('.gallery-image-card').length === 2)

  await page.locator('.gallery-title-input').fill('图文回归测试｜两张图')
  await page.locator('.gallery-caption-input').nth(0).fill('第一张说明')
  await page.locator('.gallery-caption-input').nth(1).fill('第二张说明')
  await page.locator('.gallery-copy-input').fill('这是图文回归测试的配文。\n\n第二段。')
  await page.waitForFunction(() => /已保存/.test(document.querySelector('.gallery-save-state')?.textContent || ''))

  // Move the second image before the first, then let autosave settle.
  await page.locator('.gallery-image-card').nth(1).getByRole('button', { name: '前移一位' }).click()
  await page.waitForFunction(() => /已保存/.test(document.querySelector('.gallery-save-state')?.textContent || ''))
  await page.screenshot({ path: path.join(output, 'desktop.png') })

  await page.reload()
  await page.waitForSelector('.gallery-image-card')
  assert.equal(await page.locator('.gallery-image-card').count(), 2)
  assert.equal(await page.locator('.gallery-caption-input').nth(0).inputValue(), '第二张说明')
  assert.equal(await page.locator('.gallery-caption-input').nth(1).inputValue(), '第一张说明')
  assert.match(await page.locator('.gallery-copy-input').inputValue(), /第二段/)
  const coverFlag = await page.locator('.gallery-cover-flag').innerText()
  assert.match(coverFlag, /封面/)

  // Library card shows the gallery badge and image count.
  await page.getByRole('button', { name: '返回内容库' }).click()
  await page.waitForURL(/library/)
  const cardText = (await page.locator('.document-card').first().innerText()).replace(/\n/g, ' | ')
  assert.match(cardText, /图文/)
  assert.match(cardText, /2 张图/)
  await page.screenshot({ path: path.join(output, 'library.png') })

  // Render through the API and verify every image reaches the image-first platforms.
  const renderResponse = await fetch(`${base}/api/renders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentId, platforms: ['wechatpic', 'xiaohongshu', 'douyin', 'wechat'] }),
  })
  const renderBody = await renderResponse.json()
  assert.ok(renderResponse.ok, `render failed: ${JSON.stringify(renderBody)}`)
  for (const platform of ['wechatpic', 'xiaohongshu', 'douyin', 'wechat']) {
    const result = renderBody.render.results.find((item) => item.platform === platform)
    assert.ok(result, `${platform} render missing`)
    assert.ok(result.meta.imageCount >= 2, `${platform} should see both images`)
  }
  assert.ok(renderBody.render.results.find((item) => item.platform === 'xiaohongshu').cards.length >= 2)

  // The gallery render button focuses the workbench on the three image platforms.
  await page.locator('.document-card').first().click()
  await page.waitForURL(/\/gallery\//)
  await page.waitForSelector('.gallery-image-card')
  await page.getByRole('button', { name: '渲染', exact: true }).click()
  await page.waitForURL(/\/render\?contentId=.*platforms=wechatpic,xiaohongshu,douyin/)
  await page.waitForTimeout(1000)
  await page.screenshot({ path: path.join(output, 'render.png') })

  // Mobile layout must not overflow horizontally.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${base}/gallery/${contentId}`)
  await page.waitForSelector('.gallery-image-card')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 1, `gallery mobile horizontal overflow: ${overflow}`)
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true })

  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', contentId, screenshots: output }))
} finally {
  await browser?.close()
  server.kill()
}
