import type { PlatformId } from '../../shared/types'
import type { Database, PlatformActionTrigger } from './db'
import { ApiError } from './errors'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export interface PlatformPolicy {
  /** Minimum gap between two publish submissions, drafts included. */
  minPublishIntervalMs: number
  /** Maximum submissions in any rolling 24-hour window. */
  dailyPublishLimit: number
  /** Minimum gap between two QR/login attempts. */
  loginCooldownMs: number
  /** Minimum gap between two explicit live account checks. */
  sessionCheckCooldownMs: number
}

const DEFAULT_POLICIES: Record<PlatformId, PlatformPolicy> = {
  wechat: { minPublishIntervalMs: 10 * MINUTE, dailyPublishLimit: 3, loginCooldownMs: 5 * MINUTE, sessionCheckCooldownMs: MINUTE },
  wechatpic: { minPublishIntervalMs: 5 * MINUTE, dailyPublishLimit: 10, loginCooldownMs: 5 * MINUTE, sessionCheckCooldownMs: MINUTE },
  zhihu: { minPublishIntervalMs: 10 * MINUTE, dailyPublishLimit: 8, loginCooldownMs: 2 * MINUTE, sessionCheckCooldownMs: MINUTE },
  weibo: { minPublishIntervalMs: 10 * MINUTE, dailyPublishLimit: 8, loginCooldownMs: 2 * MINUTE, sessionCheckCooldownMs: MINUTE },
  toutiao: { minPublishIntervalMs: 10 * MINUTE, dailyPublishLimit: 8, loginCooldownMs: 2 * MINUTE, sessionCheckCooldownMs: MINUTE },
  baijiahao: { minPublishIntervalMs: 10 * MINUTE, dailyPublishLimit: 8, loginCooldownMs: 2 * MINUTE, sessionCheckCooldownMs: MINUTE },
  douban: { minPublishIntervalMs: 30 * MINUTE, dailyPublishLimit: 3, loginCooldownMs: 5 * MINUTE, sessionCheckCooldownMs: MINUTE },
  juejin: { minPublishIntervalMs: 10 * MINUTE, dailyPublishLimit: 8, loginCooldownMs: 2 * MINUTE, sessionCheckCooldownMs: MINUTE },
  csdn: { minPublishIntervalMs: 10 * MINUTE, dailyPublishLimit: 8, loginCooldownMs: 2 * MINUTE, sessionCheckCooldownMs: MINUTE },
  jianshu: { minPublishIntervalMs: 10 * MINUTE, dailyPublishLimit: 8, loginCooldownMs: 2 * MINUTE, sessionCheckCooldownMs: MINUTE },
  v2ex: { minPublishIntervalMs: 30 * MINUTE, dailyPublishLimit: 3, loginCooldownMs: 5 * MINUTE, sessionCheckCooldownMs: MINUTE },
  bilibili: { minPublishIntervalMs: 30 * MINUTE, dailyPublishLimit: 3, loginCooldownMs: 2 * MINUTE, sessionCheckCooldownMs: MINUTE },
  douyin: { minPublishIntervalMs: 30 * MINUTE, dailyPublishLimit: 3, loginCooldownMs: 2 * MINUTE, sessionCheckCooldownMs: MINUTE },
  sspai: { minPublishIntervalMs: 10 * MINUTE, dailyPublishLimit: 5, loginCooldownMs: 2 * MINUTE, sessionCheckCooldownMs: MINUTE },
  blog: { minPublishIntervalMs: MINUTE, dailyPublishLimit: 20, loginCooldownMs: 5 * MINUTE, sessionCheckCooldownMs: MINUTE },
  xiaohongshu: { minPublishIntervalMs: 0, dailyPublishLimit: 0, loginCooldownMs: 0, sessionCheckCooldownMs: 0 },
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export function platformPolicy(platform: PlatformId): PlatformPolicy {
  const base = DEFAULT_POLICIES[platform]
  // Unit tests create isolated databases and often publish several fixtures in a
  // row; keep production limits out of the way unless a test opts in via env.
  const defaults = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'
    ? { minPublishIntervalMs: 0, dailyPublishLimit: 0, loginCooldownMs: 0, sessionCheckCooldownMs: 0 }
    : base
  const prefix = `MULTIPUSH_${platform.toUpperCase()}_`
  // Keep the original SSPAI variables working for existing deployments.
  const legacy = platform === 'sspai' ? (name: string, fallback: number) => envNumber(`SSPAI_${name}`, fallback) : (_name: string, fallback: number) => fallback
  return {
    minPublishIntervalMs: envNumber(`${prefix}MIN_PUBLISH_INTERVAL_MS`, legacy('MIN_PUBLISH_INTERVAL_MS', defaults.minPublishIntervalMs)),
    dailyPublishLimit: Math.floor(envNumber(`${prefix}DAILY_PUBLISH_LIMIT`, legacy('DAILY_PUBLISH_LIMIT', defaults.dailyPublishLimit))),
    loginCooldownMs: envNumber(`${prefix}LOGIN_COOLDOWN_MS`, legacy('LOGIN_COOLDOWN_MS', defaults.loginCooldownMs)),
    sessionCheckCooldownMs: envNumber(`${prefix}SESSION_CHECK_COOLDOWN_MS`, legacy('SESSION_CHECK_COOLDOWN_MS', defaults.sessionCheckCooldownMs)),
  }
}

function timestamp(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Persisted per-platform action guard. It covers manual, batch and AI callers
 * because every publish/login entry point goes through the platform service.
 */
export class PlatformActionGuard {
  private readonly policy: PlatformPolicy

  constructor(private readonly database: Database, readonly platform: PlatformId, overrides: Partial<PlatformPolicy> = {}) {
    this.policy = { ...platformPolicy(platform), ...overrides }
  }

  assertPublish(userId: string, trigger: PlatformActionTrigger = 'manual'): void {
    const now = Date.now()
    const last = timestamp(this.database.lastPlatformAction(userId, this.platform, 'publish_started'))
    if (this.policy.minPublishIntervalMs > 0 && last !== null && now - last < this.policy.minPublishIntervalMs) {
      const waitSeconds = Math.max(1, Math.ceil((this.policy.minPublishIntervalMs - (now - last)) / 1000))
      const intervalMinutes = Math.max(1, Math.ceil(this.policy.minPublishIntervalMs / MINUTE))
      throw new ApiError(429, 'platform_publish_rate_limited', `平台发布过于频繁：两次提交至少间隔 ${intervalMinutes} 分钟，请在 ${waitSeconds} 秒后再试`, undefined, waitSeconds)
    }
    if (this.policy.dailyPublishLimit > 0) {
      const since = new Date(now - DAY).toISOString()
      const count = this.database.countPlatformActions(userId, this.platform, 'publish_started', since)
      if (count >= this.policy.dailyPublishLimit) {
        throw new ApiError(429, 'platform_publish_daily_limit', `平台 24 小时内最多提交 ${this.policy.dailyPublishLimit} 篇，请稍后再试`, undefined, Math.ceil(DAY / 1000))
      }
    }
    this.database.recordPlatformAction(userId, this.platform, 'publish_started', trigger)
  }

  assertLogin(userId: string, trigger: PlatformActionTrigger = 'manual'): void {
    const now = Date.now()
    const last = timestamp(this.database.lastPlatformAction(userId, this.platform, 'login_started'))
    if (this.policy.loginCooldownMs > 0 && last !== null && now - last < this.policy.loginCooldownMs) {
      const waitSeconds = Math.max(1, Math.ceil((this.policy.loginCooldownMs - (now - last)) / 1000))
      throw new ApiError(429, 'platform_login_rate_limited', `平台登录尝试过于频繁，请在 ${waitSeconds} 秒后再试`, undefined, waitSeconds)
    }
    this.database.recordPlatformAction(userId, this.platform, 'login_started', trigger)
  }

  /** Returns false when a live check was performed too recently; callers should return their cached view. */
  allowSessionCheck(userId: string, trigger: PlatformActionTrigger = 'manual'): boolean {
    const now = Date.now()
    const last = timestamp(this.database.lastPlatformAction(userId, this.platform, 'session_checked'))
    if (this.policy.sessionCheckCooldownMs > 0 && last !== null && now - last < this.policy.sessionCheckCooldownMs) return false
    this.database.recordPlatformAction(userId, this.platform, 'session_checked', trigger)
    return true
  }

  finishPublish(userId: string, result: string, trigger: PlatformActionTrigger = 'manual'): void {
    this.database.recordPlatformAction(userId, this.platform, 'publish_finished', trigger, result.slice(0, 200))
  }
}

export { DEFAULT_POLICIES }
