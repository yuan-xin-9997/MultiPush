import { describe, expect, it } from 'vitest'
import { hashPassword, signToken, verifyPassword, verifyToken } from '../src/auth'

describe('password and token helpers', () => {
  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('MultiPush!2026')
    expect(hash).not.toBe('MultiPush!2026')
    expect(await verifyPassword('MultiPush!2026', hash)).toBe(true)
    expect(await verifyPassword('wrong-password', hash)).toBe(false)
    expect(await verifyPassword('anything', '')).toBe(false)
  })

  it('signs and verifies a token', () => {
    const token = signToken({ id: 'user-123', username: 'demo' }, 'test-secret')
    expect(verifyToken(token, 'test-secret')).toMatchObject({
      userId: 'user-123',
      username: 'demo',
    })
    expect(verifyToken(token, 'other-secret')).toBeNull()
    expect(verifyToken('not-a-jwt', 'test-secret')).toBeNull()
  })
})
