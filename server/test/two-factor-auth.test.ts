import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config'
import { createRequireAuth, hashPassword } from '../src/auth'
import { openDatabase } from '../src/db'
import { errorHandler } from '../src/errors'
import { createAuthRouter } from '../src/routes/auth'
import { generateTotpCode } from '../src/totp'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function start() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-2fa-'))
  directories.push(directory)
  const database = openDatabase(path.join(directory, 'test.sqlite'))
  const config = {
    jwtSecret: 'two-factor-secret',
    desktopMode: true,
    dataDir: directory,
    allowPrivateNetwork: true,
  } as AppConfig
  const requireAuth = createRequireAuth(database, config.jwtSecret)
  const app = express()
  app.use(express.json())
  app.use('/auth', createAuthRouter(database, config, requireAuth))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  async function request(route: string, body?: unknown, token?: string) {
    const response = await fetch(`http://127.0.0.1:${address.port}/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, data: await response.json() as Record<string, any> }
  }
  const passwordHash = await hashPassword('TwoFactor!2026')
  const user = database.createUser({ username: 'twofactor', email: 'twofactor@example.com', passwordHash, displayName: 'TwoFactor' })
  return { request, database, user, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

describe('TOTP login', () => {
  it('requires a second step, accepts TOTP and consumes recovery codes', { timeout: 20_000 }, async () => {
    const app = await start()
    try {
      const login = await app.request('auth/login', { account: 'twofactor', password: 'TwoFactor!2026' })
      expect(login.status).toBe(200)
      const token = login.data.token as string

      const initial = await app.request('auth/2fa', undefined, token)
      expect(initial.data.twoFactor).toMatchObject({ enabled: false })

      const setup = await app.request('auth/2fa/setup', {}, token)
      expect(setup.data.setup.secret).toMatch(/^[A-Z2-7]+$/)
      const secret = setup.data.setup.secret as string
      const enable = await app.request('auth/2fa/enable', { code: generateTotpCode(secret) }, token)
      expect(enable.status).toBe(200)
      expect(enable.data.recoveryCodes).toHaveLength(10)
      const recovery = enable.data.recoveryCodes[0] as string

      const secondLogin = await app.request('auth/login', { account: 'twofactor', password: 'TwoFactor!2026' })
      expect(secondLogin.data.twoFactorRequired).toBe(true)
      const challenge = secondLogin.data.challenge as string

      const wrong = await app.request('auth/2fa/verify', { challenge, code: '000000' })
      expect(wrong.status).toBe(401)

      const verified = await app.request('auth/2fa/verify', { challenge, code: generateTotpCode(secret) })
      expect(verified.status).toBe(200)
      expect(verified.data.token).toBeTruthy()

      const recoveryLogin = await app.request('auth/login', { account: 'twofactor', password: 'TwoFactor!2026' })
      const recoveryChallenge = recoveryLogin.data.challenge as string
      const recovered = await app.request('auth/2fa/verify', { challenge: recoveryChallenge, code: recovery })
      expect(recovered.status).toBe(200)

      const reused = await app.request('auth/login', { account: 'twofactor', password: 'TwoFactor!2026' })
      const reusedChallenge = reused.data.challenge as string
      const reusedResult = await app.request('auth/2fa/verify', { challenge: reusedChallenge, code: recovery })
      expect(reusedResult.status).toBe(401)
    } finally {
      await app.close()
      app.database.close()
    }
  })

  it('throttles repeated password failures for one account', { timeout: 20_000 }, async () => {
    const app = await start()
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const result = await app.request('auth/login', { account: 'twofactor', password: 'wrong-password' })
        expect(result.status).toBe(401)
      }
      const blocked = await app.request('auth/login', { account: 'twofactor', password: 'TwoFactor!2026' })
      expect(blocked.status).toBe(429)
    } finally {
      await app.close()
      app.database.close()
    }
  })
})
