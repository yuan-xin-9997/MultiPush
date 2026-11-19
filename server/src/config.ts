import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import packageJson from '../package.json'
import { loadAiProviders, type AiProvidersConfig, type AiProvidersSource } from './ai-provider-config'

export interface AiDefaultConfig {
  apiKey: string
  baseUrl: string
  model: string
  label: string
}

export interface AppConfig {
  host: string
  port: number
  nodeEnv: string
  isProduction: boolean
  dataDir: string
  uploadsDir: string
  dbPath: string
  webDist: string
  jwtSecret: string
  publicBaseUrl: string | null
  desktopMode: boolean
  aiDefaults: AiDefaultConfig | null
  /** Ordered provider pool with multiple keys per provider. */
  aiProviders: AiProvidersConfig | null
  aiProvidersSource: AiProvidersSource
  aiProvidersWarning: string | null
  version: string
}

export interface ConfigOverrides {
  host?: string
  port?: number
  nodeEnv?: string
  dataDir?: string
  webDist?: string
  jwtSecret?: string
  publicBaseUrl?: string | null
  desktopMode?: boolean
  aiDefaults?: AiDefaultConfig | null
  aiProviders?: AiProvidersConfig | null
}

const DEFAULT_PORT = 34080
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_COLOR = '#00b96b'

function trimmedEnv(name: string): string | null {
  const value = process.env[name]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** True when the current working directory looks like the `server` workspace. */
function runningFromServerWorkspace(cwd: string): boolean {
  if (path.basename(cwd).toLowerCase() !== 'server') return false
  try {
    const parentPackage = JSON.parse(readFileSync(path.resolve(cwd, '..', 'package.json'), 'utf8')) as {
      workspaces?: unknown
    }
    return Array.isArray(parentPackage.workspaces)
  } catch {
    return false
  }
}

function defaultDataDir(cwd: string): string {
  // `npm run dev -w server` starts the process in the workspace directory; the
  // product spec wants the development database in the repository root.
  if (runningFromServerWorkspace(cwd)) return path.resolve(cwd, '..', '.data')
  return path.resolve(cwd, '.data')
}

function resolveWebDist(cwd: string, override?: string): string {
  if (override) return path.resolve(cwd, override)
  const envValue = trimmedEnv('WEB_DIST')
  if (envValue) return path.resolve(cwd, envValue)

  const primary = path.resolve(cwd, 'web', 'dist')
  if (existsSync(path.join(primary, 'index.html'))) return primary

  if (runningFromServerWorkspace(cwd)) {
    const fromRoot = path.resolve(cwd, '..', 'web', 'dist')
    if (existsSync(path.join(fromRoot, 'index.html'))) return fromRoot
  }
  return primary
}

function readSecretFile(file: string): string | null {
  try {
    const value = readFileSync(file, 'utf8').trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * Load JWT_SECRET or create/persist `DATA_DIR/.jwt-secret` with owner-only
 * permissions. The file is shared by every process pointed at the same dir.
 */
export function getOrCreateJwtSecret(dataDir: string): string {
  const fromEnv = trimmedEnv('JWT_SECRET')
  if (fromEnv) return fromEnv

  mkdirSync(dataDir, { recursive: true })
  const secretFile = path.join(dataDir, '.jwt-secret')
  const existing = readSecretFile(secretFile)
  if (existing) return existing

  const generated = randomBytes(64).toString('hex')
  try {
    writeFileSync(secretFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    // Another process won the race: use the value it wrote.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = readSecretFile(secretFile)
      if (raced) return raced
      writeFileSync(secretFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600 })
    } else {
      throw error
    }
  }
  try {
    chmodSync(secretFile, 0o600)
  } catch {
    // chmod is a no-op on some filesystems (notably Windows); ignore.
  }
  return generated
}

function parsePort(value: string | null, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return fallback
  return parsed
}

function normalizeBaseUrl(value: string | null): string | null {
  if (!value) return null
  return value.replace(/\/+$/, '')
}

/** Parse `OPENCODE_GO_API_KEYS` (comma/whitespace separated), falling back to one key. */
function splitLegacyKeys(primary: string | null): string[] {
  const raw = trimmedEnv('OPENCODE_GO_API_KEYS')
  const values = raw ? raw.split(/[\s,;]+/) : []
  if (primary) values.unshift(primary)
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const cwd = process.cwd()
  const nodeEnv = overrides.nodeEnv ?? trimmedEnv('NODE_ENV') ?? 'development'
  const dataDir = path.resolve(cwd, overrides.dataDir ?? trimmedEnv('DATA_DIR') ?? defaultDataDir(cwd))
  const uploadsDir = path.join(dataDir, 'uploads')
  const dbPath = path.join(dataDir, 'multipush.sqlite')

  mkdirSync(dataDir, { recursive: true })
  mkdirSync(uploadsDir, { recursive: true })

  const explicitSecret = overrides.jwtSecret?.trim()
  const publicBaseUrl =
    overrides.publicBaseUrl === undefined ? normalizeBaseUrl(trimmedEnv('PUBLIC_BASE_URL')) : normalizeBaseUrl(overrides.publicBaseUrl)
  const desktopMode = overrides.desktopMode ?? (trimmedEnv('MULTIPUSH_DESKTOP') === '1')
  const openCodeKey = trimmedEnv('OPENCODE_GO_API_KEY')
  const openCodeKeysRaw = trimmedEnv('OPENCODE_GO_API_KEYS')
  const openCodeFirstKey = openCodeKey ?? (openCodeKeysRaw ? openCodeKeysRaw.split(/[\s,;]+/)[0] : null)
  const openCodePresent = Boolean(openCodeKey || openCodeKeysRaw)
  const defaultApiKey = trimmedEnv('AI_DEFAULT_API_KEY') ?? openCodeFirstKey
  const defaultBaseUrl = trimmedEnv('AI_DEFAULT_BASE_URL') ?? (openCodePresent ? 'https://opencode.ai/inference/go/openai/v1' : null)
  const defaultModel = trimmedEnv('AI_DEFAULT_MODEL') ?? (openCodePresent ? 'deepseek-v4.1-flash' : null)
  let aiDefaults = overrides.aiDefaults !== undefined
    ? overrides.aiDefaults
    : defaultApiKey && defaultBaseUrl && defaultModel
      ? {
          apiKey: defaultApiKey,
          baseUrl: defaultBaseUrl,
          model: defaultModel,
          label: trimmedEnv('AI_DEFAULT_LABEL') ?? (openCodePresent ? 'OpenCode Go' : '系统默认模型'),
        }
      : null

  const loadedProviders = loadAiProviders(dataDir, {
    ...(overrides.aiProviders !== undefined ? { override: overrides.aiProviders } : {}),
    defaults: aiDefaults,
    legacyKeys: splitLegacyKeys(defaultApiKey),
  })
  // Keep the legacy single-provider defaults consistent with a file/env pool so
  // that "save settings without an API key" can reuse a usable server key.
  if (!aiDefaults && loadedProviders.config) {
    const provider = loadedProviders.config.providers[0]
    const key = provider?.keys[0]
    if (provider && key) {
      aiDefaults = {
        apiKey: key.apiKey,
        baseUrl: key.baseUrl ?? provider.baseUrl,
        model: provider.defaultModel,
        label: provider.label,
      }
    }
  }

  return {
    host: overrides.host ?? trimmedEnv('HOST') ?? DEFAULT_HOST,
    port: overrides.port ?? parsePort(trimmedEnv('PORT'), DEFAULT_PORT),
    nodeEnv,
    isProduction: nodeEnv === 'production',
    dataDir,
    uploadsDir,
    dbPath,
    webDist: resolveWebDist(cwd, overrides.webDist),
    jwtSecret: explicitSecret && explicitSecret.length > 0 ? explicitSecret : getOrCreateJwtSecret(dataDir),
    publicBaseUrl,
    desktopMode,
    aiDefaults,
    aiProviders: loadedProviders.config,
    aiProvidersSource: loadedProviders.source,
    aiProvidersWarning: loadedProviders.warning,
    version: typeof packageJson.version === 'string' ? packageJson.version : '1.0.0',
  }
}

export const DEFAULT_BOOK_COLOR = DEFAULT_COLOR
