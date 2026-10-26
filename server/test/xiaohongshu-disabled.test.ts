import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { openDatabase } from '../src/db'
import { loadConfig } from '../src/config'
import { signToken } from '../src/auth'
import type { XhsDriver } from '../src/xiaohongshu-browser'

it('disables all Xiaohongshu automation, clears saved sessions, and retains owner-isolated history without browser access', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-xhs-disabled-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' }), database = openDatabase(':memory:')
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  database.saveXhsAccount(alice.id, { encryptedSession: 'saved-secret', accountId: 'account', name: '作者', status: 'connected', checkedAt: new Date().toISOString() })
  const record = database.createXhsPublication(alice.id, { renderId: 'render', title: '历史笔记', mode: 'publish', idempotencyKey: 'existing' })
  const driver = { beginLogin: vi.fn(), checkSession: vi.fn(), checkPublication: vi.fn(), publish: vi.fn(), close: vi.fn() } as unknown as XhsDriver
  const app = createApp(config, database, undefined, undefined, driver)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/xiaohongshu`
  const headers = { Authorization: `Bearer ${signToken(alice, config.jwtSecret)}`, 'Content-Type': 'application/json' }
  try {
    expect(database.getXhsAccount(alice.id)).toBeNull()
    expect((await fetch(`${base}/account`)).status).toBe(401)
    const account = await fetch(`${base}/account`, { headers })
    expect(await account.json()).toMatchObject({ disabled: true, account: { status: 'disconnected' } })
    expect(account.headers.get('cache-control')).toBe('no-store')
    for (const [method, url, body] of [['POST', '/login', {}], ['GET', '/login/old-login', undefined], ['POST', '/publications', { renderId: 'old-render', mode: 'publish' }], ['POST', `/publications/${record.id}/resolve`, { action: 'check' }]] as const) {
      const result = await fetch(base + url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
      expect(result.status).toBe(410)
      expect(await result.json()).toMatchObject({ error: 'xiaohongshu_automation_disabled' })
    }
    expect(await (await fetch(`${base}/publications`, { headers })).json()).toMatchObject({ publications: [{ id: record.id }] })
    expect((await fetch(`${base}/publications/${record.id}`, { headers: { Authorization: `Bearer ${signToken(bob, config.jwtSecret)}` } })).status).toBe(404)
    for (const method of Object.values(driver)) expect(method).not.toHaveBeenCalled()
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await app.locals.wechat.close(); await app.locals.zhihu.close(); await app.locals.douyin.close()
    database.close(); rmSync(directory, { recursive: true, force: true })
  }
})
