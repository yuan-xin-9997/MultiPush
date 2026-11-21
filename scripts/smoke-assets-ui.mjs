// Verify the asset library end to end: register, create folders, upload image /
// video / document assets, move one between folders, rename and delete a
// folder, preview/download/delete files, and check the mobile layout.
// Uses an isolated data dir and the real production build.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'assets-check')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.ASSETS_QA_PORT || 34245)
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
const MARKDOWN = Buffer.from('# 素材说明\n\n这是素材库的文档预览内容。\n\n![封面](cover.png)\n\n- 第一项\n- 第二项\n', 'utf8')

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
    JWT_SECRET: 'assets-ui-smoke',
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

  const account = `assets_ui_${Date.now().toString(36)}`
  const password = 'AssetsQA!2026'
  const registration = await (await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account, email: `${account}@example.com`, password }),
  })).json()
  assert.ok(registration.token, `registration failed: ${JSON.stringify(registration)}`)

  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, acceptDownloads: true })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.setDefaultTimeout(20_000)

  await page.goto(`${base}/login`)
  await page.fill('input[name="account"], #account', account)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')
  await page.waitForURL(/library/)

  const nav = (await page.locator('.app-nav-link').allInnerTexts()).map((text) => text.trim())
  assert.deepEqual(nav.slice(0, 3), ['AI 创作', '素材库', '内容库'])
  await page.getByRole('link', { name: '素材库', exact: true }).click()
  await page.waitForURL(/\/assets$/)
  await page.getByRole('heading', { name: '素材库', exact: true }).waitFor()
  await page.locator('.empty-state').waitFor()

  // Create a folder first; uploads go into the active folder.
  await page.locator('.assets-head-actions').getByRole('button', { name: '新建文件夹', exact: true }).click()
  await page.getByRole('dialog').locator('input').fill('产品素材')
  await page.getByRole('button', { name: '创建文件夹', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.assets-current-folder')?.textContent?.includes('产品素材'))
  assert.match(await page.locator('.assets-folders-head').innerText(), /1 个文件夹/)

  const input = page.locator('.assets-page input[type="file"]')
  await input.setInputFiles([
    { name: 'cover.png', mimeType: 'image/png', buffer: PNG },
    { name: '演示视频.mp4', mimeType: 'video/mp4', buffer: readFileSync(videoFixture) },
    { name: '素材说明.md', mimeType: 'text/markdown', buffer: MARKDOWN },
  ])
  await page.waitForFunction(() => document.querySelectorAll('.asset-card:not(.asset-card-skeleton)').length === 3)
  const names = await page.locator('.asset-name').allInnerTexts()
  assert.deepEqual(names.sort(), ['cover.png', '演示视频.mp4', '素材说明.md'].sort())
  const stats = (await page.locator('.assets-stat').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim())
  assert.match(stats[0], /3/)
  assert.match(stats[1], /1/)
  assert.match(stats[2], /1/)
  assert.match(stats[3], /1/)
  const productFolder = page.locator('.assets-folder-wrap').filter({ hasText: '产品素材' })
  assert.match(await productFolder.innerText(), /3 个素材/)
  await page.screenshot({ path: path.join(output, 'desktop.png') })

  // Markdown preview must render and resolve a relative image reference to the
  // uploaded asset in the same folder.
  await page.getByRole('button', { name: '预览 素材说明.md', exact: true }).click()
  await page.waitForFunction(() => (document.querySelector('.asset-markdown')?.textContent || '').includes('素材库的文档预览内容'))
  await page.waitForFunction(() => {
    const image = document.querySelector('.asset-markdown img')
    return Boolean(image?.getAttribute('src')?.includes('/uploads/'))
  })
  await page.screenshot({ path: path.join(output, 'markdown-preview.png') })
  await page.getByRole('button', { name: '关闭弹窗' }).click()

  // Folder navigation and a second folder.
  await page.locator('.assets-folder-card.is-all').click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 3)
  await page.locator('.assets-folder-card').filter({ hasText: '未分组' }).click()
  await page.locator('.empty-state').waitFor()
  await productFolder.locator('.assets-folder-card').click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 3)

  await page.locator('.assets-head-actions').getByRole('button', { name: '新建文件夹', exact: true }).click()
  await page.getByRole('dialog').locator('input').fill('品牌资料')
  await page.getByRole('button', { name: '创建文件夹', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.assets-current-folder')?.textContent?.includes('品牌资料'))
  await productFolder.locator('.assets-folder-card').click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 3)

  // Move cover.png into 品牌资料.
  await page.getByRole('button', { name: '「cover.png」更多操作' }).click()
  await page.getByRole('menuitem', { name: '移动到文件夹' }).click()
  await page.getByRole('dialog').locator('label').filter({ hasText: '品牌资料' }).click()
  await page.getByRole('button', { name: '确认移动' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 2)
  assert.match(await productFolder.innerText(), /2 个素材/)
  const brandFolder = page.locator('.assets-folder-wrap').filter({ hasText: '品牌资料' })
  assert.match(await brandFolder.innerText(), /1 个素材/)
  const scopedStats = (await page.locator('.assets-stat').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim())
  assert.match(scopedStats[0], /2/)
  assert.match(scopedStats[1], /0/)
  assert.match(scopedStats[2], /1/)
  assert.match(scopedStats[3], /1/)

  // Rename the folder, then delete it: its asset should return to 未分组.
  await page.getByRole('button', { name: '「品牌资料」文件夹操作' }).click()
  await page.getByRole('menuitem', { name: '重命名' }).click()
  await page.getByRole('dialog').locator('input').fill('品牌素材')
  await page.getByRole('button', { name: '保存名称' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.assets-folder-wrap')].some((node) => node.textContent?.includes('品牌素材')))
  await page.getByRole('button', { name: '「品牌素材」文件夹操作' }).click()
  await page.getByRole('menuitem', { name: '删除文件夹' }).click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('button', { name: '删除文件夹', exact: true }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.assets-folder-wrap')].some((node) => node.textContent?.includes('品牌素材')))
  await page.locator('.assets-folder-card').filter({ hasText: '未分组' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 1)
  assert.equal(await page.locator('.asset-name').first().innerText(), 'cover.png')
  await productFolder.locator('.assets-folder-card').click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 2)

  // Search and type filters stay inside the active folder.
  await page.getByLabel('搜索素材').fill('素材说明')
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 1)
  await page.getByLabel('清空搜索').click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 2)
  await page.getByRole('tab', { name: /文档/ }).click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 1)
  await page.getByRole('tab', { name: /全部/ }).click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 2)

  // Preview image (未分组), markdown text and video.
  await page.locator('.assets-folder-card').filter({ hasText: '未分组' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 1)
  await page.getByRole('button', { name: '预览 cover.png', exact: true }).click()
  await page.locator('.asset-preview-media').waitFor()
  assert.equal(await page.locator('.asset-preview-media').evaluate((node) => node.tagName), 'IMG')
  await page.getByRole('button', { name: '关闭弹窗' }).click()
  await productFolder.locator('.assets-folder-card').click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-name').length === 2)

  await page.getByRole('button', { name: '预览 素材说明.md', exact: true }).click()
  await page.waitForFunction(() => (document.querySelector('.asset-markdown')?.textContent || '').includes('素材库的文档预览内容'))
  await page.getByRole('button', { name: '关闭弹窗' }).click()
  await page.getByRole('button', { name: '预览 演示视频.mp4', exact: true }).click()
  await page.locator('video.asset-preview-media').waitFor()
  await page.getByRole('button', { name: '关闭弹窗' }).click()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载 素材说明.md' }).click(),
  ])
  assert.equal(download.suggestedFilename(), '素材说明.md')

  await page.getByRole('button', { name: '「素材说明.md」更多操作' }).click()
  await page.getByRole('menuitem', { name: '删除素材' }).click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-card:not(.asset-card-skeleton)').length === 1)

  // After reload the all-assets view shows the unfiled cover plus the video.
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.asset-card:not(.asset-card-skeleton)').length === 2)
  await page.locator('.assets-folder-wrap').filter({ hasText: '产品素材' }).locator('.assets-folder-card').click()
  await page.waitForFunction(() => document.querySelectorAll('.asset-card:not(.asset-card-skeleton)').length === 1)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 1, `assets mobile horizontal overflow: ${overflow}`)
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true })

  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', account, screenshots: output }))
} finally {
  await browser?.close()
  server.kill()
}
