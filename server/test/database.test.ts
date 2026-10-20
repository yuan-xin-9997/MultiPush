import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../src/db'

const directories: string[] = []
const databases: Database[] = []

function tempDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-db-'))
  directories.push(directory)
  const database = openDatabase(path.join(directory, 'test.sqlite'))
  databases.push(database)
  return database
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // already closed
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('database user isolation', () => {
  it('does not expose another user\'s content or books', () => {
    const database = tempDatabase()
    const alice = database.createUser({
      username: 'alice',
      email: 'alice@example.com',
      passwordHash: 'hash',
      displayName: 'Alice',
    })
    const bob = database.createUser({
      username: 'bob',
      email: 'bob@example.com',
      passwordHash: 'hash',
      displayName: 'Bob',
    })
    const book = database.createBook(alice.id, {
      name: 'Alice 的书架',
      description: '',
      color: '#00b96b',
    })
    const content = database.createContent(alice.id, {
      title: '只有 Alice 能看',
      bookId: book.id,
      contentJson: { type: 'doc', content: [] },
      contentHtml: '<p>secret</p>',
      excerpt: 'secret',
      coverImage: null,
      tags: ['私有'],
      status: 'draft',
      favorite: false,
      wordCount: 1,
      imageCount: 0,
      videoCount: 0,
    })

    expect(database.getContentDetail(alice.id, content.id)?.title).toBe('只有 Alice 能看')
    expect(database.getContentDetail(bob.id, content.id)).toBeNull()
    expect(database.getBook(bob.id, book.id)).toBeNull()
    expect(database.listContents(bob.id, { page: 1, pageSize: 20 }).total).toBe(0)
    expect(database.updateContent(bob.id, content.id, {
      title: 'hacked',
      bookId: null,
      contentJson: {},
      contentHtml: '<p>hacked</p>',
      excerpt: 'hacked',
      coverImage: null,
      tags: [],
      status: 'draft',
      favorite: false,
      wordCount: 1,
      imageCount: 0,
      videoCount: 0,
    })).toBeNull()
    expect(database.softDeleteContent(bob.id, content.id)).toBe(false)
  })

  it('soft deletes, restores and permanently deletes', () => {
    const database = tempDatabase()
    const user = database.createUser({
      username: 'carol',
      email: 'carol@example.com',
      passwordHash: 'hash',
      displayName: 'Carol',
    })
    const content = database.createContent(user.id, {
      title: '生命周期',
      bookId: null,
      contentJson: {},
      contentHtml: '<p>life</p>',
      excerpt: 'life',
      coverImage: null,
      tags: [],
      status: 'draft',
      favorite: false,
      wordCount: 1,
      imageCount: 0,
      videoCount: 0,
    })

    expect(database.softDeleteContent(user.id, content.id)).toBe(true)
    expect(database.listContents(user.id, { page: 1, pageSize: 20, trash: true }).total).toBe(1)
    expect(database.restoreContent(user.id, content.id)).toBe(true)
    expect(database.listContents(user.id, { page: 1, pageSize: 20 }).total).toBe(1)
    expect(database.permanentlyDeleteContent(user.id, content.id)).toBe(true)
    expect(database.getContentDetail(user.id, content.id)).toBeNull()
  })
})
