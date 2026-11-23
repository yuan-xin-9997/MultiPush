import { setNetworkTestTransport } from '../src/network-guard'

/**
 * Route stubbed `fetch` implementations through the guarded request call
 * sites. When a test does not replace global fetch, the real SSRF guard runs.
 */
const nativeFetch = globalThis.fetch

setNetworkTestTransport(async (input, init) => {
  if (process.env.DEBUG_GUARD) console.log('transport called', globalThis.fetch === nativeFetch)
  if (globalThis.fetch === nativeFetch) return null
  const response = await globalThis.fetch(typeof input === 'string' ? input : input.href, {
    method: init.method,
    headers: init.headers,
    body: init.body as BodyInit | undefined,
    redirect: 'manual',
  })
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  return {
    status: response.status,
    headers,
    body: Buffer.from(await response.arrayBuffer()),
    url: response.url || (typeof input === 'string' ? input : input.href),
  }
})
