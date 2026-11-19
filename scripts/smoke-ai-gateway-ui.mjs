// Isolated browser smoke for the AI high-availability panel. Never calls a real provider.
// Build first: npm run build && node scripts/smoke-ai-gateway-ui.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'ai-gateway-check')
mkdirSync(output, { recursive: true })
const time = new Date().toISOString()
const user = { id: 'alice', username: 'alice', email: 'alice@example.com', displayName: 'Alice', createdAt: time }
const settings = {
  configured: true,
  baseUrl: 'https://opencode.ai/inference/go/openai/v1',
  model: 'deepseek-v4.1-flash',
  temperature: 0.7,
  hasApiKey: true,
  source: 'server',
  label: 'OpenCode Go',
  providers: 2,
  keys: 3,
  fallback: true,
}
const sessions = [{ id: 'session-1', title: '高可用验证', createdAt: time, updatedAt: time }]
const messages = [
  { id: 'm1', role: 'user', content: '只回复连接成功。', createdAt: time },
  { id: 'm2', role: 'assistant', content: '连接成功。', createdAt: time },
]
const gateway = {
  configured: true,
  source: 'file',
  warning: null,
  probeIntervalMs: 300000,
  updatedAt: time,
  providers: [
    {
      id: 'opencode-go',
      label: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      defaultModel: 'deepseek-v4.1-flash',
      models: ['deepseek-v4.1-flash'],
      source: 'config',
      state: 'available',
      reason: null,
      cooldownUntil: null,
      consecutiveFailures: 0,
      lastError: null,
      keys: [
        {
          providerId: 'opencode-go', providerLabel: 'OpenCode Go', keyId: 'account-1', keyLabel: '账号1',
          maskedKey: 'oc_sk_e…tK-T', priority: 1, state: 'exhausted', reason: 'quota_exhausted',
          cooldownUntil: new Date(Date.now() + 25 * 60_000).toISOString(), successCount: 12, failureCount: 1,
          quotaFailures: 1, authFailures: 0, rateLimits: 0, tokensIn: 1024, tokensOut: 256,
          lastUsedAt: time, lastError: '额度不足（HTTP 429）：OpenCode Go usage limit reached',
        },
        {
          providerId: 'opencode-go', providerLabel: 'OpenCode Go', keyId: 'account-2', keyLabel: '账号2',
          maskedKey: 'oc_sk_a…-3Ea', priority: 2, state: 'available', reason: null,
          cooldownUntil: null, successCount: 8, failureCount: 0, quotaFailures: 0,
          authFailures: 0, rateLimits: 0, tokensIn: 800, tokensOut: 120, lastUsedAt: time, lastError: null,
        },
      ],
    },
    {
      id: 'deepseek',
      label: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-chat',
      models: ['deepseek-chat'],
      source: 'config',
      state: 'cooling',
      reason: 'rate_limited',
      cooldownUntil: new Date(Date.now() + 30_000).toISOString(),
      consecutiveFailures: 2,
      lastError: '触发限流（HTTP 429）',
      keys: [{
        providerId: 'deepseek', providerLabel: 'DeepSeek 官方', keyId: 'official', keyLabel: '官方 Key',
        maskedKey: 'sk-82…dad3', priority: 1, state: 'cooling', reason: 'rate_limited',
        cooldownUntil: new Date(Date.now() + 30_000).toISOString(), successCount: 2, failureCount: 2,
        quotaFailures: 0, authFailures: 0, rateLimits: 2, tokensIn: 200, tokensOut: 40,
        lastUsedAt: time, lastError: '触发限流（HTTP 429）',
      }],
    },
  ],
  events: [
    {
      id: 'e1', at: time, kind: 'key_switch', reason: 'quota_exhausted',
      detail: '额度不足（HTTP 429）', sessionId: 'session-1',
      fromProviderId: 'opencode-go', fromProviderLabel: 'OpenCode Go', fromKeyId: 'account-1', fromKeyLabel: '账号1', fromKeyMasked: 'oc_sk_e…tK-T',
      toProviderId: 'opencode-go', toProviderLabel: 'OpenCode Go', toKeyId: 'account-2', toKeyLabel: '账号2', toKeyMasked: 'oc_sk_a…-3Ea',
      model: 'deepseek-v4.1-flash', targetModel: 'deepseek-v4.1-flash',
    },
    {
      id: 'e2', at: time, kind: 'provider_switch', reason: 'quota_exhausted',
      detail: '额度不足（HTTP 429）', sessionId: 'session-1',
      fromProviderId: 'opencode-go', fromProviderLabel: 'OpenCode Go', fromKeyId: 'account-2', fromKeyLabel: '账号2', fromKeyMasked: 'oc_sk_a…-3Ea',
      toProviderId: 'deepseek', toProviderLabel: 'DeepSeek 官方', toKeyId: 'official', toKeyLabel: '官方 Key', toKeyMasked: 'sk-82…dad3',
      model: 'deepseek-v4.1-flash', targetModel: 'deepseek-chat',
    },
    {
      id: 'e3', at: time, kind: 'key_recovery', reason: 'recovered',
      detail: '探活成功，Key 恢复可用', sessionId: null,
      fromProviderId: 'opencode-go', fromProviderLabel: 'OpenCode Go', fromKeyId: 'account-1', fromKeyLabel: '账号1', fromKeyMasked: 'oc_sk_e…tK-T',
      toProviderId: null, toProviderLabel: null, toKeyId: null, toKeyLabel: null, toKeyMasked: null,
      model: null, targetModel: null,
    },
  ],
  requests: [
    {
      id: 'r1', at: time, sessionId: 'session-1', providerId: 'opencode-go', providerLabel: 'OpenCode Go',
      model: 'deepseek-v4.1-flash', keyId: 'account-2', keyLabel: '账号2', keyMasked: 'oc_sk_a…-3Ea',
      status: 'success', httpStatus: 200, errorCode: null, durationMs: 2637, tokensIn: 3970, tokensOut: 5,
    },
    {
      id: 'r2', at: time, sessionId: 'session-1', providerId: 'opencode-go', providerLabel: 'OpenCode Go',
      model: 'deepseek-v4.1-flash', keyId: 'account-1', keyLabel: '账号1', keyMasked: 'oc_sk_e…tK-T',
      status: 'failed', httpStatus: 429, errorCode: 'quota_exhausted', durationMs: 1620, tokensIn: 0, tokensOut: 0,
    },
  ],
}
const probes = [
  {
    providerId: 'opencode-go', providerLabel: 'OpenCode Go', keyId: 'account-1', keyLabel: '账号1',
    maskedKey: 'oc_sk_e…tK-T', model: 'deepseek-v4.1-flash', ok: false, message: '额度不足（HTTP 429）', latencyMs: 1620,
  },
  {
    providerId: 'opencode-go', providerLabel: 'OpenCode Go', keyId: 'account-2', keyLabel: '账号2',
    maskedKey: 'oc_sk_a…-3Ea', model: 'deepseek-v4.1-flash', ok: true, message: '连接成功', latencyMs: 42,
  },
]
const app = express()
app.use(express.json({ limit: '4mb' }))
app.get('/api/health', (_req, res) => res.json({ desktopMode: true, version: 'smoke' }))
app.get('/api/auth/me', (_req, res) => res.json({ user }))
app.get('/api/ai/settings', (_req, res) => res.json({ settings }))
app.get('/api/ai/sessions', (_req, res) => res.json({ sessions }))
app.get('/api/ai/sessions/session-1', (_req, res) => res.json({ session: { ...sessions[0], messages } }))
app.get('/api/ai/gateway', (_req, res) => res.json({ gateway }))
app.post('/api/ai/gateway/probe', (_req, res) => res.json({ probes, gateway }))
app.post('/api/ai/sessions/session-1/messages', (req, res) => {
  messages.push({ id: `u-${messages.length}`, role: 'user', content: req.body.message || '', createdAt: time })
  const reply = { id: `a-${messages.length}`, role: 'assistant', content: '好的。', createdAt: time }
  messages.push(reply)
  res.json({ session: { ...sessions[0], messages }, reply, routing: { providerId: 'opencode-go', providerLabel: 'OpenCode Go', model: 'deepseek-v4.1-flash', requestedModel: 'deepseek-v4.1-flash', keyId: 'account-2', keyLabel: '账号2', keyMasked: 'oc_sk_a…-3Ea', fallback: true, reason: 'quota_exhausted', attempts: 2 } })
})
app.use(express.static(path.join(root, 'web', 'dist')))
app.get('*', (_req, res) => res.sendFile(path.join(root, 'web', 'dist', 'index.html')))
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const executablePath = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync)
assert.ok(executablePath, 'Install Chromium or set CHROME_BIN')

const browser = await chromium.launch({ executablePath, headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('multipush_token', 'isolated-test-token') })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })

  await page.goto(`${base}/ai`, { waitUntil: 'domcontentloaded' })
  await page.locator('.ai-main-head').waitFor({ timeout: 15_000 })
  await page.locator('.ai-main-head .btn').filter({ hasText: '高可用' }).click()
  await page.locator('.ai-gateway').waitFor({ timeout: 10_000 })
  const text = await page.locator('.ai-gateway').innerText()
  for (const expected of ['2 个提供商 · 3 个 Key', 'OpenCode Go', 'DeepSeek 官方', '账号1', '额度不足', '切换与恢复记录']) {
    assert.ok(text.includes(expected), `missing ${expected}`)
  }
  const html = await page.content()
  assert.ok(!html.includes('oc_sk_REAL_KEY_SHOULD_NOT_LEAK'), 'raw key must not appear in DOM')
  assert.ok(!html.includes('sk-REAL_KEY_SHOULD_NOT_LEAK'), 'raw key must not appear in DOM')
  await page.screenshot({ path: path.join(output, 'gateway-desktop.png'), fullPage: true })

  await page.getByRole('button', { name: '检测全部 Key' }).click()
  await page.locator('.ai-gateway-probe').first().waitFor({ timeout: 10_000 })
  const probeText = await page.locator('.ai-gateway-probes').innerText()
  assert.ok(probeText.includes('不可用'))
  assert.ok(probeText.includes('可用'))
  await page.screenshot({ path: path.join(output, 'gateway-probe.png'), fullPage: true })

  await page.getByRole('tab', { name: '最近请求' }).click()
  const requestText = await page.locator('.ai-gateway-requests').innerText()
  assert.ok(requestText.includes('deepseek-v4.1-flash'))
  assert.ok(requestText.includes('额度不足'))
  await page.screenshot({ path: path.join(output, 'gateway-requests.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    modalWidth: document.querySelector('.modal')?.getBoundingClientRect().width ?? null,
  }))
  assert.ok(metrics.scrollWidth <= metrics.innerWidth + 1, `horizontal overflow: ${metrics.scrollWidth} > ${metrics.innerWidth}`)
  assert.ok(metrics.modalWidth && metrics.modalWidth <= metrics.innerWidth, 'modal overflows mobile viewport')
  await page.screenshot({ path: path.join(output, 'gateway-mobile.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, output, probeText: probeText.replace(/\s+/g, ' '), metrics }, null, 2))
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(() => resolve()))
}
