import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { ApiError } from './errors'
import type { AiDefaultConfig } from './config'

/**
 * Server-level provider pool configuration.
 *
 * The pool is intentionally independent from business code: providers, keys,
 * base URLs and model ids all come from `AI_PROVIDERS_JSON` or a protected JSON
 * file (`AI_PROVIDERS_FILE`, default `DATA_DIR/ai-providers.json`). Secrets are
 * never hardcoded and the parsed config is never returned to clients.
 */
export interface AiProviderKeyConfig {
  id: string
  label: string
  apiKey: string
  /** Optional per-key base URL override; falls back to the provider base URL. */
  baseUrl?: string
}

export interface AiProviderConfig {
  id: string
  label: string
  baseUrl: string
  models: string[]
  defaultModel: string
  keys: AiProviderKeyConfig[]
}

/** target provider id → model id, or a single fallback model for every provider. */
export type AiModelMapTargets = Record<string, string> | string

export interface AiProviderCooldowns {
  /** Quota/balance exhausted: wait before probing again. */
  quotaMs: number
  /** 401/403 invalid key: wait before probing again. */
  authMs: number
  /** 429 rate limit: temporary rotation window. */
  rateLimitMs: number
  /** Network/5xx failures. */
  transientMs: number
  /** Provider-level circuit breaker. */
  providerMs: number
}

export interface AiProvidersConfig {
  providers: AiProviderConfig[]
  /** Keyed by `${sourceProviderId}/${requestedModel}`. */
  modelMap: Record<string, AiModelMapTargets>
  probeIntervalMs: number
  maxProviderFailures: number
  cooldowns: AiProviderCooldowns
}

export type AiProvidersSource = 'env' | 'file' | 'legacy' | 'override' | 'none'

export interface LoadedAiProviders {
  config: AiProvidersConfig | null
  source: AiProvidersSource
  warning: string | null
}

export const DEFAULT_PROVIDER_COOLDOWNS: AiProviderCooldowns = {
  quotaMs: 30 * 60_000,
  authMs: 30 * 60_000,
  rateLimitMs: 30_000,
  transientMs: 20_000,
  providerMs: 2 * 60_000,
}

const DEFAULT_PROBE_INTERVAL_MS = 5 * 60_000
const DEFAULT_MAX_PROVIDER_FAILURES = 3
const MAX_PROBE_INTERVAL_MS = 24 * 60 * 60_000
const MAX_COOLDOWN_MS = 6 * 60 * 60_000
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const RESERVED_PROVIDER_IDS = new Set(['user', 'probe', 'legacy'])

export function normalizeAiBaseUrl(value: string): string {
  const trimmed = value.trim()
  let url: URL
  try { url = new URL(trimmed) } catch { throw new ApiError(400, 'ai_base_url', '大模型接口地址格式不正确') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ApiError(400, 'ai_base_url', '大模型接口地址必须是 http(s) 且不能包含用户名或密码')
  if (url.search || url.hash) throw new ApiError(400, 'ai_base_url', '大模型接口地址不能包含查询参数或锚点')
  if (['169.254.169.254', 'metadata.google.internal', '0.0.0.0'].includes(url.hostname)) throw new ApiError(400, 'ai_base_url', '不允许连接该地址')
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href.replace(/\/+$/, '')
}

function normalizeBaseUrlForConfig(value: string, field: string): string {
  try {
    return normalizeAiBaseUrl(value)
  } catch (error) {
    throw new Error(`${field} 不是合法的大模型接口地址：${error instanceof Error ? error.message : '格式错误'}`)
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function parseKey(raw: unknown, index: number, providerId: string): AiProviderKeyConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`providers.${providerId}.keys[${index}] 必须是对象`)
  const input = raw as Record<string, unknown>
  const apiKey = text(input.apiKey) || text(input.key)
  if (!apiKey) throw new Error(`providers.${providerId}.keys[${index}].apiKey 不能为空`)
  const id = text(input.id) || `key-${index + 1}`
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(id)) throw new Error(`providers.${providerId}.keys[${index}].id 只能包含字母、数字和 . _ : -`)
  const key: AiProviderKeyConfig = {
    id,
    label: text(input.label) || `Key ${index + 1}`,
    apiKey,
  }
  const baseUrl = text(input.baseUrl)
  if (baseUrl) key.baseUrl = normalizeBaseUrlForConfig(baseUrl, `providers.${providerId}.keys[${index}].baseUrl`)
  return key
}

function parseProvider(raw: unknown, index: number): AiProviderConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`providers[${index}] 必须是对象`)
  const input = raw as Record<string, unknown>
  const id = text(input.id)
  if (!id) throw new Error(`providers[${index}].id 不能为空`)
  if (!PROVIDER_ID_PATTERN.test(id)) throw new Error(`providers[${index}].id 只能是小写字母、数字、下划线和连字符`)
  if (RESERVED_PROVIDER_IDS.has(id)) throw new Error(`providers[${index}].id 不能使用保留名称 ${id}`)
  const baseUrl = text(input.baseUrl)
  if (!baseUrl) throw new Error(`providers.${id}.baseUrl 不能为空`)
  const keysInput = Array.isArray(input.keys) ? input.keys : []
  if (!keysInput.length) throw new Error(`providers.${id}.keys 至少需要一个 API Key`)
  const keys = keysInput.map((key, keyIndex) => parseKey(key, keyIndex, id))
  const keyIds = new Set<string>()
  for (const key of keys) {
    if (keyIds.has(key.id)) throw new Error(`providers.${id} 存在重复的 Key id: ${key.id}`)
    keyIds.add(key.id)
  }
  const modelsInput = Array.isArray(input.models) ? input.models : []
  const models = [...new Set(modelsInput.map(text).filter(Boolean))]
  const defaultModel = text(input.defaultModel) || models[0]
  if (!defaultModel) throw new Error(`providers.${id}.defaultModel（或 models[0]）不能为空`)
  if (!models.includes(defaultModel)) models.unshift(defaultModel)
  return {
    id,
    label: text(input.label) || id,
    baseUrl: normalizeBaseUrlForConfig(baseUrl, `providers.${id}.baseUrl`),
    models,
    defaultModel,
    keys,
  }
}

function parseCooldowns(raw: unknown): AiProviderCooldowns {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  return {
    quotaMs: integer(input.quotaMs, DEFAULT_PROVIDER_COOLDOWNS.quotaMs, 1_000, MAX_COOLDOWN_MS),
    authMs: integer(input.authMs, DEFAULT_PROVIDER_COOLDOWNS.authMs, 1_000, MAX_COOLDOWN_MS),
    rateLimitMs: integer(input.rateLimitMs, DEFAULT_PROVIDER_COOLDOWNS.rateLimitMs, 1_000, MAX_COOLDOWN_MS),
    transientMs: integer(input.transientMs, DEFAULT_PROVIDER_COOLDOWNS.transientMs, 1_000, MAX_COOLDOWN_MS),
    providerMs: integer(input.providerMs, DEFAULT_PROVIDER_COOLDOWNS.providerMs, 1_000, MAX_COOLDOWN_MS),
  }
}

/** Parse and validate a provider pool document. Error messages never echo keys. */
export function parseAiProvidersConfig(raw: unknown): AiProvidersConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('大模型提供商配置必须是 JSON 对象')
  const input = raw as Record<string, unknown>
  const providersInput = Array.isArray(input.providers) ? input.providers : []
  if (!providersInput.length) throw new Error('大模型提供商配置至少需要一个 provider')
  const providers = providersInput.map(parseProvider)
  const ids = new Set<string>()
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new Error(`大模型提供商 id 重复：${provider.id}`)
    ids.add(provider.id)
  }
  const modelMap: Record<string, AiModelMapTargets> = {}
  const rawModelMap = input.modelMap
  if (rawModelMap !== undefined) {
    if (!rawModelMap || typeof rawModelMap !== 'object' || Array.isArray(rawModelMap)) throw new Error('modelMap 必须是对象')
    for (const [key, value] of Object.entries(rawModelMap as Record<string, unknown>)) {
      const mapKey = key.trim()
      if (!mapKey.includes('/')) throw new Error(`modelMap 键 ${mapKey} 必须是 "提供商ID/模型ID"`)
      const sourceProvider = mapKey.slice(0, mapKey.indexOf('/'))
      if (sourceProvider !== 'user' && sourceProvider !== '*' && !ids.has(sourceProvider)) {
        throw new Error(`modelMap.${mapKey} 的源提供商 ${sourceProvider} 未在 providers 中定义`)
      }
      if (typeof value === 'string') {
        const model = value.trim()
        if (model) modelMap[mapKey] = model
        continue
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`modelMap.${mapKey} 必须是模型名或 { 提供商ID: 模型名 } 对象`)
      const targets: Record<string, string> = {}
      for (const [providerId, model] of Object.entries(value as Record<string, unknown>)) {
        const modelId = text(model)
        const targetProvider = providerId.trim()
        if (!targetProvider || !modelId) continue
        if (targetProvider !== '*' && !ids.has(targetProvider)) {
          throw new Error(`modelMap.${mapKey} 的目标提供商 ${targetProvider} 未在 providers 中定义`)
        }
        targets[targetProvider] = modelId
      }
      if (Object.keys(targets).length) modelMap[mapKey] = targets
    }
  }
  return {
    providers,
    modelMap,
    probeIntervalMs: integer(input.probeIntervalMs, DEFAULT_PROBE_INTERVAL_MS, 30_000, MAX_PROBE_INTERVAL_MS),
    maxProviderFailures: integer(input.maxProviderFailures, DEFAULT_MAX_PROVIDER_FAILURES, 1, 20),
    cooldowns: parseCooldowns(input.cooldowns),
  }
}

/** Wrap legacy single-provider environment defaults so old deployments keep working. */
export function providersFromDefaults(defaults: AiDefaultConfig, keys?: string[]): AiProvidersConfig {
  const apiKeys = (keys?.length ? keys : [defaults.apiKey]).map(value => value.trim()).filter(Boolean)
  const unique = [...new Set(apiKeys)]
  const provider: AiProviderConfig = {
    id: 'legacy',
    label: defaults.label || '系统默认模型',
    baseUrl: normalizeBaseUrlForConfig(defaults.baseUrl, 'AI_DEFAULT_BASE_URL'),
    models: [defaults.model],
    defaultModel: defaults.model,
    keys: unique.map((apiKey, index) => ({
      id: `key-${index + 1}`,
      label: unique.length > 1 ? `Key ${index + 1}` : '默认 Key',
      apiKey,
    })),
  }
  return {
    providers: [provider],
    modelMap: {},
    probeIntervalMs: DEFAULT_PROBE_INTERVAL_MS,
    maxProviderFailures: DEFAULT_MAX_PROVIDER_FAILURES,
    cooldowns: { ...DEFAULT_PROVIDER_COOLDOWNS },
  }
}

function readProvidersFile(file: string): { raw: unknown; warning: string | null } | null {
  if (!existsSync(file)) return null
  let warning: string | null = null
  try {
    const mode = statSync(file).mode
    if ((mode & 0o077) !== 0) {
      warning = `大模型提供商配置文件权限过宽（${(mode & 0o777).toString(8)}），已尝试收紧为 600`
      try { chmodSync(file, 0o600) } catch { /* best effort */ }
    }
  } catch { /* stat/chmod unavailable on some platforms */ }
  let content: string
  try { content = readFileSync(file, 'utf8') } catch (error) {
    throw new Error(`无法读取大模型提供商配置文件 ${file}：${error instanceof Error ? error.message : '未知错误'}`)
  }
  let raw: unknown
  try { raw = JSON.parse(content) } catch {
    throw new Error(`大模型提供商配置文件 ${file} 不是合法 JSON`)
  }
  return { raw, warning }
}

/**
 * Resolve the provider pool. Precedence: explicit override (tests/desktop),
 * `AI_PROVIDERS_JSON`, then `AI_PROVIDERS_FILE` / `DATA_DIR/ai-providers.json`,
 * then legacy single-provider environment variables.
 */
export function loadAiProviders(
  dataDir: string,
  options: {
    override?: AiProvidersConfig | null
    defaults?: AiDefaultConfig | null
    legacyKeys?: string[]
    env?: NodeJS.ProcessEnv
  } = {},
): LoadedAiProviders {
  const env = options.env ?? process.env
  if (options.override !== undefined) {
    return { config: options.override, source: options.override ? 'override' : 'none', warning: null }
  }
  const json = typeof env.AI_PROVIDERS_JSON === 'string' ? env.AI_PROVIDERS_JSON.trim() : ''
  if (json) {
    let raw: unknown
    try { raw = JSON.parse(json) } catch { throw new Error('AI_PROVIDERS_JSON 不是合法 JSON') }
    try {
      return { config: parseAiProvidersConfig(raw), source: 'env', warning: null }
    } catch (error) {
      throw new Error(`AI_PROVIDERS_JSON 配置无效：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }
  const file = (typeof env.AI_PROVIDERS_FILE === 'string' && env.AI_PROVIDERS_FILE.trim())
    || path.join(dataDir, 'ai-providers.json')
  const fromFile = readProvidersFile(file)
  if (fromFile) {
    try {
      return { config: parseAiProvidersConfig(fromFile.raw), source: 'file', warning: fromFile.warning }
    } catch (error) {
      throw new Error(`大模型提供商配置文件 ${file} 配置无效：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }
  if (options.defaults) {
    return {
      config: providersFromDefaults(options.defaults, options.legacyKeys),
      source: 'legacy',
      warning: null,
    }
  }
  return { config: null, source: 'none', warning: null }
}

/** Mask a key for logs and UI. Never reveal more than a short prefix/suffix. */
export function maskApiKey(apiKey: string): string {
  const value = apiKey.trim()
  if (value.length <= 8) return '••••••'
  const prefixLength = value.length > 24 ? 7 : 4
  const suffixLength = value.length > 16 ? 4 : 2
  return `${value.slice(0, prefixLength)}…${value.slice(-suffixLength)}`
}
