import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'

/**
 * Shared SSRF guard for every URL that comes from user input.
 *
 * Rules:
 * - only http(s), no embedded credentials;
 * - resolve the hostname, reject when any answer is a private / reserved
 *   address, then pin the validated addresses during the actual connection so
 *   DNS cannot be rebound between the check and the request;
 * - follow redirects manually, validating and pinning every hop and dropping
 *   Authorization/Cookie when the origin changes.
 */
const NON_PUBLIC_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]
const NON_PUBLIC_V6: Array<[string, number]> = [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]
const blocked = new BlockList()
for (const [address, prefix] of NON_PUBLIC_V4) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of NON_PUBLIC_V6) blocked.addSubnet(address, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export type NetworkGuardErrorCode = 'blocked' | 'resolve' | 'network' | 'timeout' | 'too_large' | 'redirect' | 'protocol'

export class NetworkGuardError extends Error {
  constructor(readonly code: NetworkGuardErrorCode, message: string) {
    super(message)
    this.name = 'NetworkGuardError'
  }
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family === 6) return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
  return false
}

export interface GuardOptions {
  /** Development / desktop override; production must leave this false. */
  allowPrivate?: boolean
  maxRedirects?: number
  timeoutMs?: number
  maxBytes?: number
}

export interface GuardRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: Buffer | string
  signal?: AbortSignal
}

export interface GuardResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
  /** Final URL after redirects. */
  url: string
}

/**
 * Test-only transport hook. Returning null falls back to the real guarded
 * request; the test setup uses it to route existing fetch mocks through the
 * same call sites without weakening production or guard-specific tests.
 */
export type NetworkTestTransport = (
  input: string | URL,
  init: GuardRequestInit,
  options: GuardOptions,
) => Promise<GuardResponse | null>

let testTransport: NetworkTestTransport | null = null

export function setNetworkTestTransport(transport: NetworkTestTransport | null): void {
  testTransport = transport
}

export function validateHttpUrl(input: string | URL): URL {
  let url: URL
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input)
  } catch {
    throw new NetworkGuardError('protocol', '地址格式不正确')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new NetworkGuardError('protocol', '只允许访问 HTTP/HTTPS 地址')
  }
  if (url.username || url.password) {
    throw new NetworkGuardError('protocol', '地址不能包含用户名或密码')
  }
  return url
}

async function resolveAddresses(url: URL, allowPrivate: boolean): Promise<Array<{ address: string; family: number }>> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!hostname) throw new NetworkGuardError('protocol', '地址缺少主机名')
  const literalFamily = isIP(hostname)
  if (literalFamily) {
    if (!allowPrivate && !isPublicAddress(hostname)) {
      throw new NetworkGuardError('blocked', '不能访问本机、内网或保留地址')
    }
    return [{ address: hostname, family: literalFamily }]
  }
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new NetworkGuardError('resolve', '无法解析目标域名')
  }
  if (!addresses.length) throw new NetworkGuardError('resolve', '目标域名没有可用地址')
  if (!allowPrivate && addresses.some(item => !isPublicAddress(item.address))) {
    throw new NetworkGuardError('blocked', '目标域名指向本机、内网或保留地址')
  }
  return addresses
}

function requestOnce(
  url: URL,
  addresses: Array<{ address: string; family: number }>,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  timeoutMs: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (signal) signals.push(signal)
    const combined = AbortSignal.any(signals)
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(url, {
      method,
      headers,
      signal: combined,
      lookup: ((hostname: string, options: { family?: number; all?: boolean }, callback: (error: NodeJS.ErrnoException | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void) => {
        const family = options.family === 4 || options.family === 6 ? options.family : 0
        const matching = family ? addresses.filter(item => item.family === family) : addresses
        if (!matching.length) {
          callback(new NetworkGuardError('resolve', '目标地址不可用') as unknown as NodeJS.ErrnoException, '', 4)
          return
        }
        if (options.all) callback(null, matching)
        else callback(null, matching[0].address, matching[0].family)
      }) as never,
    }, (response) => {
      const status = response.statusCode ?? 0
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          response.destroy(new NetworkGuardError('too_large', '目标响应过大'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', (error) => reject(error))
    })
    request.on('error', (error) => {
      if (error instanceof NetworkGuardError) {
        reject(error)
        return
      }
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        reject(new NetworkGuardError('timeout', '请求超时'))
        return
      }
      reject(new NetworkGuardError('network', '无法连接目标地址'))
    })
    if (body && body.length) request.write(body)
    request.end()
  })
}

function dropSensitiveHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase())) delete headers[key]
  }
}

function redirectMethod(status: number, method: string): { method: string; dropBody: boolean } {
  if (status === 303) return { method: 'GET', dropBody: true }
  if ((status === 301 || status === 302) && method === 'POST') return { method: 'GET', dropBody: true }
  return { method, dropBody: false }
}

/**
 * Perform an HTTP request with SSRF protection. Redirects are followed
 * manually (max `maxRedirects`), each hop is validated, and the body is capped.
 */
export async function guardedRequest(
  input: string | URL,
  init: GuardRequestInit = {},
  options: GuardOptions = {},
): Promise<GuardResponse> {
  if (testTransport) {
    const mocked = await testTransport(input, init, options)
    if (mocked) return mocked
  }
  const allowPrivate = options.allowPrivate === true
  const maxRedirects = Math.max(0, Math.min(5, options.maxRedirects ?? 3))
  const maxBytes = Math.max(1024, options.maxBytes ?? 8 * 1024 * 1024)
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 30_000)
  let url = validateHttpUrl(input)
  let method = (init.method ?? 'GET').toUpperCase()
  let headers = { ...(init.headers ?? {}) }
  let body = init.body === undefined ? undefined : Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body, 'utf8')
  if (body && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) {
    headers['Content-Length'] = String(body.length)
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const addresses = await resolveAddresses(url, allowPrivate)
    const response = await requestOnce(url, addresses, method, headers, body, timeoutMs, maxBytes, init.signal)
    const location = response.headers.location
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      if (hop === maxRedirects) throw new NetworkGuardError('redirect', '目标地址重定向次数过多')
      let next: URL
      try {
        next = validateHttpUrl(new URL(Array.isArray(location) ? location[0] : location, url))
      } catch {
        throw new NetworkGuardError('redirect', '目标地址返回了无效的重定向')
      }
      if (next.origin !== url.origin) dropSensitiveHeaders(headers)
      const nextMethod = redirectMethod(response.status, method)
      if (nextMethod.dropBody) {
        body = undefined
        for (const key of Object.keys(headers)) {
          if (['content-type', 'content-length'].includes(key.toLowerCase())) delete headers[key]
        }
      }
      method = nextMethod.method
      url = next
      continue
    }
    return { ...response, url: url.href }
  }
  throw new NetworkGuardError('redirect', '目标地址重定向次数过多')
}

/** Validate an address without performing a request (DNS is resolved and pinned). */
export async function assertPublicHttpUrl(input: string | URL, options: GuardOptions = {}): Promise<URL> {
  const url = validateHttpUrl(input)
  await resolveAddresses(url, options.allowPrivate === true)
  return url
}
