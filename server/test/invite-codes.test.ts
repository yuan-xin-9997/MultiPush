import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config'
import { createRequireAuth, hashPassword } from '../src/auth'
import { openDatabase, type Database } from '../src/db'
import { errorHandler } from '../src/errors'
import { createAdminRouter } from '../src/routes/admin'
import { createAuthRouter } from '../src/routes/auth'

const directories: string[] = []
function databaseAt(): { database: Database; directory: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-invite-'))
  directories.push(directory)
  return { database: openDatabase(path.join(directory, 'test.sqlite')), directory }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function start(database: Database) {
  const config = {
    jwtSecret: 'invite-secret',
    desktopMode: true,
    inviteCodeRequired: true,
  } as AppConfig
  const requireAuth = createRequireAuth(database, config.jwtSecret)
  const app = express()
  app.use(express.json())
  app.use('/auth', createAuthRouter(database, config, requireAuth))
  app.use('/admin', createAdminRouter(database, requireAuth))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  async function request(route: string, body?: unknown, token?: string) {
    const response = await fetch(`http://127.0.0.1:${address.port}/${route}`, {
      method: body === undefined ? 'GET' : route.includes('/invite-codes/') ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, data: await response.json() }
  }
  return { request, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

describe('invite-code registration', () => {
  it('promotes yuanxin, requires invites in production mode and enforces uses/expiry/active', async () => {
    const { database, directory } = databaseAt()
    const passwordHash = await hashPassword('AdminPassword!1')
    database.createUser({ username: 'yuanxin', email: 'yuanxin@example.com', passwordHash, displayName: 'Yuanxin' })
    database.close()
    const reopened = openDatabase(path.join(directory, 'test.sqlite'))
    try {
      const admin = reopened.findUserByAccount('yuanxin')!
      expect(admin.isAdmin).toBe(true)
      const app = await start(reopened)
      try {
        const login = await app.request('auth/login', { account: 'yuanxin', password: 'AdminPassword!1' })
        expect(login.data.user.isAdmin).toBe(true)
        const adminToken = login.data.token as string
        expect((await app.request('auth/registration-config')).data.inviteRequired).toBe(true)

        const base = { username: 'invited_one', email: 'invited_one@example.com', password: 'Invited!123' }
        const missing = await app.request('auth/register', base)
        expect(missing.data.error, JSON.stringify(missing.data)).toBe('invite_code_required')

        const created = await app.request('admin/invite-codes', { maxUses: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }, adminToken)
        expect(created.status).toBe(201)
        const code = created.data.invite.code as string
        expect((await app.request('auth/register', { ...base, inviteCode: code })).status).toBe(200)
        expect((await app.request('auth/register', { ...base, username: 'invited_two', email: 'invited_two@example.com', inviteCode: code })).data.error).toBe('invite_code_exhausted')

        const expired = await app.request('admin/invite-codes', { maxUses: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() }, adminToken)
        expect((await app.request('auth/register', { ...base, username: 'expired_one', email: 'expired_one@example.com', inviteCode: expired.data.invite.code })).data.error).toBe('invite_code_expired')

        const disabled = await app.request('admin/invite-codes', { maxUses: 1 }, adminToken)
        await app.request(`admin/invite-codes/${disabled.data.invite.id}`, { active: false }, adminToken)
        expect((await app.request('auth/register', { ...base, username: 'disabled_one', email: 'disabled_one@example.com', inviteCode: disabled.data.invite.code })).data.error).toBe('invite_code_inactive')

        expect((await app.request('admin/invite-codes', undefined, login.data.token)).status).toBe(200)
        const normal = await app.request('auth/register', { ...base, username: 'normal_one', email: 'normal_one@example.com', inviteCode: created.data.invite.code })
        expect(normal.status).toBe(400) // code already exhausted
        const normalLogin = await app.request('auth/login', { account: 'invited_one', password: 'Invited!123' })
        expect((await app.request('admin/invite-codes', undefined, normalLogin.data.token)).status).toBe(403)
      } finally {
        await app.close()
      }
    } finally {
      reopened.close()
    }
  })
})
