import { describe, expect, it } from 'vitest'
import express from 'express'
import { once } from 'node:events'
import { openDatabase } from '../src/db'
import { createAuthRouter } from '../src/routes/auth'
import { createRequireAuth } from '../src/auth'
import { errorHandler } from '../src/errors'
import type { AppConfig } from '../src/config'

describe('desktop authentication', () => {
  it('registers local accounts without an email verification code', async () => {
    const db = openDatabase(':memory:')
    const config = { jwtSecret: 'secret', desktopMode: true } as AppConfig
    const app = express()
    app.use(express.json())
    app.use('/auth', createAuthRouter(db, config, createRequireAuth(db, 'secret')))
    app.use(errorHandler)
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as { port: number }

    async function request(route: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${address.port}/auth/${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      return { status: response.status, data: await response.json() }
    }

    try {
      const input = { username: 'localuser', email: 'local@example.com', password: 'Password!123' }
      const registered = await request('register', input)
      expect(registered.status).toBe(200)
      expect(registered.data.user).toMatchObject({ username: 'localuser', email: 'local@example.com' })
      expect(registered.data.token).toEqual(expect.any(String))
      expect((await request('register', input)).status).toBe(409)
      expect((await request('login', { account: 'localuser', password: input.password })).status).toBe(200)
      expect((await request('email-code', { email: input.email, purpose: 'register' })).status).toBe(400)
      expect((await request('reset-password', { email: input.email, code: '123456', newPassword: 'Another!123' })).status).toBe(400)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
    }
  })
})
