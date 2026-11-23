import type { Request } from 'express'
import { isIP } from 'node:net'
import { isPublicAddress } from './network-guard'

/**
 * Resolve the real client address when the service sits behind a local
 * reverse proxy / Cloudflare Tunnel.
 *
 * `req.ip` alone is not enough here: the tunnel host appends its own private
 * address to X-Forwarded-For, so Express would otherwise bucket every public
 * visitor under the same private proxy IP. When the socket peer is a private /
 * loopback address (i.e. our own proxy), prefer Cloudflare's client header and
 * validate it as an IP. Direct public peers cannot set that header.
 */
export function clientIp(req: Request): string {
  const rawRemote = req.socket.remoteAddress ?? ''
  const remote = rawRemote.replace(/^::ffff:/, '')
  const trustedPeer = !!remote && (!isIP(remote) || !isPublicAddress(remote))
  if (trustedPeer) {
    const header = req.headers['cf-connecting-ip']
    const candidate = Array.isArray(header) ? header[0] : header
    if (typeof candidate === 'string') {
      const normalized = candidate.trim().replace(/^::ffff:/, '')
      if (isIP(normalized)) return normalized
    }
  }
  return req.ip || remote || 'unknown'
}
