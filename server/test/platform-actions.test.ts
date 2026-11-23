import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../src/db'
import { ApiError } from '../src/errors'
import { PlatformActionGuard } from '../src/platform-actions'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-platform-actions-'))
  const database = openDatabase(path.join(directory, 'test.sqlite'))
  const user = database.createUser({ username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const other = database.createUser({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: 'hash' })
  cleanups.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { database, user, other }
}

describe('PlatformActionGuard', () => {
  it('persists the publish interval and rejects a too-early second submission', () => {
    const { database, user } = setup()
    const guard = new PlatformActionGuard(database, 'zhihu', { minPublishIntervalMs: 10 * 60_000, dailyPublishLimit: 100, loginCooldownMs: 0, sessionCheckCooldownMs: 0 })
    guard.assertPublish(user.id)
    expect(() => guard.assertPublish(user.id)).toThrowError(/两次提交至少间隔 10 分钟/)
    try { guard.assertPublish(user.id) } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ status: 429, code: 'platform_publish_rate_limited' })
      expect((error as ApiError).retryAfterSeconds).toBeGreaterThan(0)
    }
    // A new service instance still sees the persisted action.
    const restarted = new PlatformActionGuard(database, 'zhihu', { minPublishIntervalMs: 10 * 60_000, dailyPublishLimit: 100, loginCooldownMs: 0, sessionCheckCooldownMs: 0 })
    expect(() => restarted.assertPublish(user.id)).toThrowError(/两次提交至少间隔/)
  })

  it('enforces the rolling 24-hour publish cap and isolates users', () => {
    const { database, user, other } = setup()
    const guard = new PlatformActionGuard(database, 'sspai', { minPublishIntervalMs: 0, dailyPublishLimit: 2, loginCooldownMs: 0, sessionCheckCooldownMs: 0 })
    guard.assertPublish(user.id)
    guard.assertPublish(user.id)
    expect(() => guard.assertPublish(user.id)).toThrowError(/24 小时内最多提交 2 篇/)
    expect(() => guard.assertPublish(other.id)).not.toThrow()
  })

  it('cools down login attempts and explicit session checks', () => {
    const { database, user } = setup()
    const guard = new PlatformActionGuard(database, 'weibo', { minPublishIntervalMs: 0, dailyPublishLimit: 100, loginCooldownMs: 2 * 60_000, sessionCheckCooldownMs: 60_000 })
    expect(guard.allowSessionCheck(user.id)).toBe(true)
    expect(guard.allowSessionCheck(user.id)).toBe(false)
    guard.assertLogin(user.id)
    expect(() => guard.assertLogin(user.id)).toThrowError(/登录尝试过于频繁/)
    try { guard.assertLogin(user.id) } catch (error) {
      expect(error).toMatchObject({ status: 429, code: 'platform_login_rate_limited' })
    }
  })
})
