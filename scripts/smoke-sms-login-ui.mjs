// Verify the SMS-login modal wiring on every supported publish page. This
// only exercises the local form (phone validation + consent) and never asks a
// platform to send an SMS.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'sms-login-ui')
mkdirSync(output, { recursive: true })
const dataDir = path.join(output, 'data')
rmSync(dataDir, { recursive: true, force: true })
const port = Number(process.env.SMS_LOGIN_QA_PORT || 34251)
const base = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)
assert.ok(chrome, 'Install Chrome or set CHROME_BIN')

const platforms = [
  ['zhihu', '知乎'],
  ['weibo', '微博'],
  ['toutiao', '今日头条'],
  ['baijiahao', '百家号'],
  ['douban', '豆瓣'],
  ['juejin', '掘金'],
  ['douyin', '抖音'],
]

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
    JWT_SECRET: 'sms-login-ui-smoke',
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
    try { const value = await check(); if (value) return value } catch { /* retry */ }
    await delay(150)
  }
  throw new Error(`${message}\n${log}`)
}

let browser
try {
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'server did not start')
  const account = `sms_${Date.now().toString(36)}`
  const registration = await (await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account, email: `${account}@example.com`, password: 'SmsQA!2026' }),
  })).json()
  assert.ok(registration.token, `registration failed: ${JSON.stringify(registration)}`)
  const headers = { Authorization: `Bearer ${registration.token}`, 'Content-Type': 'application/json' }
  const anonymous = await fetch(`${base}/api/platform-sms/zhihu/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '13800138000' }),
  })
  assert.equal(anonymous.status, 401, 'SMS start must require auth')
  const invalidPhone = await fetch(`${base}/api/platform-sms/zhihu/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone: '123' }),
  })
  assert.equal(invalidPhone.status, 400, 'SMS start must validate the phone before opening a browser')

  browser = await chromium.launch({ executablePath: chrome, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.addInitScript((value) => {
    if (window === window.top) localStorage.setItem('multipush_token', value)
  }, registration.token)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const fakeLogin = {
    id: '11111111-1111-4111-8111-111111111111',
    platform: 'zhihu',
    status: 'waiting',
    message: '验证码已发送至 138****8000，请查看手机短信',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    phoneMasked: '138****8000',
  }
  await page.route('**/api/platform-sms/zhihu/start', (route) => route.fulfill({ json: { login: fakeLogin } }))
  await page.route(`**/api/platform-sms/zhihu/${fakeLogin.id}/verify`, (route) =>
    route.fulfill({ json: { login: { ...fakeLogin, status: 'connected', name: '测试知乎账号', message: '测试知乎账号已连接' } } }),
  )

  for (const [platform, name] of platforms) {
    await page.goto(`${base}/publish?platform=${platform}`)
    const openButton = page.getByRole('button', { name: '手机验证码登录', exact: true })
    await openButton.waitFor({ timeout: 15_000 })
    await openButton.click()
    const dialog = page.getByRole('dialog', { name: `${name}手机验证码登录` })
    await dialog.waitFor({ timeout: 10_000 })
    const phone = dialog.getByPlaceholder('请输入 11 位手机号')
    const agree = dialog.getByRole('checkbox')
    const send = dialog.getByRole('button', { name: '发送验证码' })
    assert.equal(await send.isDisabled(), true, `${platform}: send enabled before phone/consent`)
    await phone.fill('13800138000')
    assert.equal(await send.isDisabled(), true, `${platform}: send enabled without consent`)
    await agree.check()
    await until(async () => !(await send.isDisabled()), `${platform}: send did not enable`, 10_000)
    if (platform === 'zhihu') {
      await page.screenshot({ path: path.join(output, 'sms-modal.png') })
      await send.click()
      const code = dialog.getByPlaceholder('请输入短信中的验证码')
      await code.waitFor({ timeout: 10_000 })
      await page.screenshot({ path: path.join(output, 'sms-code-form.png') })
      await code.fill('123456')
      await dialog.getByRole('button', { name: '验证并连接' }).click()
      await dialog.waitFor({ state: 'detached', timeout: 10_000 })
      await page.getByText('测试知乎账号').first().waitFor({ timeout: 10_000 })
    } else {
      await dialog.getByRole('button', { name: '取消' }).click()
      await dialog.waitFor({ state: 'detached', timeout: 10_000 })
    }
    console.log(`[sms-ui] ${platform}: ok`)
  }

  assert.deepEqual(errors, [], errors.join('; '))
  console.log(JSON.stringify({ ok: true, platforms: platforms.map(([platform]) => platform), output }))
} finally {
  await browser?.close().catch(() => {})
  server.kill('SIGTERM')
  await new Promise((resolve) => server.once('exit', resolve))
}
