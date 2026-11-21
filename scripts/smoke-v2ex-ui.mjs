// Verify V2EX render preview and the V2EX publish page wiring. Publishing itself
// needs a real V2EX cookie and network access, which this isolated smoke cannot
// provide; it checks rendering, limits, node selection and manual fallbacks.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'v2ex-check')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.V2EX_QA_PORT || 34247)
const base = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
assert.ok(chrome, 'Install Chrome or set CHROME_BIN')

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
    JWT_SECRET: 'v2ex-ui-smoke',
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
  const account = `v2ex_ui_${Date.now().toString(36)}`
  const password = 'V2exQA!2026'
  const registration = await (await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account, email: `${account}@example.com`, password }),
  })).json()
  assert.ok(registration.token, `registration failed: ${JSON.stringify(registration)}`)
  const auth = { Authorization: `Bearer ${registration.token}`, 'Content-Type': 'application/json' }

  const content = await (await fetch(`${base}/api/contents`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      title: 'V2EX 渲染发布测试：数字生活与工具',
      kind: 'article',
      tags: ['数字生活', '工具'],
      contentHtml: '<h2>为什么写这篇</h2><p>这是一篇用于验证 <strong>V2EX</strong> 渲染和发布流程的文章。</p><ul><li>标题与节点</li><li>Markdown 正文</li></ul><pre><code>const ok = true</code></pre>',
      status: 'ready',
    }),
  })).json()
  const render = await (await fetch(`${base}/api/renders`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ contentId: content.content.id, platforms: ['v2ex'], options: {} }),
  })).json()
  assert.ok(render.render?.id, `render failed: ${JSON.stringify(render)}`)

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

  await page.goto(`${base}/render?renderId=${render.render.id}`)
  await page.waitForSelector('.render-tab')
  const tab = page.getByRole('tab', { name: /V2EX/ })
  if (await tab.count()) await tab.click()
  await page.waitForFunction(() => (document.querySelector('body')?.innerText || '').includes('V2EX 主题'))
  const body = await page.locator('body').innerText()
  assert.match(body, /标题最多 120 字/)
  assert.match(body, /正文最多 20000 字符/)
  await page.screenshot({ path: path.join(output, 'render.png') })

  await page.getByRole('button', { name: /发布到 V2EX/ }).click()
  await page.waitForURL(/\/publish\?platform=v2ex/)
  await page.waitForSelector('.v2ex-publish-page')
  await page.waitForFunction(() => document.querySelectorAll('.v2ex-publish-page select option').length > 2)
  const options = await page.locator('.v2ex-publish-page select option').allInnerTexts()
  assert.ok(options.some(text => text.includes('programming')), 'common nodes should be shown')
  const text = await page.locator('.v2ex-publish-page').innerText()
  assert.match(text, /连接 V2EX/)
  assert.match(text, /复制 Markdown/)
  assert.match(text, /打开发帖页/)
  await page.screenshot({ path: path.join(output, 'publish.png') })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 1, `V2EX mobile horizontal overflow: ${overflow}`)
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true })

  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', screenshots: output }))
} finally {
  await browser?.close()
  server.kill()
}
