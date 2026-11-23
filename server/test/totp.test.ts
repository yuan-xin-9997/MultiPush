import { describe, expect, it } from 'vitest'
import {
  decodeBase32,
  encodeBase32,
  generateRecoveryCode,
  hashRecoveryCode,
  recoveryCodeMatches,
  totpUri,
  verifyTotp,
} from '../src/totp'

describe('TOTP', () => {
  it('encodes and decodes base32', () => {
    const buffer = Buffer.from('12345678901234567890')
    const encoded = encodeBase32(buffer)
    expect(encoded).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(decodeBase32(encoded).equals(buffer)).toBe(true)
  })

  it('matches the RFC 6238 SHA-1 vector', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true)
    expect(verifyTotp(secret, '287083', 59_000)).toBe(false)
  })

  it('builds an otpauth URI and verifies recovery codes', () => {
    expect(totpUri('ABC234', 'alice')).toContain('otpauth://totp/MultiPush%3Aalice')
    const code = generateRecoveryCode()
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/)
    const hash = hashRecoveryCode(code, 'test-key')
    expect(recoveryCodeMatches(hash, code.toLowerCase(), 'test-key')).toBe(true)
    expect(recoveryCodeMatches(hash, 'AAAA-BBBB', 'test-key')).toBe(false)
    expect(recoveryCodeMatches(hash, code, 'other-key')).toBe(false)
  })
})
