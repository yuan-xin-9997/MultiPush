import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = require('electron')
const userData = await mkdtemp(path.join(os.tmpdir(), 'multipush-desktop-smoke-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
Object.assign(env, {
  MULTIPUSH_USER_DATA: userData,
  ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
})

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function launch() {
  return electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: desktopDir,
    env,
    timeout: 30_000,
  })
}

async function findWindow(electronApp, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = electronApp.windows().find(predicate)
    if (found) return found
    await delay(100)
  }
  throw new Error(`Timed out waiting for window. Open windows: ${electronApp.windows().map((page) => page.url()).join(', ')}`)
}

let electronApp = null
try {
  electronApp = await launch()
  const page = await findWindow(electronApp, (window) => window.url().startsWith('http://127.0.0.1:'), 30_000)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 20_000 })
  if (!/MultiPush/.test(await page.title())) throw new Error(`Unexpected title: ${await page.title()}`)

  const baseUrl = new URL(page.url()).origin
  const health = await page.evaluate(async () => {
    const response = await fetch('/api/health')
    return response.json()
  })
  if (health.service !== 'multipush' || health.desktopMode !== true) {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`)
  }

  await page.goto(`${baseUrl}/register`)
  await page.waitForSelector('#register-username')
  await page.waitForFunction(
    () => document.body.innerText.includes('本地版无需邮箱验证码') && !document.querySelector('#email-code'),
    null,
    { timeout: 10_000 },
  )

  await page.fill('#register-username', 'localuser')
  await page.fill('#register-email', 'local@example.com')
  await page.fill('#register-password', 'Password!123')
  await page.fill('#register-confirm', 'Password!123')
  await page.click('button[type="submit"]')
  await page.waitForURL(/\/library/, { timeout: 30_000 })
  await page.waitForSelector('.app-shell')
  await page.waitForSelector('.library-page')

  const database = path.join(userData, 'data', 'multipush.sqlite')
  const info = await stat(database)
  if (info.size <= 0) throw new Error('Local database was not created')

  await electronApp.close()
  electronApp = null

  // Relaunch with the same user data: the local database and JWT session must
  // survive, and the saved port should keep the origin stable.
  electronApp = await launch()
  const second = await findWindow(electronApp, (window) => window.url().startsWith('http://127.0.0.1:'), 30_000)
  await second.waitForLoadState('domcontentloaded')
  await second.waitForSelector('.app-shell', { timeout: 20_000 })
  await second.waitForSelector('.library-page', { timeout: 20_000 })
  if (new URL(second.url()).origin !== baseUrl) {
    throw new Error(`Desktop origin changed across launches: ${baseUrl} -> ${new URL(second.url()).origin}`)
  }

  console.log(`MultiPush local desktop smoke passed on ${process.platform} (${baseUrl})`)
} finally {
  await electronApp?.close().catch(() => {})
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}
