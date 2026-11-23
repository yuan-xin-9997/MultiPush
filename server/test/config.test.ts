import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

const directories: string[] = []
function dataDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-config-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('security-related config defaults', () => {
  it('locks the server pool to admins and public URLs in production', () => {
    const config = loadConfig({ nodeEnv: 'production', dataDir: dataDir(), jwtSecret: 'x' })
    expect(config.aiPoolAccess).toBe('admin')
    expect(config.aiPoolUsers).toEqual([])
    expect(config.aiPoolDailyLimit).toBe(0)
    expect(config.allowPrivateNetwork).toBe(false)
    expect(config.trustProxy).toBe('loopback')
  })

  it('keeps local development usable but honours explicit overrides', () => {
    const dev = loadConfig({ nodeEnv: 'development', dataDir: dataDir(), jwtSecret: 'x' })
    expect(dev.aiPoolAccess).toBe('all')
    expect(dev.allowPrivateNetwork).toBe(true)
    const hardened = loadConfig({
      nodeEnv: 'production',
      dataDir: dataDir(),
      jwtSecret: 'x',
      aiPoolAccess: 'all',
      aiPoolUsers: ['someone'],
      aiPoolDailyLimit: 25,
      allowPrivateNetwork: true,
      trustProxy: false,
    })
    expect(hardened).toMatchObject({ aiPoolAccess: 'all', aiPoolUsers: ['someone'], aiPoolDailyLimit: 25, allowPrivateNetwork: true, trustProxy: false })
  })
})
