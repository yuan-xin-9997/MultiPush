import express from 'express'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { createUploadsRouter } from '../src/static'

it('isolates scripts in legacy SVG files while still serving uploaded images', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-static-'))
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
  writeFileSync(path.join(directory, 'legacy.svg'), svg)
  const app = express()
  app.use('/uploads', createUploadsRouter(directory))
  const server = app.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing port')
    const response = await fetch(`http://127.0.0.1:${address.port}/uploads/legacy.svg`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('image/svg+xml')
    expect(response.headers.get('content-security-policy')).toBe("sandbox; script-src 'none'; object-src 'none'")
    expect(await response.text()).toBe(svg)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})
