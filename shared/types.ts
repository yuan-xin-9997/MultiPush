/**
 * MultiPush shared contracts.
 *
 * This module is imported by both the Express server (bundled by esbuild) and
 * the React web app (Vite alias `@shared`). Keep it free of runtime-specific
 * dependencies so it can be used in either environment.
 */

export type PlatformId = 'wechat' | 'xiaohongshu' | 'zhihu' | 'weibo' | 'toutiao' | 'baijiahao' | 'douban' | 'juejin' | 'jianshu' | 'douyin' | 'sspai' | 'blog'

export type ContentStatus = 'draft' | 'ready'

/** A content is either a rich-text article or a video-first note. */
export type ContentKind = 'article' | 'video'

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
    id: 'weibo',
    name: '微博',
    shortName: '微博',
    description: '生成微博图文文案与话题，支持复制文案、下载图片，或连接微博账号直接发布。',
    color: '#ff8200',
    softColor: '#fff4e8',
    contentTypes: ['image-text'],
    highlight: '微博图文 · 双井号话题 · 最多 9 图',
    limits: { titleMax: 64, bodyMax: 2000, imageMax: 9 },
  },
  {
    id: 'toutiao',
    name: '今日头条',
    shortName: '头条',
    description: '生成今日头条图文排版，支持复制富文本、下载 HTML/Markdown，或连接头条号直接发布。',
    color: '#f04142',
    softColor: '#fff0f0',
    contentTypes: ['image-text'],
    highlight: '头条图文 · 推荐流长文 · 直接发布',
    limits: { titleMax: 30, bodyMax: 50000, imageMax: 100 },
  },
  {
    id: 'baijiahao',
    name: '百家号',
    shortName: '百家号',
    description: '生成百家号图文排版，支持复制富文本、下载 HTML/Markdown，或连接百家号直接发布。',
    color: '#2932e1',
    softColor: '#eef0ff',
    contentTypes: ['image-text'],
    highlight: '百度百家号 · 图文长文 · 直接发布',
    limits: { titleMax: 30, bodyMax: 50000, imageMax: 100 },
  },
  {
    id: 'douban',
    name: '豆瓣',
    shortName: '豆瓣',
    description: '生成豆瓣日记排版，提供 HTML/Markdown 下载与富文本复制；连接豆瓣账号后可发布日记（实验性）。',
    color: '#00b51d',
    softColor: '#eaf8ee',
    contentTypes: ['image-text'],
    highlight: '豆瓣日记 · 扫码登录 · 图片转存',
    limits: { titleMax: 100, bodyMax: 50000, imageMax: 100 },
  },
  {
    id: 'juejin',
    name: '掘金',
    shortName: '掘金',
    description: '生成掘金技术文章排版，支持 Markdown/HTML 下载；连接掘金账号后可保存草稿或发布文章。',
    color: '#1e80ff',
    softColor: '#edf4ff',
    contentTypes: ['image-text'],
    highlight: '技术文章 · Markdown · 草稿 / 发布',
    limits: { titleMax: 100, bodyMax: 50000, imageMax: 100 },
  },
  {
    id: 'jianshu',
    name: '简书',
    shortName: '简书',
    description: '生成简书文章排版，支持 Markdown/HTML 下载；连接简书账号后可创建草稿或发布文章。',
    color: '#ea6f5a',
    softColor: '#fff2ef',
    contentTypes: ['image-text'],
    highlight: 'Markdown 长文 · 草稿 / 发布 · 文集',
    limits: { titleMax: 100, bodyMax: 50000, imageMax: 100 },
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
  {
    id: 'sspai',
    name: '少数派',
    shortName: '少数派',
    description: '生成少数派 Matrix 文章排版，提供 Markdown 与富文本；支持保存草稿与立即发布。',
    color: '#d71a1b',
    softColor: '#fdeceb',
    contentTypes: ['image-text'],
    highlight: 'Matrix 长文 · 草稿 / 立即发布 · 微信扫码',
    limits: { titleMax: 32, bodyMax: 50000, imageMax: 100 },
  },
  {
    id: 'blog',
    name: '个人博客',
    shortName: '博客',
    description: '生成 Halo 个人博客文章排版，支持保存草稿与公开发布，正文图片自动转存到博客附件库。',
    color: '#0f172a',
    softColor: '#f1f5f9',
    contentTypes: ['image-text'],
    highlight: 'Halo 博客 · 草稿 / 发布 · 图片转存',
    limits: { titleMax: 120, bodyMax: 100000, imageMax: 200 },
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
  code: string
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
  kind: ContentKind
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
  /** True when contentJson no longer describes contentHtml (e.g. an API-only HTML edit). */
  contentJsonStale?: boolean
  /** Internal checksum used to detect the mismatch above. */
  contentHtmlHash?: string
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
  kind?: ContentKind
  sort?: 'updated_desc' | 'created_desc' | 'title_asc'
  page?: number
  pageSize?: number
}

export interface ContentInput {
  title?: string
  kind?: ContentKind
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
  /** Probe metadata for videos, when ffprobe was available at upload time. */
  duration?: number | null
  width?: number | null
  height?: number | null
  createdAt: string
}

// ---------------------------------------------------------------- video editing

/**
 * One editable segment inside a video content's timeline. A timeline is an
 * ordered list of clips; the exported video plays them back to back with each
 * clip trimmed to `[trimStart, trimEnd ?? duration]`.
 */
export interface VideoClip {
  id: string
  mediaId: string
  /** Trim start in seconds within the source video. */
  trimStart: number
  /** Trim end in seconds; `null` means "until the end of the source". */
  trimEnd: number | null
  /** Source duration in seconds when known (probe or browser metadata). */
  duration: number | null
}

export interface VideoClipDetail extends VideoClip {
  /** Effective playable seconds after the trim is applied. */
  trimDuration: number
  /** The referenced media asset, or null when it was deleted. */
  media: MediaAsset | null
}

export interface VideoClipInput {
  mediaId: string
  trimStart?: number
  trimEnd?: number | null
  /** Client-measured source duration in seconds, used when the server has no ffprobe. */
  duration?: number | null
}

export interface VideoProject {
  contentId: string
  clips: VideoClipDetail[]
  /** Sum of trim durations in seconds. */
  totalDuration: number
  updatedAt: string
}

export type VideoExportStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface VideoExport {
  id: string
  contentId: string
  status: VideoExportStatus
  /** 0-100, best effort while ffmpeg reports progress. */
  progress: number
  message: string
  /** Snapshot of the timeline used for this export. */
  clips: VideoClipDetail[]
  totalDuration: number
  outputMedia: MediaAsset | null
  createdAt: string
  updatedAt: string
}

/** Server-side ffmpeg availability reported to the workspace UI. */
export interface VideoCapability {
  ffmpeg: boolean
  ffprobe: boolean
  version: string | null
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
  imagePosition?: { x: number; y: number }
}

export interface PlatformAdjustment {
  title: string
  html?: string
  body?: string
  tags: string[]
  cards?: XhsCard[]
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
  sourceUpdatedAt?: string
  captionBody?: string
  editedAt?: string
  authorName?: string
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

export interface WechatAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface WechatLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export interface WechatPublishInput {
  renderId: string
  mode: 'draft' | 'publish'
  coverMediaId: string
  author?: string
  digest?: string
  sourceUrl?: string
}

export interface PublicationDeletion {
  ok: true
  remoteDeleted: boolean
}

export interface WechatPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'awaiting_confirmation' | 'published' | 'failed' | 'uncertain'
  message: string
  qrCode: string | null
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
}

export interface ZhihuAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

/** Platforms whose official login page supports a mainland mobile SMS code. */
export type SmsLoginPlatform = 'zhihu' | 'weibo' | 'toutiao' | 'baijiahao' | 'douban' | 'juejin' | 'douyin'

export interface SmsLogin {
  id: string
  platform: SmsLoginPlatform
  status: 'waiting' | 'verifying' | 'connected' | 'expired' | 'failed'
  message: string
  expiresAt: string
  /** Masked mobile number; the full number and SMS code are never returned. */
  phoneMasked: string
  /** Connected platform account name when status is `connected`. */
  name?: string | null
}

export interface ZhihuLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export interface ZhihuPublishInput {
  renderId: string
  mode: 'draft' | 'publish'
  coverMediaId?: string
}

export interface ZhihuPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: ZhihuResolution[]
}

export interface ZhihuResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface ZhihuResolveInput {
  action: ZhihuResolution['action']
  articleUrl?: string
}

export interface XhsAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface XhsLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export interface XhsPublishInput {
  renderId: string
  mode: 'publish'
  imageMediaIds: string[]
}

export interface XhsPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: XhsResolution[]
}

export interface XhsResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface XhsResolveInput {
  action: XhsResolution['action']
  articleUrl?: string
}

export interface WeiboAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface WeiboLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export interface WeiboPublishInput {
  renderId: string
  mode?: 'draft' | 'publish'
}

export interface WeiboPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: WeiboResolution[]
}

export interface WeiboResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface WeiboResolveInput {
  action: WeiboResolution['action']
  articleUrl?: string
}

export interface ToutiaoAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface ToutiaoLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export interface ToutiaoPublishInput {
  renderId: string
  mode?: 'draft' | 'publish'
}

export interface ToutiaoPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: ToutiaoResolution[]
}

export interface ToutiaoResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface ToutiaoResolveInput {
  action: ToutiaoResolution['action']
  articleUrl?: string
}

export interface BaijiahaoAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
  message?: string
}

export interface BaijiahaoLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export interface BaijiahaoPublishInput {
  renderId: string
  mode?: 'draft' | 'publish'
}

export interface BaijiahaoPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: BaijiahaoResolution[]
}

export interface BaijiahaoResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface BaijiahaoResolveInput {
  action: BaijiahaoResolution['action']
  articleUrl?: string
}

export interface DoubanAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface DoubanLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export type DoubanPrivacy = 'public' | 'private'

export interface DoubanPublishInput {
  renderId: string
  mode?: 'draft' | 'publish'
  privacy?: DoubanPrivacy
  tags?: string[]
}

export interface DoubanPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: DoubanResolution[]
}

export interface DoubanResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface DoubanResolveInput {
  action: DoubanResolution['action']
  articleUrl?: string
}

export interface JuejinAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface JuejinLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export interface JuejinPublishInput {
  renderId: string
  mode: 'draft' | 'publish'
  categoryId?: string
  tags?: string[]
}

export interface JuejinPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: JuejinResolution[]
}

export interface JuejinResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface JuejinResolveInput {
  action: JuejinResolution['action']
  articleUrl?: string
}

export interface JianshuAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface JianshuConnectInput {
  /** Cookie header copied from a signed-in browser; remember_user_token is required. */
  cookie: string
}

export interface JianshuPublishInput {
  renderId: string
  mode: 'draft' | 'publish'
  notebookId?: string
}

export interface JianshuPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: JianshuResolution[]
}

export interface JianshuResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface JianshuResolveInput {
  action: JianshuResolution['action']
  articleUrl?: string
}

export interface DouyinAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface DouyinLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export interface DouyinPublishInput {
  renderId: string
  mode: 'draft' | 'publish'
  imageMediaIds?: string[]
  videoMediaId?: string
}

export interface DouyinPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: DouyinResolution[]
}

export interface DouyinResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface DouyinResolveInput {
  action: DouyinResolution['action']
  articleUrl?: string
}

export interface SspaiAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface SspaiLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export interface SspaiPublishInput {
  renderId: string
  mode: 'draft' | 'publish'
  coverMediaId?: string
}

export interface SspaiPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: SspaiResolution[]
}

export interface SspaiResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface SspaiResolveInput {
  action: SspaiResolution['action']
  articleUrl?: string
}

export interface BlogAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  baseUrl: string | null
  checkedAt: string | null
}

export interface BlogConnectInput {
  baseUrl: string
  token: string
}

export interface BlogPublishInput {
  renderId: string
  mode: 'draft' | 'publish'
  coverMediaId?: string
}

export interface BlogPublication {
  id: string
  renderId: string
  title: string
  mode: 'draft' | 'publish'
  status: 'running' | 'draft' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: BlogResolution[]
}

export interface BlogResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface BlogResolveInput {
  action: BlogResolution['action']
  articleUrl?: string
}

export interface AiSettings {
  configured: boolean
  baseUrl: string
  model: string
  temperature: number
  hasApiKey: boolean
  /** Where the active configuration comes from: the user's saved settings or server defaults. */
  source?: 'user' | 'server'
  label?: string
}

export interface AiSettingsInput {
  baseUrl: string
  apiKey?: string
  model: string
  temperature?: number
}

export interface AiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface AiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: AiToolCall[]
  toolCallId?: string
  toolName?: string
  toolArguments?: unknown
  toolResult?: unknown
  createdAt: string
}

export interface AiSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface AiSessionDetail extends AiSession {
  messages: AiMessage[]
}

export interface AiChatResult {
  session: AiSessionDetail
  reply: AiMessage
}

export type BatchJobKind = 'render' | 'publish'
export type BatchJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type BatchItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface BatchJobItem {
  index: number
  contentId: string
  title: string
  status: BatchItemStatus
  message: string
  renderId?: string
  publicationId?: string
  publicationStatus?: string
  url?: string
}

export interface BatchJob {
  id: string
  kind: BatchJobKind
  status: BatchJobStatus
  total: number
  done: number
  message: string
  items: BatchJobItem[]
  createdAt: string
  updatedAt: string
}

export interface BatchRenderInput {
  contentIds: string[]
  platforms: PlatformId[]
  options?: RenderOptions
}

export type BatchPublishPlatform = 'wechat' | 'zhihu' | 'weibo' | 'toutiao' | 'douban' | 'juejin' | 'jianshu' | 'sspai' | 'blog'

export interface BatchPublishInput {
  contentIds: string[]
  platform: BatchPublishPlatform
  mode: 'draft' | 'publish'
  coverMediaId?: string
  options?: RenderOptions
}

export interface ApiHealth {
  status: 'ok'
  service: string
  version: string
  desktopMode?: boolean
  uptime: number
  time: string
}

export interface ApiErrorBody {
  error: string
  message: string
  issues?: Array<{ path: string; message: string }>
}

export const PLATFORM_ORDER: PlatformId[] = ['wechat', 'xiaohongshu', 'zhihu', 'weibo', 'toutiao', 'baijiahao', 'douban', 'juejin', 'jianshu', 'douyin', 'sspai', 'blog']
