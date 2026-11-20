import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiGatewayStatus } from '../../shared/types'
import type { AiService } from '../src/ai'
import { createRequireAuth, signToken } from '../src/auth'
import { openDatabase, type Database } from '../src/db'
import { errorHandler } from '../src/errors'
import { createAiRouter } from '../src/routes/ai'

const servers: Server[] = []
const databases: Database[] = []
const directories: string[] = []

function gatewayStatus(): AiGatewayStatus {
  return {
    configured: true,
    source: 'file',
    warning: null,
    probeIntervalMs: 300_000,
    updatedAt: new Date().toISOString(),
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
        providerId: 'opencode-go',
        providerLabel: 'OpenCode Go',
        keyId: 'account-1',
        keyLabel: '账号1',
        maskedKey: 'oc_sk_…StK-T',
        priority: 1,
        state: 'exhausted',
        reason: 'quota_exhausted',
        cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
        successCount: 3,
        failureCount: 1,
        quotaFailures: 1,
        authFailures: 0,
        rateLimits: 0,
        tokensIn: 100,
        tokensOut: 20,
        lastUsedAt: new Date().toISOString(),
        lastError: '额度不足（HTTP 429）',
      }],
    }],
    events: [],
    requests: [],
  }
}

async function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-gateway-routes-'))
  directories.push(directory)
  const database = openDatabase(':memory:')
  databases.push(database)
  const user = database.createUser({ username: 'gatewayroutes', email: 'gatewayroutes@example.com', passwordHash: 'unused', displayName: 'Routes' })
  const pool = {
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
      keys: [{ id: 'account-2', label: '账号2', maskedKey: 'oc_sk_…3Ea', baseUrl: null, enabled: true }],
    }],
    modelMap: {},
    probeIntervalMs: 300_000,
    maxProviderFailures: 3,
    cooldowns: { quotaMs: 1_800_000, authMs: 1_800_000, rateLimitMs: 30_000, transientMs: 20_000, providerMs: 120_000 },
    updatedAt: new Date().toISOString(),
  }
  const service = {
    gatewayStatus: vi.fn(() => gatewayStatus()),
    providerPool: vi.fn(() => pool),
    saveProviderPool: vi.fn(() => pool),
    probeGateway: vi.fn(async (_userId: string, providerId?: string) => [{
      providerId: providerId ?? 'opencode-go',
      providerLabel: 'OpenCode Go',
      keyId: 'account-2',
      keyLabel: '账号2',
      maskedKey: 'oc_sk_…3Ea',
      model: 'deepseek-v4.1-flash',
      ok: true,
      message: '连接成功',
      latencyMs: 42,
    }]),
  } as unknown as AiService
  const app = express()
  app.use(express.json())
  app.use('/api/ai', createRequireAuth(database, 'routes-secret'), createAiRouter(service))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await once(server, 'listening')
  const address = server.address() as { port: number }
  return { database, user, token: signToken(user, 'routes-secret'), service, base: `http://127.0.0.1:${address.port}/api/ai` }
}

async function call(base: string, route: string, token?: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${route}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  return { status: response.status, cacheControl: response.headers.get('cache-control'), data: await response.json() as Record<string, unknown> }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('AI gateway management routes', () => {
  it('rejects anonymous requests', async () => {
    const { base } = await setup()
    expect((await call(base, '/gateway')).status).toBe(401)
  })

  it('returns a no-store status snapshot without raw keys', async () => {
    const { base, token } = await setup()
    const result = await call(base, '/gateway', token)
    expect(result.status).toBe(200)
    expect(result.cacheControl).toBe('no-store')
    const gateway = result.data.gateway as Record<string, unknown>
    expect(gateway.configured).toBe(true)
    expect(JSON.stringify(gateway)).not.toContain('oc_sk_REAL_KEY_SHOULD_NOT_LEAK')
    expect(JSON.stringify(gateway)).toContain('oc_sk_…StK-T')
  })

  it('returns and saves the provider pool with server-side validation', async () => {
    const { base, token, service } = await setup()
    const read = await call(base, '/providers', token)
    expect(read.status).toBe(200)
    expect(read.cacheControl).toBe('no-store')
    expect((read.data.pool as Record<string, unknown>).editable).toBe(true)

    const payload = {
      providers: [{
        id: 'opencode-go',
        label: 'OpenCode Go',
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        defaultModel: 'deepseek-v4.1-flash',
        models: ['deepseek-v4.1-flash'],
        highAvailability: false,
        keys: [
          { id: 'account-1', label: '账号1', enabled: true },
          { label: '账号2', apiKey: 'sk-new-key-12345678', enabled: true },
        ],
      }],
      probeIntervalMs: 120_000,
    }
    const saved = await call(base, '/providers', token, { method: 'PUT', body: JSON.stringify(payload) })
    expect(saved.status).toBe(200)
    expect((service as unknown as { saveProviderPool: ReturnType<typeof vi.fn> }).saveProviderPool)
      .toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ providers: expect.any(Array) }))

    const invalid = await call(base, '/providers', token, { method: 'PUT', body: JSON.stringify({ providers: [] }) })
    expect(invalid.status).toBe(400)
    expect(invalid.data.error).toBe('validation_failed')
  })

  it('rejects anonymous provider pool writes', async () => {
    const { base } = await setup()
    const response = await call(base, '/providers', undefined, { method: 'PUT', body: JSON.stringify({ providers: [] }) })
    expect(response.status).toBe(401)
  })

  it('probes all keys or one provider and returns the refreshed status', async () => {
    const { base, token, service } = await setup()
    const all = await call(base, '/gateway/probe', token, { method: 'POST', body: JSON.stringify({}) })
    expect(all.status).toBe(200)
    expect((all.data.probes as unknown[]).length).toBe(1)
    expect((all.data.gateway as Record<string, unknown>).configured).toBe(true)
    expect((service as unknown as { probeGateway: ReturnType<typeof vi.fn> }).probeGateway)
      .toHaveBeenCalledWith(expect.any(String), undefined)

    const one = await call(base, '/gateway/probe', token, { method: 'POST', body: JSON.stringify({ providerId: 'opencode-go' }) })
    expect(one.status).toBe(200)
    expect((one.data.probes as Array<{ providerId: string }>)[0].providerId).toBe('opencode-go')
    expect((service as unknown as { probeGateway: ReturnType<typeof vi.fn> }).probeGateway)
      .toHaveBeenLastCalledWith(expect.any(String), 'opencode-go')
  })

  it('validates the probe body', async () => {
    const { base, token } = await setup()
    const result = await call(base, '/gateway/probe', token, { method: 'POST', body: JSON.stringify({ providerId: 'x'.repeat(200) }) })
    expect(result.status).toBe(400)
    expect(result.data.error).toBe('validation_failed')
  })
})
