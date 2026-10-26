import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { once } from 'node:events'
import { openDatabase } from '../src/db'
import { createAuthRouter } from '../src/routes/auth'
import { createRequireAuth, hashPassword, signToken } from '../src/auth'
import { errorHandler } from '../src/errors'
import type { AppConfig } from '../src/config'
import { EmailVerification } from '../src/email'
import { createHmac } from 'node:crypto'

const sendMail = vi.hoisted(() => vi.fn(async (_mail: { text: string }) => ({})))
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail, close() {} }) } }))
afterEach(() => { vi.unstubAllEnvs(); sendMail.mockClear() })

describe('email verification authentication', () => {
  it('fails closed without SMTP and allows retry after delivery failure', async () => {
    const db = openDatabase(':memory:')
    const verification = new EmailVerification(db, 'secret')
    try {
      vi.stubEnv('SMTP_HOST', '')
      await expect(verification.send('mail@example.com', 'register')).rejects.toMatchObject({ code: 'mail_unavailable' })
      vi.stubEnv('SMTP_HOST', 'smtp.example.com'); vi.stubEnv('SMTP_FROM', 'test@example.com')
      sendMail.mockRejectedValueOnce(new Error('unavailable'))
      await expect(verification.send('mail@example.com', 'register')).rejects.toMatchObject({ code: 'mail_failed' })
      await expect(verification.send('mail@example.com', 'register')).resolves.toBeUndefined()
    } finally { db.close() }
  })

  it('requires email proof, supports both login names, binds legacy accounts and resets passwords', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com'); vi.stubEnv('SMTP_FROM', 'test@example.com')
    const db = openDatabase(':memory:')
    const app = express(); app.use(express.json())
    app.use('/auth', createAuthRouter(db, { jwtSecret: 'secret' } as AppConfig, createRequireAuth(db, 'secret')))
    app.use(errorHandler)
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address() as { port: number }
    async function request(route: string, body?: unknown, token?: string) {
      const res = await fetch(`http://127.0.0.1:${address.port}/auth/${route}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
      return { status: res.status, data: await res.json() }
    }
    const code = () => sendMail.mock.calls.at(-1)![0].text.match(/\d{6}/)![0]
    try {
      const input = { username: 'alice', email: 'Alice@example.com', password: 'Password!123' }
      expect((await request('register', input)).status).toBe(400)
      expect((await request('email-code', { email: input.email, purpose: 'register' })).status).toBe(200)
      const registerCode = code()
      expect((await request('email-code', { email: input.email, purpose: 'register' })).status).toBe(429)
      expect((await request('register', { ...input, code: '000000' })).status).toBe(400)
      const registered = await request('register', { ...input, code: registerCode })
      expect(registered.status).toBe(200)
      for (const account of ['alice', 'ALICE@example.com']) expect((await request('login', { account, password: input.password })).status).toBe(200)
      const verification = new EmailVerification(db, 'secret')
      expect(() => verification.verify('alice@example.com', 'register', registerCode)).toThrow()
      expect((await request('email-code', { email: 'alice@example.com', purpose: 'reset' })).status).toBe(200)
      expect((await request('reset-password', { email: 'alice@example.com', code: code(), newPassword: 'NewPassword!123' })).status).toBe(200)
      expect((await request('me', undefined, registered.data.token)).status).toBe(401)
      expect((await request('login', { account: 'alice', password: input.password })).status).toBe(401)
      expect((await request('login', { account: 'alice', password: 'NewPassword!123' })).status).toBe(200)
      const legacy = db.createUser({ username: 'legacy', email: '', passwordHash: await hashPassword(input.password), displayName: 'Legacy' })
      const token = signToken(legacy, 'secret')
      expect((await request('email-code', { email: 'legacy@example.com', purpose: 'bind' })).status).toBe(401)
      expect((await request('email-code', { email: 'legacy@example.com', purpose: 'bind' }, token)).status).toBe(200)
      expect((await request('bind-email', { email: 'other@example.com', code: code() }, token)).status).toBe(400)
      expect((await request('bind-email', { email: 'legacy@example.com', code: code() }, token)).data.user.email).toBe('legacy@example.com')
      expect((await request('login', { account: 'legacy@example.com', password: input.password })).status).toBe(200)
      expect((await request('email-code', { email: 'unknown@example.com', purpose: 'reset' })).status).toBe(200)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close() }
  }, 15000)

  it('expires codes, limits guesses and separates purposes and users', () => {
    const db = openDatabase(':memory:')
    const verification = new EmailVerification(db, 'secret')
    const scope = 'bind:user:email@example.com'
    const digest = createHmac('sha256', 'secret').update(`${scope}:123456`).digest('hex')
    try {
      db.saveEmailCode(scope, digest, Date.now() - 600001)
      expect(() => verification.verify('email@example.com', 'bind', '123456', 'user')).toThrow()
      db.saveEmailCode(scope, digest, Date.now())
      expect(() => verification.verify('email@example.com', 'reset', '123456')).toThrow()
      expect(() => verification.verify('email@example.com', 'bind', '123456', 'another')).toThrow()
      for (let i = 0; i < 5; i++) expect(() => verification.verify('email@example.com', 'bind', '000000', 'user')).toThrow()
      expect(() => verification.verify('email@example.com', 'bind', '123456', 'user')).toThrow()
    } finally { db.close() }
  })
})
