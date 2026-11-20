// Isolated browser smoke for the unified settings page. Never calls a real provider.
// Build first: npm run build && node scripts/smoke-settings-ui.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'settings-check')
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
  providers: 1,
  keys: 2,
  fallback: true,
}
let pool = {
  editable: true,
  editableReason: null,
  source: 'file',
  warning: null,
  providers: [{
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    defaultModel: 'deepseek-v4.1-flash',
    models: ['deepseek-v4.1-flash'],
    highAvailability: true,
    keys: [
      { id: 'account-1', label: '账号1', maskedKey: 'oc_sk_e…tK-T', baseUrl: null, enabled: true },
      { id: 'account-2', label: '账号2', maskedKey: 'oc_sk_a…-3Ea', baseUrl: null, enabled: true },
    ],
  }],
  modelMap: {},
  probeIntervalMs: 300_000,
  maxProviderFailures: 3,
  cooldowns: { quotaMs: 1_800_000, authMs: 1_800_000, rateLimitMs: 30_000, transientMs: 20_000, providerMs: 120_000 },
  updatedAt: time,
}
const gateway = {
  configured: true,
  source: 'file',
  warning: null,
  probeIntervalMs: 300_000,
  updatedAt: time,
  providers: [{
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
    keys: [{
      providerId: 'opencode-go', providerLabel: 'OpenCode Go', keyId: 'account-2', keyLabel: '账号2',
      maskedKey: 'oc_sk_a…-3Ea', priority: 1, state: 'available', reason: null, cooldownUntil: null,
      successCount: 3, failureCount: 0, quotaFailures: 0, authFailures: 0, rateLimits: 0,
      tokensIn: 1000, tokensOut: 80, lastUsedAt: time, lastError: null,
    }],
  }],
  events: [],
  requests: [],
}
let savedBody = null

function mask(value) {
  return value && value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '••••••'
}

function applyPool(body) {
  savedBody = body
  const previous = new Map(pool.providers.map(provider => [provider.id, provider]))
  pool = {
    ...pool,
    updatedAt: new Date().toISOString(),
    providers: body.providers.map((provider) => {
      const before = previous.get(provider.id)
      return {
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        defaultModel: provider.defaultModel,
        models: provider.models ?? [provider.defaultModel],
        highAvailability: provider.highAvailability !== false,
        keys: provider.keys.map((key, index) => {
          const old = before?.keys.find(item => item.id === key.id)
          return {
            id: key.id ?? `key-${index + 1}`,
            label: key.label,
            maskedKey: key.apiKey ? mask(key.apiKey) : (old?.maskedKey ?? '••••••'),
            baseUrl: key.baseUrl ?? null,
            enabled: key.enabled !== false,
          }
        }),
      }
    }),
    modelMap: body.modelMap ?? {},
    probeIntervalMs: body.probeIntervalMs ?? 300_000,
    maxProviderFailures: body.maxProviderFailures ?? 3,
    cooldowns: { ...pool.cooldowns, ...(body.cooldowns ?? {}) },
  }
  return pool
}

const app = express()
app.use(express.json({ limit: '4mb' }))
app.get('/api/health', (_req, res) => res.json({ desktopMode: false, version: 'smoke' }))
app.get('/api/auth/me', (_req, res) => res.json({ user }))
app.get('/api/ai/settings', (_req, res) => res.json({ settings }))
app.get('/api/ai/providers', (_req, res) => res.json({ pool }))
app.put('/api/ai/providers', (req, res) => res.json({ pool: applyPool(req.body) }))
app.get('/api/ai/gateway', (_req, res) => res.json({ gateway }))
app.post('/api/ai/gateway/probe', (_req, res) => res.json({
  probes: [{ providerId: 'opencode-go', providerLabel: 'OpenCode Go', keyId: 'account-2', keyLabel: '账号2', maskedKey: 'oc_sk_a…-3Ea', model: 'deepseek-v4.1-flash', ok: true, message: '连接成功', latencyMs: 42 }],
  gateway,
}))
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

  await page.goto(`${base}/settings?tab=providers`, { waitUntil: 'domcontentloaded' })
  await page.getByText('提供商回退链').waitFor({ timeout: 15_000 })
  const providerText = await page.locator('.provider-editor').innerText()
  assert.ok(providerText.includes('oc_sk_e…tK-T'))
  assert.ok(providerText.includes('oc_sk_a…-3Ea'))
  assert.equal(await page.getByRole('switch', { name: 'OpenCode Go 多 Key 高可用' }).getAttribute('aria-checked'), 'true')
  await page.getByRole('switch', { name: 'OpenCode Go 多 Key 高可用' }).click()
  await page.getByRole('switch', { name: '启用 Key 账号2' }).click()
  await page.getByRole('button', { name: '保存提供商池' }).click()
  await page.getByText('提供商池已保存并立即生效').waitFor({ timeout: 10_000 })
  assert.equal(savedBody.providers[0].highAvailability, false)
  assert.equal(savedBody.providers[0].keys[1].enabled, false)
  await page.screenshot({ path: path.join(output, 'providers-desktop.png'), fullPage: true })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('提供商回退链').waitFor({ timeout: 15_000 })
  assert.equal(await page.getByRole('switch', { name: 'OpenCode Go 多 Key 高可用' }).getAttribute('aria-checked'), 'false')
  assert.equal(await page.getByRole('switch', { name: '启用 Key 账号2' }).getAttribute('aria-checked'), 'false')

  await page.locator('.settings-tab').filter({ hasText: '大模型' }).first().click()
  await page.getByText('账号自定义大模型').waitFor({ timeout: 10_000 })
  await page.screenshot({ path: path.join(output, 'ai-desktop.png'), fullPage: true })

  await page.locator('.settings-tab').filter({ hasText: '账号与安全' }).click()
  await page.getByRole('heading', { name: '个人资料' }).waitFor({ timeout: 10_000 })
  await page.screenshot({ path: path.join(output, 'account-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.settings-tab').filter({ hasText: '大模型高可用' }).click()
  await page.getByText('提供商回退链').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(300)
  const metrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: innerWidth }))
  assert.ok(metrics.scrollWidth <= metrics.innerWidth + 1, `horizontal overflow: ${metrics.scrollWidth} > ${metrics.innerWidth}`)
  await page.screenshot({ path: path.join(output, 'providers-mobile.png'), fullPage: true })

  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, output, metrics }, null, 2))
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(() => resolve()))
}
