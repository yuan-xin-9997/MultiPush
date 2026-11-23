import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Minimal RFC 6238 TOTP implementation (SHA-1, 6 digits, 30 s) used for
 * optional two-factor authentication. No external dependency is needed.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOTP_PERIOD_SECONDS = 30
const TOTP_DIGITS = 6

export function encodeBase32(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export function decodeBase32(input: string): Buffer {
  const normalized = input.replace(/[=\s-]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const output: number[] = []
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index < 0) throw new Error('无效的 TOTP 密钥')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(output)
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20))
}

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmacSha1(secret, buffer)
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

function createHmacSha1(secret: Buffer, buffer: Buffer): Buffer {
  return createHmac('sha1', secret).update(buffer).digest()
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Verify a 6-digit code, accepting one period of clock skew in each direction. */
/** Current code for a secret; used by tests and manual diagnostics. */
export function generateTotpCode(secret: string, now = Date.now()): string {
  return hotp(decodeBase32(secret), Math.floor(now / 1000 / TOTP_PERIOD_SECONDS))
}

export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const normalized = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(normalized)) return false
  let key: Buffer
  try {
    key = decodeBase32(secret)
  } catch {
    return false
  }
  if (!key.length) return false
  const counter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS)
  for (let offset = -1; offset <= 1; offset += 1) {
    if (safeEqual(hotp(key, counter + offset), normalized)) return true
  }
  return false
}

export function totpUri(secret: string, account: string, issuer = 'MultiPush'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/** Human-friendly recovery code, e.g. `K7QF-3M9A`. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(8)
  let raw = ''
  for (const byte of bytes) raw += BASE32_ALPHABET[byte % 32]
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase()
}

/** Recovery codes are stored as keyed HMAC-SHA256 hashes, never in clear text. */
export function hashRecoveryCode(code: string, key: Buffer | string = ''): string {
  return createHmac('sha256', key).update(normalizeRecoveryCode(code)).digest('hex')
}

export function recoveryCodeMatches(hash: string, code: string, key: Buffer | string = ''): boolean {
  const candidate = Buffer.from(hashRecoveryCode(code, key), 'hex')
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export const TOTP_PERIOD_MS = TOTP_PERIOD_SECONDS * 1000
