import { describe, expect, it } from 'vitest'
import { LoginRateLimiter } from '../src/login-guard'

describe('login rate limiter', () => {
  it('blocks after the configured failures and resets on success', () => {
    const limiter = new LoginRateLimiter({ maxFailures: 2, windowMs: 60_000, blockMs: 60_000 })
    expect(limiter.check('account:a', 0).allowed).toBe(true)
    limiter.fail('account:a', 0)
    expect(limiter.check('account:a', 1).allowed).toBe(true)
    limiter.fail('account:a', 1)
    const blocked = limiter.check('account:a', 2)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
    limiter.reset('account:a')
    expect(limiter.check('account:a', 2).allowed).toBe(true)
  })

  it('starts a new window after expiry', () => {
    const limiter = new LoginRateLimiter({ maxFailures: 1, windowMs: 1_000, blockMs: 1_000 })
    limiter.fail('ip:1', 0)
    expect(limiter.check('ip:1', 500).allowed).toBe(false)
    expect(limiter.check('ip:1', 2_000).allowed).toBe(true)
  })
})
