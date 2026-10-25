import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserContext } from 'playwright-core'

export type PublisherStorageState = Awaited<ReturnType<BrowserContext['storageState']>>

export function loadPublisherKey(dataDir: string, platform: 'wechat' | 'zhihu' | 'xiaohongshu' | 'douyin'): Buffer {
  const file = path.join(dataDir, `.${platform}-session-key`)
  try { writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const key = readFileSync(file)
  if (key.length !== 32) throw new Error('Invalid publisher session encryption key')
  return key
}

export function encryptPublisherSession(state: PublisherStorageState, key: Buffer, userId: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(userId))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function decryptPublisherSession(value: string, key: Buffer, userId: string): PublisherStorageState {
  const buffer = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12))
  decipher.setAAD(Buffer.from(userId))
  decipher.setAuthTag(buffer.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8')) as PublisherStorageState
}
