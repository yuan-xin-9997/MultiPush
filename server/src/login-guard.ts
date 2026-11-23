/**
 * In-memory login / second-factor throttling.
 *
 * The service is a single Node process, so a local sliding window is enough.
 * Keys are bucketed per account and per client IP: an attacker cannot lock the
 * owner out from a different IP, and one IP cannot spray many accounts.
 */
interface Bucket {
  failures: number
  windowStart: number
  blockedUntil: number
}

export interface LimitDecision {
  allowed: boolean
  retryAfterSeconds: number
}

export interface LimiterOptions {
  maxFailures: number
  windowMs: number
  blockMs: number
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const MINUTE = 60_000

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(private readonly options: LimiterOptions) {}

  check(key: string, now = Date.now()): LimitDecision {
    const bucket = this.buckets.get(key)
    if (!bucket) return { allowed: true, retryAfterSeconds: 0 }
    if (bucket.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000)) }
    }
    if (now - bucket.windowStart >= this.options.windowMs) {
      this.buckets.delete(key)
      return { allowed: true, retryAfterSeconds: 0 }
    }
    if (bucket.failures >= this.options.maxFailures) {
      bucket.blockedUntil = now + this.options.blockMs
      return { allowed: false, retryAfterSeconds: Math.ceil(this.options.blockMs / 1000) }
    }
    return { allowed: true, retryAfterSeconds: 0 }
  }

  fail(key: string, now = Date.now()): void {
    this.prune(now)
    const bucket = this.buckets.get(key)
    if (!bucket || now - bucket.windowStart >= this.options.windowMs) {
      this.buckets.set(key, { failures: 1, windowStart: now, blockedUntil: 0 })
      return
    }
    bucket.failures += 1
    if (bucket.failures >= this.options.maxFailures) bucket.blockedUntil = now + this.options.blockMs
  }

  reset(key: string): void {
    this.buckets.delete(key)
  }

  private prune(now: number): void {
    if (this.buckets.size < 500) return
    for (const [key, bucket] of this.buckets) {
      if (bucket.blockedUntil <= now && now - bucket.windowStart >= this.options.windowMs) this.buckets.delete(key)
    }
  }
}

export const ACCOUNT_LIMITER = new LoginRateLimiter({
  maxFailures: envInt('LOGIN_MAX_FAILURES', 8),
  windowMs: 15 * MINUTE,
  blockMs: envInt('LOGIN_BLOCK_MINUTES', 15) * MINUTE,
})

export const IP_LIMITER = new LoginRateLimiter({
  maxFailures: envInt('LOGIN_IP_MAX_FAILURES', 30),
  windowMs: 15 * MINUTE,
  blockMs: envInt('LOGIN_BLOCK_MINUTES', 15) * MINUTE,
})

export const TWO_FACTOR_LIMITER = new LoginRateLimiter({
  maxFailures: envInt('LOGIN_2FA_MAX_FAILURES', 8),
  windowMs: 10 * MINUTE,
  blockMs: 10 * MINUTE,
})

export function accountKey(account: string): string {
  return `account:${account.trim().toLowerCase()}`
}

export function ipKey(ip: string | undefined): string {
  return `ip:${ip || 'unknown'}`
}
