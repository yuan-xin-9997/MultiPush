import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = require('electron')

const fixture = http.createServer((request, response) => {
  if (request.url === '/api/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ status: 'ok', service: 'multipush', version: '9.9.9', time: new Date().toISOString() }))
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>MultiPush Smoke</title></head>
<body><main id="ok">MultiPush desktop smoke test</main></body></html>`)
})

await new Promise((resolve, reject) => {
  fixture.once('error', reject)
  fixture.listen(0, '127.0.0.1', resolve)
})
const port = fixture.address().port
const baseUrl = `http://127.0.0.1:${port}`
const userData = await mkdtemp(path.join(os.tmpdir(), 'multipush-desktop-smoke-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
Object.assign(env, {
  MULTIPUSH_USER_DATA: userData,
  MULTIPUSH_SERVER: baseUrl,
  MULTIPUSH_SMOKE: '1',
  ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
})

const electronApp = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  cwd: desktopDir,
  env,
  timeout: 30_000,
})

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function findWindow(predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = electronApp.windows().find(predicate)
    if (found) return found
    await delay(100)
  }
  throw new Error(`Timed out waiting for window. Open windows: ${electronApp.windows().map((page) => page.url()).join(', ')}`)
}

async function waitForStatus(page, kind, timeout = 15_000) {
  await page.waitForFunction(
    (expected) => document.querySelector('#status')?.dataset.kind === expected,
    kind,
    { timeout },
  )
}

try {
  const setup = await findWindow((page) => page.url().includes('setup.html'), 20_000)
  await setup.waitForLoadState('domcontentloaded')
  await setup.waitForSelector('#server')
  if (await setup.title() !== '连接 MultiPush') throw new Error('Setup window title is unexpected')
  const prefilled = await setup.inputValue('#server')
  if (prefilled !== baseUrl) throw new Error(`Setup window should prefill ${baseUrl}, got ${prefilled}`)

  await setup.fill('#server', 'http://127.0.0.1:1')
  await setup.click('#test')
  await waitForStatus(setup, 'error')

  await setup.fill('#server', baseUrl)
  await setup.click('#test')
  await waitForStatus(setup, 'success')
  const statusText = await setup.textContent('#status')
  if (!statusText?.includes('9.9.9')) throw new Error(`Server version missing from status: ${statusText}`)

  await setup.click('#connect')
  const page = await findWindow((window) => window.url().startsWith(`${baseUrl}/`), 30_000)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => document.querySelector('#ok')?.textContent === 'MultiPush desktop smoke test')
  if (await page.title() !== 'MultiPush Smoke') throw new Error(`App window title is ${await page.title()}`)

  console.log(`MultiPush desktop smoke passed on ${process.platform}`)
} finally {
  await electronApp.close().catch(() => {})
  await new Promise((resolve) => fixture.close(resolve))
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}
