import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../src/db'

const directories: string[] = []
const databases: Database[] = []

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-wechat-db-'))
  directories.push(directory)
  const filename = path.join(directory, 'test.sqlite')
  const database = reopen(filename)
  const alice = database.createUser({ username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: 'hash' })
  return { filename, database, alice, bob }
}

function reopen(filename: string) {
  const database = openDatabase(filename)
  databases.push(database)
  return database
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WeChat persistence', () => {
  it('retains encrypted sessions across restarts and isolates account and media access', () => {
    const { filename, database, alice, bob } = setup()
    const account = { encryptedSession: 'encrypted-session', name: 'Alice 的公众号', status: 'connected' as const, checkedAt: new Date().toISOString() }
    database.saveWechatAccount(alice.id, account)
    const media = database.createMedia(alice.id, { kind: 'image', filename: 'cover.png', originalName: '封面.png', mimeType: 'image/png', size: 123 })
    expect(database.getWechatAccount(bob.id)).toBeNull()
    expect(database.deleteWechatAccount(bob.id)).toBe(false)
    expect(database.getMediaByFilename(alice.id, 'cover.png')?.id).toBe(media.id)
    expect(database.getMediaByFilename(bob.id, 'cover.png')).toBeNull()

    database.close()
    const restored = reopen(filename)
    expect(restored.getWechatAccount(alice.id)).toEqual(account)
    restored.saveWechatAccount(alice.id, { ...account, encryptedSession: 'new-session', status: 'expired' })
    expect(restored.getWechatAccount(alice.id)?.status).toBe('expired')
    expect(restored.deleteWechatAccount(alice.id)).toBe(true)
    expect(restored.getWechatAccount(alice.id)).toBeNull()
  })

  it('deduplicates publication submissions per user and enforces ownership on updates', () => {
    const { database, alice, bob } = setup()
    const input = { renderId: 'render-1', title: '文章', mode: 'publish' as const, idempotencyKey: 'same-submission' }
    const publication = database.createWechatPublication(alice.id, input)
    expect(database.createWechatPublication(alice.id, input).id).toBe(publication.id)
    expect(database.listWechatPublications(alice.id)).toHaveLength(1)
    expect(database.getWechatPublication(bob.id, publication.id)).toBeNull()
    expect(database.findWechatPublication(bob.id, input.idempotencyKey)).toBeNull()
    expect(database.updateWechatPublication(bob.id, publication.id, { status: 'published' })).toBeNull()
    expect(database.createWechatPublication(bob.id, input).id).not.toBe(publication.id)

    const updated = database.updateWechatPublication(alice.id, publication.id, { status: 'published', message: '发表成功', url: 'https://mp.weixin.qq.com/s/article', remoteId: '123' })
    expect(updated).toMatchObject({ status: 'published', url: 'https://mp.weixin.qq.com/s/article', remoteId: '123', qrCode: null })
    expect(database.updateWechatPublication(alice.id, publication.id, { message: '已核实' })).toMatchObject({ status: 'published', remoteId: '123', url: updated?.url })
    expect(database.updateWechatPublication(alice.id, publication.id, { url: null, remoteId: null })).toMatchObject({ url: null, remoteId: null })
  })

  it('marks interrupted work uncertain on restart and preserves completed publication audit records', () => {
    const { filename, database, alice } = setup()
    const create = (idempotencyKey: string) => database.createWechatPublication(alice.id, { renderId: 'deleted-render', title: '文章', mode: 'publish', idempotencyKey })
    const running = create('running')
    const confirming = create('confirming')
    const complete = create('complete')
    database.updateWechatPublication(alice.id, confirming.id, { status: 'awaiting_confirmation', remoteId: 'wechat-draft' })
    database.updateWechatPublication(alice.id, complete.id, { status: 'published', url: 'https://mp.weixin.qq.com/s/published' })
    database.close()

    const restored = reopen(filename)
    expect(restored.getWechatPublication(alice.id, running.id)).toMatchObject({ status: 'uncertain', qrCode: null })
    expect(restored.getWechatPublication(alice.id, confirming.id)).toMatchObject({ status: 'uncertain', remoteId: 'wechat-draft' })
    expect(restored.getWechatPublication(alice.id, confirming.id)?.message).toContain('后台核实')
    expect(restored.getWechatPublication(alice.id, complete.id)).toMatchObject({ status: 'published', url: 'https://mp.weixin.qq.com/s/published' })
    expect(restored.createWechatPublication(alice.id, { renderId: running.renderId, title: running.title, mode: running.mode, idempotencyKey: 'running' }).id).toBe(running.id)
  })

  it('adds WeChat tables to an existing version 2 database without losing users or books', () => {
    const { filename, database, alice } = setup()
    const book = database.createBook(alice.id, { name: '旧知识库', description: '', color: '#00b96b' })
    database.close()
    const legacy = new DatabaseSync(filename)
    legacy.exec('DROP TABLE wechat_publications; DROP TABLE wechat_accounts; PRAGMA user_version = 2;')
    legacy.close()

    const migrated = reopen(filename)
    expect(migrated.findUserById(alice.id)?.username).toBe('alice')
    expect(migrated.getBook(alice.id, book.id)?.name).toBe('旧知识库')
    expect(migrated.getWechatAccount(alice.id)).toBeNull()
    expect(migrated.listWechatPublications(alice.id)).toEqual([])
    migrated.saveWechatAccount(alice.id, { encryptedSession: 'migrated-session', name: null, status: 'connected', checkedAt: new Date().toISOString() })
    expect(migrated.getWechatAccount(alice.id)?.encryptedSession).toBe('migrated-session')
  })
})
