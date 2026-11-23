import http from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  NetworkGuardError,
  assertPublicHttpUrl,
  guardedRequest,
  isPublicAddress,
  validateHttpUrl,
} from '../src/network-guard'

describe('network guard', () => {
  it('classifies public and reserved addresses', () => {
    expect(isPublicAddress('127.0.0.1')).toBe(false)
    expect(isPublicAddress('10.0.0.1')).toBe(false)
    expect(isPublicAddress('192.168.1.2')).toBe(false)
    expect(isPublicAddress('169.254.169.254')).toBe(false)
    expect(isPublicAddress('::1')).toBe(false)
    expect(isPublicAddress('fc00::1')).toBe(false)
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('1.1.1.1')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
  })

  it('rejects non-http URLs and embedded credentials', () => {
    expect(() => validateHttpUrl('file:///etc/passwd')).toThrow(NetworkGuardError)
    expect(() => validateHttpUrl('http://user:pass@example.com')).toThrow(NetworkGuardError)
  })

  it('blocks loopback literals and localhost names before connecting', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'blocked' })
    await expect(assertPublicHttpUrl('http://localhost:34080')).rejects.toMatchObject({ code: 'blocked' })
    await expect(assertPublicHttpUrl('http://[::1]:34080')).rejects.toMatchObject({ code: 'blocked' })
  })

  it('allows private targets only when explicitly enabled', async () => {
    const server = http.createServer((_req, res) => { res.end('ok') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      await expect(guardedRequest(`http://127.0.0.1:${port}/`, {}, { allowPrivate: false })).rejects.toMatchObject({ code: 'blocked' })
      const response = await guardedRequest(`http://127.0.0.1:${port}/`, {}, { allowPrivate: true })
      expect(response.status).toBe(200)
      expect(response.body.toString()).toBe('ok')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
