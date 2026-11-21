import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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

describe('gallery content migration', () => {
  it('rebuilds an old contents table so gallery content can be created without losing rows', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'multipush-gallery-db-'))
    directories.push(directory)
    const filename = path.join(directory, 'legacy.sqlite')
    const legacy = new DatabaseSync(filename)
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE books (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '#00b96b',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE contents (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'article' CHECK (kind IN ('article', 'video')),
        title TEXT NOT NULL,
        excerpt TEXT NOT NULL DEFAULT '',
        content_json TEXT NOT NULL DEFAULT '{}',
        content_html TEXT NOT NULL DEFAULT '',
        content_html_hash TEXT,
        content_json_stale INTEGER NOT NULL DEFAULT 0,
        cover_image TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready')),
        favorite INTEGER NOT NULL DEFAULT 0,
        word_count INTEGER NOT NULL DEFAULT 0,
        image_count INTEGER NOT NULL DEFAULT 0,
        video_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE media (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
        filename TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        meta_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE video_projects (
        content_id TEXT PRIMARY KEY REFERENCES contents(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        timeline_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO users VALUES ('u1', 'legacy', 'legacy@example.com', 'hash', 'Legacy', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO contents (id, user_id, kind, title, created_at, updated_at)
        VALUES ('c1', 'u1', 'article', '旧文章', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO video_projects VALUES ('c1', 'u1', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO media VALUES ('m1', 'u1', 'image', 'legacy.png', '旧图片.png', 'image/png', 128, NULL, '2026-01-01T00:00:00.000Z');
    `)
    legacy.close()

    const database = openDatabase(filename)
    databases.push(database)
    const userId = database.findUserById('u1')!.id
    expect(database.getContentSummary(userId, 'c1')?.title).toBe('旧文章')

    const gallery = database.createContent(userId, {
      title: '新图文', kind: 'gallery', bookId: null, contentJson: { type: 'doc', content: [] },
      contentHtml: '<figure><img src="/uploads/a.png"></figure>', excerpt: '', coverImage: '/uploads/a.png',
      tags: [], status: 'draft', favorite: false, wordCount: 0, imageCount: 1, videoCount: 0,
    })
    expect(gallery.kind).toBe('gallery')
    expect(database.listContents(userId, { favorite: false, trash: false, kind: 'gallery', sort: 'updated_desc', page: 1, pageSize: 20 }).total).toBe(1)
    expect(database.listContents(userId, { favorite: false, trash: false, kind: 'article', sort: 'updated_desc', page: 1, pageSize: 20 }).total).toBe(1)

    expect(database.getMediaStats(userId)).toMatchObject({ total: 1, images: 1, videos: 0, documents: 0 })
    const report = database.createMedia(userId, {
      kind: 'document', filename: 'report.pdf', originalName: '报告.pdf',
      mimeType: 'application/pdf', size: 256,
    })
    expect(report.kind).toBe('document')
    expect(database.getMediaStats(userId)).toMatchObject({ total: 2, documents: 1, bytes: 384 })
    expect(database.listMedia(userId, { kind: 'document', page: 1, pageSize: 20 }).map((item) => item.originalName)).toEqual(['报告.pdf'])
    expect(database.listMedia(userId, { q: '旧图片', page: 1, pageSize: 20 }).map((item) => item.originalName)).toEqual(['旧图片.png'])

    const folder = database.createMediaFolder(userId, '品牌资料')
    expect(database.listMediaFolders(userId)).toMatchObject([{ id: folder.id, name: '品牌资料', assetCount: 0 }])
    expect(database.moveMedia(userId, 'm1', folder.id)?.folderId).toBe(folder.id)
    expect(database.listMedia(userId, { folderId: folder.id, page: 1, pageSize: 20 })).toHaveLength(1)
    expect(database.listMediaFolders(userId)[0]?.assetCount).toBe(1)
    expect(database.renameMediaFolder(userId, folder.id, '旧品牌资料')?.name).toBe('旧品牌资料')
    expect(database.getMediaFolderByName(userId, '旧品牌资料')?.id).toBe(folder.id)
    expect(database.deleteMediaFolder(userId, folder.id)).toEqual({ moved: 1 })
    expect(database.getMedia(userId, 'm1')?.folderId).toBeNull()
    expect(database.listMedia(userId, { folderId: 'unfiled', page: 1, pageSize: 20 }).map((item) => item.id)).toContain('m1')

    database.close()
    const check = new DatabaseSync(filename, { readOnly: true })
    expect(check.prepare('SELECT COUNT(*) AS total FROM video_projects').get()?.total).toBe(1)
    check.close()
  })
})

describe('database user isolation', () => {
  it('saves platform drafts separately and enforces ownership on read, save and reset', () => {
    const database = tempDatabase()
    const alice = database.createUser({ username: 'draft_alice', email: 'draft-alice@example.com', passwordHash: 'hash', displayName: 'Alice' })
    const bob = database.createUser({ username: 'draft_bob', email: 'draft-bob@example.com', passwordHash: 'hash', displayName: 'Bob' })
    const content = database.createContent(alice.id, { title: '原文', bookId: null, contentJson: {}, contentHtml: '<p>原文</p>', excerpt: '', coverImage: null, tags: [], status: 'draft', favorite: false, wordCount: 2, imageCount: 0, videoCount: 0 })
    const result = { platform: 'wechat' as const, title: '生成标题', html: '<p>生成结果</p>', markdown: null, text: '生成结果', previewMode: 'article' as const, themeColor: '#00b96b', meta: { wordCount: 4, imageCount: 0, videoCount: 0, readMinutes: 1, tags: [], titleLength: 4, summary: '' }, cards: [], assets: [], videos: [], warnings: [], downloads: [], generatedAt: content.updatedAt }
    const record = database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['wechat'], options: {}, results: [result] })
    const draft = { ...result, title: '专属标题' }
    expect(database.saveRenderDraft(bob.id, record.id, draft)).toBe(false)
    expect(database.saveRenderDraft(alice.id, record.id, draft)).toBe(true)
    expect(database.getRender(alice.id, record.id)?.results[0].title).toBe('专属标题')
    expect(database.getRender(alice.id, record.id, true)?.results[0].title).toBe('生成标题')
    expect(database.getRender(bob.id, record.id)).toBeNull()
    expect(database.resetRenderDraft(bob.id, record.id, 'wechat')).toBe(false)
    expect(database.getContentDetail(alice.id, content.id)?.title).toBe('原文')
    expect(database.resetRenderDraft(alice.id, record.id, 'wechat')).toBe(true)
    expect(database.getRender(alice.id, record.id)?.results[0].title).toBe('生成标题')
  })

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
