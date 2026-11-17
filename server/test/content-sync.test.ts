import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { signToken, createRequireAuth } from '../src/auth'
import { openDatabase, type Database } from '../src/db'
import { errorHandler } from '../src/errors'
import { createContentsRouter } from '../src/routes/contents'

const directories: string[] = []
const databases: Database[] = []
const servers: Server[] = []

function setup(filename = ':memory:') {
  const directory = filename === ':memory:' ? null : mkdtempSync(path.join(tmpdir(), 'multipush-content-sync-'))
  if (directory) directories.push(directory)
  const database = openDatabase(directory ? path.join(directory, 'sync.sqlite') : ':memory:')
  databases.push(database)
  const user = database.createUser({ username: 'syncuser', email: 'sync@example.com', passwordHash: 'unused', displayName: 'Sync' })
  const app = express()
  app.use(express.json())
  app.use('/api/contents', createRequireAuth(database, 'sync-secret'), createContentsRouter(database))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  return { database, user, directory, token: signToken(user, 'sync-secret') }
}

async function request(server: Server, token: string, route: string, init: RequestInit = {}) {
  if (!server.listening) await once(server, 'listening')
  const address = server.address() as { port: number }
  const response = await fetch(`http://127.0.0.1:${address.port}/api/contents${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: response.status, data: await response.json() as { content: Record<string, unknown>; error?: string } }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('contentHtml / contentJson synchronization', () => {
  it('marks JSON stale after an HTML-only PATCH and clears it when both are saved', async () => {
    const { user, token } = setup()
    const server = servers.at(-1)!
    const created = await request(server, token, '', {
      method: 'POST',
      body: JSON.stringify({
        title: '同步测试',
        contentHtml: '<p>旧正文</p>',
        contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧正文' }] }] },
      }),
    })
    expect(created.status).toBe(200)
    const id = String(created.data.content.id)
    expect(created.data.content).toMatchObject({ contentJsonStale: false, contentHtml: '<p>旧正文</p>' })

    const patched = await request(server, token, `/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ contentHtml: '<p>正文已改</p>' }),
    })
    expect(patched.status).toBe(200)
    expect(patched.data.content.contentHtml).toBe('<p>正文已改</p>')
    expect(patched.data.content.contentJsonStale).toBe(true)
    expect(patched.data.content.contentJson).toMatchObject({ type: 'doc' })

    const read = await request(server, token, `/${id}`)
    expect(read.data.content.contentJsonStale).toBe(true)
    expect(read.data.content.contentHtml).toBe('<p>正文已改</p>')

    const synced = await request(server, token, `/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        contentHtml: '<p>正文已改</p><p>新增</p>',
        contentJson: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '正文已改' }] },
            { type: 'paragraph', content: [{ type: 'text', text: '新增' }] },
          ],
        },
      }),
    })
    expect(synced.data.content.contentJsonStale).toBe(false)
    expect(synced.data.content.contentHtml).toContain('新增')
  })

  it('rebuilds contentHtml from a JSON-only PATCH so renderers never use an old body', async () => {
    const { token } = setup()
    const server = servers.at(-1)!
    const created = await request(server, token, '', {
      method: 'POST',
      body: JSON.stringify({ title: 'JSON 同步', contentHtml: '<p>旧正文</p>', contentJson: { type: 'doc', content: [] } }),
    })
    const id = String(created.data.content.id)
    expect(created.data.content.contentJsonStale).toBe(true)

    const patched = await request(server, token, `/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        contentJson: {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '标题' }] },
            {
              type: 'figure',
              content: [
                { type: 'image', attrs: { src: '/uploads/a.png', alt: '图' } },
                { type: 'figcaption', content: [{ type: 'text', text: '图：说明' }] },
              ],
            },
          ],
        },
      }),
    })
    expect(patched.status).toBe(200)
    expect(patched.data.content.contentJsonStale).toBe(false)
    expect(String(patched.data.content.contentHtml)).toBe(
      '<h2>标题</h2><figure><img src="/uploads/a.png" alt="图"><figcaption>图：说明</figcaption></figure>',
    )
  })

  it('upgrades a database created before the sync columns existed', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'multipush-content-migrate-'))
    directories.push(directory)
    const file = path.join(directory, 'old.sqlite')
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL, avatar_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE contents (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        book_id TEXT, title TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '', content_json TEXT NOT NULL DEFAULT '{}',
        content_html TEXT NOT NULL DEFAULT '', cover_image TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft', favorite INTEGER NOT NULL DEFAULT 0, word_count INTEGER NOT NULL DEFAULT 0,
        image_count INTEGER NOT NULL DEFAULT 0, video_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      INSERT INTO users VALUES ('u1', 'old', 'old@example.com', 'hash', 'Old', NULL, '2026-01-01', '2026-01-01');
      INSERT INTO contents (id, user_id, title, content_json, content_html, created_at, updated_at)
        VALUES ('c1', 'u1', '旧文档', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"旧正文"}]}]}', '<p>旧正文</p>', '2026-01-01', '2026-01-01');
    `)
    legacy.close()
    const migrated = openDatabase(file)
    databases.push(migrated)
    const detail = migrated.getContentDetail('u1', 'c1')!
    expect(detail.contentJsonStale).toBe(false)
    expect(detail.contentHtmlHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('detects stale JSON after a restart using the persisted checksum', () => {
    const first = setup('disk')
    const content = first.database.createContent(first.user.id, {
      title: '重启测试',
      bookId: null,
      contentHtml: '<p>旧正文</p>',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧正文' }] }] },
      excerpt: '',
      coverImage: null,
      tags: [],
      status: 'draft',
      favorite: false,
      wordCount: 3,
      imageCount: 0,
      videoCount: 0,
    })
    expect(content.contentJsonStale).toBe(false)
    // Simulate the route's HTML-only PATCH: keep the old checksum and flag the JSON.
    first.database.updateContent(first.user.id, content.id, {
      title: content.title,
      bookId: null,
      contentJson: content.contentJson,
      contentHtml: '<p>重启后修改</p>',
      contentHtmlHash: content.contentHtmlHash,
      contentJsonStale: true,
      excerpt: '',
      coverImage: null,
      tags: [],
      status: 'draft',
      favorite: false,
      wordCount: 3,
      imageCount: 0,
      videoCount: 0,
    })
    first.database.close()
    databases.splice(databases.indexOf(first.database), 1)
    const reopened = openDatabase(path.join(first.directory!, 'sync.sqlite'))
    databases.push(reopened)
    const detail = reopened.getContentDetail(first.user.id, content.id)!
    expect(detail.contentJsonStale).toBe(true)
    expect(detail.contentHtml).toBe('<p>重启后修改</p>')
  })
})
