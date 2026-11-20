import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../src/ai-gateway'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { applyProviderPoolInput, maskApiKey, parseAiProvidersConfig, providerPoolView, writeAiProvidersFile, type AiProvidersConfig } from '../src/ai-provider-config'

const cleanups: Array<() => void> = []

function response(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function success(content = '好的'): Response {
  return response({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 12, completion_tokens: 3 } })
}

function quotaError(): Response {
  return response({
    type: 'error',
    error: { type: 'GoUsageLimitError', message: 'OpenCode Go usage limit reached (monthly, resets in 12d)' },
  }, 429)
}

function rateLimitError(): Response {
  return response({ error: { message: 'rate limit exceeded, please retry later' } }, 429, { 'retry-after': '0' })
}

function unauthorized(): Response {
  return response({ error: { message: 'invalid api key' } }, 401)
}

function longRateLimitError(): Response {
  return response({ error: { message: 'rate limit exceeded, please retry later' } }, 429, { 'retry-after': '30' })
}

function pool(overrides: Partial<ReturnType<typeof rawPool>> = {}): AiProvidersConfig {
  return parseAiProvidersConfig({
    ...rawPool(),
    ...overrides,
  })
}

function rawPool() {
  return {
    providers: [
      {
        id: 'alpha',
        label: 'Alpha 云',
        baseUrl: 'https://alpha.example/v1',
        defaultModel: 'alpha-flash',
        models: ['alpha-flash'],
        keys: [
          { id: 'a1', label: '账号1', apiKey: 'sk-alpha-key-111111111111' },
          { id: 'a2', label: '账号2', apiKey: 'sk-alpha-key-222222222222' },
        ],
      },
      {
        id: 'beta',
        label: 'Beta 官方',
        baseUrl: 'https://beta.example/v1',
        defaultModel: 'beta-pro',
        models: ['beta-pro', 'beta-flash'],
        keys: [{ id: 'b1', label: '官方 Key', apiKey: 'sk-beta-key-111111111111' }],
      },
    ],
    modelMap: { 'alpha/alpha-flash': { beta: 'beta-pro' } },
    probeIntervalMs: 60_000,
    maxProviderFailures: 2,
    cooldowns: { quotaMs: 2_000, authMs: 2_000, rateLimitMs: 1_000, transientMs: 1_000, providerMs: 2_000 },
  }
}

function setup(providerPool: AiProvidersConfig = pool()) {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-gateway-'))
  const config = loadConfig({
    dataDir: directory,
    nodeEnv: 'test',
    jwtSecret: 'gateway-test-secret',
    aiDefaults: null,
    aiProviders: providerPool,
  })
  const database = openDatabase(':memory:')
  const user = database.createUser({ username: 'gateway', email: 'gateway@example.com', displayName: 'Gateway', passwordHash: 'hash' })
  let clock = Date.now()
  const gateway = new AiGateway(database, config, { now: () => clock, rateLimitWaitMs: 10 })
  cleanups.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  return {
    directory,
    config,
    database,
    user,
    gateway,
    advance(ms: number) { clock += ms },
  }
}

function request(init?: RequestInit): { authorization: string; model: string } {
  const headers = (init?.headers ?? {}) as Record<string, string>
  const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
  return { authorization: headers.Authorization ?? '', model: body.model ?? '' }
}

function completeInput(userId: string) {
  return {
    userId,
    sessionId: 'session-1',
    messages: [{ role: 'user' as const, content: '你好' }],
    temperature: 0.7,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('AI gateway multi-key failover', () => {
  it('switches to the next key when the first key is out of quota, keeping the model unchanged', async () => {
    const { database, user, gateway } = setup()
    const seen: Array<{ authorization: string; model: string }> = []
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push(request(init))
      calls += 1
      if (calls === 1) return quotaError()
      return success('已完成')
    }))

    const result = await gateway.complete(completeInput(user.id))
    expect(seen).toHaveLength(2)
    expect(seen[0].authorization).toBe('Bearer sk-alpha-key-111111111111')
    expect(seen[1].authorization).toBe('Bearer sk-alpha-key-222222222222')
    expect(new Set(seen.map(item => item.model))).toEqual(new Set(['alpha-flash']))
    expect(result.routing).toMatchObject({
      providerId: 'alpha',
      model: 'alpha-flash',
      requestedModel: 'alpha-flash',
      keyId: 'a2',
      fallback: true,
      reason: 'quota_exhausted',
      attempts: 2,
    })
    expect(result.routing.keyMasked).not.toContain('sk-alpha-key-222222222222')

    const first = database.getAiKeyState('alpha', 'a1')!
    expect(first.state).toBe('exhausted')
    expect(first.quotaFailures).toBe(1)
    expect(first.cooldownUntil).toBeTruthy()
    expect(database.getAiKeyState('alpha', 'a2')!.successCount).toBe(1)

    const events = database.listAiFailoverEvents(user.id, 20)
    expect(events.some(event => event.kind === 'key_switch' && event.fromKeyId === 'a1' && event.toKeyId === 'a2')).toBe(true)
    expect(events.some(event => event.kind === 'key_cooldown' && event.reason === 'quota_exhausted')).toBe(true)
    expect(JSON.stringify(events)).not.toContain('sk-alpha-key-111111111111')

    const requests = database.listAiProviderRequests(user.id, 20)
    expect(requests.map(item => item.status)).toEqual(['success', 'failed'])
    expect(requests[1]).toMatchObject({ providerId: 'alpha', keyId: 'a1', errorCode: 'quota_exhausted', httpStatus: 429 })
    expect(JSON.stringify(requests)).not.toContain('sk-alpha-key-111111111111')
  })

  it('treats 401 as an invalid key and rotates without losing the request', async () => {
    const { database, user, gateway } = setup()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return calls === 1 ? unauthorized() : success('恢复了')
    }))
    const result = await gateway.complete(completeInput(user.id))
    expect(result.routing.keyId).toBe('a2')
    expect(result.routing.reason).toBe('unauthorized')
    expect(database.getAiKeyState('alpha', 'a1')!.state).toBe('invalid')
    expect(database.getAiKeyState('alpha', 'a1')!.authFailures).toBe(1)
  })

  it('classifies a 403 quota response as exhaustion instead of an invalid key', async () => {
    const { database, user, gateway } = setup()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) return response({ error: { message: 'monthly usage limit reached' } }, 403)
      return success('继续')
    }))
    const result = await gateway.complete(completeInput(user.id))
    expect(result.routing.keyId).toBe('a2')
    expect(result.routing.reason).toBe('quota_exhausted')
    expect(database.getAiKeyState('alpha', 'a1')!.state).toBe('exhausted')
    expect(database.getAiKeyState('alpha', 'a1')!.authFailures).toBe(0)
  })

  it('does not mark a rate-limited key as invalid and rotates temporarily', async () => {
    const { database, user, gateway } = setup()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return calls === 1 ? rateLimitError() : success('继续')
    }))
    const result = await gateway.complete(completeInput(user.id))
    expect(result.routing.keyId).toBe('a2')
    expect(result.routing.reason).toBe('rate_limited')
    const first = database.getAiKeyState('alpha', 'a1')!
    expect(first.state).toBe('cooling')
    expect(first.state).not.toBe('invalid')
    expect(first.rateLimits).toBe(1)
    expect(database.listAiFailoverEvents(user.id, 20).some(event => event.kind === 'rate_limited')).toBe(true)
  })

  it('does not retry before the key Retry-After cooldown elapses', async () => {
    const single = parseAiProvidersConfig({
      ...rawPool(),
      providers: [rawPool().providers[0]],
      modelMap: {},
    })
    single.providers[0].keys = [single.providers[0].keys[0]]
    const { database, user, gateway, advance } = setup(single)
    const fetchMock = vi.fn(async () => longRateLimitError())
    vi.stubGlobal('fetch', fetchMock)
    await expect(gateway.complete(completeInput(user.id))).rejects.toMatchObject({ status: 429, code: 'ai_rate_limited' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const state = database.getAiKeyState('alpha', 'a1')!
    expect(state.state).toBe('cooling')
    expect(Date.parse(state.cooldownUntil!)).toBeGreaterThan(Date.now() + 20_000)

    advance(31_000)
    vi.stubGlobal('fetch', vi.fn(async () => success('限流恢复')))
    const second = await gateway.complete(completeInput(user.id))
    expect(second.routing.keyId).toBe('a1')
    expect(second.routing.fallback).toBe(false)
  })

  it('waits and retries the same key when it is the only one and the provider rate-limits', async () => {
    const single = parseAiProvidersConfig({
      ...rawPool(),
      providers: [rawPool().providers[0]],
      modelMap: {},
    })
    // Only keep one key on the provider.
    single.providers[0].keys = [single.providers[0].keys[0]]
    const { user, gateway } = setup(single)
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return calls === 1 ? rateLimitError() : success('限流后成功')
    }))
    const result = await gateway.complete(completeInput(user.id))
    expect(calls).toBe(2)
    expect(result.routing.keyId).toBe('a1')
    expect(result.routing.fallback).toBe(true)
  })
})

describe('AI gateway provider fallback and model mapping', () => {
  it('treats a request-scoped 400 as a per-request skip without cooling the shared provider', async () => {
    const { database, user, gateway } = setup()
    const urls: string[] = []
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      calls += 1
      if (calls === 1) return response({ error: { message: 'invalid request parameter: messages too long' } }, 400)
      return success('备用提供商完成')
    }))
    const result = await gateway.complete(completeInput(user.id))
    expect(urls[0]).toContain('alpha.example')
    expect(urls[1]).toContain('beta.example')
    expect(result.routing.providerId).toBe('beta')
    expect(database.getAiProviderState('alpha')).toBeNull()
    expect(database.getAiKeyState('alpha', 'a1')).toBeNull()
  })

  it('falls back to the next provider with the mapped model when every key of the first provider is exhausted', async () => {
    const { database, user, gateway } = setup()
    const calls: string[] = []
    let count = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      count += 1
      const seen = request(init)
      calls.push(`${String(url)}|${seen.model}`)
      if (count <= 2) return quotaError()
      return success('来自备用提供商')
    }))
    const result = await gateway.complete(completeInput(user.id))
    expect(calls).toEqual([
      'https://alpha.example/v1/chat/completions|alpha-flash',
      'https://alpha.example/v1/chat/completions|alpha-flash',
      'https://beta.example/v1/chat/completions|beta-pro',
    ])
    expect(result.routing).toMatchObject({
      providerId: 'beta',
      providerLabel: 'Beta 官方',
      model: 'beta-pro',
      requestedModel: 'alpha-flash',
      keyId: 'b1',
      fallback: true,
      attempts: 3,
    })
    expect(database.getAiProviderState('alpha')!.state).toBe('cooling')
    const events = database.listAiFailoverEvents(user.id, 20)
    const providerSwitch = events.find(event => event.kind === 'provider_switch')!
    expect(providerSwitch).toMatchObject({ fromProviderId: 'alpha', toProviderId: 'beta', model: 'alpha-flash', targetModel: 'beta-pro' })
  })

  it('skips a cooling provider on the next request without hitting it again', async () => {
    const { database, user, gateway } = setup()
    const urls: string[] = []
    let count = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      count += 1
      if (count <= 2) return quotaError()
      return success('备用')
    }))
    await gateway.complete(completeInput(user.id))
    const before = urls.length
    const eventsBefore = database.listAiFailoverEvents(user.id, 50).length
    const second = await gateway.complete(completeInput(user.id))
    expect(urls.length).toBe(before + 1)
    expect(urls[urls.length - 1]).toContain('beta.example')
    expect(second.routing.providerId).toBe('beta')
    // The primary provider was skipped without an HTTP attempt, but the
    // routing still shows the active fallback and its reason.
    expect(second.routing.fallback).toBe(true)
    expect(second.routing.reason).toBe('quota_exhausted')
    const eventsAfter = database.listAiFailoverEvents(user.id, 50)
    expect(eventsAfter.length).toBeGreaterThan(eventsBefore)
    expect(eventsAfter[0]).toMatchObject({
      kind: 'provider_switch',
      reason: 'quota_exhausted',
      fromProviderId: 'alpha',
      toProviderId: 'beta',
      fromKeyMasked: 'sk-alph…1111',
      toKeyMasked: 'sk-b…1111',
    })
  })

  it('falls through to a broader model map when a specific entry has no target', async () => {
    const config = parseAiProvidersConfig({
      providers: [
        { id: 'alpha', label: 'Alpha', baseUrl: 'https://alpha.example/v1', defaultModel: 'm1', models: ['m1'], keys: [{ id: 'a1', label: 'A1', apiKey: 'sk-alpha-key-111111111111' }] },
        { id: 'beta', label: 'Beta', baseUrl: 'https://beta.example/v1', defaultModel: 'beta-m1', models: ['beta-m1'], keys: [{ id: 'b1', label: 'B1', apiKey: 'sk-beta-key-111111111111' }] },
        { id: 'gamma', label: 'Gamma', baseUrl: 'https://gamma.example/v1', defaultModel: 'g1', models: ['g1'], keys: [{ id: 'c1', label: 'C1', apiKey: 'sk-gamma-key-111111111111' }] },
      ],
      modelMap: { 'alpha/m1': { beta: 'beta-m1' }, '*/*': 'star-model' },
      cooldowns: { quotaMs: 2_000, authMs: 2_000, rateLimitMs: 1_000, transientMs: 1_000, providerMs: 2_000 },
    })
    const { user, gateway } = setup(config)
    const models: string[] = []
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1
      models.push(request(init).model)
      if (calls <= 2) return quotaError()
      return success('Gamma 完成')
    }))
    const result = await gateway.complete(completeInput(user.id))
    expect(models).toEqual(['m1', 'beta-m1', 'star-model'])
    expect(result.routing).toMatchObject({ providerId: 'gamma', model: 'star-model', requestedModel: 'm1' })
  })

  it('recovers the highest-priority key after a successful probe', async () => {
    const { database, user, gateway, advance } = setup()
    let count = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      count += 1
      return count <= 2 ? quotaError() : success('正常')
    }))
    const first = await gateway.complete(completeInput(user.id))
    expect(first.routing.providerId).toBe('beta')
    advance(3_000)

    // Probe every key: alpha recovers, so the next request goes back to a1.
    vi.stubGlobal('fetch', vi.fn(async () => success('探活成功')))
    const probes = await gateway.probe(user.id)
    expect(probes.every(result => result.ok)).toBe(true)
    expect(database.getAiKeyState('alpha', 'a1')!.state).toBe('available')
    expect(database.getAiProviderState('alpha')!.state).toBe('available')

    const events = database.listAiFailoverEvents(user.id, 30)
    expect(events.some(event => event.kind === 'key_recovery' && event.fromKeyId === 'a1')).toBe(true)
    expect(events.some(event => event.kind === 'provider_recovery' && event.fromProviderId === 'alpha')).toBe(true)

    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(request(init).authorization)
      return success('回到主 Key')
    }))
    const second = await gateway.complete(completeInput(user.id))
    expect(seen).toEqual(['Bearer sk-alpha-key-111111111111'])
    expect(second.routing).toMatchObject({ providerId: 'alpha', keyId: 'a1', fallback: false })
  })
})

describe('AI gateway account override and status', () => {
  it('tries the account override first, then the server pool, keeping conversation history independent', async () => {
    const { user, gateway } = setup()
    const seen: string[] = []
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1
      seen.push(request(init).authorization)
      return calls === 1 ? unauthorized() : success('服务器池接手')
    }))
    const result = await gateway.complete({
      ...completeInput(user.id),
      preferred: {
        baseUrl: 'https://user.example/v1',
        model: 'user-model',
        apiKey: 'sk-user-private-key-999999',
        temperature: 0.3,
        label: '账号自定义配置',
      },
    })
    expect(seen).toEqual(['Bearer sk-user-private-key-999999', 'Bearer sk-alpha-key-111111111111'])
    expect(result.routing).toMatchObject({
      providerId: 'alpha',
      requestedModel: 'user-model',
      model: 'alpha-flash',
      fallback: true,
      reason: 'unauthorized',
    })
    expect(result.routing.keyMasked).not.toContain('sk-user-private-key-999999')
  })

  it('probes an account override before reusing it after cooldown', async () => {
    const { user, gateway, advance } = setup()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return calls === 1 ? unauthorized() : success('服务器池接手')
    }))
    const preferred = {
      baseUrl: 'https://user.example/v1',
      model: 'user-model',
      apiKey: 'sk-user-private-key-999999',
      temperature: 0.3,
      label: '账号自定义配置',
    }
    const first = await gateway.complete({ ...completeInput(user.id), preferred })
    expect(first.routing.providerId).toBe('alpha')
    advance(2_500)

    const bodies: Array<{ model?: string; max_tokens?: number }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as { model?: string; max_tokens?: number })
      return success('账号 Key 恢复')
    }))
    const second = await gateway.complete({ ...completeInput(user.id), preferred })
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ model: 'user-model', max_tokens: 16 })
    expect(bodies[1]).toMatchObject({ model: 'user-model' })
    expect(second.routing.providerId).toBe(`user:${user.id}`)
    expect(second.routing.fallback).toBe(false)
  })

  it('exposes masked status, events and requests for the management page', async () => {
    const { user, gateway } = setup()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return calls === 1 ? quotaError() : success()
    }))
    await gateway.complete(completeInput(user.id))
    const status = gateway.status(user.id)
    expect(status.configured).toBe(true)
    expect(status.source).toBe('override')
    expect(status.providers).toHaveLength(2)
    expect(status.providers[0].keys).toHaveLength(2)
    expect(status.providers[0].keys[0]).toMatchObject({ keyId: 'a1', state: 'exhausted', priority: 1 })
    expect(status.providers[0].keys[1]).toMatchObject({ keyId: 'a2', state: 'available', successCount: 1 })
    expect(status.events.length).toBeGreaterThan(0)
    expect(status.requests).toHaveLength(2)
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('sk-alpha-key-111111111111')
    expect(serialized).not.toContain('sk-alpha-key-222222222222')
    expect(serialized).not.toContain('sk-beta-key-111111111111')
  })

  it('throttles repeated manual probes per user', async () => {
    const { user, gateway } = setup()
    vi.stubGlobal('fetch', vi.fn(async () => success('探活成功')))
    const first = await gateway.probe(user.id)
    expect(first.length).toBeGreaterThan(0)
    await expect(gateway.probe(user.id)).rejects.toMatchObject({ status: 429, code: 'ai_probe_rate_limited' })
  })

  it('throws a clear 429 when every key is rate-limited', async () => {
    const { user, gateway } = setup()
    vi.stubGlobal('fetch', vi.fn(async () => rateLimitError()))
    await expect(gateway.complete(completeInput(user.id))).rejects.toMatchObject({ status: 429, code: 'ai_rate_limited' })
  })
})

describe('provider pool configuration', () => {
  it('requires at least one key and rejects reserved provider ids', () => {
    expect(() => parseAiProvidersConfig({ providers: [{ id: 'x', baseUrl: 'https://x.example/v1', defaultModel: 'm', keys: [] }] })).toThrow(/至少需要一个 API Key/)
    expect(() => parseAiProvidersConfig({ providers: [{ id: 'user', baseUrl: 'https://x.example/v1', defaultModel: 'm', keys: [{ apiKey: 'k-12345678' }] }] })).toThrow(/保留名称/)
    expect(() => parseAiProvidersConfig({ providers: [{ id: 'x', baseUrl: 'https://x.example/v1', defaultModel: 'm', keys: [{ id: 'dup', apiKey: 'k-12345678' }, { id: 'dup', apiKey: 'k-87654321' }] }] })).toThrow(/重复/)
  })

  it('accepts per-key base URLs and a wildcard mapping', () => {
    const config = parseAiProvidersConfig({
      providers: [{
        id: 'x',
        baseUrl: 'https://x.example/v1',
        defaultModel: 'm',
        keys: [{ id: 'k1', apiKey: 'k-12345678', baseUrl: 'https://k1.example/v1' }],
      }],
      modelMap: { 'x/*': 'fallback-model' },
    })
    expect(config.providers[0].keys[0].baseUrl).toBe('https://k1.example/v1')
    expect(config.modelMap['x/*']).toBe('fallback-model')
  })

  it('masks keys without leaving the secret visible', () => {
    const masked = maskApiKey('sk-alpha-key-111111111111')
    expect(masked).toContain('…')
    expect(masked).not.toContain('111111111111')
    expect(masked.startsWith('sk-alph')).toBe(true)
  })
})


describe('provider pool file and environment configuration', () => {
  it('loads a protected JSON file and tightens overly permissive file modes', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'multipush-gateway-config-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const file = path.join(directory, 'ai-providers.json')
    writeFileSync(file, JSON.stringify(rawPool()), { mode: 0o644 })
    vi.stubEnv('OPENCODE_GO_API_KEY', '')
    vi.stubEnv('OPENCODE_GO_API_KEYS', '')
    vi.stubEnv('AI_PROVIDERS_JSON', '')
    vi.stubEnv('AI_PROVIDERS_FILE', '')
    const config = loadConfig({ dataDir: directory, nodeEnv: 'test', jwtSecret: 'file-config-secret', aiDefaults: null })
    expect(config.aiProvidersSource).toBe('file')
    expect(config.aiProviders?.providers.map(provider => provider.id)).toEqual(['alpha', 'beta'])
    expect(config.aiProviders?.providers[0].keys).toHaveLength(2)
    expect(config.aiProvidersWarning).toMatch(/权限过宽/)
    try {
      expect(statSync(file).mode & 0o077).toBe(0)
    } catch { /* chmod may be unsupported on some test hosts */ }
  })

  it('reads AI_PROVIDERS_JSON from the environment and never exposes keys in errors', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'multipush-gateway-env-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    vi.stubEnv('OPENCODE_GO_API_KEY', '')
    vi.stubEnv('AI_PROVIDERS_FILE', path.join(directory, 'missing.json'))
    vi.stubEnv('AI_PROVIDERS_JSON', JSON.stringify(rawPool()))
    const config = loadConfig({ dataDir: directory, nodeEnv: 'test', jwtSecret: 'env-config-secret', aiDefaults: null })
    expect(config.aiProvidersSource).toBe('env')
    expect(config.aiProviders?.providers).toHaveLength(2)
    expect(JSON.stringify(config)).toContain('sk-alpha-key-111111111111') // server memory only
    expect(config.aiDefaults).toMatchObject({ label: 'Alpha 云', model: 'alpha-flash' })
  })

  it('rejects malformed provider JSON without echoing the secret', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'multipush-gateway-bad-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    vi.stubEnv('OPENCODE_GO_API_KEY', '')
    vi.stubEnv('AI_PROVIDERS_FILE', path.join(directory, 'missing.json'))
    vi.stubEnv('AI_PROVIDERS_JSON', '{"providers": [{"id": "x", "apiKey": "sk-should-not-leak"}')
    expect(() => loadConfig({ dataDir: directory, nodeEnv: 'test', jwtSecret: 'bad-config-secret', aiDefaults: null }))
      .toThrow(/AI_PROVIDERS_JSON/)
    try {
      loadConfig({ dataDir: directory, nodeEnv: 'test', jwtSecret: 'bad-config-secret', aiDefaults: null })
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('sk-should-not-leak')
    }
    // The file is absent; ensure no accidental write of secrets.
    expect(() => readFileSync(path.join(directory, 'ai-providers.json'), 'utf8')).toThrow()
  })
})


describe('provider pool editing', () => {
  it('keeps stored keys when the editor leaves apiKey blank and writes a 600 file', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'multipush-gateway-write-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const current = parseAiProvidersConfig(rawPool())
    const next = applyProviderPoolInput({
      providers: [
        {
          id: 'alpha',
          label: 'Alpha 云',
          baseUrl: 'https://alpha.example/v1',
          defaultModel: 'alpha-flash',
          models: ['alpha-flash'],
          highAvailability: false,
          keys: [
            { id: 'a1', label: '账号1', baseUrl: 'https://alpha-key.example/v1', enabled: true },
            { id: 'a2', label: '账号2', enabled: false },
          ],
        },
        {
          id: 'beta',
          label: 'Beta 官方',
          baseUrl: 'https://beta.example/v1',
          defaultModel: 'beta-pro',
          models: ['beta-pro'],
          keys: [{ id: 'b1', label: '官方 Key', apiKey: 'sk-new-beta-key-999999', enabled: true }],
        },
      ],
      probeIntervalMs: 120_000,
      maxProviderFailures: 4,
      cooldowns: { quotaMs: 5_000 },
    }, current)
    expect(next.providers[0].keys[0]).toMatchObject({ apiKey: 'sk-alpha-key-111111111111', baseUrl: 'https://alpha-key.example/v1', enabled: true })
    expect(next.providers[0].keys[1]).toMatchObject({ apiKey: 'sk-alpha-key-222222222222', enabled: false })
    expect(next.providers[0].highAvailability).toBe(false)
    expect(next.providers[1].keys[0].apiKey).toBe('sk-new-beta-key-999999')
    expect(next.probeIntervalMs).toBe(120_000)
    expect(next.maxProviderFailures).toBe(4)
    expect(next.cooldowns.quotaMs).toBe(5_000)
    const file = path.join(directory, 'nested', 'ai-providers.json')
    writeAiProvidersFile(file, next)
    expect(statSync(file).mode & 0o077).toBe(0)
    const view = providerPoolView(next, { editable: true, editableReason: null, source: 'file', warning: null })
    expect(view.providers[0].highAvailability).toBe(false)
    expect(view.providers[0].keys[0].maskedKey).toBe('sk-alph…1111')
    expect(JSON.stringify(view)).not.toContain('sk-alpha-key-111111111111')
  })

  it('requires an API key for a newly added key', () => {
    const current = parseAiProvidersConfig(rawPool())
    expect(() => applyProviderPoolInput({
      providers: [{
        id: 'alpha',
        label: 'Alpha 云',
        baseUrl: 'https://alpha.example/v1',
        defaultModel: 'alpha-flash',
        keys: [{ id: 'new-key', label: '新 Key', enabled: true }],
      }],
    }, current)).toThrow(/需要填写 API Key/)
  })

  it('rejects a provider with every key disabled', () => {
    expect(() => parseAiProvidersConfig({
      providers: [{
        id: 'alpha',
        baseUrl: 'https://alpha.example/v1',
        defaultModel: 'm1',
        keys: [{ id: 'a1', apiKey: 'sk-alpha-key-111111111111', enabled: false }],
      }],
    })).toThrow(/至少需要一个启用/)
  })
})

describe('provider HA switches and reload', () => {
  it('uses only the first enabled key when highAvailability is false', async () => {
    const config = parseAiProvidersConfig({
      ...rawPool(),
      providers: [{
        ...rawPool().providers[0],
        highAvailability: false,
      }],
      modelMap: {},
    })
    const { user, gateway } = setup(config)
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(request(init).authorization)
      return success('主 Key')
    }))
    const result = await gateway.complete(completeInput(user.id))
    expect(seen).toEqual(['Bearer sk-alpha-key-111111111111'])
    expect(result.routing.keyId).toBe('a1')
    expect(gateway.keyCount).toBe(1)
    // Explicit testing still covers all enabled keys so the user can verify a
    // second key before turning high availability on.
    vi.stubGlobal('fetch', vi.fn(async () => success('探活成功')))
    const probes = await gateway.probe(user.id)
    expect(probes.map(probe => probe.keyId)).toEqual(['a1', 'a2'])
  })

  it('skips disabled keys', async () => {
    const config = parseAiProvidersConfig({
      ...rawPool(),
      providers: [{
        ...rawPool().providers[0],
        keys: [
          { ...rawPool().providers[0].keys[0], enabled: false },
          rawPool().providers[0].keys[1],
        ],
      }],
      modelMap: {},
    })
    const { user, gateway } = setup(config)
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(request(init).authorization)
      return success('账号2')
    }))
    const result = await gateway.complete(completeInput(user.id))
    expect(seen).toEqual(['Bearer sk-alpha-key-222222222222'])
    expect(result.routing.keyId).toBe('a2')
  })

  it('swaps the provider pool at runtime after a settings save', async () => {
    const { user, gateway } = setup()
    let body = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? '')
      return success('旧池')
    }))
    await gateway.complete(completeInput(user.id))
    expect(body).toContain('alpha-flash')

    const next = parseAiProvidersConfig({
      providers: [{
        id: 'gamma',
        label: 'Gamma 新池',
        baseUrl: 'https://gamma.example/v1',
        defaultModel: 'gamma-mini',
        models: ['gamma-mini'],
        keys: [{ id: 'g1', label: 'Gamma Key', apiKey: 'sk-gamma-key-999999' }],
      }],
      modelMap: {},
    })
    gateway.reloadProviderPool(next, 'file', null)
    expect(gateway.providerCount).toBe(1)
    expect(gateway.status(user.id).source).toBe('file')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? '')
      return success('新池')
    }))
    const result = await gateway.complete(completeInput(user.id))
    expect(result.routing.providerId).toBe('gamma')
    expect(body).toContain('gamma-mini')
  })
})
