import { describe, expect, it, vi } from 'vitest'
import type { BrowserContext } from 'playwright-core'
import { PublisherContextCache } from '../src/publisher-context-cache'

function context(): BrowserContext & { close: ReturnType<typeof vi.fn> } {
  return { pages: () => [], close: vi.fn(async () => {}) } as unknown as BrowserContext & { close: ReturnType<typeof vi.fn> }
}

const state = { cookies: [{ name: 'sid', value: 'one', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] }

describe('PublisherContextCache', () => {
  it('reuses a context for the same state and closes it when the cache closes', async () => {
    const cache = new PublisherContextCache(60_000, 4)
    const first = context()
    const key = cache.key(state)
    cache.set(key, first)
    await cache.close()
    expect(first.close).toHaveBeenCalledTimes(1)
  })

  it('keeps different sessions isolated and releases without closing immediately', async () => {
    const cache = new PublisherContextCache(60_000, 4)
    const one = context()
    const two = context()
    const keyOne = cache.key(state)
    const keyTwo = cache.key({ ...state, cookies: [{ ...state.cookies[0], value: 'two' }] })
    expect(keyOne).not.toBe(keyTwo)
    cache.set(keyOne, one)
    cache.set(keyTwo, two)
    await cache.release(one)
    expect(one.close).not.toHaveBeenCalled()
    expect(cache.get(keyOne)).toBe(one)
    await cache.release(one)
    await cache.close()
    expect(one.close).toHaveBeenCalledTimes(1)
    expect(two.close).toHaveBeenCalledTimes(1)
  })

  it('closes uncached contexts on release', async () => {
    const cache = new PublisherContextCache()
    const contextValue = context()
    await cache.release(contextValue)
    expect(contextValue.close).toHaveBeenCalledTimes(1)
  })
})
