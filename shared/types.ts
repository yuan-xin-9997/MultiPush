/**
 * MultiPush shared contracts.
 *
 * This module is imported by both the Express server (bundled by esbuild) and
 * the React web app (Vite alias `@shared`). Keep it free of runtime-specific
 * dependencies so it can be used in either environment.
 */

export type PlatformId = 'wechat' | 'xiaohongshu' | 'zhihu' | 'douyin'

export type ContentStatus = 'draft' | 'ready'

export type MediaKind = 'image' | 'video'

export type RenderPreviewMode = 'article' | 'cards' | 'video' | 'vertical'

export interface PlatformInfo {
  id: PlatformId
  name: string
  shortName: string
  description: string
  color: string
  softColor: string
  contentTypes: Array<'image-text' | 'video'>
  highlight: string
  limits: {
    titleMax?: number
    bodyMax?: number
    imageMax?: number
  }
}

export const PLATFORMS: PlatformInfo[] = [
  {
    id: 'wechat',
    name: '微信公众号',
    shortName: '公众号',
    description: '排版为公众号图文消息，支持复制富文本到公众号后台，或下载离线 HTML。',
    color: '#07c160',
    softColor: '#e9f9f0',
    contentTypes: ['image-text', 'video'],
    highlight: '沉浸式图文排版 · 内联样式 · 一键复制',
    limits: { titleMax: 64, bodyMax: 20000, imageMax: 100 },
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    shortName: '小红书',
    description: '自动分页为 3:4 图文卡片，生成标题、正文与话题，打包下载 PNG 与文案。',
    color: '#ff2442',
    softColor: '#fff0f2',
    contentTypes: ['image-text', 'video'],
    highlight: '3:4 卡片分页 · 高清 PNG · 文案与话题',
    limits: { titleMax: 20, bodyMax: 1000, imageMax: 18 },
  },
  {
    id: 'zhihu',
    name: '知乎',
    shortName: '知乎',
    description: '生成知乎盐选风格长文，提供 Markdown 与富文本下载，适合专栏与回答。',
    color: '#1772f6',
    softColor: '#edf4ff',
    contentTypes: ['image-text', 'video'],
    highlight: '专栏长文 · Markdown · 引用与代码块',
    limits: { titleMax: 100, bodyMax: 50000, imageMax: 200 },
  },
  {
    id: 'douyin',
    name: '抖音',
    shortName: '抖音',
    description: '生成抖音竖屏图文 / 视频笔记文案，适配标题、正文与话题标签，配套 HTML 与 JSON。',
    color: '#fe2c55',
    softColor: '#fff0f3',
    contentTypes: ['image-text', 'video'],
    highlight: '竖屏封面 · 话题文案 · 视频笔记',
    limits: { titleMax: 55, bodyMax: 1000, imageMax: 35 },
  },
]

export function getPlatformInfo(id: PlatformId): PlatformInfo {
  const info = PLATFORMS.find((platform) => platform.id === id)
  if (!info) throw new Error(`Unknown platform: ${id}`)
  return info
}

/** Tiptap JSON document. Kept as a JSON object to avoid coupling the server. */
export type RichTextJson = Record<string, unknown>

export interface User {
  id: string
  username: string
  email: string
  displayName: string
  avatarUrl: string | null
  createdAt: string
}

export interface AuthResponse {
  token: string
  user: User
}

export interface RegisterInput {
  username: string
  email: string
  password: string
  displayName?: string
}

export interface LoginInput {
  account: string
  password: string
}

export interface Book {
  id: string
  name: string
  description: string
  color: string
  docCount: number
  createdAt: string
  updatedAt: string
}

export interface BookInput {
  name: string
  description?: string
  color?: string
}

export interface ContentSummary {
  id: string
  bookId: string | null
  bookName: string | null
  title: string
  excerpt: string
  coverImage: string | null
  tags: string[]
  status: ContentStatus
  favorite: boolean
  wordCount: number
  imageCount: number
  videoCount: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface ContentDetail extends ContentSummary {
  contentJson: RichTextJson
  contentHtml: string
}

export interface ContentListResult {
  items: ContentSummary[]
  total: number
  page: number
  pageSize: number
}

export interface ContentListQuery {
  bookId?: string | null
  favorite?: boolean
  trash?: boolean
  q?: string
  sort?: 'updated_desc' | 'created_desc' | 'title_asc'
  page?: number
  pageSize?: number
}

export interface ContentInput {
  title?: string
  bookId?: string | null
  contentJson?: RichTextJson
  contentHtml?: string
  excerpt?: string
  coverImage?: string | null
  tags?: string[]
  status?: ContentStatus
  favorite?: boolean
}

export interface MediaAsset {
  id: string
  kind: MediaKind
  filename: string
  originalName: string
  mimeType: string
  size: number
  url: string
  createdAt: string
}

export type RenderOptions = {
  cardStyle?: 'clean' | 'warm' | 'bold'
  themeColor?: string
  includeToc?: boolean
  includeTags?: boolean
  authorName?: string
  accountName?: string
}

export interface RenderRequest {
  contentId: string
  platforms: PlatformId[]
  options?: RenderOptions
}

export interface XhsCard {
  id: string
  type: 'cover' | 'content' | 'quote' | 'end'
  index: number
  total: number
  title: string
  body: string[]
  images: string[]
  footer: string
}

export interface RenderedAsset {
  filename: string
  url: string
  kind: 'image' | 'video'
}

export interface RenderDownload {
  filename: string
  mimeType: string
  kind: 'html' | 'markdown' | 'text' | 'json'
  content: string
}

export interface PlatformRenderMeta {
  wordCount: number
  imageCount: number
  videoCount: number
  readMinutes: number
  tags: string[]
  titleLength: number
  titleLimit?: number
  summary: string
}

export interface PlatformRender {
  platform: PlatformId
  title: string
  html: string
  markdown: string | null
  text: string | null
  previewMode: RenderPreviewMode
  themeColor: string
  meta: PlatformRenderMeta
  cards: XhsCard[]
  assets: RenderedAsset[]
  videos: string[]
  warnings: string[]
  downloads: RenderDownload[]
  generatedAt: string
}

export interface RenderRecord {
  id: string
  contentId: string
  contentTitle: string
  platforms: PlatformId[]
  results: PlatformRender[]
  options: RenderOptions
  createdAt: string
}

export interface RenderListItem {
  id: string
  contentId: string
  contentTitle: string
  platforms: PlatformId[]
  createdAt: string
}

export interface ApiHealth {
  status: 'ok'
  service: string
  version: string
  uptime: number
  time: string
}

export interface ApiErrorBody {
  error: string
  message: string
  issues?: Array<{ path: string; message: string }>
}

export const PLATFORM_ORDER: PlatformId[] = ['wechat', 'xiaohongshu', 'zhihu', 'douyin']
