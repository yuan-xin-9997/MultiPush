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
  WechatPublication,
  ZhihuPublication,
  XhsPublication,
  DouyinPublication,
  DouyinResolution,
  XhsResolution,
  ZhihuResolution,
  SspaiPublication,
  SspaiResolution,
  BlogPublication,
  BlogResolution,
  WeiboPublication,
  WeiboResolution,
  ToutiaoPublication,
  ToutiaoResolution,
  AiMessage,
  AiSession,
  AiToolCall,
  BatchJob,
  BatchJobItem,
  BatchJobKind,
  BatchJobStatus,
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

export interface WechatAccountSession {
  encryptedSession: string
  name: string | null
  status: 'connected' | 'expired'
  checkedAt: string
}

export interface ZhihuAccountSession extends WechatAccountSession { accountId: string }

export interface BlogAccountSession {
  encryptedCredentials: string
  accountId: string
  baseUrl: string
  name: string | null
  status: 'connected' | 'expired'
  checkedAt: string
}

export interface AiSettingsRecord {
  encryptedApiKey: string
  baseUrl: string
  model: string
  temperature: number
  updatedAt: string
}

export interface CreateAiMessageValues {
  role: AiMessage['role']
  content: string
  toolCalls?: AiToolCall[]
  toolCallId?: string | null
  toolName?: string | null
  toolArguments?: unknown
  toolResult?: unknown
}

export interface CreateBatchJobValues {
  kind: BatchJobKind
  total: number
  message?: string
  input: unknown
  items: BatchJobItem[]
}

export type UpdateBatchJobValues = Partial<Pick<BatchJob, 'status' | 'done' | 'message' | 'items'>>

export interface CreateWechatPublicationValues {
  renderId: string
  title: string
  mode: WechatPublication['mode']
  idempotencyKey: string
}

export type UpdateWechatPublicationValues = Partial<Pick<WechatPublication, 'status' | 'message' | 'url' | 'remoteId'>>

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
      CREATE TABLE IF NOT EXISTS user_auth_versions (user_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS email_codes (
        scope TEXT PRIMARY KEY, digest TEXT NOT NULL, sent_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
      );
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
      CREATE TABLE IF NOT EXISTS wechat_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wechat_publications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        render_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('draft', 'publish')),
        status TEXT NOT NULL CHECK (status IN ('running', 'draft', 'awaiting_confirmation', 'published', 'failed', 'uncertain')),
        message TEXT NOT NULL,
        url TEXT,
        remote_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_wechat_publications_user_created ON wechat_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS zhihu_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS zhihu_publications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        render_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('draft', 'publish')),
        status TEXT NOT NULL CHECK (status IN ('running', 'draft', 'published', 'failed', 'uncertain')),
        message TEXT NOT NULL,
        url TEXT,
        remote_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_zhihu_publications_user_created ON zhihu_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS zhihu_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES zhihu_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_zhihu_resolutions_publication ON zhihu_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS xiaohongshu_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS xiaohongshu_publications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        render_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('draft', 'publish')),
        status TEXT NOT NULL CHECK (status IN ('running', 'draft', 'published', 'failed', 'uncertain')),
        message TEXT NOT NULL,
        url TEXT,
        remote_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_xiaohongshu_publications_user_created ON xiaohongshu_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS xiaohongshu_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES xiaohongshu_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_xiaohongshu_resolutions_publication ON xiaohongshu_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS douyin_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS douyin_publications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        render_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('draft', 'publish')),
        status TEXT NOT NULL CHECK (status IN ('running', 'draft', 'published', 'failed', 'uncertain')),
        message TEXT NOT NULL,
        url TEXT,
        remote_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_douyin_publications_user_created ON douyin_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS douyin_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES douyin_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_douyin_resolutions_publication ON douyin_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS sspai_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sspai_publications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        render_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('draft', 'publish')),
        status TEXT NOT NULL CHECK (status IN ('running', 'draft', 'published', 'failed', 'uncertain')),
        message TEXT NOT NULL,
        url TEXT,
        remote_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_sspai_publications_user_created ON sspai_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS sspai_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES sspai_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sspai_resolutions_publication ON sspai_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS blog_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_credentials TEXT NOT NULL,
        account_id TEXT NOT NULL,
        base_url TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blog_publications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        render_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('draft', 'publish')),
        status TEXT NOT NULL CHECK (status IN ('running', 'draft', 'published', 'failed', 'uncertain')),
        message TEXT NOT NULL,
        url TEXT,
        remote_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_blog_publications_user_created ON blog_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS blog_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES blog_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_blog_resolutions_publication ON blog_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS ai_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_api_key TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        temperature REAL NOT NULL DEFAULT 0.7,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_updated ON ai_sessions(user_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS ai_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL DEFAULT '',
        tool_calls_json TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        tool_arguments_json TEXT,
        tool_result_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_messages_session_created ON ai_messages(session_id, created_at);
      CREATE TABLE IF NOT EXISTS batch_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('render', 'publish')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        total INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        input_json TEXT NOT NULL DEFAULT '{}',
        items_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_batch_jobs_user_created ON batch_jobs(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS weibo_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS weibo_publications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        render_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('draft', 'publish')),
        status TEXT NOT NULL CHECK (status IN ('running', 'draft', 'published', 'failed', 'uncertain')),
        message TEXT NOT NULL,
        url TEXT,
        remote_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_weibo_publications_user_created ON weibo_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS weibo_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES weibo_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_weibo_resolutions_publication ON weibo_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS toutiao_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS toutiao_publications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        render_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('draft', 'publish')),
        status TEXT NOT NULL CHECK (status IN ('running', 'draft', 'published', 'failed', 'uncertain')),
        message TEXT NOT NULL,
        url TEXT,
        remote_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_toutiao_publications_user_created ON toutiao_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS toutiao_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES toutiao_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_toutiao_resolutions_publication ON toutiao_publication_resolutions(publication_id, created_at DESC);
      PRAGMA user_version = 12;
    `)
    this.run(`UPDATE xiaohongshu_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`, ['服务已重启，请先在小红书核实结果，避免重复发布。', nowIso()])
    this.run(`UPDATE douyin_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`, ['服务已重启，请先核实抖音发布结果，避免重复发布。', nowIso()])
    // Never resend an operation that may already have reached WeChat before a restart.
    this.run(`UPDATE wechat_publications SET status = 'uncertain', message = ?, updated_at = ?
      WHERE status IN ('running', 'awaiting_confirmation')`,
    ['服务已重启，无法确认上次操作结果。请先到微信公众号后台核实，避免重复发表。', nowIso()])
    this.run(`UPDATE zhihu_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对知乎草稿与已发布文章，系统不会自动重复发布。', nowIso()])
    this.run(`UPDATE sspai_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对少数派草稿与已发布文章，系统不会自动重复发布。', nowIso()])
    this.run(`UPDATE blog_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对个人博客草稿与已发布文章，系统不会自动重复发布。', nowIso()])
    this.run(`UPDATE weibo_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对微博发布结果，系统不会自动重复发布。', nowIso()])
    this.run(`UPDATE toutiao_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对今日头条发布结果，系统不会自动重复发布。', nowIso()])
    this.run(`UPDATE batch_jobs SET status = 'failed', message = ?, updated_at = ? WHERE status IN ('queued', 'running')`,
      ['服务已重启，批量任务已中断，请重新提交。', nowIso()])
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

  authVersion(userId: string): number {
    return numberValue(this.get('SELECT version FROM user_auth_versions WHERE user_id = ?', [userId])?.version)
  }

  updateUserPassword(userId: string, passwordHash: string): boolean {
    return this.transaction(() => {
      const changed = this.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [passwordHash, nowIso(), userId]) > 0
      if (changed) this.run(`INSERT INTO user_auth_versions (user_id, version) VALUES (?, 1)
        ON CONFLICT(user_id) DO UPDATE SET version = version + 1`, [userId])
      return changed
    })
  }

  saveEmailCode(scope: string, digest: string, now: number): boolean {
    this.run('DELETE FROM email_codes WHERE sent_at <= ?', [now - 600000])
    return this.run(`INSERT INTO email_codes (scope, digest, sent_at, attempts) VALUES (?, ?, ?, 0)
      ON CONFLICT(scope) DO UPDATE SET digest=excluded.digest, sent_at=excluded.sent_at, attempts=0
      WHERE email_codes.sent_at <= ?`, [scope, digest, now, now - 60000]) > 0
  }

  consumeEmailCode(scope: string, digest: string): boolean {
    this.run('UPDATE email_codes SET attempts = attempts + 1 WHERE scope = ?', [scope])
    return this.run('DELETE FROM email_codes WHERE scope = ? AND digest = ? AND sent_at > ? AND attempts <= 5',
      [scope, digest, Date.now() - 600000]) > 0
  }

  clearEmailCode(scope: string, digest: string): void {
    this.run('DELETE FROM email_codes WHERE scope = ? AND digest = ?', [scope, digest])
  }

  bindUserEmail(userId: string, email: string): User | null {
    this.run("UPDATE users SET email = ?, updated_at = ? WHERE id = ? AND (email IS NULL OR email = '')", [email, nowIso(), userId])
    return this.findUserById(userId)
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

  getMediaByFilename(userId: string, filename: string): MediaAsset | null {
    const row = this.get('SELECT * FROM media WHERE filename = ? AND user_id = ?', [filename, userId])
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

  // -------------------------------------------------------------- WeChat

  getWechatAccount(userId: string): WechatAccountSession | null {
    const row = this.get('SELECT * FROM wechat_accounts WHERE user_id = ?', [userId])
    return row ? {
      encryptedSession: text(row.encrypted_session),
      name: nullableText(row.name),
      status: row.status === 'expired' ? 'expired' : 'connected',
      checkedAt: text(row.checked_at),
    } : null
  }

  saveWechatAccount(userId: string, values: WechatAccountSession): void {
    this.run(`INSERT INTO wechat_accounts (user_id, encrypted_session, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      encrypted_session = excluded.encrypted_session, name = excluded.name,
      status = excluded.status, checked_at = excluded.checked_at`,
    [userId, values.encryptedSession, values.name, values.status, values.checkedAt])
  }

  deleteWechatAccount(userId: string): boolean {
    return this.run('DELETE FROM wechat_accounts WHERE user_id = ?', [userId]) > 0
  }

  private mapWechatPublication(row: Row): WechatPublication {
    return {
      id: text(row.id),
      renderId: text(row.render_id),
      title: text(row.title),
      mode: row.mode as WechatPublication['mode'],
      status: row.status as WechatPublication['status'],
      message: text(row.message),
      qrCode: null,
      url: nullableText(row.url),
      remoteId: nullableText(row.remote_id),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    }
  }

  createWechatPublication(userId: string, values: CreateWechatPublicationValues): WechatPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO wechat_publications
      (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
      ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
    [randomUUID(), userId, values.renderId, values.title, values.mode, '正在处理公众号发布任务', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findWechatPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create WeChat publication')
    return publication
  }

  getWechatPublication(userId: string, id: string): WechatPublication | null {
    const row = this.get('SELECT * FROM wechat_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapWechatPublication(row) : null
  }

  findWechatPublication(userId: string, idempotencyKey: string): WechatPublication | null {
    const row = this.get('SELECT * FROM wechat_publications WHERE user_id = ? AND idempotency_key = ?', [userId, idempotencyKey])
    return row ? this.mapWechatPublication(row) : null
  }

  listWechatPublications(userId: string): WechatPublication[] {
    return this.all('SELECT * FROM wechat_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId])
      .map((row) => this.mapWechatPublication(row))
  }

  updateWechatPublication(userId: string, id: string, values: UpdateWechatPublicationValues): WechatPublication | null {
    const current = this.getWechatPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE wechat_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`,
    [values.status ?? current.status, values.message ?? current.message,
      values.url === undefined ? current.url : values.url,
      values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getWechatPublication(userId, id)
  }

  deleteWechatPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM wechat_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  getZhihuAccount(userId: string): ZhihuAccountSession | null {
    const row = this.get('SELECT * FROM zhihu_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveZhihuAccount(userId: string, values: ZhihuAccountSession): void {
    this.run(`INSERT INTO zhihu_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteZhihuAccount(userId: string): void { this.run('DELETE FROM zhihu_accounts WHERE user_id = ?', [userId]) }

  private mapZhihuPublication(row: Row): ZhihuPublication {
    const resolutions: ZhihuResolution[] = this.all('SELECT * FROM zhihu_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)]).map(r => ({ id: text(r.id), action: r.action as ZhihuResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as ZhihuPublication['mode'], status: row.status as ZhihuPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createZhihuPublication(userId: string, values: CreateWechatPublicationValues): ZhihuPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO zhihu_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备知乎文章', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findZhihuPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create Zhihu publication')
    return publication
  }

  getZhihuPublication(userId: string, id: string): ZhihuPublication | null {
    const row = this.get('SELECT * FROM zhihu_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapZhihuPublication(row) : null
  }

  findZhihuPublication(userId: string, key: string): ZhihuPublication | null {
    const row = this.get('SELECT * FROM zhihu_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapZhihuPublication(row) : null
  }

  listZhihuPublications(userId: string): ZhihuPublication[] {
    return this.all('SELECT * FROM zhihu_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapZhihuPublication(row))
  }

  updateZhihuPublication(userId: string, id: string, values: Partial<Pick<ZhihuPublication, 'status' | 'message' | 'url' | 'remoteId'>>): ZhihuPublication | null {
    const current = this.getZhihuPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE zhihu_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getZhihuPublication(userId, id)
  }

  deleteZhihuPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM zhihu_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveZhihuPublication(userId: string, id: string, action: ZhihuResolution['action'], values: Pick<ZhihuPublication, 'status' | 'message' | 'url' | 'remoteId'>): ZhihuPublication | null {
    return this.transaction(() => {
      const current = this.getZhihuPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO zhihu_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateZhihuPublication(userId, id, values)
    })
  }  getXhsAccount(userId: string): ZhihuAccountSession | null {
    const row = this.get('SELECT * FROM xiaohongshu_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveXhsAccount(userId: string, values: ZhihuAccountSession): void {
    this.run(`INSERT INTO xiaohongshu_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  clearXhsAccounts(): void { this.run('DELETE FROM xiaohongshu_accounts') }

  deleteXhsAccount(userId: string): void { this.run('DELETE FROM xiaohongshu_accounts WHERE user_id = ?', [userId]) }

  private mapXhsPublication(row: Row): XhsPublication {
    const resolutions: XhsResolution[] = this.all('SELECT * FROM xiaohongshu_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)]).map(r => ({ id: text(r.id), action: r.action as XhsResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as XhsPublication['mode'], status: row.status as XhsPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createXhsPublication(userId: string, values: CreateWechatPublicationValues): XhsPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO xiaohongshu_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备小红书文章', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findXhsPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create Xhs publication')
    return publication
  }

  getXhsPublication(userId: string, id: string): XhsPublication | null {
    const row = this.get('SELECT * FROM xiaohongshu_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapXhsPublication(row) : null
  }

  findXhsPublication(userId: string, key: string): XhsPublication | null {
    const row = this.get('SELECT * FROM xiaohongshu_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapXhsPublication(row) : null
  }

  hasUncertainXhsPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM xiaohongshu_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listXhsPublications(userId: string): XhsPublication[] {
    return this.all('SELECT * FROM xiaohongshu_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapXhsPublication(row))
  }

  updateXhsPublication(userId: string, id: string, values: Partial<Pick<XhsPublication, 'status' | 'message' | 'url' | 'remoteId'>>): XhsPublication | null {
    const current = this.getXhsPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE xiaohongshu_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getXhsPublication(userId, id)
  }

  deleteXhsPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM xiaohongshu_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveXhsPublication(userId: string, id: string, action: XhsResolution['action'], values: Pick<XhsPublication, 'status' | 'message' | 'url' | 'remoteId'>): XhsPublication | null {
    return this.transaction(() => {
      const current = this.getXhsPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO xiaohongshu_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateXhsPublication(userId, id, values)
    })
  }
  getDouyinAccount(userId: string): ZhihuAccountSession | null {
    const row = this.get('SELECT * FROM douyin_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveDouyinAccount(userId: string, values: ZhihuAccountSession): void {
    this.run(`INSERT INTO douyin_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteDouyinAccount(userId: string): void { this.run('DELETE FROM douyin_accounts WHERE user_id = ?', [userId]) }

  private mapDouyinPublication(row: Row): DouyinPublication {
    const resolutions: DouyinResolution[] = this.all('SELECT * FROM douyin_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)]).map(r => ({ id: text(r.id), action: r.action as DouyinResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as DouyinPublication['mode'], status: row.status as DouyinPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createDouyinPublication(userId: string, values: CreateWechatPublicationValues): DouyinPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO douyin_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备抖音文章', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findDouyinPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create Douyin publication')
    return publication
  }

  getDouyinPublication(userId: string, id: string): DouyinPublication | null {
    const row = this.get('SELECT * FROM douyin_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapDouyinPublication(row) : null
  }

  findDouyinPublication(userId: string, key: string): DouyinPublication | null {
    const row = this.get('SELECT * FROM douyin_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapDouyinPublication(row) : null
  }

  hasUncertainDouyinPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM douyin_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listDouyinPublications(userId: string): DouyinPublication[] {
    return this.all('SELECT * FROM douyin_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapDouyinPublication(row))
  }

  updateDouyinPublication(userId: string, id: string, values: Partial<Pick<DouyinPublication, 'status' | 'message' | 'url' | 'remoteId'>>): DouyinPublication | null {
    const current = this.getDouyinPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE douyin_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getDouyinPublication(userId, id)
  }

  deleteDouyinPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM douyin_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveDouyinPublication(userId: string, id: string, action: DouyinResolution['action'], values: Pick<DouyinPublication, 'status' | 'message' | 'url' | 'remoteId'>): DouyinPublication | null {
    return this.transaction(() => {
      const current = this.getDouyinPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO douyin_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateDouyinPublication(userId, id, values)
    })
  }

  getSspaiAccount(userId: string): ZhihuAccountSession | null {
    const row = this.get('SELECT * FROM sspai_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status as ZhihuAccountSession['status'], checkedAt: text(row.checked_at) } : null
  }

  saveSspaiAccount(userId: string, values: ZhihuAccountSession): void {
    this.run(`INSERT INTO sspai_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteSspaiAccount(userId: string): void { this.run('DELETE FROM sspai_accounts WHERE user_id = ?', [userId]) }

  private mapSspaiPublication(row: Row): SspaiPublication {
    const resolutions: SspaiResolution[] = this.all('SELECT * FROM sspai_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)])
      .map(r => ({ id: text(r.id), action: r.action as SspaiResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as SspaiPublication['mode'], status: row.status as SspaiPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createSspaiPublication(userId: string, values: CreateWechatPublicationValues): SspaiPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO sspai_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备少数派文章', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findSspaiPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create Sspai publication')
    return publication
  }

  getSspaiPublication(userId: string, id: string): SspaiPublication | null {
    const row = this.get('SELECT * FROM sspai_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapSspaiPublication(row) : null
  }

  findSspaiPublication(userId: string, key: string): SspaiPublication | null {
    const row = this.get('SELECT * FROM sspai_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapSspaiPublication(row) : null
  }

  hasUncertainSspaiPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM sspai_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listSspaiPublications(userId: string): SspaiPublication[] {
    return this.all('SELECT * FROM sspai_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapSspaiPublication(row))
  }

  updateSspaiPublication(userId: string, id: string, values: Partial<Pick<SspaiPublication, 'status' | 'message' | 'url' | 'remoteId'>>): SspaiPublication | null {
    const current = this.getSspaiPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE sspai_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getSspaiPublication(userId, id)
  }

  deleteSspaiPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM sspai_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveSspaiPublication(userId: string, id: string, action: SspaiResolution['action'], values: Pick<SspaiPublication, 'status' | 'message' | 'url' | 'remoteId'>): SspaiPublication | null {
    return this.transaction(() => {
      const current = this.getSspaiPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO sspai_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateSspaiPublication(userId, id, values)
    })
  }

  getBlogAccount(userId: string): BlogAccountSession | null {
    const row = this.get('SELECT * FROM blog_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedCredentials: text(row.encrypted_credentials), accountId: text(row.account_id), baseUrl: text(row.base_url), name: nullableText(row.name), status: row.status as BlogAccountSession['status'], checkedAt: text(row.checked_at) } : null
  }

  saveBlogAccount(userId: string, values: BlogAccountSession): void {
    this.run(`INSERT INTO blog_accounts (user_id, encrypted_credentials, account_id, base_url, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_credentials = excluded.encrypted_credentials,
      account_id = excluded.account_id, base_url = excluded.base_url, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedCredentials, values.accountId, values.baseUrl, values.name, values.status, values.checkedAt])
  }

  deleteBlogAccount(userId: string): void { this.run('DELETE FROM blog_accounts WHERE user_id = ?', [userId]) }

  private mapBlogPublication(row: Row): BlogPublication {
    const resolutions: BlogResolution[] = this.all('SELECT * FROM blog_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)])
      .map(r => ({ id: text(r.id), action: r.action as BlogResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as BlogPublication['mode'], status: row.status as BlogPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createBlogPublication(userId: string, values: CreateWechatPublicationValues): BlogPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO blog_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备个人博客文章', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findBlogPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create blog publication')
    return publication
  }

  getBlogPublication(userId: string, id: string): BlogPublication | null {
    const row = this.get('SELECT * FROM blog_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapBlogPublication(row) : null
  }

  findBlogPublication(userId: string, key: string): BlogPublication | null {
    const row = this.get('SELECT * FROM blog_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapBlogPublication(row) : null
  }

  hasUncertainBlogPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM blog_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listBlogPublications(userId: string): BlogPublication[] {
    return this.all('SELECT * FROM blog_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapBlogPublication(row))
  }

  updateBlogPublication(userId: string, id: string, values: Partial<Pick<BlogPublication, 'status' | 'message' | 'url' | 'remoteId'>>): BlogPublication | null {
    const current = this.getBlogPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE blog_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getBlogPublication(userId, id)
  }

  deleteBlogPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM blog_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveBlogPublication(userId: string, id: string, action: BlogResolution['action'], values: Pick<BlogPublication, 'status' | 'message' | 'url' | 'remoteId'>): BlogPublication | null {
    return this.transaction(() => {
      const current = this.getBlogPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO blog_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateBlogPublication(userId, id, values)
    })
  }

  getWeiboAccount(userId: string): ZhihuAccountSession | null {
    const row = this.get('SELECT * FROM weibo_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveWeiboAccount(userId: string, values: ZhihuAccountSession): void {
    this.run(`INSERT INTO weibo_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteWeiboAccount(userId: string): void { this.run('DELETE FROM weibo_accounts WHERE user_id = ?', [userId]) }

  private mapWeiboPublication(row: Row): WeiboPublication {
    const resolutions: WeiboResolution[] = this.all('SELECT * FROM weibo_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)])
      .map(r => ({ id: text(r.id), action: r.action as WeiboResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as WeiboPublication['mode'], status: row.status as WeiboPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createWeiboPublication(userId: string, values: CreateWechatPublicationValues): WeiboPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO weibo_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备微博发布', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findWeiboPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create Weibo publication')
    return publication
  }

  getWeiboPublication(userId: string, id: string): WeiboPublication | null {
    const row = this.get('SELECT * FROM weibo_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapWeiboPublication(row) : null
  }

  findWeiboPublication(userId: string, key: string): WeiboPublication | null {
    const row = this.get('SELECT * FROM weibo_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapWeiboPublication(row) : null
  }

  hasUncertainWeiboPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM weibo_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listWeiboPublications(userId: string): WeiboPublication[] {
    return this.all('SELECT * FROM weibo_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapWeiboPublication(row))
  }

  updateWeiboPublication(userId: string, id: string, values: Partial<Pick<WeiboPublication, 'status' | 'message' | 'url' | 'remoteId'>>): WeiboPublication | null {
    const current = this.getWeiboPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE weibo_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getWeiboPublication(userId, id)
  }

  deleteWeiboPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM weibo_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveWeiboPublication(userId: string, id: string, action: WeiboResolution['action'], values: Pick<WeiboPublication, 'status' | 'message' | 'url' | 'remoteId'>): WeiboPublication | null {
    return this.transaction(() => {
      const current = this.getWeiboPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO weibo_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateWeiboPublication(userId, id, values)
    })
  }

  getToutiaoAccount(userId: string): ZhihuAccountSession | null {
    const row = this.get('SELECT * FROM toutiao_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveToutiaoAccount(userId: string, values: ZhihuAccountSession): void {
    this.run(`INSERT INTO toutiao_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteToutiaoAccount(userId: string): void { this.run('DELETE FROM toutiao_accounts WHERE user_id = ?', [userId]) }

  private mapToutiaoPublication(row: Row): ToutiaoPublication {
    const resolutions: ToutiaoResolution[] = this.all('SELECT * FROM toutiao_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)])
      .map(r => ({ id: text(r.id), action: r.action as ToutiaoResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as ToutiaoPublication['mode'], status: row.status as ToutiaoPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createToutiaoPublication(userId: string, values: CreateWechatPublicationValues): ToutiaoPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO toutiao_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备今日头条发布', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findToutiaoPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create Toutiao publication')
    return publication
  }

  getToutiaoPublication(userId: string, id: string): ToutiaoPublication | null {
    const row = this.get('SELECT * FROM toutiao_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapToutiaoPublication(row) : null
  }

  findToutiaoPublication(userId: string, key: string): ToutiaoPublication | null {
    const row = this.get('SELECT * FROM toutiao_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapToutiaoPublication(row) : null
  }

  hasUncertainToutiaoPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM toutiao_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listToutiaoPublications(userId: string): ToutiaoPublication[] {
    return this.all('SELECT * FROM toutiao_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapToutiaoPublication(row))
  }

  updateToutiaoPublication(userId: string, id: string, values: Partial<Pick<ToutiaoPublication, 'status' | 'message' | 'url' | 'remoteId'>>): ToutiaoPublication | null {
    const current = this.getToutiaoPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE toutiao_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getToutiaoPublication(userId, id)
  }

  deleteToutiaoPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM toutiao_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveToutiaoPublication(userId: string, id: string, action: ToutiaoResolution['action'], values: Pick<ToutiaoPublication, 'status' | 'message' | 'url' | 'remoteId'>): ToutiaoPublication | null {
    return this.transaction(() => {
      const current = this.getToutiaoPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO toutiao_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateToutiaoPublication(userId, id, values)
    })
  }

  // ------------------------------------------------------------------- AI

  getAiSettings(userId: string): AiSettingsRecord | null {
    const row = this.get('SELECT * FROM ai_settings WHERE user_id = ?', [userId])
    return row ? {
      encryptedApiKey: text(row.encrypted_api_key),
      baseUrl: text(row.base_url),
      model: text(row.model),
      temperature: numberValue(row.temperature),
      updatedAt: text(row.updated_at),
    } : null
  }

  saveAiSettings(userId: string, values: { encryptedApiKey: string; baseUrl: string; model: string; temperature: number }): void {
    const createdAt = nowIso()
    this.run(`INSERT INTO ai_settings (user_id, encrypted_api_key, base_url, model, temperature, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      encrypted_api_key = excluded.encrypted_api_key, base_url = excluded.base_url, model = excluded.model,
      temperature = excluded.temperature, updated_at = excluded.updated_at`,
      [userId, values.encryptedApiKey, values.baseUrl, values.model, values.temperature, createdAt, createdAt])
  }

  deleteAiSettings(userId: string): void { this.run('DELETE FROM ai_settings WHERE user_id = ?', [userId]) }

  createAiSession(userId: string, title = '新会话'): AiSession {
    const id = randomUUID(), createdAt = nowIso()
    this.run('INSERT INTO ai_sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [id, userId, title, createdAt, createdAt])
    const row = this.get('SELECT * FROM ai_sessions WHERE id = ? AND user_id = ?', [id, userId])
    if (!row) throw new Error('Failed to create AI session')
    return this.mapAiSession(row)
  }

  private mapAiSession(row: Row): AiSession {
    return { id: text(row.id), title: text(row.title), createdAt: text(row.created_at), updatedAt: text(row.updated_at) }
  }

  getAiSession(userId: string, id: string): AiSession | null {
    const row = this.get('SELECT * FROM ai_sessions WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapAiSession(row) : null
  }

  listAiSessions(userId: string): AiSession[] {
    return this.all('SELECT * FROM ai_sessions WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50', [userId])
      .map(row => this.mapAiSession(row))
  }

  updateAiSession(userId: string, id: string, values: { title?: string; touch?: boolean }): AiSession | null {
    const current = this.getAiSession(userId, id)
    if (!current) return null
    this.run('UPDATE ai_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [values.title ?? current.title, values.touch === false ? current.updatedAt : nowIso(), id, userId])
    return this.getAiSession(userId, id)
  }

  deleteAiSession(userId: string, id: string): boolean {
    return this.run('DELETE FROM ai_sessions WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  private mapAiMessage(row: Row): AiMessage {
    const toolCalls = parseJson(row.tool_calls_json)
    return {
      id: text(row.id),
      role: row.role as AiMessage['role'],
      content: text(row.content),
      toolCalls: Array.isArray(toolCalls) ? toolCalls as AiToolCall[] : undefined,
      toolCallId: nullableText(row.tool_call_id) ?? undefined,
      toolName: nullableText(row.tool_name) ?? undefined,
      toolArguments: parseJson(row.tool_arguments_json) ?? undefined,
      toolResult: parseJson(row.tool_result_json) ?? undefined,
      createdAt: text(row.created_at),
    }
  }

  listAiMessages(userId: string, sessionId: string): AiMessage[] {
    return this.all('SELECT * FROM ai_messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC, rowid ASC', [sessionId, userId])
      .map(row => this.mapAiMessage(row))
  }

  createAiMessage(userId: string, sessionId: string, values: CreateAiMessageValues): AiMessage {
    const id = randomUUID()
    this.run(`INSERT INTO ai_messages (id, session_id, user_id, role, content, tool_calls_json, tool_call_id, tool_name, tool_arguments_json, tool_result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, sessionId, userId, values.role, values.content,
        values.toolCalls ? JSON.stringify(values.toolCalls) : null,
        values.toolCallId ?? null, values.toolName ?? null,
        values.toolArguments === undefined ? null : JSON.stringify(values.toolArguments),
        values.toolResult === undefined ? null : JSON.stringify(values.toolResult),
        nowIso()])
    const row = this.get('SELECT * FROM ai_messages WHERE id = ? AND user_id = ?', [id, userId])
    if (!row) throw new Error('Failed to create AI message')
    return this.mapAiMessage(row)
  }

  // ---------------------------------------------------------------- batch

  private mapBatchJob(row: Row): BatchJob {
    const items = parseJson(row.items_json)
    return {
      id: text(row.id),
      kind: row.kind as BatchJobKind,
      status: row.status as BatchJobStatus,
      total: numberValue(row.total),
      done: numberValue(row.done),
      message: text(row.message),
      items: Array.isArray(items) ? items as BatchJobItem[] : [],
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    }
  }

  createBatchJob(userId: string, values: CreateBatchJobValues): BatchJob {
    const id = randomUUID(), createdAt = nowIso()
    this.run(`INSERT INTO batch_jobs (id, user_id, kind, status, total, done, message, input_json, items_json, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?)`,
      [id, userId, values.kind, values.total, values.message ?? '等待处理', JSON.stringify(values.input), JSON.stringify(values.items), createdAt, createdAt])
    const job = this.getBatchJob(userId, id)
    if (!job) throw new Error('Failed to create batch job')
    return job
  }

  getBatchJob(userId: string, id: string): BatchJob | null {
    const row = this.get('SELECT * FROM batch_jobs WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapBatchJob(row) : null
  }

  getBatchJobInput(userId: string, id: string): unknown {
    const row = this.get('SELECT input_json FROM batch_jobs WHERE id = ? AND user_id = ?', [id, userId])
    return row ? parseJson(row.input_json) : null
  }

  listBatchJobs(userId: string): BatchJob[] {
    return this.all('SELECT * FROM batch_jobs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20', [userId])
      .map(row => this.mapBatchJob(row))
  }

  updateBatchJob(userId: string, id: string, values: UpdateBatchJobValues): BatchJob | null {
    const current = this.getBatchJob(userId, id)
    if (!current) return null
    this.run(`UPDATE batch_jobs SET status = ?, done = ?, message = ?, items_json = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.done ?? current.done, values.message ?? current.message,
        JSON.stringify(values.items ?? current.items), nowIso(), id, userId])
    return this.getBatchJob(userId, id)
  }
}

export function openDatabase(filename: string): Database {
  return new Database(filename)
}
