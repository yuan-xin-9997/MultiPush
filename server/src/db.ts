import { randomUUID } from 'node:crypto'
import { contentHtmlHash, jsonHasContent } from './tiptap-html'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  Book,
  ContentDetail,
  ContentKind,
  ContentListResult,
  ContentStatus,
  ContentSummary,
  MediaAsset,
  MediaFolder,
  MediaKind,
  MediaStats,
  PlatformId,
  PlatformOptionOverrides,
  RenderListItem,
  RenderOptions,
  RenderRecord,
  RichTextJson,
  User,
  VideoClip,
  VideoClipDetail,
  VideoExport,
  VideoExportStatus,
  WechatPublication,
  WechatpicPublication,
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
  BaijiahaoPublication,
  BaijiahaoResolution,
  DoubanPublication,
  DoubanResolution,
  JuejinPublication,
  JuejinResolution,
  CsdnPublication,
  CsdnResolution,
  JianshuPublication,
  JianshuResolution,
  V2exPublication,
  V2exResolution,
  AiMessage,
  AiMessageAttachment,
  AiSession,
  AiToolCall,
  AiFailoverEvent,
  AiFailoverEventKind,
  AiKeyState,
  AiProviderRequest,
  AiProviderState,
  BatchJob,
  BatchJobItem,
  BatchJobKind,
  BatchJobStatus,
  BilibiliPublication,
  BilibiliPublicationType,
  BilibiliPublicationStatus,
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

function parsePlatformOptions(value: unknown): PlatformOptionOverrides {
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const result: PlatformOptionOverrides = {}
  for (const [platform, options] of Object.entries(parsed)) {
    if (!(PLATFORM_ORDER as string[]).includes(platform)) continue
    if (!options || typeof options !== 'object' || Array.isArray(options)) continue
    result[platform as PlatformId] = options as RenderOptions
  }
  return result
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

/** Persisted `contents.kind` values: keep older/unknown values on the article path. */
function normalizeContentKind(value: unknown): ContentKind {
  if (value === 'video') return 'video'
  if (value === 'gallery') return 'gallery'
  return 'article'
}

/** Effective seconds a stored clip plays after its trim is applied. */
function clipTrimDuration(clip: StoredVideoClip): number {
  if (clip.trimEnd !== null) return Math.max(0, clip.trimEnd - clip.trimStart)
  if (clip.duration !== null) return Math.max(0, clip.duration - clip.trimStart)
  return 0
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
  kind: ContentKind
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
  /** Leave unset to hash contentHtml; set explicitly to preserve the mismatch. */
  contentHtmlHash?: string
  contentJsonStale?: boolean
}

export interface ContentListOptions {
  bookId?: string
  favorite: boolean
  trash: boolean
  q?: string
  kind?: ContentKind
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
  folderId?: string | null
  /** ffprobe metadata for videos; stored as JSON in media.meta_json. */
  meta?: MediaProbeMeta | null
}

export interface MediaListOptions {
  kind?: MediaKind
  q?: string
  folderId?: string
  page: number
  pageSize: number
}

export interface MediaFilterOptions {
  kind?: MediaKind
  q?: string
  folderId?: string
}

/** Lightweight probe result persisted next to a video media asset. */
export interface MediaProbeMeta {
  duration?: number | null
  width?: number | null
  height?: number | null
  hasAudio?: boolean
  videoCodec?: string | null
  audioCodec?: string | null
}

/** A timeline row as stored inside video_projects.timeline_json. */
export interface StoredVideoClip {
  id: string
  mediaId: string
  trimStart: number
  trimEnd: number | null
  duration: number | null
}

export interface SaveVideoProjectValues {
  clips: StoredVideoClip[]
  /** Raw material ids in upload order. Omit to preserve the existing list. */
  materials?: string[] | null
}

export interface CreateVideoExportValues {
  contentId: string
  timeline: StoredVideoClip[]
  totalDuration: number
}

export interface UpdateVideoExportValues {
  status?: VideoExportStatus
  progress?: number
  message?: string
  outputMediaId?: string | null
}

export interface CreateRenderValues {
  contentId: string
  contentTitle: string
  platforms: PlatformId[]
  options: RenderOptions
  platformOptions?: PlatformOptionOverrides
  results: RenderRecord['results']
}

export interface CreateBilibiliPublicationValues {
  renderId: string
  title: string
  type: BilibiliPublicationType
  mode: 'draft' | 'publish'
  idempotencyKey: string
}

export interface BilibiliAccountSession {
  encryptedSession: string
  accountId: string
  name: string | null
  status: 'connected' | 'expired'
  checkedAt: string
}

export interface BilibiliResolutionRecord {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface WechatAccountSession {
  encryptedSession: string
  name: string | null
  status: 'connected' | 'expired'
  checkedAt: string
}

export interface ZhihuAccountSession extends WechatAccountSession { accountId: string }
export interface V2exAccountSession extends WechatAccountSession { accountId: string }

export interface BlogAccountSession {
  encryptedCredentials: string
  accountId: string
  baseUrl: string
  name: string | null
  status: 'connected' | 'expired'
  checkedAt: string
}

export interface WechatpicAccountSession {
  encryptedCredentials: string
  appId: string
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
  attachments?: AiMessageAttachment[]
}

export interface AiKeyStateRecord {
  providerId: string
  keyId: string
  state: AiKeyState
  reason: string | null
  cooldownUntil: string | null
  successCount: number
  failureCount: number
  quotaFailures: number
  authFailures: number
  rateLimits: number
  tokensIn: number
  tokensOut: number
  lastUsedAt: string | null
  lastError: string | null
  updatedAt: string
}

export interface AiProviderStateRecord {
  providerId: string
  state: AiProviderState
  reason: string | null
  cooldownUntil: string | null
  consecutiveFailures: number
  lastError: string | null
  updatedAt: string
}

export interface CreateAiFailoverEventValues {
  userId: string | null
  sessionId?: string | null
  kind: AiFailoverEventKind
  reason: string
  detail?: string | null
  fromProviderId?: string | null
  fromProviderLabel?: string | null
  fromKeyId?: string | null
  fromKeyLabel?: string | null
  fromKeyMasked?: string | null
  toProviderId?: string | null
  toProviderLabel?: string | null
  toKeyId?: string | null
  toKeyLabel?: string | null
  toKeyMasked?: string | null
  model?: string | null
  targetModel?: string | null
}

export interface CreateAiProviderRequestValues {
  userId: string
  sessionId?: string | null
  providerId: string
  providerLabel: string
  model: string
  keyId: string
  keyLabel: string
  keyMasked: string
  status: 'success' | 'failed'
  httpStatus?: number | null
  errorCode?: string | null
  durationMs: number
  tokensIn?: number
  tokensOut?: number
}

export interface CreateBatchJobValues {
  kind: BatchJobKind
  total: number
  message?: string
  input: unknown
  items: BatchJobItem[]
}

export type UpdateBatchJobValues = Partial<Pick<BatchJob, 'status' | 'done' | 'message' | 'items'>>

export interface CreateDoubanPublicationValues {
  renderId: string
  title: string
  mode: DoubanPublication['mode']
  idempotencyKey: string
}

export interface CreateJuejinPublicationValues {
  renderId: string
  title: string
  mode: JuejinPublication['mode']
  idempotencyKey: string
}

export interface CreateCsdnPublicationValues {
  renderId: string
  title: string
  mode: CsdnPublication['mode']
  idempotencyKey: string
}

export interface CreateJianshuPublicationValues {
  renderId: string
  title: string
  mode: JianshuPublication['mode']
  idempotencyKey: string
}

export interface CreateV2exPublicationValues {
  renderId: string
  title: string
  nodeName: string
  idempotencyKey: string
}

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
        kind TEXT NOT NULL DEFAULT 'article' CHECK (kind IN ('article', 'gallery', 'video')),
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
      CREATE INDEX IF NOT EXISTS idx_contents_user_updated ON contents(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contents_user_deleted ON contents(user_id, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_contents_book ON contents(book_id);

      CREATE TABLE IF NOT EXISTS media_folders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_media_folders_user_name ON media_folders(user_id, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_media_folders_user_updated ON media_folders(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        folder_id TEXT REFERENCES media_folders(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document')),
        filename TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        meta_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_user_created ON media(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS video_projects (
        content_id TEXT PRIMARY KEY REFERENCES contents(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        timeline_json TEXT NOT NULL DEFAULT '[]',
        materials_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_video_projects_user ON video_projects(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS video_exports (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        progress INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        timeline_json TEXT NOT NULL DEFAULT '[]',
        output_media_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_video_exports_user_created ON video_exports(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_video_exports_content ON video_exports(content_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS renders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
        content_title TEXT NOT NULL,
        platforms_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '{}',
        platform_options_json TEXT NOT NULL DEFAULT '{}',
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
      CREATE TABLE IF NOT EXISTS wechatpic_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_credentials TEXT NOT NULL,
        app_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wechatpic_publications (
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
      CREATE INDEX IF NOT EXISTS idx_wechatpic_publications_user_created ON wechatpic_publications(user_id, created_at DESC);
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
        attachments_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_messages_session_created ON ai_messages(session_id, created_at);
      CREATE TABLE IF NOT EXISTS ai_provider_key_states (
        provider_id TEXT NOT NULL,
        key_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('available', 'cooling', 'exhausted', 'invalid')),
        reason TEXT,
        cooldown_until TEXT,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        quota_failures INTEGER NOT NULL DEFAULT 0,
        auth_failures INTEGER NOT NULL DEFAULT 0,
        rate_limits INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider_id, key_id)
      );
      CREATE TABLE IF NOT EXISTS ai_provider_states (
        provider_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('available', 'cooling')),
        reason TEXT,
        cooldown_until TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_failover_events (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT,
        from_provider_id TEXT,
        from_provider_label TEXT,
        from_key_id TEXT,
        from_key_label TEXT,
        from_key_masked TEXT,
        to_provider_id TEXT,
        to_provider_label TEXT,
        to_key_id TEXT,
        to_key_label TEXT,
        to_key_masked TEXT,
        model TEXT,
        target_model TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_failover_events_user_created ON ai_failover_events(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS ai_provider_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT,
        provider_id TEXT NOT NULL,
        provider_label TEXT NOT NULL,
        model TEXT NOT NULL,
        key_id TEXT NOT NULL,
        key_label TEXT NOT NULL,
        key_masked TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
        http_status INTEGER,
        error_code TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_provider_requests_user_created ON ai_provider_requests(user_id, created_at DESC);
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
      CREATE TABLE IF NOT EXISTS baijiahao_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS baijiahao_publications (
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
      CREATE INDEX IF NOT EXISTS idx_baijiahao_publications_user_created ON baijiahao_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS baijiahao_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES baijiahao_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_baijiahao_resolutions_publication ON baijiahao_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS douban_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS douban_publications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        render_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'publish',
        status TEXT NOT NULL CHECK (status IN ('running', 'draft', 'published', 'failed', 'uncertain')),
        message TEXT NOT NULL,
        url TEXT,
        remote_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_douban_publications_user_created ON douban_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS douban_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES douban_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_douban_resolutions_publication ON douban_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS juejin_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS juejin_publications (
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
      CREATE INDEX IF NOT EXISTS idx_juejin_publications_user_created ON juejin_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS juejin_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES juejin_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_juejin_resolutions_publication ON juejin_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS csdn_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS csdn_publications (
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
      CREATE INDEX IF NOT EXISTS idx_csdn_publications_user_created ON csdn_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS csdn_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES csdn_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_csdn_resolutions_publication ON csdn_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS jianshu_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jianshu_publications (
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
      CREATE INDEX IF NOT EXISTS idx_jianshu_publications_user_created ON jianshu_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS jianshu_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES jianshu_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jianshu_resolutions_publication ON jianshu_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS v2ex_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v2ex_publications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        render_id TEXT NOT NULL,
        title TEXT NOT NULL,
        node_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'published', 'failed', 'uncertain')),
        message TEXT NOT NULL,
        url TEXT,
        remote_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_v2ex_publications_user_created ON v2ex_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS v2ex_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES v2ex_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_v2ex_resolutions_publication ON v2ex_publication_resolutions(publication_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS bilibili_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_session TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'expired')),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bilibili_publications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        render_id TEXT NOT NULL,
        title TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('video', 'article')),
        mode TEXT NOT NULL CHECK (mode IN ('draft', 'publish')),
        status TEXT NOT NULL CHECK (status IN ('running', 'draft', 'reviewing', 'published', 'failed', 'uncertain')),
        message TEXT NOT NULL,
        url TEXT,
        remote_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_bilibili_publications_user_created ON bilibili_publications(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS bilibili_publication_resolutions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        publication_id TEXT NOT NULL REFERENCES bilibili_publications(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('check', 'not_published', 'published')),
        message TEXT NOT NULL,
        article_url TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bilibili_resolutions_publication ON bilibili_publication_resolutions(publication_id, created_at DESC);
      PRAGMA user_version = 23;
    `)
    this.ensureContentSyncColumns()
    this.ensureVideoColumns()
    this.ensureVideoMaterialsColumn()
    this.ensureGalleryKind()
    this.ensureDocumentMediaKind()
    this.ensureMediaFolders()
    this.ensureDoubanPublicationColumns()
    this.ensureAiColumns()
    this.ensureRenderPlatformOptions()
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
    this.run(`UPDATE wechatpic_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对公众号草稿箱中的贴图草稿，系统不会自动重复创建。', nowIso()])
    this.run(`UPDATE weibo_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对微博发布结果，系统不会自动重复发布。', nowIso()])
    this.run(`UPDATE toutiao_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对今日头条发布结果，系统不会自动重复发布。', nowIso()])
    this.run(`UPDATE baijiahao_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对百家号发布结果，系统不会自动重复发布。', nowIso()])

    this.run(`UPDATE douban_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对豆瓣日记发布结果，系统不会自动重复发布。', nowIso()])
    this.run(`UPDATE juejin_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对掘金草稿与文章发布结果，系统不会自动重复发布。', nowIso()])
    this.run(`UPDATE jianshu_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对简书草稿与文章发布结果，系统不会自动重复发布。', nowIso()])
    this.run(`UPDATE bilibili_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对 B 站投稿/专栏是否已提交，避免重复发布。', nowIso()])
    this.run(`UPDATE v2ex_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核实 V2EX 主题是否已发布，避免重复发布。', nowIso()])
    this.run(`UPDATE csdn_publications SET status = 'uncertain', message = ?, updated_at = ? WHERE status = 'running'`,
      ['服务已重启，请先核对 CSDN 草稿箱与文章发布结果，系统不会自动重复发布。', nowIso()])
    this.run(`UPDATE batch_jobs SET status = 'failed', message = ?, updated_at = ? WHERE status IN ('queued', 'running')`,
      ['服务已重启，批量任务已中断，请重新提交。', nowIso()])
    this.failRunningVideoExports()
  }

  /** Older Douban tables had no draft mode; add it without rewriting rows. */
  private ensureDoubanPublicationColumns(): void {
    const columns = new Set(this.all('PRAGMA table_info(douban_publications)').map((row) => text(row.name)))
    if (!columns.has('mode')) this.database.exec("ALTER TABLE douban_publications ADD COLUMN mode TEXT NOT NULL DEFAULT 'publish'")
  }

  /** Additive migration for per-platform render settings on older databases. */
  private ensureRenderPlatformOptions(): void {
    const columns = new Set(this.all('PRAGMA table_info(renders)').map((row) => text(row.name)))
    if (!columns.has('platform_options_json')) {
      this.database.exec("ALTER TABLE renders ADD COLUMN platform_options_json TEXT NOT NULL DEFAULT '{}'")
    }
  }

  /** Additive migration for AI message attachments on older databases. */
  private ensureAiColumns(): void {
    const columns = new Set(this.all('PRAGMA table_info(ai_messages)').map((row) => text(row.name)))
    if (!columns.has('attachments_json')) {
      this.database.exec('ALTER TABLE ai_messages ADD COLUMN attachments_json TEXT')
    }
  }

  /**
   * Additive migration for video contents: `contents.kind`, `media.meta_json`
   * and the video project/export tables. Older databases keep working and
   * existing rows default to the article kind.
   */
  private ensureVideoColumns(): void {
    const contentColumns = new Set(this.all('PRAGMA table_info(contents)').map((row) => text(row.name)))
    if (!contentColumns.has('kind')) {
      this.database.exec("ALTER TABLE contents ADD COLUMN kind TEXT NOT NULL DEFAULT 'article'")
    }
    const mediaColumns = new Set(this.all('PRAGMA table_info(media)').map((row) => text(row.name)))
    if (!mediaColumns.has('meta_json')) {
      this.database.exec('ALTER TABLE media ADD COLUMN meta_json TEXT')
    }
  }

  /**
   * Older databases constrain `contents.kind` to article/video. SQLite cannot
   * alter a CHECK constraint in place, so rebuild the table once to allow the
   * image-first `gallery` kind. Foreign keys are disabled only for the rebuild
   * and checked again before returning.
   */
  private ensureVideoMaterialsColumn(): void {
    const columns = new Set(this.all('PRAGMA table_info(video_projects)').map((row) => text(row.name)))
    if (!columns.has('materials_json')) this.run('ALTER TABLE video_projects ADD COLUMN materials_json TEXT')
  }

  private ensureGalleryKind(): void {
    const row = this.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'contents'")
    const tableSql = text(row?.sql)
    if (!tableSql || tableSql.includes("'gallery'")) return
    if (!/check\s*\(\s*kind\s+in/i.test(tableSql)) return

    this.database.exec('PRAGMA foreign_keys = OFF')
    try {
      this.transaction(() => {
        this.database.exec(`
          DROP TABLE IF EXISTS contents_gallery_migration;
          CREATE TABLE contents_gallery_migration (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
            kind TEXT NOT NULL DEFAULT 'article' CHECK (kind IN ('article', 'gallery', 'video')),
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
          INSERT INTO contents_gallery_migration
            (id, user_id, book_id, kind, title, excerpt, content_json, content_html, content_html_hash,
             content_json_stale, cover_image, tags_json, status, favorite, word_count, image_count,
             video_count, created_at, updated_at, deleted_at)
          SELECT id, user_id, book_id, kind, title, excerpt, content_json, content_html, content_html_hash,
             content_json_stale, cover_image, tags_json, status, favorite, word_count, image_count,
             video_count, created_at, updated_at, deleted_at
          FROM contents;
          DROP TABLE contents;
          ALTER TABLE contents_gallery_migration RENAME TO contents;
          CREATE INDEX IF NOT EXISTS idx_contents_user_updated ON contents(user_id, updated_at DESC);
          CREATE INDEX IF NOT EXISTS idx_contents_user_deleted ON contents(user_id, deleted_at);
          CREATE INDEX IF NOT EXISTS idx_contents_book ON contents(book_id);
        `)
      })
    } finally {
      this.database.exec('PRAGMA foreign_keys = ON')
    }
    const violations = this.all('PRAGMA foreign_key_check')
    if (violations.length > 0) {
      throw new Error('contents table migration for gallery kind broke foreign keys')
    }
  }

  /**
   * Older databases restrict `media.kind` to image/video. Rebuild the table
   * once to allow document assets; media has no incoming foreign keys, so only
   * its own rows and index need to be preserved.
   */
  private ensureDocumentMediaKind(): void {
    const row = this.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media'")
    const tableSql = text(row?.sql)
    if (!tableSql || tableSql.includes("'document'")) return
    if (!/check\s*\(\s*kind\s+in/i.test(tableSql)) return

    this.database.exec('PRAGMA foreign_keys = OFF')
    try {
      this.transaction(() => {
        this.database.exec(`
          DROP TABLE IF EXISTS media_document_migration;
          CREATE TABLE media_document_migration (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            folder_id TEXT REFERENCES media_folders(id) ON DELETE SET NULL,
            kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document')),
            filename TEXT NOT NULL UNIQUE,
            original_name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            meta_json TEXT,
            created_at TEXT NOT NULL
          );
          INSERT INTO media_document_migration
            (id, user_id, kind, filename, original_name, mime_type, size, meta_json, created_at)
          SELECT id, user_id, kind, filename, original_name, mime_type, size, meta_json, created_at
          FROM media;
          DROP TABLE media;
          ALTER TABLE media_document_migration RENAME TO media;
          CREATE INDEX IF NOT EXISTS idx_media_user_created ON media(user_id, created_at DESC);
        `)
      })
    } finally {
      this.database.exec('PRAGMA foreign_keys = ON')
    }
    const violations = this.all('PRAGMA foreign_key_check')
    if (violations.length > 0) {
      throw new Error('media table migration for document kind broke foreign keys')
    }
  }

  /** Additive migration: folder support for existing media tables. */
  private ensureMediaFolders(): void {
    const columns = new Set(
      this.all('PRAGMA table_info(media)').map((row) => text(row.name)),
    )
    if (!columns.has('folder_id')) {
      this.database.exec('ALTER TABLE media ADD COLUMN folder_id TEXT REFERENCES media_folders(id) ON DELETE SET NULL')
    }
    this.database.exec('CREATE INDEX IF NOT EXISTS idx_media_folder ON media(folder_id)')
  }

  /** Additive migration: older databases keep working and are backfilled once. */
  private ensureContentSyncColumns(): void {
    const columns = new Set(
      this.all('PRAGMA table_info(contents)').map((row) => text(row.name)),
    )
    if (!columns.has('content_html_hash')) {
      this.database.exec('ALTER TABLE contents ADD COLUMN content_html_hash TEXT')
    }
    if (!columns.has('content_json_stale')) {
      this.database.exec('ALTER TABLE contents ADD COLUMN content_json_stale INTEGER NOT NULL DEFAULT 0')
    }
    const missing = this.all('SELECT id, content_html FROM contents WHERE content_html_hash IS NULL OR content_html_hash = ?', [''])
    if (missing.length > 0) {
      this.transaction(() => {
        for (const row of missing) {
          this.run('UPDATE contents SET content_html_hash = ? WHERE id = ?', [contentHtmlHash(text(row.content_html)), text(row.id)])
        }
      })
    }
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
      kind: normalizeContentKind(row.kind),
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
    const contentHtml = text(row.content_html)
    const contentJson = parseContentJson(row.content_json)
    const storedHash = nullableText(row.content_html_hash)
    const currentHash = contentHtmlHash(contentHtml)
    const jsonEmpty = !jsonHasContent(contentJson)
    // A JSON document is stale when it had content but the HTML no longer
    // matches the checksum captured at the last synchronous save, or when the
    // JSON is empty while HTML carries the article (legacy imports).
    const stale = numberValue(row.content_json_stale) === 1
      || (jsonEmpty ? contentHtml.trim().length > 0 : storedHash !== null && storedHash !== currentHash)
      || (!jsonEmpty && storedHash === null)
    return {
      ...this.mapContentSummary(row),
      contentJson,
      contentHtml,
      contentJsonStale: stale,
      contentHtmlHash: storedHash ?? currentHash,
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

    if (options.kind) {
      where.push('c.kind = ?')
      params.push(options.kind)
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
        (id, user_id, book_id, kind, title, excerpt, content_json, content_html, content_html_hash, content_json_stale,
         cover_image, tags_json, status, favorite, word_count, image_count, video_count, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        userId,
        values.bookId,
        normalizeContentKind(values.kind),
        values.title,
        values.excerpt,
        JSON.stringify(values.contentJson ?? {}),
        values.contentHtml,
        values.contentHtmlHash ?? contentHtmlHash(values.contentHtml),
        values.contentJsonStale ? 1 : 0,
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
        book_id = ?, kind = ?, title = ?, excerpt = ?, content_json = ?, content_html = ?, content_html_hash = ?,
        content_json_stale = ?, cover_image = ?, tags_json = ?, status = ?, favorite = ?, word_count = ?,
        image_count = ?, video_count = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [
        values.bookId,
        normalizeContentKind(values.kind),
        values.title,
        values.excerpt,
        JSON.stringify(values.contentJson ?? {}),
        values.contentHtml,
        values.contentHtmlHash ?? contentHtmlHash(values.contentHtml),
        values.contentJsonStale ? 1 : 0,
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

  private mapMediaFolder(row: Row): MediaFolder {
    return {
      id: text(row.id),
      name: text(row.name),
      assetCount: numberValue(row.asset_count),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    }
  }

  listMediaFolders(userId: string): MediaFolder[] {
    return this.all(
      `SELECT f.*, COUNT(m.id) AS asset_count
       FROM media_folders f
       LEFT JOIN media m ON m.folder_id = f.id AND m.user_id = f.user_id
       WHERE f.user_id = ?
       GROUP BY f.id
       ORDER BY f.name COLLATE NOCASE ASC, f.created_at ASC`,
      [userId],
    ).map((row) => this.mapMediaFolder(row))
  }

  getMediaFolder(userId: string, folderId: string): MediaFolder | null {
    const row = this.get(
      `SELECT f.*,
        (SELECT COUNT(*) FROM media m WHERE m.folder_id = f.id AND m.user_id = f.user_id) AS asset_count
       FROM media_folders f WHERE f.id = ? AND f.user_id = ?`,
      [folderId, userId],
    )
    return row ? this.mapMediaFolder(row) : null
  }

  getMediaFolderByName(userId: string, name: string): MediaFolder | null {
    const row = this.get(
      `SELECT f.*,
        (SELECT COUNT(*) FROM media m WHERE m.folder_id = f.id AND m.user_id = f.user_id) AS asset_count
       FROM media_folders f WHERE f.user_id = ? AND f.name = ? COLLATE NOCASE`,
      [userId, name],
    )
    return row ? this.mapMediaFolder(row) : null
  }

  createMediaFolder(userId: string, name: string): MediaFolder {
    const id = randomUUID()
    const now = nowIso()
    this.run(
      'INSERT INTO media_folders (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [id, userId, name, now, now],
    )
    const folder = this.getMediaFolder(userId, id)
    if (!folder) throw new Error('Failed to create media folder')
    return folder
  }

  renameMediaFolder(userId: string, folderId: string, name: string): MediaFolder | null {
    const changes = this.run(
      'UPDATE media_folders SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [name, nowIso(), folderId, userId],
    )
    return changes > 0 ? this.getMediaFolder(userId, folderId) : null
  }

  deleteMediaFolder(userId: string, folderId: string): { moved: number } | null {
    if (!this.getMediaFolder(userId, folderId)) return null
    let moved = 0
    this.transaction(() => {
      moved = this.run('UPDATE media SET folder_id = NULL WHERE folder_id = ? AND user_id = ?', [folderId, userId])
      this.run('DELETE FROM media_folders WHERE id = ? AND user_id = ?', [folderId, userId])
    })
    return { moved }
  }

  moveMedia(userId: string, mediaId: string, folderId: string | null): MediaAsset | null {
    const changes = this.run(
      'UPDATE media SET folder_id = ? WHERE id = ? AND user_id = ?',
      [folderId, mediaId, userId],
    )
    return changes > 0 ? this.getMedia(userId, mediaId) : null
  }

  private mapMedia(row: Row): MediaAsset {
    const meta = parseJson(row.meta_json) as MediaProbeMeta | null
    return {
      id: text(row.id),
      kind: row.kind === 'video' ? 'video' : row.kind === 'document' ? 'document' : 'image',
      filename: text(row.filename),
      originalName: text(row.original_name),
      mimeType: text(row.mime_type),
      size: numberValue(row.size),
      url: `/uploads/${text(row.filename)}`,
      duration: meta && typeof meta.duration === 'number' ? meta.duration : null,
      width: meta && typeof meta.width === 'number' ? meta.width : null,
      height: meta && typeof meta.height === 'number' ? meta.height : null,
      folderId: nullableText(row.folder_id),
      createdAt: text(row.created_at),
    }
  }

  createMedia(userId: string, values: CreateMediaValues): MediaAsset {
    const id = randomUUID()
    const createdAt = nowIso()
    this.run(
      `INSERT INTO media (id, user_id, folder_id, kind, filename, original_name, mime_type, size, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, values.folderId ?? null, values.kind, values.filename, values.originalName,
        values.mimeType, values.size, values.meta ? JSON.stringify(values.meta) : null, createdAt],
    )
    return {
      id,
      kind: values.kind,
      filename: values.filename,
      originalName: values.originalName,
      mimeType: values.mimeType,
      size: values.size,
      url: `/uploads/${values.filename}`,
      duration: values.meta?.duration ?? null,
      width: values.meta?.width ?? null,
      height: values.meta?.height ?? null,
      folderId: values.folderId ?? null,
      createdAt,
    }
  }

  /** Store or refresh ffprobe metadata for a media asset (no-op when absent). */
  updateMediaMeta(userId: string, mediaId: string, meta: MediaProbeMeta): boolean {
    return this.run('UPDATE media SET meta_json = ? WHERE id = ? AND user_id = ?', [JSON.stringify(meta), mediaId, userId]) > 0
  }

  private mediaWhere(userId: string, options: MediaFilterOptions): { clause: string; params: SqlValue[] } {
    const where = ['user_id = ?']
    const params: SqlValue[] = [userId]
    if (options.kind) {
      where.push('kind = ?')
      params.push(options.kind)
    }
    if (options.folderId === 'unfiled') {
      where.push('folder_id IS NULL')
    } else if (options.folderId) {
      where.push('folder_id = ?')
      params.push(options.folderId)
    }
    const search = (options.q ?? '').trim()
    if (search) {
      const pattern = `%${escapeLike(search)}%`
      where.push("(original_name LIKE ? ESCAPE '\\' OR mime_type LIKE ? ESCAPE '\\')")
      params.push(pattern, pattern)
    }
    return { clause: where.join(' AND '), params }
  }

  listMedia(userId: string, options: Partial<MediaListOptions> = {}): MediaAsset[] {
    const page = Math.max(1, options.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 100))
    const { clause, params } = this.mediaWhere(userId, options)
    return this.all(
      `SELECT * FROM media WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    ).map((row) => this.mapMedia(row))
  }

  countMedia(userId: string, options: MediaFilterOptions = {}): number {
    const { clause, params } = this.mediaWhere(userId, options)
    return numberValue(this.get(`SELECT COUNT(*) AS total FROM media WHERE ${clause}`, params)?.total)
  }

  getMediaStats(userId: string, options: MediaFilterOptions = {}): MediaStats {
    const { clause, params } = this.mediaWhere(userId, options)
    const row = this.get(
      `SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END), 0) AS images,
        COALESCE(SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END), 0) AS videos,
        COALESCE(SUM(CASE WHEN kind = 'document' THEN 1 ELSE 0 END), 0) AS documents,
        COALESCE(SUM(size), 0) AS bytes
       FROM media WHERE ${clause}`,
      params,
    )
    return {
      total: numberValue(row?.total),
      images: numberValue(row?.images),
      videos: numberValue(row?.videos),
      documents: numberValue(row?.documents),
      bytes: numberValue(row?.bytes),
    }
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

  // ---------------------------------------------------------------- video projects

  private mapStoredClips(value: unknown): StoredVideoClip[] {
    if (!Array.isArray(value)) return []
    const clips: StoredVideoClip[] = []
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue
      const record = raw as Record<string, unknown>
      const mediaId = typeof record.mediaId === 'string' ? record.mediaId : null
      if (!mediaId) continue
      const trimStart = typeof record.trimStart === 'number' && record.trimStart >= 0 ? record.trimStart : 0
      const trimEnd = typeof record.trimEnd === 'number' && record.trimEnd > trimStart ? record.trimEnd : null
      clips.push({
        id: typeof record.id === 'string' && record.id ? record.id : randomUUID(),
        mediaId,
        trimStart,
        trimEnd,
        duration: typeof record.duration === 'number' && record.duration > 0 ? record.duration : null,
      })
    }
    return clips
  }

  private mapClipDetails(clips: StoredVideoClip[], userId: string): VideoClipDetail[] {
    if (clips.length === 0) return []
    const mediaIds = [...new Set(clips.map((clip) => clip.mediaId))]
    const placeholders = mediaIds.map(() => '?').join(',')
    const rows = this.all(`SELECT * FROM media WHERE user_id = ? AND id IN (${placeholders})`, [userId, ...mediaIds])
    const mediaById = new Map(rows.map((row) => [text(row.id), this.mapMedia(row)]))
    return clips.map((clip) => ({
      ...clip,
      trimDuration: clipTrimDuration(clip),
      media: mediaById.get(clip.mediaId) ?? null,
    }))
  }

  /** Timeline row for a content; an empty project is returned when never saved. */
  getVideoProjectRow(userId: string, contentId: string): { clips: StoredVideoClip[]; materials: string[] | null; updatedAt: string } {
    const row = this.get('SELECT timeline_json, materials_json, updated_at FROM video_projects WHERE content_id = ? AND user_id = ?', [contentId, userId])
    if (!row) return { clips: [], materials: null, updatedAt: '' }
    const rawMaterials = parseJson(row.materials_json)
    return {
      clips: this.mapStoredClips(parseJson(row.timeline_json)),
      materials: Array.isArray(rawMaterials) ? rawMaterials.filter((value): value is string => typeof value === 'string') : null,
      updatedAt: text(row.updated_at),
    }
  }

  saveVideoProject(userId: string, contentId: string, values: SaveVideoProjectValues): StoredVideoClip[] {
    const now = nowIso()
    this.transaction(() => {
      const materials = values.materials === undefined ? null : values.materials === null ? null : JSON.stringify(values.materials)
      this.run(
        `INSERT INTO video_projects (content_id, user_id, timeline_json, materials_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(content_id) DO UPDATE SET timeline_json = excluded.timeline_json,
           materials_json = COALESCE(excluded.materials_json, video_projects.materials_json),
           updated_at = excluded.updated_at`,
        [contentId, userId, JSON.stringify(values.clips), materials, now, now],
      )
      this.run('UPDATE contents SET video_count = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
        values.clips.length, now, contentId, userId,
      ])
    })
    return values.clips
  }

  /** Copy the timeline to a duplicated content (content duplicate feature). */
  copyVideoProject(userId: string, fromContentId: string, toContentId: string): void {
    const source = this.get('SELECT timeline_json, materials_json FROM video_projects WHERE content_id = ? AND user_id = ?', [fromContentId, userId])
    if (!source) return
    const now = nowIso()
    this.run(
      `INSERT INTO video_projects (content_id, user_id, timeline_json, materials_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [toContentId, userId, text(source.timeline_json), source.materials_json == null ? null : text(source.materials_json), now, now],
    )
  }

  // ---------------------------------------------------------------- video exports

  private mapVideoExport(row: Row): VideoExport {
    const clips = this.mapClipDetails(this.mapStoredClips(parseJson(row.timeline_json)), text(row.user_id))
    const outputMediaId = nullableText(row.output_media_id)
    const outputMedia = outputMediaId ? this.getMedia(text(row.user_id), outputMediaId) : null
    return {
      id: text(row.id),
      contentId: text(row.content_id),
      status: text(row.status) as VideoExportStatus,
      progress: numberValue(row.progress),
      message: text(row.message),
      clips,
      totalDuration: clips.reduce((sum, clip) => sum + clip.trimDuration, 0),
      outputMedia,
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    }
  }

  createVideoExport(userId: string, values: CreateVideoExportValues): VideoExport {
    const id = randomUUID()
    const createdAt = nowIso()
    this.run(
      `INSERT INTO video_exports (id, user_id, content_id, status, progress, message, timeline_json, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, '', ?, ?, ?)`,
      [id, userId, values.contentId, JSON.stringify(values.timeline), createdAt, createdAt],
    )
    const created = this.getVideoExport(userId, id)
    if (!created) throw new Error('Failed to create video export')
    return created
  }

  updateVideoExport(userId: string, exportId: string, values: UpdateVideoExportValues): VideoExport | null {
    const current = this.get('SELECT * FROM video_exports WHERE id = ? AND user_id = ?', [exportId, userId])
    if (!current) return null
    this.run(
      `UPDATE video_exports SET status = ?, progress = ?, message = ?, output_media_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [
        values.status ?? text(current.status),
        values.progress !== undefined ? Math.max(0, Math.min(100, Math.round(values.progress))) : numberValue(current.progress),
        values.message ?? text(current.message),
        values.outputMediaId !== undefined ? values.outputMediaId : nullableText(current.output_media_id),
        nowIso(),
        exportId,
        userId,
      ],
    )
    return this.getVideoExport(userId, exportId)
  }

  getVideoExport(userId: string, exportId: string): VideoExport | null {
    const row = this.get('SELECT * FROM video_exports WHERE id = ? AND user_id = ?', [exportId, userId])
    return row ? this.mapVideoExport(row) : null
  }

  listVideoExports(userId: string, contentId?: string): VideoExport[] {
    const rows = contentId
      ? this.all('SELECT * FROM video_exports WHERE user_id = ? AND content_id = ? ORDER BY created_at DESC, id DESC LIMIT 30', [userId, contentId])
      : this.all('SELECT * FROM video_exports WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId])
    return rows.map((row) => this.mapVideoExport(row))
  }

  deleteVideoExport(userId: string, exportId: string): boolean {
    return this.run('DELETE FROM video_exports WHERE id = ? AND user_id = ?', [exportId, userId]) > 0
  }

  /** Interrupted exports can never resume after a restart. */
  failRunningVideoExports(): void {
    this.run(`UPDATE video_exports SET status = 'failed', message = ?, updated_at = ?
      WHERE status IN ('queued', 'running')`,
    ['服务已重启，导出任务已中断，请重新导出。', nowIso()])
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
      platformOptions: parsePlatformOptions(row.platform_options_json),
      createdAt: text(row.created_at),
    }
  }

  createRender(userId: string, values: CreateRenderValues): RenderRecord {
    const id = randomUUID()
    const createdAt = nowIso()
    this.run(
      `INSERT INTO renders (id, user_id, content_id, content_title, platforms_json, result_json, options_json, platform_options_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        userId,
        values.contentId,
        values.contentTitle,
        JSON.stringify(values.platforms),
        JSON.stringify(values.results),
        JSON.stringify(values.options ?? {}),
        JSON.stringify(values.platformOptions ?? {}),
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
      platformOptions: values.platformOptions ?? {},
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

  getBaijiahaoAccount(userId: string): ZhihuAccountSession | null {
    const row = this.get('SELECT * FROM baijiahao_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveBaijiahaoAccount(userId: string, values: ZhihuAccountSession): void {
    this.run(`INSERT INTO baijiahao_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteBaijiahaoAccount(userId: string): void { this.run('DELETE FROM baijiahao_accounts WHERE user_id = ?', [userId]) }

  private mapBaijiahaoPublication(row: Row): BaijiahaoPublication {
    const resolutions: BaijiahaoResolution[] = this.all('SELECT * FROM baijiahao_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)])
      .map(r => ({ id: text(r.id), action: r.action as BaijiahaoResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as BaijiahaoPublication['mode'], status: row.status as BaijiahaoPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createBaijiahaoPublication(userId: string, values: CreateWechatPublicationValues): BaijiahaoPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO baijiahao_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备百家号发布', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findBaijiahaoPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create Baijiahao publication')
    return publication
  }

  getBaijiahaoPublication(userId: string, id: string): BaijiahaoPublication | null {
    const row = this.get('SELECT * FROM baijiahao_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapBaijiahaoPublication(row) : null
  }

  findBaijiahaoPublication(userId: string, key: string): BaijiahaoPublication | null {
    const row = this.get('SELECT * FROM baijiahao_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapBaijiahaoPublication(row) : null
  }

  hasUncertainBaijiahaoPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM baijiahao_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listBaijiahaoPublications(userId: string): BaijiahaoPublication[] {
    return this.all('SELECT * FROM baijiahao_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapBaijiahaoPublication(row))
  }

  updateBaijiahaoPublication(userId: string, id: string, values: Partial<Pick<BaijiahaoPublication, 'status' | 'message' | 'url' | 'remoteId'>>): BaijiahaoPublication | null {
    const current = this.getBaijiahaoPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE baijiahao_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getBaijiahaoPublication(userId, id)
  }

  deleteBaijiahaoPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM baijiahao_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveBaijiahaoPublication(userId: string, id: string, action: BaijiahaoResolution['action'], values: Pick<BaijiahaoPublication, 'status' | 'message' | 'url' | 'remoteId'>): BaijiahaoPublication | null {
    return this.transaction(() => {
      const current = this.getBaijiahaoPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO baijiahao_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateBaijiahaoPublication(userId, id, values)
    })
  }

  getDoubanAccount(userId: string): ZhihuAccountSession | null {
    const row = this.get('SELECT * FROM douban_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveDoubanAccount(userId: string, values: ZhihuAccountSession): void {
    this.run(`INSERT INTO douban_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteDoubanAccount(userId: string): void { this.run('DELETE FROM douban_accounts WHERE user_id = ?', [userId]) }

  private mapDoubanPublication(row: Row): DoubanPublication {
    const resolutions: DoubanResolution[] = this.all('SELECT * FROM douban_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)])
      .map(r => ({ id: text(r.id), action: r.action as DoubanResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: (row.mode === 'draft' ? 'draft' : 'publish') as DoubanPublication['mode'], status: row.status as DoubanPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createDoubanPublication(userId: string, values: CreateDoubanPublicationValues): DoubanPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO douban_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备豆瓣日记发布', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findDoubanPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create Douban publication')
    return publication
  }

  getDoubanPublication(userId: string, id: string): DoubanPublication | null {
    const row = this.get('SELECT * FROM douban_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapDoubanPublication(row) : null
  }

  findDoubanPublication(userId: string, key: string): DoubanPublication | null {
    const row = this.get('SELECT * FROM douban_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapDoubanPublication(row) : null
  }

  hasUncertainDoubanPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM douban_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listDoubanPublications(userId: string): DoubanPublication[] {
    return this.all('SELECT * FROM douban_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapDoubanPublication(row))
  }

  updateDoubanPublication(userId: string, id: string, values: Partial<Pick<DoubanPublication, 'status' | 'message' | 'url' | 'remoteId'>>): DoubanPublication | null {
    const current = this.getDoubanPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE douban_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getDoubanPublication(userId, id)
  }

  deleteDoubanPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM douban_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveDoubanPublication(userId: string, id: string, action: DoubanResolution['action'], values: Pick<DoubanPublication, 'status' | 'message' | 'url' | 'remoteId'>): DoubanPublication | null {
    return this.transaction(() => {
      const current = this.getDoubanPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO douban_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateDoubanPublication(userId, id, values)
    })
  }

  getJuejinAccount(userId: string): ZhihuAccountSession | null {
    const row = this.get('SELECT * FROM juejin_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveJuejinAccount(userId: string, values: ZhihuAccountSession): void {
    this.run(`INSERT INTO juejin_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteJuejinAccount(userId: string): void { this.run('DELETE FROM juejin_accounts WHERE user_id = ?', [userId]) }

  private mapJuejinPublication(row: Row): JuejinPublication {
    const resolutions: JuejinResolution[] = this.all('SELECT * FROM juejin_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)])
      .map(r => ({ id: text(r.id), action: r.action as JuejinResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as JuejinPublication['mode'], status: row.status as JuejinPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createJuejinPublication(userId: string, values: CreateJuejinPublicationValues): JuejinPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO juejin_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备掘金发布', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findJuejinPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create Juejin publication')
    return publication
  }

  getJuejinPublication(userId: string, id: string): JuejinPublication | null {
    const row = this.get('SELECT * FROM juejin_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapJuejinPublication(row) : null
  }

  findJuejinPublication(userId: string, key: string): JuejinPublication | null {
    const row = this.get('SELECT * FROM juejin_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapJuejinPublication(row) : null
  }

  hasUncertainJuejinPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM juejin_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listJuejinPublications(userId: string): JuejinPublication[] {
    return this.all('SELECT * FROM juejin_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapJuejinPublication(row))
  }

  updateJuejinPublication(userId: string, id: string, values: Partial<Pick<JuejinPublication, 'status' | 'message' | 'url' | 'remoteId'>>): JuejinPublication | null {
    const current = this.getJuejinPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE juejin_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getJuejinPublication(userId, id)
  }

  deleteJuejinPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM juejin_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveJuejinPublication(userId: string, id: string, action: JuejinResolution['action'], values: Pick<JuejinPublication, 'status' | 'message' | 'url' | 'remoteId'>): JuejinPublication | null {
    return this.transaction(() => {
      const current = this.getJuejinPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO juejin_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateJuejinPublication(userId, id, values)
    })
  }

  getCsdnAccount(userId: string): ZhihuAccountSession | null {
    const row = this.get('SELECT * FROM csdn_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveCsdnAccount(userId: string, values: ZhihuAccountSession): void {
    this.run(`INSERT INTO csdn_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteCsdnAccount(userId: string): void { this.run('DELETE FROM csdn_accounts WHERE user_id = ?', [userId]) }

  private mapCsdnPublication(row: Row): CsdnPublication {
    const resolutions: CsdnResolution[] = this.all('SELECT * FROM csdn_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)])
      .map(r => ({ id: text(r.id), action: r.action as CsdnResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as CsdnPublication['mode'], status: row.status as CsdnPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createCsdnPublication(userId: string, values: CreateCsdnPublicationValues): CsdnPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO csdn_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备 CSDN 发布', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findCsdnPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create CSDN publication')
    return publication
  }

  getCsdnPublication(userId: string, id: string): CsdnPublication | null {
    const row = this.get('SELECT * FROM csdn_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapCsdnPublication(row) : null
  }

  findCsdnPublication(userId: string, key: string): CsdnPublication | null {
    const row = this.get('SELECT * FROM csdn_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapCsdnPublication(row) : null
  }

  hasUncertainCsdnPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM csdn_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listCsdnPublications(userId: string): CsdnPublication[] {
    return this.all('SELECT * FROM csdn_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapCsdnPublication(row))
  }

  updateCsdnPublication(userId: string, id: string, values: Partial<Pick<CsdnPublication, 'status' | 'message' | 'url' | 'remoteId'>>): CsdnPublication | null {
    const current = this.getCsdnPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE csdn_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getCsdnPublication(userId, id)
  }

  deleteCsdnPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM csdn_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveCsdnPublication(userId: string, id: string, action: CsdnResolution['action'], values: Pick<CsdnPublication, 'status' | 'message' | 'url' | 'remoteId'>): CsdnPublication | null {
    return this.transaction(() => {
      const current = this.getCsdnPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO csdn_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateCsdnPublication(userId, id, values)
    })
  }

  getJianshuAccount(userId: string): ZhihuAccountSession | null {
    const row = this.get('SELECT * FROM jianshu_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveJianshuAccount(userId: string, values: ZhihuAccountSession): void {
    this.run(`INSERT INTO jianshu_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteJianshuAccount(userId: string): void { this.run('DELETE FROM jianshu_accounts WHERE user_id = ?', [userId]) }

  private mapJianshuPublication(row: Row): JianshuPublication {
    const resolutions: JianshuResolution[] = this.all('SELECT * FROM jianshu_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)])
      .map(r => ({ id: text(r.id), action: r.action as JianshuResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as JianshuPublication['mode'], status: row.status as JianshuPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at), resolutions }
  }

  createJianshuPublication(userId: string, values: CreateJianshuPublicationValues): JianshuPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO jianshu_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备简书发布', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findJianshuPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create Jianshu publication')
    return publication
  }

  getJianshuPublication(userId: string, id: string): JianshuPublication | null {
    const row = this.get('SELECT * FROM jianshu_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapJianshuPublication(row) : null
  }

  findJianshuPublication(userId: string, key: string): JianshuPublication | null {
    const row = this.get('SELECT * FROM jianshu_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapJianshuPublication(row) : null
  }

  hasUncertainJianshuPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM jianshu_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listJianshuPublications(userId: string): JianshuPublication[] {
    return this.all('SELECT * FROM jianshu_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapJianshuPublication(row))
  }

  updateJianshuPublication(userId: string, id: string, values: Partial<Pick<JianshuPublication, 'status' | 'message' | 'url' | 'remoteId'>>): JianshuPublication | null {
    const current = this.getJianshuPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE jianshu_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getJianshuPublication(userId, id)
  }

  deleteJianshuPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM jianshu_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveJianshuPublication(userId: string, id: string, action: JianshuResolution['action'], values: Pick<JianshuPublication, 'status' | 'message' | 'url' | 'remoteId'>): JianshuPublication | null {
    return this.transaction(() => {
      const current = this.getJianshuPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO jianshu_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateJianshuPublication(userId, id, values)
    })
  }

  getV2exAccount(userId: string): V2exAccountSession | null {
    const row = this.get('SELECT * FROM v2ex_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveV2exAccount(userId: string, values: V2exAccountSession): void {
    this.run(`INSERT INTO v2ex_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteV2exAccount(userId: string): void { this.run('DELETE FROM v2ex_accounts WHERE user_id = ?', [userId]) }

  private mapV2exPublication(row: Row): V2exPublication {
    const resolutions: V2exResolution[] = this.all('SELECT * FROM v2ex_publication_resolutions WHERE publication_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10', [text(row.id), text(row.user_id)])
      .map(r => ({ id: text(r.id), action: r.action as V2exResolution['action'], message: text(r.message), articleUrl: nullableText(r.article_url), createdAt: text(r.created_at) }))
    return {
      id: text(row.id),
      renderId: text(row.render_id),
      title: text(row.title),
      nodeName: text(row.node_name),
      status: row.status as V2exPublication['status'],
      message: text(row.message),
      url: nullableText(row.url),
      remoteId: nullableText(row.remote_id),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      resolutions,
    }
  }

  createV2exPublication(userId: string, values: CreateV2exPublicationValues): V2exPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO v2ex_publications (id, user_id, render_id, title, node_name, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.nodeName, '正在准备 V2EX 发布', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findV2exPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create V2EX publication')
    return publication
  }

  getV2exPublication(userId: string, id: string): V2exPublication | null {
    const row = this.get('SELECT * FROM v2ex_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapV2exPublication(row) : null
  }

  findV2exPublication(userId: string, key: string): V2exPublication | null {
    const row = this.get('SELECT * FROM v2ex_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapV2exPublication(row) : null
  }

  hasUncertainV2exPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM v2ex_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listV2exPublications(userId: string): V2exPublication[] {
    return this.all('SELECT * FROM v2ex_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapV2exPublication(row))
  }

  updateV2exPublication(userId: string, id: string, values: Partial<Pick<V2exPublication, 'status' | 'message' | 'url' | 'remoteId'>>): V2exPublication | null {
    const current = this.getV2exPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE v2ex_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getV2exPublication(userId, id)
  }

  deleteV2exPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM v2ex_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveV2exPublication(userId: string, id: string, action: V2exResolution['action'], values: Pick<V2exPublication, 'status' | 'message' | 'url' | 'remoteId'>): V2exPublication | null {
    return this.transaction(() => {
      const current = this.getV2exPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO v2ex_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateV2exPublication(userId, id, values)
    })
  }

  getBilibiliAccount(userId: string): BilibiliAccountSession | null {
    const row = this.get('SELECT * FROM bilibili_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedSession: text(row.encrypted_session), accountId: text(row.account_id), name: nullableText(row.name), status: row.status === 'expired' ? 'expired' : 'connected', checkedAt: text(row.checked_at) } : null
  }

  saveBilibiliAccount(userId: string, values: BilibiliAccountSession): void {
    this.run(`INSERT INTO bilibili_accounts (user_id, encrypted_session, account_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_session = excluded.encrypted_session,
      account_id = excluded.account_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedSession, values.accountId, values.name, values.status, values.checkedAt])
  }

  deleteBilibiliAccount(userId: string): void { this.run('DELETE FROM bilibili_accounts WHERE user_id = ?', [userId]) }

  private mapBilibiliPublication(row: Row): BilibiliPublication {
    return {
      id: text(row.id),
      renderId: text(row.render_id),
      title: text(row.title),
      type: row.type as BilibiliPublicationType,
      status: row.status as BilibiliPublicationStatus,
      message: text(row.message),
      url: nullableText(row.url),
      remoteId: nullableText(row.remote_id),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    }
  }

  createBilibiliPublication(userId: string, values: CreateBilibiliPublicationValues): BilibiliPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO bilibili_publications (id, user_id, render_id, title, type, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.type, values.mode, '正在准备 B 站发布', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findBilibiliPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create Bilibili publication')
    return publication
  }

  getBilibiliPublication(userId: string, id: string): BilibiliPublication | null {
    const row = this.get('SELECT * FROM bilibili_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapBilibiliPublication(row) : null
  }

  findBilibiliPublication(userId: string, key: string): BilibiliPublication | null {
    const row = this.get('SELECT * FROM bilibili_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapBilibiliPublication(row) : null
  }

  hasUncertainBilibiliPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM bilibili_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listBilibiliPublications(userId: string): BilibiliPublication[] {
    return this.all('SELECT * FROM bilibili_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapBilibiliPublication(row))
  }

  updateBilibiliPublication(userId: string, id: string, values: Partial<Pick<BilibiliPublication, 'status' | 'message' | 'url' | 'remoteId'>>): BilibiliPublication | null {
    const current = this.getBilibiliPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE bilibili_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getBilibiliPublication(userId, id)
  }

  deleteBilibiliPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM bilibili_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
  }

  resolveBilibiliPublication(userId: string, id: string, action: 'check' | 'not_published' | 'published', values: Pick<BilibiliPublication, 'status' | 'message' | 'url' | 'remoteId'>): BilibiliPublication | null {
    return this.transaction(() => {
      const current = this.getBilibiliPublication(userId, id)
      if (!current || !['uncertain', 'running'].includes(current.status)) return null
      this.run('INSERT INTO bilibili_publication_resolutions (id,user_id,publication_id,action,message,article_url,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, id, action, values.message, action === 'published' || values.status === 'published' ? values.url : null, nowIso()])
      return this.updateBilibiliPublication(userId, id, values)
    })
  }

  // -------------------------------------------------------- wechatpic (公众号贴图)

  getWechatpicAccount(userId: string): WechatpicAccountSession | null {
    const row = this.get('SELECT * FROM wechatpic_accounts WHERE user_id = ?', [userId])
    return row ? { encryptedCredentials: text(row.encrypted_credentials), appId: text(row.app_id), name: nullableText(row.name), status: row.status as WechatpicAccountSession['status'], checkedAt: text(row.checked_at) } : null
  }

  saveWechatpicAccount(userId: string, values: WechatpicAccountSession): void {
    this.run(`INSERT INTO wechatpic_accounts (user_id, encrypted_credentials, app_id, name, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_credentials = excluded.encrypted_credentials,
      app_id = excluded.app_id, name = excluded.name, status = excluded.status, checked_at = excluded.checked_at`,
      [userId, values.encryptedCredentials, values.appId, values.name, values.status, values.checkedAt])
  }

  deleteWechatpicAccount(userId: string): void { this.run('DELETE FROM wechatpic_accounts WHERE user_id = ?', [userId]) }

  private mapWechatpicPublication(row: Row): WechatpicPublication {
    return { id: text(row.id), renderId: text(row.render_id), title: text(row.title), mode: row.mode as WechatpicPublication['mode'], status: row.status as WechatpicPublication['status'], message: text(row.message), url: nullableText(row.url), remoteId: nullableText(row.remote_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at) }
  }

  createWechatpicPublication(userId: string, values: CreateWechatPublicationValues): WechatpicPublication {
    const createdAt = nowIso()
    this.run(`INSERT INTO wechatpic_publications (id, user_id, render_id, title, mode, status, message, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
      [randomUUID(), userId, values.renderId, values.title, values.mode, '正在准备公众号贴图草稿', values.idempotencyKey, createdAt, createdAt])
    const publication = this.findWechatpicPublication(userId, values.idempotencyKey)
    if (!publication) throw new Error('Failed to create wechatpic publication')
    return publication
  }

  getWechatpicPublication(userId: string, id: string): WechatpicPublication | null {
    const row = this.get('SELECT * FROM wechatpic_publications WHERE id = ? AND user_id = ?', [id, userId])
    return row ? this.mapWechatpicPublication(row) : null
  }

  findWechatpicPublication(userId: string, key: string): WechatpicPublication | null {
    const row = this.get('SELECT * FROM wechatpic_publications WHERE user_id = ? AND idempotency_key = ?', [userId, key])
    return row ? this.mapWechatpicPublication(row) : null
  }

  hasUncertainWechatpicPublication(userId: string): boolean {
    return !!this.get("SELECT id FROM wechatpic_publications WHERE user_id = ? AND status = 'uncertain' LIMIT 1", [userId])
  }

  listWechatpicPublications(userId: string): WechatpicPublication[] {
    return this.all('SELECT * FROM wechatpic_publications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [userId]).map(row => this.mapWechatpicPublication(row))
  }

  updateWechatpicPublication(userId: string, id: string, values: Partial<Pick<WechatpicPublication, 'status' | 'message' | 'url' | 'remoteId'>>): WechatpicPublication | null {
    const current = this.getWechatpicPublication(userId, id)
    if (!current) return null
    this.run(`UPDATE wechatpic_publications SET status = ?, message = ?, url = ?, remote_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [values.status ?? current.status, values.message ?? current.message, values.url === undefined ? current.url : values.url, values.remoteId === undefined ? current.remoteId : values.remoteId, nowIso(), id, userId])
    return this.getWechatpicPublication(userId, id)
  }

  deleteWechatpicPublication(userId: string, id: string): boolean {
    return this.run('DELETE FROM wechatpic_publications WHERE id = ? AND user_id = ?', [id, userId]) > 0
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
    const attachments = parseJson(row.attachments_json)
    return {
      id: text(row.id),
      role: row.role as AiMessage['role'],
      content: text(row.content),
      toolCalls: Array.isArray(toolCalls) ? toolCalls as AiToolCall[] : undefined,
      toolCallId: nullableText(row.tool_call_id) ?? undefined,
      toolName: nullableText(row.tool_name) ?? undefined,
      toolArguments: parseJson(row.tool_arguments_json) ?? undefined,
      toolResult: parseJson(row.tool_result_json) ?? undefined,
      attachments: Array.isArray(attachments) ? attachments as AiMessage['attachments'] : undefined,
      createdAt: text(row.created_at),
    }
  }

  listAiMessages(userId: string, sessionId: string): AiMessage[] {
    return this.all('SELECT * FROM ai_messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC, rowid ASC', [sessionId, userId])
      .map(row => this.mapAiMessage(row))
  }

  createAiMessage(userId: string, sessionId: string, values: CreateAiMessageValues): AiMessage {
    const id = randomUUID()
    this.run(`INSERT INTO ai_messages (id, session_id, user_id, role, content, tool_calls_json, tool_call_id, tool_name, tool_arguments_json, tool_result_json, attachments_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, sessionId, userId, values.role, values.content,
        values.toolCalls ? JSON.stringify(values.toolCalls) : null,
        values.toolCallId ?? null, values.toolName ?? null,
        values.toolArguments === undefined ? null : JSON.stringify(values.toolArguments),
        values.toolResult === undefined ? null : JSON.stringify(values.toolResult),
        values.attachments?.length ? JSON.stringify(values.attachments) : null,
        nowIso()])
    const row = this.get('SELECT * FROM ai_messages WHERE id = ? AND user_id = ?', [id, userId])
    if (!row) throw new Error('Failed to create AI message')
    return this.mapAiMessage(row)
  }

  // ------------------------------------------------- AI high availability

  private mapAiKeyState(row: Row): AiKeyStateRecord {
    return {
      providerId: text(row.provider_id),
      keyId: text(row.key_id),
      state: row.state as AiKeyState,
      reason: nullableText(row.reason),
      cooldownUntil: nullableText(row.cooldown_until),
      successCount: numberValue(row.success_count),
      failureCount: numberValue(row.failure_count),
      quotaFailures: numberValue(row.quota_failures),
      authFailures: numberValue(row.auth_failures),
      rateLimits: numberValue(row.rate_limits),
      tokensIn: numberValue(row.tokens_in),
      tokensOut: numberValue(row.tokens_out),
      lastUsedAt: nullableText(row.last_used_at),
      lastError: nullableText(row.last_error),
      updatedAt: text(row.updated_at),
    }
  }

  getAiKeyState(providerId: string, keyId: string): AiKeyStateRecord | null {
    const row = this.get('SELECT * FROM ai_provider_key_states WHERE provider_id = ? AND key_id = ?', [providerId, keyId])
    return row ? this.mapAiKeyState(row) : null
  }

  listAiKeyStates(): AiKeyStateRecord[] {
    return this.all('SELECT * FROM ai_provider_key_states').map(row => this.mapAiKeyState(row))
  }

  saveAiKeyState(record: AiKeyStateRecord): void {
    this.run(`INSERT INTO ai_provider_key_states (provider_id, key_id, state, reason, cooldown_until, success_count, failure_count,
        quota_failures, auth_failures, rate_limits, tokens_in, tokens_out, last_used_at, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, key_id) DO UPDATE SET
        state = excluded.state, reason = excluded.reason, cooldown_until = excluded.cooldown_until,
        success_count = excluded.success_count, failure_count = excluded.failure_count,
        quota_failures = excluded.quota_failures, auth_failures = excluded.auth_failures,
        rate_limits = excluded.rate_limits, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
        last_used_at = excluded.last_used_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      [record.providerId, record.keyId, record.state, record.reason, record.cooldownUntil,
        record.successCount, record.failureCount, record.quotaFailures, record.authFailures, record.rateLimits,
        record.tokensIn, record.tokensOut, record.lastUsedAt, record.lastError, nowIso()])
  }

  /** Clear key state for a user's own override after they change the key. */
  resetAiKeyStates(providerId: string): void {
    this.run('DELETE FROM ai_provider_key_states WHERE provider_id = ?', [providerId])
  }

  private mapAiProviderState(row: Row): AiProviderStateRecord {
    return {
      providerId: text(row.provider_id),
      state: row.state as AiProviderState,
      reason: nullableText(row.reason),
      cooldownUntil: nullableText(row.cooldown_until),
      consecutiveFailures: numberValue(row.consecutive_failures),
      lastError: nullableText(row.last_error),
      updatedAt: text(row.updated_at),
    }
  }

  getAiProviderState(providerId: string): AiProviderStateRecord | null {
    const row = this.get('SELECT * FROM ai_provider_states WHERE provider_id = ?', [providerId])
    return row ? this.mapAiProviderState(row) : null
  }

  saveAiProviderState(record: AiProviderStateRecord): void {
    this.run(`INSERT INTO ai_provider_states (provider_id, state, reason, cooldown_until, consecutive_failures, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        state = excluded.state, reason = excluded.reason, cooldown_until = excluded.cooldown_until,
        consecutive_failures = excluded.consecutive_failures, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      [record.providerId, record.state, record.reason, record.cooldownUntil, record.consecutiveFailures, record.lastError, nowIso()])
  }

  resetAiProviderState(providerId: string): void {
    this.run('DELETE FROM ai_provider_states WHERE provider_id = ?', [providerId])
  }

  /** Full reset for a user override provider (keys + provider state). */
  resetAiProviderScope(providerId: string): void {
    this.resetAiKeyStates(providerId)
    this.resetAiProviderState(providerId)
  }

  private mapAiFailoverEvent(row: Row): AiFailoverEvent {
    return {
      id: text(row.id),
      at: text(row.created_at),
      kind: row.kind as AiFailoverEventKind,
      reason: text(row.reason),
      detail: nullableText(row.detail),
      sessionId: nullableText(row.session_id),
      fromProviderId: nullableText(row.from_provider_id),
      fromProviderLabel: nullableText(row.from_provider_label),
      fromKeyId: nullableText(row.from_key_id),
      fromKeyLabel: nullableText(row.from_key_label),
      fromKeyMasked: nullableText(row.from_key_masked),
      toProviderId: nullableText(row.to_provider_id),
      toProviderLabel: nullableText(row.to_provider_label),
      toKeyId: nullableText(row.to_key_id),
      toKeyLabel: nullableText(row.to_key_label),
      toKeyMasked: nullableText(row.to_key_masked),
      model: nullableText(row.model),
      targetModel: nullableText(row.target_model),
    }
  }

  createAiFailoverEvent(values: CreateAiFailoverEventValues): AiFailoverEvent {
    const id = randomUUID()
    this.run(`INSERT INTO ai_failover_events (id, user_id, session_id, kind, reason, detail,
        from_provider_id, from_provider_label, from_key_id, from_key_label, from_key_masked,
        to_provider_id, to_provider_label, to_key_id, to_key_label, to_key_masked, model, target_model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, values.userId, values.sessionId ?? null, values.kind, values.reason, values.detail ?? null,
        values.fromProviderId ?? null, values.fromProviderLabel ?? null, values.fromKeyId ?? null,
        values.fromKeyLabel ?? null, values.fromKeyMasked ?? null,
        values.toProviderId ?? null, values.toProviderLabel ?? null, values.toKeyId ?? null,
        values.toKeyLabel ?? null, values.toKeyMasked ?? null,
        values.model ?? null, values.targetModel ?? null, nowIso()])
    this.pruneAiGatewayRecords(values.userId)
    const row = this.get('SELECT * FROM ai_failover_events WHERE id = ?', [id])
    if (!row) throw new Error('Failed to create AI failover event')
    return this.mapAiFailoverEvent(row)
  }

  /** User-owned events plus system recovery events (user_id IS NULL). */
  listAiFailoverEvents(userId: string, limit = 50): AiFailoverEvent[] {
    const size = Math.max(1, Math.min(200, limit))
    return this.all(`SELECT * FROM ai_failover_events WHERE user_id = ? OR user_id IS NULL
      ORDER BY created_at DESC, rowid DESC LIMIT ?`, [userId, size]).map(row => this.mapAiFailoverEvent(row))
  }

  private mapAiProviderRequest(row: Row): AiProviderRequest {
    return {
      id: text(row.id),
      at: text(row.created_at),
      sessionId: nullableText(row.session_id),
      providerId: text(row.provider_id),
      providerLabel: text(row.provider_label),
      model: text(row.model),
      keyId: text(row.key_id),
      keyLabel: text(row.key_label),
      keyMasked: text(row.key_masked),
      status: row.status === 'failed' ? 'failed' : 'success',
      httpStatus: row.http_status === null || row.http_status === undefined ? null : numberValue(row.http_status),
      errorCode: nullableText(row.error_code),
      durationMs: numberValue(row.duration_ms),
      tokensIn: numberValue(row.tokens_in),
      tokensOut: numberValue(row.tokens_out),
    }
  }

  createAiProviderRequest(values: CreateAiProviderRequestValues): AiProviderRequest {
    const id = randomUUID()
    this.run(`INSERT INTO ai_provider_requests (id, user_id, session_id, provider_id, provider_label, model, key_id, key_label,
        key_masked, status, http_status, error_code, duration_ms, tokens_in, tokens_out, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, values.userId, values.sessionId ?? null, values.providerId, values.providerLabel, values.model,
        values.keyId, values.keyLabel, values.keyMasked, values.status, values.httpStatus ?? null,
        values.errorCode ?? null, values.durationMs, values.tokensIn ?? 0, values.tokensOut ?? 0, nowIso()])
    this.pruneAiGatewayRecords(values.userId)
    const row = this.get('SELECT * FROM ai_provider_requests WHERE id = ? AND user_id = ?', [id, values.userId])
    if (!row) throw new Error('Failed to create AI provider request')
    return this.mapAiProviderRequest(row)
  }

  listAiProviderRequests(userId: string, limit = 50): AiProviderRequest[] {
    const size = Math.max(1, Math.min(200, limit))
    return this.all('SELECT * FROM ai_provider_requests WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      [userId, size]).map(row => this.mapAiProviderRequest(row))
  }

  /** Keep audit tables bounded; called after each insert. */
  private pruneAiGatewayRecords(userId: string | null): void {
    if (userId) {
      this.run(`DELETE FROM ai_provider_requests WHERE user_id = ? AND rowid NOT IN (
        SELECT rowid FROM ai_provider_requests WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500)`, [userId, userId])
      this.run(`DELETE FROM ai_failover_events WHERE user_id = ? AND rowid NOT IN (
        SELECT rowid FROM ai_failover_events WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 300)`, [userId, userId])
    }
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
