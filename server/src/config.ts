import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import packageJson from '../package.json'

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
    version: typeof packageJson.version === 'string' ? packageJson.version : '1.0.0',
  }
}

export const DEFAULT_BOOK_COLOR = DEFAULT_COLOR
