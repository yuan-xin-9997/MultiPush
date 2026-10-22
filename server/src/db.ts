import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  Book,
  ContentDetail,
  ContentListResult,
  ContentStatus,
  ContentSummary,
  MediaAsset,
  MediaKind,
  PlatformId,
  RenderListItem,
  RenderOptions,
  RenderRecord,
  RichTextJson,
  User,
} from '../../shared/types'
import { PLATFORM_ORDER } from '../../shared/types'
import { DEFAULT_BOOK_COLOR } from './config'

type Row = Record<string, unknown>
type SqlValue = string | number | null | bigint

function nowIso(): string {
  return new Date().toISOString()
}

function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return fallback
  return String(value)
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const result = String(value)
  return result.length > 0 ? result : null
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function parseContentJson(value: unknown): RichTextJson {
  const parsed = parseJson(value)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as RichTextJson
  return {}
}

function parseTags(value: unknown): string[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is string => typeof item === 'string')
}

function parsePlatforms(value: unknown): PlatformId[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed)) return []
  const result: PlatformId[] = []
  for (const item of parsed) {
    if (typeof item === 'string' && (PLATFORM_ORDER as string[]).includes(item)) {
      result.push(item as PlatformId)
    }
  }
  return result
}

function parseResults(value: unknown): RenderRecord['results'] {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? (parsed as RenderRecord['results']) : []
}

function parseOptions(value: unknown): RenderOptions {
  const parsed = parseJson(value)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as RenderOptions
  return {}
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

export interface UserWithPassword extends User {
  passwordHash: string
}

export interface CreateUserValues {
  username: string
  email: string
  passwordHash: string
  displayName: string
}

export interface UpdateProfileValues {
  displayName?: string
  avatarUrl?: string | null
}

export interface CreateBookValues {
  name: string
  description: string
  color: string
}

export interface UpdateBookValues {
  name?: string
  description?: string
  color?: string
}

export interface ContentWriteValues {
  title: string
  bookId: string | null
  contentJson: RichTextJson
  contentHtml: string
  excerpt: string
  coverImage: string | null
  tags: string[]
  status: ContentStatus
  favorite: boolean
  wordCount: number
  imageCount: number
  videoCount: number
}

export interface ContentListOptions {
  bookId?: string
  favorite: boolean
  trash: boolean
  q?: string
  sort: 'updated_desc' | 'created_desc' | 'title_asc'
  page: number
  pageSize: number
}

export interface CreateMediaValues {
  kind: MediaKind
  filename: string
  originalName: string
  mimeType: string
  size: number
}

export interface CreateRenderValues {
  contentId: string
  contentTitle: string
  platforms: PlatformId[]
  options: RenderOptions
  results: RenderRecord['results']
}

/**
 * SQLite persistence. Every read/write on user-owned resources takes a userId
 * so cross-tenant access can only ever return null/0 (mapped to HTTP 404).
 */
export class Database {
  private readonly database: DatabaseSync
  private closed = false

  constructor(filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(path.dirname(filename), { recursive: true })
    }
    this.database = new DatabaseSync(filename)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `)
    this.migrate()
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '${DEFAULT_BOOK_COLOR}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_books_user_updated ON books(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS contents (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        excerpt TEXT NOT NULL DEFAULT '',
        content_json TEXT NOT NULL DEFAULT '{}',
        content_html TEXT NOT NULL DEFAULT '',
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
      CREATE INDEX IF NOT EXISTS idx_contents_user_updated ON contents(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contents_user_deleted ON contents(user_id, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_contents_book ON contents(book_id);

      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
        filename TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_user_created ON media(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS renders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
        content_title TEXT NOT NULL,
        platforms_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_renders_user_created ON renders(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_renders_content ON renders(content_id);

      CREATE TABLE IF NOT EXISTS render_drafts (
        render_id TEXT NOT NULL REFERENCES renders(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (render_id, platform)
      );
      PRAGMA user_version = 2;
    `)
  }

  private all(sql: string, params: SqlValue[] = []): Row[] {
    return this.database.prepare(sql).all(...params) as unknown as Row[]
  }

  private get(sql: string, params: SqlValue[] = []): Row | undefined {
    return this.database.prepare(sql).get(...params) as unknown as Row | undefined
  }

  private run(sql: string, params: SqlValue[] = []): number {
    const result = this.database.prepare(sql).run(...params)
    return Number(result.changes)
  }

  private transaction<T>(callback: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const value = callback()
      this.database.exec('COMMIT')
      return value
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // Ignore rollback failures; the original error is more useful.
      }
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  // ---------------------------------------------------------------- users

  private mapUser(row: Row): User {
    return {
      id: text(row.id),
      username: text(row.username),
      email: text(row.email),
      displayName: text(row.display_name),
      avatarUrl: nullableText(row.avatar_url),
      createdAt: text(row.created_at),
    }
  }

  createUser(values: CreateUserValues): User {
    const id = randomUUID()
    const createdAt = nowIso()
    this.run(
      `INSERT INTO users (id, username, email, password_hash, display_name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      [id, values.username, values.email, values.passwordHash, values.displayName, createdAt, createdAt],
    )
    const user = this.findUserById(id)
    if (!user) throw new Error('Failed to create user')
    return user
  }

  findUserByAccount(account: string): UserWithPassword | null {
    const row = this.get(
      `SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE LIMIT 1`,
      [account, account],
    )
    if (!row) return null
    return { ...this.mapUser(row), passwordHash: text(row.password_hash) }
  }

  findUserById(id: string): User | null {
    const row = this.get('SELECT * FROM users WHERE id = ?', [id])
    return row ? this.mapUser(row) : null
  }

  findUserWithPasswordById(id: string): UserWithPassword | null {
    const row = this.get('SELECT * FROM users WHERE id = ?', [id])
    if (!row) return null
    return { ...this.mapUser(row), passwordHash: text(row.password_hash) }
  }

  usernameTaken(username: string): boolean {
    const row = this.get('SELECT 1 AS present FROM users WHERE username = ? COLLATE NOCASE LIMIT 1', [username])
    return Boolean(row)
  }

  emailTaken(email: string): boolean {
    const row = this.get('SELECT 1 AS present FROM users WHERE email = ? COLLATE NOCASE LIMIT 1', [email])
    return Boolean(row)
  }

  updateUserProfile(userId: string, values: UpdateProfileValues): User | null {
    const current = this.findUserById(userId)
    if (!current) return null
    const displayName =
      values.displayName === undefined ? current.displayName : values.displayName.trim() || current.username
    const avatarUrl = values.avatarUrl === undefined ? current.avatarUrl : values.avatarUrl
    this.run('UPDATE users SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?', [
      displayName,
      avatarUrl,
      nowIso(),
      userId,
    ])
    return this.findUserById(userId)
  }

  updateUserPassword(userId: string, passwordHash: string): boolean {
    return this.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      passwordHash,
      nowIso(),
      userId,
    ]) > 0
  }

  // ---------------------------------------------------------------- books

  private mapBook(row: Row): Book {
    return {
      id: text(row.id),
      name: text(row.name),
      description: text(row.description),
      color: text(row.color, DEFAULT_BOOK_COLOR),
      docCount: numberValue(row.doc_count),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    }
  }

  private bookSelect(): string {
    return `SELECT b.*,
      (SELECT COUNT(*) FROM contents c WHERE c.book_id = b.id AND c.deleted_at IS NULL) AS doc_count
      FROM books b`
  }

  listBooks(userId: string): Book[] {
    return this.all(`${this.bookSelect()} WHERE b.user_id = ? ORDER BY b.updated_at DESC, b.created_at DESC`, [
      userId,
    ]).map((row) => this.mapBook(row))
  }

  getBook(userId: string, bookId: string): Book | null {
    const row = this.get(`${this.bookSelect()} WHERE b.id = ? AND b.user_id = ?`, [bookId, userId])
    return row ? this.mapBook(row) : null
  }

  createBook(userId: string, values: CreateBookValues): Book {
    const id = randomUUID()
    const createdAt = nowIso()
    this.run(
      `INSERT INTO books (id, user_id, name, description, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, values.name, values.description, values.color, createdAt, createdAt],
    )
    const book = this.getBook(userId, id)
    if (!book) throw new Error('Failed to create book')
    return book
  }

  updateBook(userId: string, bookId: string, values: UpdateBookValues): Book | null {
    const current = this.getBook(userId, bookId)
    if (!current) return null
    this.run('UPDATE books SET name = ?, description = ?, color = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
      values.name ?? current.name,
      values.description ?? current.description,
      values.color ?? current.color,
      nowIso(),
      bookId,
      userId,
    ])
    return this.getBook(userId, bookId)
  }

  /** Delete a book, moving all of its documents (including trash) to unfiled. */
  deleteBook(userId: string, bookId: string): boolean {
    if (!this.getBook(userId, bookId)) return false
    this.transaction(() => {
      this.run('UPDATE contents SET book_id = NULL WHERE book_id = ? AND user_id = ?', [bookId, userId])
      this.run('DELETE FROM books WHERE id = ? AND user_id = ?', [bookId, userId])
    })
    return true
  }

  // ------------------------------------------------------------- contents

  private mapContentSummary(row: Row): ContentSummary {
    return {
      id: text(row.id),
      bookId: nullableText(row.book_id),
      bookName: nullableText(row.book_name),
      title: text(row.title),
      excerpt: text(row.excerpt),
      coverImage: nullableText(row.cover_image),
      tags: parseTags(row.tags_json),
      status: row.status === 'ready' ? 'ready' : 'draft',
      favorite: numberValue(row.favorite) === 1,
      wordCount: numberValue(row.word_count),
      imageCount: numberValue(row.image_count),
      videoCount: numberValue(row.video_count),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      deletedAt: nullableText(row.deleted_at),
    }
  }

  private mapContentDetail(row: Row): ContentDetail {
    return {
      ...this.mapContentSummary(row),
      contentJson: parseContentJson(row.content_json),
      contentHtml: text(row.content_html),
    }
  }

  private contentSelect(): string {
    return `SELECT c.*, b.name AS book_name
      FROM contents c
      LEFT JOIN books b ON b.id = c.book_id AND b.user_id = c.user_id`
  }

  getContentDetail(userId: string, contentId: string): ContentDetail | null {
    const row = this.get(`${this.contentSelect()} WHERE c.id = ? AND c.user_id = ?`, [contentId, userId])
    return row ? this.mapContentDetail(row) : null
  }

  getContentSummary(userId: string, contentId: string): ContentSummary | null {
    const row = this.get(`${this.contentSelect()} WHERE c.id = ? AND c.user_id = ?`, [contentId, userId])
    return row ? this.mapContentSummary(row) : null
  }

  listContents(userId: string, options: ContentListOptions): ContentListResult {
    const where: string[] = ['c.user_id = ?']
    const params: SqlValue[] = [userId]

    where.push(options.trash ? 'c.deleted_at IS NOT NULL' : 'c.deleted_at IS NULL')
    if (options.favorite) where.push('c.favorite = 1')

    if (options.bookId === 'unfiled') {
      where.push('c.book_id IS NULL')
    } else if (options.bookId) {
      where.push('c.book_id = ?')
      params.push(options.bookId)
    }

    const search = (options.q ?? '').trim()
    if (search) {
      const pattern = `%${escapeLike(search)}%`
      where.push(
        `(c.title LIKE ? ESCAPE '\\' OR c.excerpt LIKE ? ESCAPE '\\' OR c.tags_json LIKE ? ESCAPE '\\' OR c.content_html LIKE ? ESCAPE '\\' OR c.content_json LIKE ? ESCAPE '\\')`,
      )
      params.push(pattern, pattern, pattern, pattern, pattern)
    }

    const whereSql = where.join(' AND ')
    const totalRow = this.get(`SELECT COUNT(*) AS total FROM contents c WHERE ${whereSql}`, params)
    const total = numberValue(totalRow?.total)

    let orderBy: string
    switch (options.sort) {
      case 'created_desc':
        orderBy = 'c.created_at DESC, c.id DESC'
        break
      case 'title_asc':
        orderBy = 'c.title COLLATE NOCASE ASC, c.updated_at DESC'
        break
      default:
        orderBy = 'c.updated_at DESC, c.id DESC'
        break
    }

    const offset = (options.page - 1) * options.pageSize
    const rows = this.all(
      `${this.contentSelect()} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, options.pageSize, offset],
    )

    return {
      items: rows.map((row) => this.mapContentSummary(row)),
      total,
      page: options.page,
      pageSize: options.pageSize,
    }
  }

  createContent(userId: string, values: ContentWriteValues): ContentDetail {
    const id = randomUUID()
    const createdAt = nowIso()
    this.run(
      `INSERT INTO contents
        (id, user_id, book_id, title, excerpt, content_json, content_html, cover_image, tags_json, status,
         favorite, word_count, image_count, video_count, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        userId,
        values.bookId,
        values.title,
        values.excerpt,
        JSON.stringify(values.contentJson ?? {}),
        values.contentHtml,
        values.coverImage,
        JSON.stringify(values.tags),
        values.status,
        values.favorite ? 1 : 0,
        values.wordCount,
        values.imageCount,
        values.videoCount,
        createdAt,
        createdAt,
      ],
    )
    const content = this.getContentDetail(userId, id)
    if (!content) throw new Error('Failed to create content')
    return content
  }

  updateContent(userId: string, contentId: string, values: ContentWriteValues): ContentDetail | null {
    const changes = this.run(
      `UPDATE contents SET
        book_id = ?, title = ?, excerpt = ?, content_json = ?, content_html = ?, cover_image = ?,
        tags_json = ?, status = ?, favorite = ?, word_count = ?, image_count = ?, video_count = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [
        values.bookId,
        values.title,
        values.excerpt,
        JSON.stringify(values.contentJson ?? {}),
        values.contentHtml,
        values.coverImage,
        JSON.stringify(values.tags),
        values.status,
        values.favorite ? 1 : 0,
        values.wordCount,
        values.imageCount,
        values.videoCount,
        nowIso(),
        contentId,
        userId,
      ],
    )
    if (changes === 0) return null
    return this.getContentDetail(userId, contentId)
  }

  softDeleteContent(userId: string, contentId: string): boolean {
    return (
      this.run('UPDATE contents SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [
        nowIso(),
        contentId,
        userId,
      ]) > 0
    )
  }

  restoreContent(userId: string, contentId: string): boolean {
    return (
      this.run('UPDATE contents SET deleted_at = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL', [
        contentId,
        userId,
      ]) > 0
    )
  }

  permanentlyDeleteContent(userId: string, contentId: string): boolean {
    return this.run('DELETE FROM contents WHERE id = ? AND user_id = ?', [contentId, userId]) > 0
  }

  setContentFavorite(userId: string, contentId: string, favorite: boolean): boolean {
    return (
      this.run('UPDATE contents SET favorite = ? WHERE id = ? AND user_id = ?', [
        favorite ? 1 : 0,
        contentId,
        userId,
      ]) > 0
    )
  }

  // ---------------------------------------------------------------- media

  private mapMedia(row: Row): MediaAsset {
    return {
      id: text(row.id),
      kind: row.kind === 'video' ? 'video' : 'image',
      filename: text(row.filename),
      originalName: text(row.original_name),
      mimeType: text(row.mime_type),
      size: numberValue(row.size),
      url: `/uploads/${text(row.filename)}`,
      createdAt: text(row.created_at),
    }
  }

  createMedia(userId: string, values: CreateMediaValues): MediaAsset {
    const id = randomUUID()
    const createdAt = nowIso()
    this.run(
      `INSERT INTO media (id, user_id, kind, filename, original_name, mime_type, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, values.kind, values.filename, values.originalName, values.mimeType, values.size, createdAt],
    )
    return {
      id,
      kind: values.kind,
      filename: values.filename,
      originalName: values.originalName,
      mimeType: values.mimeType,
      size: values.size,
      url: `/uploads/${values.filename}`,
      createdAt,
    }
  }

  listMedia(userId: string): MediaAsset[] {
    return this.all('SELECT * FROM media WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', [
      userId,
    ]).map((row) => this.mapMedia(row))
  }

  getMedia(userId: string, mediaId: string): MediaAsset | null {
    const row = this.get('SELECT * FROM media WHERE id = ? AND user_id = ?', [mediaId, userId])
    return row ? this.mapMedia(row) : null
  }

  deleteMedia(userId: string, mediaId: string): boolean {
    return this.run('DELETE FROM media WHERE id = ? AND user_id = ?', [mediaId, userId]) > 0
  }

  // -------------------------------------------------------------- renders

  private mapRenderRecord(row: Row): RenderRecord {
    return {
      id: text(row.id),
      contentId: text(row.content_id),
      contentTitle: text(row.content_title),
      platforms: parsePlatforms(row.platforms_json),
      results: parseResults(row.result_json),
      options: parseOptions(row.options_json),
      createdAt: text(row.created_at),
    }
  }

  createRender(userId: string, values: CreateRenderValues): RenderRecord {
    const id = randomUUID()
    const createdAt = nowIso()
    this.run(
      `INSERT INTO renders (id, user_id, content_id, content_title, platforms_json, result_json, options_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        userId,
        values.contentId,
        values.contentTitle,
        JSON.stringify(values.platforms),
        JSON.stringify(values.results),
        JSON.stringify(values.options ?? {}),
        createdAt,
      ],
    )
    return {
      id,
      contentId: values.contentId,
      contentTitle: values.contentTitle,
      platforms: values.platforms,
      results: values.results,
      options: values.options ?? {},
      createdAt,
    }
  }

  listRenders(userId: string, contentId?: string): RenderListItem[] {
    const params: SqlValue[] = [userId]
    let sql = 'SELECT id, content_id, content_title, platforms_json, created_at FROM renders WHERE user_id = ?'
    if (contentId) {
      sql += ' AND content_id = ?'
      params.push(contentId)
    }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT 30'
    return this.all(sql, params).map((row) => ({
      id: text(row.id),
      contentId: text(row.content_id),
      contentTitle: text(row.content_title),
      platforms: parsePlatforms(row.platforms_json),
      createdAt: text(row.created_at),
    }))
  }

  getRender(userId: string, renderId: string, original = false): RenderRecord | null {
    const row = this.get('SELECT * FROM renders WHERE id = ? AND user_id = ?', [renderId, userId])
    if (!row) return null
    const record = this.mapRenderRecord(row)
    if (!original) {
      for (const draft of this.all('SELECT platform, result_json FROM render_drafts WHERE render_id = ?', [renderId])) {
        const result = parseJson(draft.result_json) as RenderRecord['results'][number] | null
        if (result) record.results = record.results.map((item) => item.platform === draft.platform ? result : item)
      }
    }
    return record
  }

  saveRenderDraft(userId: string, renderId: string, result: RenderRecord['results'][number]): boolean {
    const record = this.getRender(userId, renderId)
    if (!record?.platforms.includes(result.platform)) return false
    this.run(`INSERT INTO render_drafts (render_id, platform, result_json) VALUES (?, ?, ?)
      ON CONFLICT(render_id, platform) DO UPDATE SET result_json = excluded.result_json`,
    [renderId, result.platform, JSON.stringify(result)])
    return true
  }

  resetRenderDraft(userId: string, renderId: string, platform: PlatformId): boolean {
    if (!this.getRender(userId, renderId)?.platforms.includes(platform)) return false
    this.run('DELETE FROM render_drafts WHERE render_id = ? AND platform = ?', [renderId, platform])
    return true
  }

  deleteRender(userId: string, renderId: string): boolean {
    return this.run('DELETE FROM renders WHERE id = ? AND user_id = ?', [renderId, userId]) > 0
  }
}

export function openDatabase(filename: string): Database {
  return new Database(filename)
}
