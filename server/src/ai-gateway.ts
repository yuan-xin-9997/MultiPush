import type {
  AiFailoverEventKind,
  AiGatewayProviderStatus,
  AiGatewayStatus,
  AiKeyState,
  AiProbeResult,
  AiProviderState,
  AiRoutingInfo,
  AiToolCall,
} from '../../shared/types'
import type { AppConfig } from './config'
import type { AiKeyStateRecord, AiProviderStateRecord, Database } from './db'
import { ApiError } from './errors'
import {
  DEFAULT_PROVIDER_COOLDOWNS,
  maskApiKey,
  type AiProviderConfig,
  type AiProviderCooldowns,
  type AiProvidersConfig,
} from './ai-provider-config'

const PROVIDER_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 30_000
const PROBE_MAX_TOKENS = 16
const MAX_COOLDOWN_MS = 6 * 60 * 60_000
const RATE_LIMIT_RETRY_LIMIT = 3_000
const DEFAULT_RATE_LIMIT_WAIT_MS = 3_000
const PROBE_MAX_PER_TICK = 6

type FailureKind = 'quota' | 'auth' | 'rate_limit' | 'transient' | 'bad_request'

interface GatewayMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
  tool_calls?: unknown[]
  tool_call_id?: string
}

interface GatewayTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface PreferredAiProvider {
  baseUrl: string
  model: string
  apiKey: string
  temperature: number
  label?: string
}

export interface GatewayCompletionInput {
  userId: string
  sessionId?: string
  messages: GatewayMessage[]
  tools?: GatewayTool[]
  temperature: number
  maxTokens?: number
  preferred?: PreferredAiProvider | null
}

export interface GatewayCompletionResult {
  content: string
  toolCalls: AiToolCall[]
  routing: AiRoutingInfo
}

interface ChainKey {
  id: string
  label: string
  apiKey: string
  baseUrl: string
  masked: string
  priority: number
}

interface ChainProvider {
  id: string
  label: string
  baseUrl: string
  models: string[]
  defaultModel: string
  source: 'config' | 'user'
  keys: ChainKey[]
}

interface Candidate {
  provider: ChainProvider
  key: ChainKey
  model: string
}

interface Failure {
  kind: FailureKind
  code: string
  message: string
  httpStatus: number | null
  retryAfterMs: number | null
}

interface AttemptRef {
  providerId: string
  providerLabel: string
  keyId: string
  keyLabel: string
  keyMasked: string
  model: string
  failure?: Failure
}

interface CallSuccess {
  ok: true
  content: string
  toolCalls: AiToolCall[]
  tokensIn: number
  tokensOut: number
  durationMs: number
}

interface CallFailure {
  ok: false
  failure: Failure
  durationMs: number
}

type CallOutcome = CallSuccess | CallFailure

interface RuntimeKey {
  state: AiKeyState
  reason: string | null
  cooldownUntil: number | null
  successCount: number
  failureCount: number
  quotaFailures: number
  authFailures: number
  rateLimits: number
  tokensIn: number
  tokensOut: number
  lastUsedAt: string | null
  lastError: string | null
}

interface RuntimeProvider {
  state: AiProviderState
  reason: string | null
  cooldownUntil: number | null
  consecutiveFailures: number
  lastError: string | null
}

interface GatewayOptions {
  /** Tests can shorten or disable the wait before retrying a rate-limited key. */
  rateLimitWaitMs?: number
  /** Replaceable clock for deterministic cooldown tests. */
  now?: () => number
}

function emptyKeyState(): RuntimeKey {
  return {
    state: 'available',
    reason: null,
    cooldownUntil: null,
    successCount: 0,
    failureCount: 0,
    quotaFailures: 0,
    authFailures: 0,
    rateLimits: 0,
    tokensIn: 0,
    tokensOut: 0,
    lastUsedAt: null,
    lastError: null,
  }
}

function emptyProviderState(): RuntimeProvider {
  return {
    state: 'available',
    reason: null,
    cooldownUntil: null,
    consecutiveFailures: 0,
    lastError: null,
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clampText(value: string, limit = 500): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function chatEndpoint(baseUrl: string): string {
  return /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_COOLDOWN_MS)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), MAX_COOLDOWN_MS))
  return null
}

function looksLikeQuotaError(body: string): boolean {
  return /(quota|usage[\s_-]*limit|monthly[\s_-]*limit|daily[\s_-]*limit|insufficient|balance|credit|billing|payment[\s_-]*required|额度|余额|配额|套餐.*(用尽|耗尽)|exceeded.*(quota|usage limit|monthly limit))/i.test(body)
}

function looksLikeModelError(body: string): boolean {
  return /(model.{0,20}(not found|not exist|does not exist|unsupported|invalid)|unknown model|no such model|模型.{0,10}(不存在|不支持))/i.test(body)
}

function modelFamily(model: string): string | null {
  const lower = model.toLowerCase()
  const families = ['deepseek', 'qwen', 'glm', 'minimax', 'kimi', 'moonshot', 'claude', 'gpt', 'gemini', 'grok', 'llama', 'mistral', 'doubao', 'ernie', 'hunyuan', 'step', 'spark', 'nova', 'yi']
  for (const family of families) {
    if (lower.includes(family)) return family
  }
  const first = lower.split(/[-_.:/@]/)[0]
  return first && first.length >= 2 ? first : null
}

function modelTier(model: string): string | null {
  const lower = model.toLowerCase()
  for (const tier of ['reasoner', 'thinking', 'flash', 'turbo', 'mini', 'lite', 'chat', 'pro', 'max', 'ultra', 'plus']) {
    if (lower.includes(tier)) return tier
  }
  return null
}


/**
 * Resilient OpenAI-compatible provider gateway.
 *
 * Responsibilities:
 * - ordered provider fallback chain with multiple API keys per provider;
 * - quota / auth / rate-limit aware key rotation with persisted cooldown;
 * - provider-level circuit breaker and periodic probing;
 * - model equivalence mapping when falling back to another provider;
 * - masked routing records and failover events for the management page.
 */
export class AiGateway {
  private readonly providers: AiProviderConfig[]
  private readonly config: AiProvidersConfig | null
  private readonly cooldowns: AiProviderCooldowns
  private readonly rateLimitWaitMs: number
  private readonly now: () => number
  private readonly keyStates = new Map<string, RuntimeKey>()
  private readonly providerStates = new Map<string, RuntimeProvider>()
  private timer: NodeJS.Timeout | null = null
  private probing = false

  constructor(
    private readonly database: Database,
    private readonly appConfig: AppConfig,
    private readonly options: GatewayOptions = {},
  ) {
    this.config = appConfig.aiProviders
    this.providers = this.config?.providers ?? []
    this.cooldowns = { ...DEFAULT_PROVIDER_COOLDOWNS, ...(this.config?.cooldowns ?? {}) }
    this.rateLimitWaitMs = Math.max(0, options.rateLimitWaitMs ?? DEFAULT_RATE_LIMIT_WAIT_MS)
    this.now = options.now ?? (() => Date.now())
  }

  get configured(): boolean {
    return this.providers.length > 0
  }

  get providerCount(): number {
    return this.providers.length
  }

  get keyCount(): number {
    return this.providers.reduce((total, provider) => total + provider.keys.length, 0)
  }

  get probeIntervalMs(): number {
    return this.config?.probeIntervalMs ?? 5 * 60_000
  }

  /** Reset the per-user override's cooldown when the user changes their key. */
  resetUserProvider(userId: string): void {
    const providerId = `user:${userId}`
    this.providerStates.delete(providerId)
    for (const key of [...this.keyStates.keys()]) {
      if (key.startsWith(`${providerId}\u0000`)) this.keyStates.delete(key)
    }
    try {
      this.database.resetAiProviderScope(providerId)
    } catch { /* state reset is best effort */ }
  }

  private keyCacheKey(providerId: string, keyId: string): string {
    return `${providerId}\u0000${keyId}`
  }

  private keyState(providerId: string, keyId: string): RuntimeKey {
    const cacheKey = this.keyCacheKey(providerId, keyId)
    const cached = this.keyStates.get(cacheKey)
    if (cached) return cached
    let record: AiKeyStateRecord | null = null
    try { record = this.database.getAiKeyState(providerId, keyId) } catch { record = null }
    const runtime: RuntimeKey = record ? {
      state: record.state,
      reason: record.reason,
      cooldownUntil: record.cooldownUntil ? Date.parse(record.cooldownUntil) : null,
      successCount: record.successCount,
      failureCount: record.failureCount,
      quotaFailures: record.quotaFailures,
      authFailures: record.authFailures,
      rateLimits: record.rateLimits,
      tokensIn: record.tokensIn,
      tokensOut: record.tokensOut,
      lastUsedAt: record.lastUsedAt,
      lastError: record.lastError,
    } : emptyKeyState()
    this.keyStates.set(cacheKey, runtime)
    return runtime
  }

  private persistKey(providerId: string, keyId: string, runtime: RuntimeKey): void {
    const record: AiKeyStateRecord = {
      providerId,
      keyId,
      state: runtime.state,
      reason: runtime.reason,
      cooldownUntil: runtime.cooldownUntil ? new Date(runtime.cooldownUntil).toISOString() : null,
      successCount: runtime.successCount,
      failureCount: runtime.failureCount,
      quotaFailures: runtime.quotaFailures,
      authFailures: runtime.authFailures,
      rateLimits: runtime.rateLimits,
      tokensIn: runtime.tokensIn,
      tokensOut: runtime.tokensOut,
      lastUsedAt: runtime.lastUsedAt,
      lastError: runtime.lastError,
      updatedAt: new Date(this.now()).toISOString(),
    }
    try { this.database.saveAiKeyState(record) } catch { /* audit persistence is best effort */ }
  }

  private providerState(providerId: string): RuntimeProvider {
    const cached = this.providerStates.get(providerId)
    if (cached) return cached
    let record: AiProviderStateRecord | null = null
    try { record = this.database.getAiProviderState(providerId) } catch { record = null }
    const runtime: RuntimeProvider = record ? {
      state: record.state,
      reason: record.reason,
      cooldownUntil: record.cooldownUntil ? Date.parse(record.cooldownUntil) : null,
      consecutiveFailures: record.consecutiveFailures,
      lastError: record.lastError,
    } : emptyProviderState()
    this.providerStates.set(providerId, runtime)
    return runtime
  }

  private persistProvider(providerId: string, runtime: RuntimeProvider): void {
    try {
      this.database.saveAiProviderState({
        providerId,
        state: runtime.state,
        reason: runtime.reason,
        cooldownUntil: runtime.cooldownUntil ? new Date(runtime.cooldownUntil).toISOString() : null,
        consecutiveFailures: runtime.consecutiveFailures,
        lastError: runtime.lastError,
        updatedAt: new Date(this.now()).toISOString(),
      })
    } catch { /* best effort */ }
  }

  private isCooling(until: number | null): boolean {
    return until !== null && until > this.now()
  }

  private keyUsable(providerId: string, keyId: string): boolean {
    const state = this.keyState(providerId, keyId)
    if (state.state === 'available') return true
    return !this.isCooling(state.cooldownUntil)
  }

  private providerUsable(providerId: string): boolean {
    const state = this.providerState(providerId)
    if (state.state === 'available') return true
    return !this.isCooling(state.cooldownUntil)
  }

  private allKeysUnusable(provider: ChainProvider): boolean {
    return provider.keys.every(key => !this.keyUsable(provider.id, key.id))
  }

  /** Build the effective chain: the user's own setting first, then server pool. */
  private buildChain(userId: string, preferred?: PreferredAiProvider | null): ChainProvider[] {
    const chain: ChainProvider[] = []
    if (preferred?.apiKey && preferred.baseUrl && preferred.model) {
      const apiKey = preferred.apiKey.trim()
      chain.push({
        id: `user:${userId}`,
        label: preferred.label || '账号自定义配置',
        baseUrl: preferred.baseUrl,
        models: [preferred.model],
        defaultModel: preferred.model,
        source: 'user',
        keys: [{
          id: 'user-key',
          label: '账号 Key',
          apiKey,
          baseUrl: preferred.baseUrl,
          masked: maskApiKey(apiKey),
          priority: 1,
        }],
      })
    }
    for (const provider of this.providers) {
      chain.push({
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        models: provider.models,
        defaultModel: provider.defaultModel,
        source: 'config',
        keys: provider.keys.map((key, index) => ({
          id: key.id,
          label: key.label,
          apiKey: key.apiKey,
          baseUrl: key.baseUrl || provider.baseUrl,
          masked: maskApiKey(key.apiKey),
          priority: index + 1,
        })),
      })
    }
    return chain
  }

  private resolveModel(requestedModel: string, sourceProviderId: string, target: ChainProvider): { model: string; via: string } {
    if (target.models.includes(requestedModel)) return { model: requestedModel, via: 'same' }
    const map = this.config?.modelMap ?? {}
    const keys = [`${sourceProviderId}/${requestedModel}`, `${sourceProviderId}/*`]
    if (sourceProviderId.startsWith('user:')) keys.push(`user/${requestedModel}`, 'user/*')
    keys.push(`*/${requestedModel}`, '*/*')
    const targets = keys.map(key => map[key]).find(Boolean)
    if (typeof targets === 'string' && targets) return { model: targets, via: 'map' }
    if (targets && typeof targets === 'object') {
      const mapped = targets[target.id] || targets['*']
      if (mapped) return { model: mapped, via: 'map' }
    }
    const family = modelFamily(requestedModel)
    if (family) {
      const sameFamily = target.models.filter(model => modelFamily(model) === family)
      if (sameFamily.length) {
        const tier = modelTier(requestedModel)
        const sameTier = tier ? sameFamily.find(model => modelTier(model) === tier) : undefined
        return { model: sameTier ?? sameFamily[0], via: 'family' }
      }
    }
    return { model: target.defaultModel, via: 'default' }
  }

  private redact(text: string, preferred?: PreferredAiProvider | null): string {
    let result = text
    for (const provider of this.providers) {
      for (const key of provider.keys) {
        if (key.apiKey) result = result.split(key.apiKey).join(maskApiKey(key.apiKey))
      }
    }
    if (preferred?.apiKey) result = result.split(preferred.apiKey).join(maskApiKey(preferred.apiKey))
    return clampText(result)
  }

  private logEvent(
    kind: AiFailoverEventKind,
    reason: string,
    input: { userId: string | null; sessionId?: string | null; preferred?: PreferredAiProvider | null },
    values: {
      detail?: string | null
      from?: AttemptRef | null
      to?: AttemptRef | null
      model?: string | null
      targetModel?: string | null
    },
  ): void {
    const from = values.from ?? null
    const to = values.to ?? null
    try {
      this.database.createAiFailoverEvent({
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        kind,
        reason,
        detail: values.detail ? this.redact(values.detail, input.preferred) : null,
        fromProviderId: from?.providerId ?? null,
        fromProviderLabel: from?.providerLabel ?? null,
        fromKeyId: from?.keyId ?? null,
        fromKeyLabel: from?.keyLabel ?? null,
        fromKeyMasked: from?.keyMasked ?? null,
        toProviderId: to?.providerId ?? null,
        toProviderLabel: to?.providerLabel ?? null,
        toKeyId: to?.keyId ?? null,
        toKeyLabel: to?.keyLabel ?? null,
        toKeyMasked: to?.keyMasked ?? null,
        model: values.model ?? null,
        targetModel: values.targetModel ?? null,
      })
    } catch (error) {
      console.error('[multipush] failed to persist AI failover event:', error instanceof Error ? error.message : error)
    }
    const route = from && to
      ? `${from.providerLabel}/${from.keyLabel} → ${to.providerLabel}/${to.keyLabel}`
      : from ? `${from.providerLabel}/${from.keyLabel}` : (to ? `${to.providerLabel}/${to.keyLabel}` : '-')
    const detail = values.detail ? ` detail=${this.redact(values.detail, input.preferred)}` : ''
    const line = `[multipush] ai ${kind} reason=${reason} ${route}`
    if (kind === 'key_recovery' || kind === 'provider_recovery') console.info(`${line}${detail}`)
    else console.warn(`${line}${detail}`)
  }

  private attemptRef(candidate: Candidate): AttemptRef {
    return {
      providerId: candidate.provider.id,
      providerLabel: candidate.provider.label,
      keyId: candidate.key.id,
      keyLabel: candidate.key.label,
      keyMasked: candidate.key.masked,
      model: candidate.model,
    }
  }

  private coolKey(
    provider: ChainProvider,
    key: ChainKey,
    failure: Failure,
    input: { userId: string | null; sessionId?: string | null; preferred?: PreferredAiProvider | null },
  ): void {
    const runtime = this.keyState(provider.id, key.id)
    const now = this.now()
    if (failure.kind === 'quota') {
      runtime.state = 'exhausted'
      runtime.quotaFailures += 1
      const backoff = Math.min(this.cooldowns.quotaMs * 2 ** Math.min(runtime.quotaFailures - 1, 6), MAX_COOLDOWN_MS)
      runtime.cooldownUntil = now + backoff
    } else if (failure.kind === 'auth') {
      runtime.state = 'invalid'
      runtime.authFailures += 1
      const backoff = Math.min(this.cooldowns.authMs * 2 ** Math.min(runtime.authFailures - 1, 6), MAX_COOLDOWN_MS)
      runtime.cooldownUntil = now + backoff
    } else if (failure.kind === 'rate_limit') {
      runtime.state = 'cooling'
      runtime.rateLimits += 1
      runtime.cooldownUntil = now + Math.min(failure.retryAfterMs ?? this.cooldowns.rateLimitMs, MAX_COOLDOWN_MS)
    } else {
      runtime.state = 'cooling'
      runtime.cooldownUntil = now + this.cooldowns.transientMs
    }
    runtime.reason = failure.code
    runtime.failureCount += 1
    runtime.lastError = failure.message
    this.persistKey(provider.id, key.id, runtime)
    const ref = this.attemptRef({ provider, key, model: '' })
    this.logEvent(failure.kind === 'rate_limit' ? 'rate_limited' : 'key_cooldown', failure.code, input, {
      detail: failure.message,
      from: ref,
    })
  }

  private noteProviderFailure(
    provider: ChainProvider,
    failure: Failure,
    input: { userId: string | null; sessionId?: string | null; preferred?: PreferredAiProvider | null },
    options: { immediate?: boolean } = {},
  ): void {
    const runtime = this.providerState(provider.id)
    runtime.consecutiveFailures += 1
    runtime.lastError = failure.message
    this.persistProvider(provider.id, runtime)
    const threshold = this.config?.maxProviderFailures ?? 3
    if (options.immediate || runtime.consecutiveFailures >= threshold) {
      this.coolProvider(provider, options.immediate ? failure.code : 'consecutive_failures', failure.message, input)
    }
  }

  private coolProvider(
    provider: ChainProvider,
    reason: string,
    detail: string,
    input: { userId: string | null; sessionId?: string | null; preferred?: PreferredAiProvider | null },
  ): void {
    const runtime = this.providerState(provider.id)
    const alreadyCooling = runtime.state === 'cooling' && this.isCooling(runtime.cooldownUntil)
    runtime.state = 'cooling'
    runtime.reason = reason
    runtime.cooldownUntil = this.now() + this.cooldowns.providerMs
    runtime.lastError = detail
    this.persistProvider(provider.id, runtime)
    if (!alreadyCooling) {
      this.logEvent('provider_cooldown', reason, input, {
        detail,
        from: { providerId: provider.id, providerLabel: provider.label, keyId: '', keyLabel: '', keyMasked: '', model: '' },
      })
    }
  }

  private recoverProvider(
    provider: ChainProvider,
    input: { userId: string | null; sessionId?: string | null; preferred?: PreferredAiProvider | null },
  ): void {
    const runtime = this.providerState(provider.id)
    const wasCooling = runtime.state !== 'available'
    runtime.state = 'available'
    runtime.reason = null
    runtime.cooldownUntil = null
    runtime.consecutiveFailures = 0
    runtime.lastError = null
    this.persistProvider(provider.id, runtime)
    if (wasCooling) {
      this.logEvent('provider_recovery', 'recovered', input, {
        detail: '提供商探活成功，恢复可用',
        from: { providerId: provider.id, providerLabel: provider.label, keyId: '', keyLabel: '', keyMasked: '', model: '' },
      })
    }
  }

  private classifyHttpFailure(status: number, body: string, retryAfter: string | null): Failure {
    const detail = clampText(body || `HTTP ${status}`)
    if (status === 401 || status === 403) {
      if (looksLikeQuotaError(body)) {
        return { kind: 'quota', code: 'quota_exhausted', message: `额度不足（HTTP ${status}）：${detail}`, httpStatus: status, retryAfterMs: null }
      }
      return { kind: 'auth', code: 'unauthorized', message: `Key 认证失败（HTTP ${status}）：${detail}`, httpStatus: status, retryAfterMs: null }
    }
    if (status === 402) {
      return { kind: 'quota', code: 'quota_exhausted', message: `额度不足（HTTP ${status}）：${detail}`, httpStatus: status, retryAfterMs: null }
    }
    if (status === 429) {
      if (looksLikeQuotaError(body)) {
        return { kind: 'quota', code: 'quota_exhausted', message: `额度不足（HTTP 429）：${detail}`, httpStatus: status, retryAfterMs: null }
      }
      return { kind: 'rate_limit', code: 'rate_limited', message: `触发限流（HTTP 429）：${detail}`, httpStatus: status, retryAfterMs: parseRetryAfter(retryAfter) }
    }
    if (status === 400 || status === 404 || status === 422) {
      if (looksLikeModelError(body)) {
        return { kind: 'bad_request', code: 'model_unavailable', message: `模型不可用（HTTP ${status}）：${detail}`, httpStatus: status, retryAfterMs: null }
      }
      return { kind: 'bad_request', code: 'provider_bad_request', message: `大模型请求参数被拒绝（HTTP ${status}）：${detail}`, httpStatus: status, retryAfterMs: null }
    }
    if (status >= 500 || status === 408) {
      return { kind: 'transient', code: 'provider_error', message: `大模型服务异常（HTTP ${status}）：${detail}`, httpStatus: status, retryAfterMs: parseRetryAfter(retryAfter) }
    }
    return { kind: 'transient', code: 'provider_error', message: `大模型请求失败（HTTP ${status}）：${detail}`, httpStatus: status, retryAfterMs: null }
  }

  private async callCandidate(
    candidate: Candidate,
    input: GatewayCompletionInput,
    timeoutMs = PROVIDER_TIMEOUT_MS,
  ): Promise<CallOutcome> {
    const startedAt = this.now()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${candidate.key.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'MultiPush/2.0',
    }
    if (/opencode\.ai\/inference\/go/i.test(candidate.key.baseUrl)) {
      headers['x-opencode-session'] = `multipush-${input.sessionId || 'default'}`
    }
    let response: Response
    try {
      response = await fetch(chatEndpoint(candidate.key.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: candidate.model,
          messages: input.messages,
          temperature: input.temperature,
          stream: false,
          ...(input.tools?.length ? { tools: input.tools, tool_choice: 'auto' } : {}),
          ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '网络错误'
      return {
        ok: false,
        durationMs: this.now() - startedAt,
        failure: { kind: 'transient', code: 'network_error', message: `无法连接大模型接口：${this.redact(message, input.preferred)}`, httpStatus: null, retryAfterMs: null },
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return {
        ok: false,
        durationMs: this.now() - startedAt,
        failure: this.classifyHttpFailure(response.status, text, response.headers.get('retry-after')),
      }
    }
    let payload: Record<string, unknown>
    try {
      payload = object(await response.json())
    } catch (error) {
      return {
        ok: false,
        durationMs: this.now() - startedAt,
        failure: { kind: 'transient', code: 'invalid_response', message: `大模型返回了无法解析的响应：${this.redact(error instanceof Error ? error.message : '未知错误', input.preferred)}`, httpStatus: response.status, retryAfterMs: null },
      }
    }
    const choices = payload.choices
    const choice = Array.isArray(choices) ? object(choices[0]) : {}
    const message = object(choice.message)
    const content = typeof message.content === 'string' ? message.content : ''
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    const toolCalls: AiToolCall[] = rawCalls.flatMap((raw) => {
      const call = object(raw)
      const fn = object(call.function)
      return typeof call.id === 'string' && typeof fn.name === 'string' && typeof fn.arguments === 'string'
        ? [{ id: call.id, type: 'function' as const, function: { name: fn.name, arguments: fn.arguments } }]
        : []
    })
    const usage = object(payload.usage)
    return {
      ok: true,
      content,
      toolCalls,
      tokensIn: numberValue(usage.prompt_tokens) || numberValue(usage.input_tokens),
      tokensOut: numberValue(usage.completion_tokens) || numberValue(usage.output_tokens),
      durationMs: this.now() - startedAt,
    }
  }

  private recordRequest(
    input: GatewayCompletionInput,
    candidate: Candidate,
    outcome: CallOutcome,
  ): void {
    try {
      this.database.createAiProviderRequest({
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        providerId: candidate.provider.id,
        providerLabel: candidate.provider.label,
        model: candidate.model,
        keyId: candidate.key.id,
        keyLabel: candidate.key.label,
        keyMasked: candidate.key.masked,
        status: outcome.ok ? 'success' : 'failed',
        httpStatus: outcome.ok ? 200 : outcome.failure.httpStatus,
        errorCode: outcome.ok ? null : outcome.failure.code,
        durationMs: outcome.durationMs,
        tokensIn: outcome.ok ? outcome.tokensIn : 0,
        tokensOut: outcome.ok ? outcome.tokensOut : 0,
      })
    } catch (error) {
      console.error('[multipush] failed to persist AI provider request:', error instanceof Error ? error.message : error)
    }
  }

  private markSuccess(candidate: Candidate, outcome: CallSuccess, input: GatewayCompletionInput): void {
    const runtime = this.keyState(candidate.provider.id, candidate.key.id)
    const wasUnavailable = runtime.state !== 'available'
    runtime.state = 'available'
    runtime.reason = null
    runtime.cooldownUntil = null
    runtime.successCount += 1
    runtime.tokensIn += outcome.tokensIn
    runtime.tokensOut += outcome.tokensOut
    runtime.lastUsedAt = new Date(this.now()).toISOString()
    runtime.lastError = null
    this.persistKey(candidate.provider.id, candidate.key.id, runtime)
    if (wasUnavailable) {
      this.logEvent('key_recovery', 'recovered', { userId: input.userId || null, sessionId: input.sessionId, preferred: input.preferred }, {
        detail: '探活成功，Key 恢复可用',
        from: { providerId: candidate.provider.id, providerLabel: candidate.provider.label, keyId: candidate.key.id, keyLabel: candidate.key.label, keyMasked: candidate.key.masked, model: candidate.model },
      })
    }
    this.recoverProvider(candidate.provider, { userId: input.userId || null, sessionId: input.sessionId, preferred: input.preferred })
  }

  private buildRouting(candidate: Candidate, input: GatewayCompletionInput, requestedModel: string, failures: Failure[]): AiRoutingInfo {
    return {
      providerId: candidate.provider.id,
      providerLabel: candidate.provider.label,
      model: candidate.model,
      requestedModel,
      keyId: candidate.key.id,
      keyLabel: candidate.key.label,
      keyMasked: candidate.key.masked,
      fallback: failures.length > 0,
      reason: failures[0]?.code ?? null,
      attempts: failures.length + 1,
    }
  }

  private async attemptOnce(
    candidate: Candidate,
    input: GatewayCompletionInput,
    requestedModel: string,
    failures: Failure[],
  ): Promise<GatewayCompletionResult | null> {
    const outcome = await this.callCandidate(candidate, input)
    this.recordRequest(input, candidate, outcome)
    if (outcome.ok) {
      this.markSuccess(candidate, outcome, input)
      const routing = this.buildRouting(candidate, input, requestedModel, failures)
      if (routing.fallback) {
        console.info(`[multipush] ai routing provider=${routing.providerId} model=${routing.model} key=${routing.keyMasked} attempts=${routing.attempts} reason=${routing.reason}`)
      }
      return { content: outcome.content, toolCalls: outcome.toolCalls, routing }
    }
    // Persist the failure details for the management page before updating states.
    const failure = { ...outcome.failure, message: this.redact(outcome.failure.message, input.preferred) }
    failures.push(failure)
    const eventInput = { userId: input.userId, sessionId: input.sessionId, preferred: input.preferred }
    if (failure.kind === 'bad_request') {
      // The model or request is rejected as a whole: skip the rest of this provider.
      this.noteProviderFailure(candidate.provider, failure, eventInput, { immediate: true })
    } else if (failure.kind === 'transient') {
      this.coolKey(candidate.provider, candidate.key, failure, eventInput)
      this.noteProviderFailure(candidate.provider, failure, eventInput)
    } else {
      this.coolKey(candidate.provider, candidate.key, failure, eventInput)
      if (this.allKeysUnusable(candidate.provider)) {
        this.coolProvider(candidate.provider, 'keys_unavailable', '该提供商的所有 Key 均在冷却或不可用', eventInput)
      }
    }
    return null
  }

  /**
   * Even when the primary provider/key is skipped without an HTTP attempt
   * (still cooling), the result must tell the user that the fallback route is
   * active and why. This keeps every request traceable.
   */
  private withRootFallback(result: GatewayCompletionResult, chain: ChainProvider[]): GatewayCompletionResult {
    const root = chain[0]
    if (!root || result.routing.fallback) return result
    const rootKey = root.keys[0]
    if (rootKey && result.routing.providerId === root.id && result.routing.keyId === rootKey.id) return result
    const keyState = rootKey ? this.keyState(root.id, rootKey.id) : null
    const providerState = this.providerState(root.id)
    const reason = keyState?.reason ?? providerState.reason ?? 'primary_unavailable'
    return { ...result, routing: { ...result.routing, fallback: true, reason } }
  }

  async complete(input: GatewayCompletionInput): Promise<GatewayCompletionResult> {
    const chain = this.buildChain(input.userId, input.preferred)
    if (!chain.length) throw new ApiError(409, 'ai_not_configured', '请先在 AI 创作页配置大模型接口和 API Key')
    const requestedModel = input.preferred?.model || chain[0].defaultModel
    const sourceProviderId = chain[0].id
    const failures: Failure[] = []
    const rateLimited: Candidate[] = []
    let previous: AttemptRef | null = null
    let attempts = 0

    const candidates: Candidate[] = chain.flatMap((provider) => provider.keys.map((key) => ({
      provider,
      key,
      model: this.resolveModel(requestedModel, sourceProviderId, provider).model,
    })))

    for (const candidate of candidates) {
      if (!this.providerUsable(candidate.provider.id)) continue
      if (!this.keyUsable(candidate.provider.id, candidate.key.id)) continue
      const current = this.attemptRef(candidate)
      if (previous && (previous.providerId !== current.providerId || previous.keyId !== current.keyId)) {
        this.logEvent(previous.providerId === current.providerId ? 'key_switch' : 'provider_switch', previous.failure?.code ?? 'fallback', {
          userId: input.userId, sessionId: input.sessionId, preferred: input.preferred,
        }, {
          detail: previous.failure?.message ?? null,
          from: previous,
          to: current,
          model: requestedModel,
          targetModel: candidate.model,
        })
      }
      previous = current
      attempts += 1
      const result = await this.attemptOnce(candidate, input, requestedModel, failures)
      if (result) return this.withRootFallback(result, chain)
      const failure = failures[failures.length - 1]
      current.failure = failure
      previous = current
      if (failure.kind === 'rate_limit') {
        rateLimited.push(candidate)
      } else if (failure.kind === 'bad_request') {
        // Skip the remaining keys of this provider; the next provider may have the model.
        const providerIndex = candidates.indexOf(candidate)
        for (let index = candidates.length - 1; index > providerIndex; index--) {
          if (candidates[index].provider.id === candidate.provider.id) candidates.splice(index, 1)
        }
      }
    }

    // Rate limits are temporary: wait briefly and retry the affected keys once.
    if (rateLimited.length) {
      const waits = rateLimited
        .map(candidate => {
          const state = this.keyState(candidate.provider.id, candidate.key.id)
          return state.cooldownUntil ? Math.max(0, state.cooldownUntil - this.now()) : this.cooldowns.rateLimitMs
        })
      const wait = Math.min(Math.max(...waits, 0), this.rateLimitWaitMs, RATE_LIMIT_RETRY_LIMIT)
      if (wait > 0) await delay(wait)
      for (const candidate of rateLimited) {
        if (!this.providerUsable(candidate.provider.id) && this.providerState(candidate.provider.id).reason !== 'keys_unavailable') continue
        const current = this.attemptRef(candidate)
        if (previous && (previous.providerId !== current.providerId || previous.keyId !== current.keyId)) {
          this.logEvent('key_switch', previous.failure?.code ?? 'rate_limited', {
            userId: input.userId, sessionId: input.sessionId, preferred: input.preferred,
          }, {
            detail: '限流冷却后重试',
            from: previous,
            to: current,
            model: requestedModel,
            targetModel: candidate.model,
          })
        }
        previous = current
        attempts += 1
        const result = await this.attemptOnce(candidate, input, requestedModel, failures)
        if (result) return this.withRootFallback(result, chain)
        current.failure = failures[failures.length - 1]
        previous = current
      }
    }

    const summary = [...new Set(failures.map(failure => `${failure.code}（${failure.message.split('：')[0]}）`))].join('、')
    const allRateLimited = failures.length > 0 && failures.every(failure => failure.kind === 'rate_limit')
    if (allRateLimited) {
      throw new ApiError(429, 'ai_rate_limited', `所有大模型 Key 当前都被限流，请稍后重试${summary ? `：${summary}` : ''}`)
    }
    if (!failures.length) {
      const earliest = chain
        .map(provider => this.providerState(provider.id).cooldownUntil)
        .filter((value): value is number => typeof value === 'number')
        .sort((a, b) => a - b)[0]
      const until = earliest ? `，预计 ${new Date(earliest).toLocaleString('zh-CN')} 后自动探活恢复` : ''
      throw new ApiError(503, 'ai_providers_cooling', `所有大模型提供商当前都在冷却中${until}。请稍后重试或检查「高可用」状态。`)
    }
    const first = failures[0]
    const status = first.httpStatus && first.httpStatus >= 400 && first.httpStatus < 500 ? 502 : 503
    throw new ApiError(status, 'ai_all_providers_failed', `所有大模型提供商均不可用（共尝试 ${attempts} 次）。最后一次原因：${first.message}${summary ? `；失败摘要：${summary}` : ''}`)
  }

  private chainWithPreferred(userId: string, preferred?: PreferredAiProvider | null): ChainProvider[] {
    return this.buildChain(userId, preferred)
  }

  /** Fetch a status snapshot for the management page. Never includes raw keys. */
  status(userId: string, preferred?: PreferredAiProvider | null): AiGatewayStatus {
    const chain = this.chainWithPreferred(userId, preferred)
    const providers: AiGatewayProviderStatus[] = chain.map((provider) => {
      const state = this.providerState(provider.id)
      return {
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        defaultModel: provider.defaultModel,
        models: provider.models,
        source: provider.source,
        state: state.state,
        reason: state.reason,
        cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : null,
        consecutiveFailures: state.consecutiveFailures,
        lastError: state.lastError,
        keys: provider.keys.map((key) => {
          const keyState = this.keyState(provider.id, key.id)
          return {
            providerId: provider.id,
            providerLabel: provider.label,
            keyId: key.id,
            keyLabel: key.label,
            maskedKey: key.masked,
            priority: key.priority,
            state: keyState.state,
            reason: keyState.reason,
            cooldownUntil: keyState.cooldownUntil ? new Date(keyState.cooldownUntil).toISOString() : null,
            successCount: keyState.successCount,
            failureCount: keyState.failureCount,
            quotaFailures: keyState.quotaFailures,
            authFailures: keyState.authFailures,
            rateLimits: keyState.rateLimits,
            tokensIn: keyState.tokensIn,
            tokensOut: keyState.tokensOut,
            lastUsedAt: keyState.lastUsedAt,
            lastError: keyState.lastError,
          }
        }),
      }
    })
    return {
      configured: chain.length > 0,
      source: this.appConfig.aiProvidersSource,
      warning: this.appConfig.aiProvidersWarning,
      probeIntervalMs: this.probeIntervalMs,
      updatedAt: new Date(this.now()).toISOString(),
      providers,
      events: this.database.listAiFailoverEvents(userId, 30),
      requests: this.database.listAiProviderRequests(userId, 20),
    }
  }

  private probeInput(userId: string | null, preferred?: PreferredAiProvider | null): GatewayCompletionInput {
    return {
      userId: userId ?? '',
      sessionId: 'probe',
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      maxTokens: PROBE_MAX_TOKENS,
      preferred: preferred ?? null,
    }
  }

  /** Explicit connectivity test: one minimal request per key, bypassing cooldown. */
  async probe(userId: string, preferred?: PreferredAiProvider | null, providerId?: string): Promise<AiProbeResult[]> {
    const chain = this.chainWithPreferred(userId, preferred).filter(provider => !providerId || provider.id === providerId)
    const results: AiProbeResult[] = []
    for (const provider of chain) {
      let providerSucceeded = false
      for (const key of provider.keys) {
        const candidate: Candidate = { provider, key, model: provider.defaultModel }
        const input = this.probeInput(userId, preferred)
        const outcome = await this.callCandidate(candidate, input, PROBE_TIMEOUT_MS)
        if (outcome.ok) {
          this.markSuccess(candidate, outcome, input)
          providerSucceeded = true
          results.push({
            providerId: provider.id,
            providerLabel: provider.label,
            keyId: key.id,
            keyLabel: key.label,
            maskedKey: key.masked,
            model: provider.defaultModel,
            ok: true,
            message: outcome.content ? `连接成功：${clampText(outcome.content, 120)}` : '连接成功',
            latencyMs: outcome.durationMs,
          })
        } else {
          const failure = { ...outcome.failure, message: this.redact(outcome.failure.message, preferred) }
          this.coolKey(provider, key, failure, { userId, sessionId: 'probe', preferred })
          results.push({
            providerId: provider.id,
            providerLabel: provider.label,
            keyId: key.id,
            keyLabel: key.label,
            maskedKey: key.masked,
            model: provider.defaultModel,
            ok: false,
            message: failure.message,
            latencyMs: outcome.durationMs,
          })
        }
      }
      if (!providerSucceeded) {
        const failure: Failure = { kind: 'transient', code: 'provider_probe_failed', message: '该提供商的所有 Key 探活失败', httpStatus: null, retryAfterMs: null }
        this.coolProvider(provider, 'probe_failed', failure.message, { userId, sessionId: 'probe', preferred })
      }
    }
    return results
  }

  /** Probe keys whose cooldown expired; used by the periodic timer. */
  private async probeDue(): Promise<void> {
    if (this.probing || !this.config) return
    this.probing = true
    try {
      const now = this.now()
      const due: Candidate[] = []
      for (const provider of this.providers) {
        const providerState = this.providerState(provider.id)
        const providerDue = providerState.state !== 'available' && !this.isCooling(providerState.cooldownUntil)
        for (const key of provider.keys) {
          const state = this.keyState(provider.id, key.id)
          const keyDue = state.state !== 'available' && !this.isCooling(state.cooldownUntil)
          if (keyDue || (providerDue && state.state === 'available')) {
            due.push({ provider: { ...this.toChainProvider(provider) }, key: { ...key, baseUrl: key.baseUrl || provider.baseUrl, masked: maskApiKey(key.apiKey), priority: 1 }, model: provider.defaultModel })
            if (due.length >= PROBE_MAX_PER_TICK) break
          }
        }
        if (due.length >= PROBE_MAX_PER_TICK) break
      }
      for (const candidate of due) {
        const input = this.probeInput(null)
        const outcome = await this.callCandidate(candidate, input, PROBE_TIMEOUT_MS)
        if (outcome.ok) {
          this.markSuccess(candidate, outcome, input)
        } else {
          const failure = { ...outcome.failure, message: this.redact(outcome.failure.message) }
          this.coolKey(candidate.provider, candidate.key, failure, { userId: null, sessionId: 'probe' })
        }
      }
    } finally {
      this.probing = false
    }
  }

  private toChainProvider(provider: AiProviderConfig): ChainProvider {
    return {
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      models: provider.models,
      defaultModel: provider.defaultModel,
      source: 'config',
      keys: provider.keys.map((key, index) => ({
        id: key.id,
        label: key.label,
        apiKey: key.apiKey,
        baseUrl: key.baseUrl || provider.baseUrl,
        masked: maskApiKey(key.apiKey),
        priority: index + 1,
      })),
    }
  }

  startProber(): void {
    if (this.timer || !this.config) return
    const interval = Math.max(15_000, Math.min(this.probeIntervalMs, 60_000))
    this.timer = setInterval(() => { void this.probeDue() }, interval)
    this.timer.unref?.()
  }

  stopProber(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  close(): void {
    this.stopProber()
  }
}

