// End-to-end figure/caption regression:
// Markdown import -> Tiptap editor open/save/reopen -> server render for
// WeChat / Zhihu / blog. Uses an isolated local database and never publishes.
//
//   npm run build
//   node scripts/smoke-figure-captions.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { load } from 'cheerio'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'figure-caption-fix')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'e2e-data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.FIGURE_QA_PORT || 34211)
const base = `http://127.0.0.1:${port}`
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
const chrome = process.env.CHROME_BIN || process.env.WECHAT_BROWSER_PATH || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/opt/MultiPush/.browsers/chromium-1243/chrome-linux64/chrome',
].find(existsSync)
assert.ok(chrome, 'Install Chrome/Chromium or set CHROME_BIN')

function imageData(index) {
  const hue = Math.round((index * 360) / 21)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},70%,35%)"/></linearGradient></defs><rect width="800" height="500" fill="url(#g)"/><text x="400" y="250" text-anchor="middle" font-size="64" fill="white" font-family="sans-serif">图 ${index + 1}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

const markdown = [
  '# 21 组图注回归',
  '',
  '这篇文章用于验证 Markdown 导入、编辑器保存和三个平台渲染。',
  '',
  ...Array.from({ length: 21 }, (_, index) => [
    `## 第 ${index + 1} 组`,
    '',
    `![第 ${index + 1} 张图](${imageData(index)})`,
    '',
    `*图：第 ${index + 1} 组图注：）*`,
    '',
    `第 ${index + 1} 组正文，图片与图注之间不应出现空行。`,
    '',
  ]).flat(),
].join('\n')
const markdownPath = path.join(output, 'fixtures-21.md')
writeFileSync(markdownPath, markdown, 'utf8')

let log = ''
const server = spawn(process.execPath, ['server/dist/index.js'], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    WEB_DIST: path.join(root, 'web', 'dist'),
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    MULTIPUSH_DESKTOP: '1',
    PUBLIC_BASE_URL: base,
    JWT_SECRET: 'figure-caption-e2e-secret',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (data) => { log += data })
server.stderr.on('data', (data) => { log += data })

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message, timeout = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const value = await check()
      if (value) return value
    } catch { /* retry */ }
    await delay(150)
  }
  throw new Error(`${message}\n--- server log ---\n${log}`)
}

let browser
let token = ''
async function api(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${base}/api/${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json()
  if (!response.ok) throw new Error(`${method} /api/${route}: ${response.status} ${JSON.stringify(data)}`)
  return data
}

function figureStats(html) {
  const $ = load(html)
  return {
    figures: $('figure').length,
    captions: $('figcaption').length,
    captionsInsideParagraphs: $('p figcaption').length,
    paragraphsInsideFigures: $('figure p').length,
    imagesInsideParagraphs: $('p img').length,
    imageMargins: [...new Set($('figure img').toArray().map((node) => $(node).css('margin')))],
    captionMargins: [...new Set($('figcaption').toArray().map((node) => $(node).css('margin-top') || $(node).css('margin')))],
  }
}

try {
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'Isolated server did not start')
  const account = `figure_${Date.now().toString(36)}`
  const registration = await api('auth/register', { username: account, email: `${account}@example.com`, password: 'FigureQA!2026' })
  token = registration.token

  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript((value) => localStorage.setItem('multipush_token', value), token)
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`${base}/library`)
  await page.getByRole('heading', { name: '全部内容' }).waitFor()
  await page.locator('input[type="file"]').setInputFiles(markdownPath)
  await page.getByText(/成功导入 1 篇文档/).waitFor({ timeout: 20_000 })
  const card = page.getByRole('button', { name: /打开文档「21 组图注回归」/ })
  await card.waitFor()
  await card.click()
  await page.locator('.tiptap').waitFor()
  await until(async () => (await page.locator('.tiptap figure').count()) === 21, 'Editor did not load 21 figures')
  assert.equal(await page.locator('.tiptap figcaption').count(), 21)
  await page.screenshot({ path: path.join(output, 'editor-21-figures.png'), fullPage: false })

  // Ctrl/Cmd+S forces the same save path as the toolbar's auto-save.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await until(async () => {
    const list = await api('contents?q=' + encodeURIComponent('21 组图注回归'))
    const item = list.items?.[0]
    if (!item) return false
    const detail = await api(`contents/${item.id}`)
    return detail.content?.contentJsonStale === false && (detail.content?.contentHtml?.match(/<figure/g) ?? []).length === 21
  }, 'Saved content did not contain 21 figures')

  const list = await api('contents?q=' + encodeURIComponent('21 组图注回归'))
  const contentId = list.items[0].id
  const detail = await api(`contents/${contentId}`)
  assert.equal(detail.content.contentJsonStale, false)
  assert.equal((detail.content.contentJson.content ?? []).filter((node) => node.type === 'figure').length, 21)
  assert.equal((detail.content.contentHtml.match(/<figure/g) ?? []).length, 21)

  // Re-open the saved document and confirm the editor still sees 21 figures.
  await page.reload()
  await page.locator('.tiptap').waitFor()
  await until(async () => (await page.locator('.tiptap figure').count()) === 21, 'Reopened editor lost figures')
  assert.equal(await page.locator('.tiptap figcaption').count(), 21)
  await page.screenshot({ path: path.join(output, 'editor-21-figures-reopened.png') })

  // Simulate an API-only contentHtml PATCH: the editor must load the new HTML,
  // not the old contentJson snapshot, and a subsequent save must resync both.
  const staleHtml = String(detail.content.contentHtml).replace(
    '<p>这篇文章用于验证 Markdown 导入、编辑器保存和三个平台渲染。</p>',
    '<p>这篇文章用于验证 Markdown 导入、编辑器保存和三个平台渲染。</p><p>API 直接修改的正文标记。</p>',
  )
  const patchResponse = await fetch(`${base}/api/contents/${contentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ contentHtml: staleHtml }),
  })
  assert.equal(patchResponse.status, 200)
  const patched = await patchResponse.json()
  assert.equal(patched.content.contentJsonStale, true)
  await page.reload()
  await page.locator('.tiptap').waitFor()
  await page.getByText('API 直接修改的正文标记。').waitFor()
  assert.equal(await page.locator('.tiptap figure').count(), 21)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await until(async () => {
    const latest = await api(`contents/${contentId}`)
    return latest.content?.contentJsonStale === false
  }, 'Editor save did not resync stale JSON')

  const { render } = await api('renders', {
    contentId,
    platforms: ['wechat', 'zhihu', 'blog'],
    options: { authorName: '图注回归' },
  })
  const summary = {}
  for (const platform of ['wechat', 'zhihu', 'blog']) {
    const result = render.results.find((item) => item.platform === platform)
    assert.ok(result, `missing ${platform} result`)
    writeFileSync(path.join(output, `${platform}-render.html`), result.html, 'utf8')
    const stats = figureStats(result.html)
    assert.equal(stats.figures, 21, `${platform}: expected 21 figures`)
    assert.equal(stats.captions, 21, `${platform}: expected 21 figcaptions`)
    assert.equal(stats.captionsInsideParagraphs, 0, `${platform}: figcaption inside p`)
    assert.equal(stats.paragraphsInsideFigures, 0, `${platform}: p inside figure`)
    for (const margin of stats.imageMargins) assert.match(margin, /^0(auto)?/i, `${platform}: image margin ${margin}`)
    for (const margin of stats.captionMargins) assert.match(margin, /^8px/i, `${platform}: caption margin ${margin}`)
    summary[platform] = stats

    // Visual evidence: render the platform fragment in a fresh page. Blog
    // output uses loading="lazy"; force eager so a full-page screenshot has all
    // 21 images (this only changes the local screenshot copy).
    const preview = await context.newPage()
    const body = result.html.replace(/loading="lazy"/g, 'loading="eager"')
    await preview.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
      body{margin:0;background:#eef0f3;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
      .phone{width:${platform === 'wechat' ? 414 : 760}px;margin:24px auto;background:#fff;padding:${platform === 'wechat' ? 20 : 32}px;box-sizing:border-box;box-shadow:0 8px 30px rgba(0,0,0,.08)}
    </style></head><body><main class="phone">${body}</main></body></html>`)
    await preview.waitForLoadState('load')
    await preview.screenshot({ path: path.join(output, `${platform}-preview.png`), fullPage: true })
    await preview.close()
  }

  assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join('; ')}`)
  writeFileSync(path.join(output, 'e2e-result.json'), JSON.stringify({ ok: true, contentId, summary }, null, 2), 'utf8')
  console.log(JSON.stringify({ ok: true, contentId, summary, artifacts: output }, null, 2))
} finally {
  await browser?.close().catch(() => {})
  server.kill('SIGTERM')
  await new Promise((resolve) => server.once('exit', resolve))
}
