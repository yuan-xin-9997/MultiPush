import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { clientIp } from '../src/request-ip'

function request(remoteAddress: string, headers: Record<string, string> = {}, ip = remoteAddress): Request {
  return { socket: { remoteAddress }, headers, ip } as unknown as Request
}

describe('clientIp', () => {
  it('prefers Cloudflare client IP when the peer is a private proxy', () => {
    expect(clientIp(request('192.168.0.100', { 'cf-connecting-ip': '203.0.113.9' }))).toBe('203.0.113.9')
    expect(clientIp(request('::1', { 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8::1')
  })

  it('ignores the Cloudflare header from public peers', () => {
    expect(clientIp(request('8.8.8.8', { 'cf-connecting-ip': '1.2.3.4' }))).toBe('8.8.8.8')
  })

  it('ignores malformed headers', () => {
    expect(clientIp(request('127.0.0.1', { 'cf-connecting-ip': 'not-an-ip' }))).toBe('127.0.0.1')
  })
})
