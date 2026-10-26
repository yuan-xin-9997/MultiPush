import { describe, expect, it } from 'vitest'
import { registerSchema, changePasswordSchema, loginSchema } from '../src/validation'
import { getMediaDescriptor } from '../src/upload'

describe('security input validation', () => {
  it('limits new passwords by UTF-8 bytes for registration and password changes', () => {
    for (const password of ['a'.repeat(72), '汉'.repeat(24)]) {
      expect(registerSchema.safeParse({ code: '123456', username: 'audit', email: 'audit@example.com', password }).success).toBe(true)
      expect(changePasswordSchema.safeParse({ currentPassword: 'old-password', newPassword: password }).success).toBe(true)
    }
    for (const password of ['a'.repeat(73), '汉'.repeat(25)]) {
      expect(registerSchema.safeParse({ code: '123456', username: 'audit', email: 'audit@example.com', password }).success).toBe(false)
      expect(changePasswordSchema.safeParse({ currentPassword: 'old-password', newPassword: password }).success).toBe(false)
    }
    // Existing long-password accounts must still be able to sign in and change passwords.
    expect(loginSchema.safeParse({ account: 'audit', password: 'a'.repeat(100) }).success).toBe(true)
  })

  it('rejects SVG uploads including uppercase extensions while allowing raster images', () => {
    expect(getMediaDescriptor('payload.svg')).toBeNull()
    expect(getMediaDescriptor('payload.SVG')).toBeNull()
    expect(getMediaDescriptor('photo.png')?.kind).toBe('image')
  })
})
