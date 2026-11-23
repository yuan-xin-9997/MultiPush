import { createHash } from 'node:crypto'
import type { BrowserContext } from 'playwright-core'
import type { PublisherStorageState } from './publisher-session'

interface Entry {
  context: BrowserContext
  refs: number
  lastUsed: number
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Keeps a small number of browser contexts alive per platform driver so two
 * consecutive operations with the same saved session reuse the same browser
 * identity instead of creating a fresh "device" every time.
 *
 * Contexts are keyed by a hash of the encrypted storage state, so users and
 * accounts never share a context. Idle contexts are closed after the TTL and
 * the cache is capped.
 */
export class PublisherContextCache {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly ttlMs = 45 * 60_000, private readonly maxEntries = 8) {}

  key(state: unknown): string {
    return createHash('sha256').update(JSON.stringify(state)).digest('hex')
  }

  get(key: string): BrowserContext | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    entry.refs += 1
    entry.lastUsed = Date.now()
    return entry.context
  }

  set(key: string, context: BrowserContext): void {
    const existing = this.entries.get(key)
    if (existing && existing.context !== context) {
      if (existing.timer) { clearTimeout(existing.timer); existing.timer = null }
      this.entries.delete(key)
      void existing.context.close().catch(() => {})
    }
    this.entries.set(key, { context, refs: 1, lastUsed: Date.now(), timer: null })
    this.enforceLimit()
  }

  /** Release a lease. Cached contexts stay open until their idle TTL. */
  async release(context: BrowserContext): Promise<void> {
    const entry = [...this.entries.values()].find(item => item.context === context)
    if (!entry) { await context.close().catch(() => {}); return }
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs > 0 || entry.timer) return
    // Pages must not accumulate while the context is parked. Some tests and
    // lightweight drivers provide a minimal BrowserContext stub.
    const pages = typeof context.pages === 'function' ? context.pages() : []
    for (const page of pages) await page.close().catch(() => {})
    entry.lastUsed = Date.now()
    entry.timer = setTimeout(() => { void this.evictByEntry(entry) }, this.ttlMs)
    entry.timer.unref()
    this.enforceLimit()
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(entries.map(async entry => {
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
      await entry.context.close().catch(() => {})
    }))
  }

  private enforceLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const idle = [...this.entries.entries()].filter(([, entry]) => entry.refs === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
      if (!idle) return
      void this.evict(idle[0])
    }
  }

  private async evict(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (entry) await this.evictByEntry(entry)
  }

  private async evictByEntry(entry: Entry): Promise<void> {
    const key = [...this.entries.entries()].find(([, candidate]) => candidate === entry)?.[0]
    if (!key) return
    this.entries.delete(key)
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    await entry.context.close().catch(() => {})
  }
}
