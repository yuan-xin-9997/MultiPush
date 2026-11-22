/**
 * MultiPush shared contracts.
 *
 * This module is imported by both the Express server (bundled by esbuild) and
 * the React web app (Vite alias `@shared`). Keep it free of runtime-specific
 * dependencies so it can be used in either environment.
 */

export type PlatformId = 'wechat' | 'wechatpic' | 'xiaohongshu' | 'zhihu' | 'weibo' | 'toutiao' | 'baijiahao' | 'douban' | 'juejin' | 'csdn' | 'jianshu' | 'v2ex' | 'bilibili' | 'douyin' | 'sspai' | 'blog'

export type ContentStatus = 'draft' | 'ready'

/**
 * A content is a rich-text article, an image-first gallery note (公众号贴图 /
 * 抖音图文 / 小红书), or a video-first note.
 */
export type ContentKind = 'article' | 'gallery' | 'video'

export type MediaKind = 'image' | 'video' | 'document'

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
    id: 'wechatpic',
    name: '公众号贴图',
    shortName: '贴图',
    description: '生成微信公众号图片消息（贴图）所需的标题、配文与图片清单；连接公众号 API 后一键保存为草稿，发表在公众号后台手动完成。',
    color: '#07c160',
    softColor: '#e9f9f0',
    contentTypes: ['image-text'],
    highlight: '图片消息 · 最多 20 图 · API 建草稿 · 手动发表',
    limits: { titleMax: 32, bodyMax: 20000, imageMax: 20 },
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
    id: 'csdn',
    name: 'CSDN',
    shortName: 'CSDN',
    description: '生成 CSDN 技术博客排版，支持 Markdown/HTML 下载；连接 CSDN 账号后可保存草稿或发布文章。',
    color: '#fc5531',
    softColor: '#fff1ec',
    contentTypes: ['image-text'],
    highlight: '技术博客 · Markdown · 草稿 / 发布',
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
    id: 'v2ex',
    name: 'V2EX',
    shortName: 'V2EX',
    description: '生成 V2EX 主题 Markdown，选择节点后通过浏览器会话发布公开主题；也可复制 Markdown 到 V2EX 发帖页手动发布。',
    color: '#333333',
    softColor: '#f2f2f2',
    contentTypes: ['image-text'],
    highlight: '论坛主题 · Markdown · 节点 · 浏览器发布',
    limits: { titleMax: 120, bodyMax: 20000, imageMax: 100 },
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    shortName: 'B站',
    description: '生成 B 站视频投稿或专栏图文排版，支持视频/图文预览、下载与浏览器自动发布。',
    color: '#00aeec',
    softColor: '#e6f7fd',
    contentTypes: ['image-text', 'video'],
    highlight: '视频投稿 · 专栏图文 · 16:9',
    limits: { titleMax: 80, bodyMax: 40000, imageMax: 100 },
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
  /** Owning folder, or null when the asset is unfiled. */
  folderId: string | null
  createdAt: string
}

export interface MediaFolder {
  id: string
  name: string
  assetCount: number
  createdAt: string
  updatedAt: string
}

export interface MediaListResult {
  media: MediaAsset[]
  total: number
  page: number
  pageSize: number
}

export interface MediaStats {
  total: number
  images: number
  videos: number
  documents: number
  /** Sum of all asset sizes in bytes. */
  bytes: number
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

export interface VideoMaterial {
  mediaId: string
  /** The raw source asset, or null when it was deleted from the media library. */
  media: MediaAsset | null
}

export interface VideoProject {
  contentId: string
  /** Raw uploaded source materials, in upload order. */
  materials: VideoMaterial[]
  clips: VideoClipDetail[]
  /** True when the timeline differs from a plain concatenation of materials. */
  edited: boolean
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

export type PlatformOptionOverrides = Partial<Record<PlatformId, RenderOptions>>

export interface RenderRequest {
  contentId: string
  platforms: PlatformId[]
  /** Base options applied to every selected platform. */
  options?: RenderOptions
  /** Per-platform overrides merged on top of `options` for that platform only. */
  platformOptions?: PlatformOptionOverrides
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
  platformOptions: PlatformOptionOverrides
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

export interface WechatpicAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  appId: string | null
  checkedAt: string | null
}

export interface WechatpicConnectInput {
  /** 公众号 AppID，在微信开发者平台「我的业务 → 公众号/服务号 → 基础信息」查看。 */
  appId: string
  /** 公众号 AppSecret，连接后按用户加密保存。 */
  appSecret: string
}

export interface WechatpicPublishInput {
  renderId: string
}

export interface WechatpicPublication {
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

export interface CsdnAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface CsdnLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export interface CsdnPublishInput {
  renderId: string
  mode: 'draft' | 'publish'
  tags?: string[]
}

export interface CsdnPublication {
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
  resolutions?: CsdnResolution[]
}

export interface CsdnResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface CsdnResolveInput {
  action: CsdnResolution['action']
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

export interface V2exAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface V2exConnectInput {
  /** Cookie header copied from a signed-in V2EX browser session. */
  cookie: string
}

export interface V2exNode {
  name: string
  title: string
}

export interface V2exPublishInput {
  renderId: string
  nodeName: string
}

export interface V2exPublication {
  id: string
  renderId: string
  title: string
  nodeName: string
  status: 'running' | 'published' | 'failed' | 'uncertain'
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
  resolutions?: V2exResolution[]
}

export interface V2exResolution {
  id: string
  action: 'check' | 'not_published' | 'published'
  message: string
  articleUrl: string | null
  createdAt: string
}

export interface V2exResolveInput {
  action: V2exResolution['action']
  topicUrl?: string
}

/** Common V2EX nodes shown before a session can enumerate the live list. */
export const V2EX_COMMON_NODES: V2exNode[] = [
  { name: 'programming', title: '程序员' },
  { name: 'create', title: '分享创造' },
  { name: 'share', title: '分享发现' },
  { name: 'qna', title: '问与答' },
  { name: 'ideas', title: '奇思妙想' },
  { name: 'career', title: '职场话题' },
  { name: 'life', title: '生活' },
  { name: 'python', title: 'Python' },
  { name: 'javascript', title: 'JavaScript' },
  { name: 'nodejs', title: 'Node.js' },
  { name: 'linux', title: 'Linux' },
  { name: 'apple', title: 'Apple' },
  { name: 'macos', title: 'macOS' },
  { name: 'android', title: 'Android' },
  { name: 'ios', title: 'iOS' },
  { name: 'hardware', title: '硬件' },
  { name: 'photography', title: '摄影' },
  { name: 'movies', title: '电影' },
  { name: 'reading', title: '阅读' },
  { name: 'travel', title: '旅行' },
]

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
  /** Number of providers in the effective fallback chain (account override included). */
  providers?: number
  /** Number of API keys in the effective fallback chain. */
  keys?: number
  /** True when the server configured a cross-provider fallback chain. */
  fallback?: boolean
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

/** One attachment on an AI chat message: a media asset or a text document. */
export interface AiMessageAttachment {
  kind: 'image' | 'video' | 'document'
  name: string
  mimeType: string
  size: number
  /** Media asset id for image/video attachments; tools accept it directly. */
  mediaId?: string
  url?: string
  width?: number | null
  height?: number | null
  duration?: number | null
  /** Extracted plain text for document attachments (capped on save). */
  text?: string
}

export interface AiSendMessageInput {
  message: string
  /** Image/video media asset ids already uploaded to the media library. */
  mediaIds?: string[]
  /** Text documents read client-side; the server caps each text again. */
  documents?: Array<{ name: string; mimeType: string; size?: number; text?: string }>
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
  attachments?: AiMessageAttachment[]
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

/** Actual provider/model/key used by one provider call (never exposes the key). */
export interface AiRoutingInfo {
  providerId: string
  providerLabel: string
  model: string
  /** Model the user asked for, before any equivalence mapping. */
  requestedModel: string
  keyId: string
  keyLabel: string
  keyMasked: string
  /** True when a key or provider switch happened before this call succeeded. */
  fallback: boolean
  /** Stable reason code of the first switch (quota_exhausted, unauthorized, ...). */
  reason: string | null
  /** Number of failed attempts before the successful one. */
  attempts: number
}

export type AiKeyState = 'available' | 'cooling' | 'exhausted' | 'invalid'
export type AiProviderState = 'available' | 'cooling'

export interface AiGatewayKeyStatus {
  providerId: string
  providerLabel: string
  keyId: string
  keyLabel: string
  maskedKey: string
  /** 1-based priority inside the provider. */
  priority: number
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
}

export interface AiGatewayProviderStatus {
  id: string
  label: string
  baseUrl: string
  defaultModel: string
  models: string[]
  source: 'config' | 'user'
  state: AiProviderState
  reason: string | null
  cooldownUntil: string | null
  consecutiveFailures: number
  lastError: string | null
  keys: AiGatewayKeyStatus[]
}

export type AiFailoverEventKind =
  | 'key_switch'
  | 'provider_switch'
  | 'key_cooldown'
  | 'provider_cooldown'
  | 'key_recovery'
  | 'provider_recovery'
  | 'rate_limited'

export interface AiFailoverEvent {
  id: string
  at: string
  kind: AiFailoverEventKind
  reason: string
  detail: string | null
  sessionId: string | null
  fromProviderId: string | null
  fromProviderLabel: string | null
  fromKeyId: string | null
  fromKeyLabel: string | null
  fromKeyMasked: string | null
  toProviderId: string | null
  toProviderLabel: string | null
  toKeyId: string | null
  toKeyLabel: string | null
  toKeyMasked: string | null
  model: string | null
  targetModel: string | null
}

export interface AiProviderRequest {
  id: string
  at: string
  sessionId: string | null
  providerId: string
  providerLabel: string
  model: string
  keyId: string
  keyLabel: string
  keyMasked: string
  status: 'success' | 'failed'
  httpStatus: number | null
  errorCode: string | null
  durationMs: number
  tokensIn: number
  tokensOut: number
}

export type AiProviderConfigSource = 'env' | 'file' | 'legacy' | 'override' | 'none'

export interface AiGatewayStatus {
  configured: boolean
  /** Where the provider pool came from: environment, protected file, or legacy single-provider env. */
  source: AiProviderConfigSource
  warning: string | null
  probeIntervalMs: number
  updatedAt: string
  providers: AiGatewayProviderStatus[]
  events: AiFailoverEvent[]
  requests: AiProviderRequest[]
}

/** Editable provider pool metadata. Masked keys only; raw keys are never returned. */
export interface AiProviderKeyView {
  id: string
  label: string
  maskedKey: string
  /** Key-specific base URL override; null means inherit the provider base URL. */
  baseUrl: string | null
  enabled: boolean
}

export interface AiProviderView {
  id: string
  label: string
  baseUrl: string
  defaultModel: string
  models: string[]
  /** When false, only the first enabled key is used (no multi-key rotation). */
  highAvailability: boolean
  keys: AiProviderKeyView[]
}

export interface AiProviderCooldownSettings {
  quotaMs: number
  authMs: number
  rateLimitMs: number
  transientMs: number
  providerMs: number
}

export interface AiProviderPoolView {
  editable: boolean
  editableReason: string | null
  source: AiProviderConfigSource
  warning: string | null
  providers: AiProviderView[]
  modelMap: Record<string, Record<string, string> | string>
  probeIntervalMs: number
  maxProviderFailures: number
  cooldowns: AiProviderCooldownSettings
  updatedAt: string
}

export interface AiProviderKeyInput {
  id?: string
  label: string
  /** Leave empty/omitted for an existing key to keep its stored secret. */
  apiKey?: string
  baseUrl?: string | null
  enabled?: boolean
}

export interface AiProviderInput {
  id: string
  label: string
  baseUrl: string
  defaultModel: string
  models?: string[]
  highAvailability?: boolean
  keys: AiProviderKeyInput[]
}

export interface AiProviderPoolInput {
  providers: AiProviderInput[]
  modelMap?: Record<string, Record<string, string> | string>
  probeIntervalMs?: number
  maxProviderFailures?: number
  cooldowns?: Partial<AiProviderCooldownSettings>
}

export interface AiProbeResult {
  providerId: string
  providerLabel: string
  keyId: string
  keyLabel: string
  maskedKey: string
  model: string
  ok: boolean
  message: string
  latencyMs: number
}

export interface AiChatResult {
  session: AiSessionDetail
  reply: AiMessage
  /** Routing of the last provider call in this turn; omitted when the reply was produced locally. */
  routing?: AiRoutingInfo
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

export type BilibiliPublicationType = 'video' | 'article'
export type BilibiliPublicationStatus = 'running' | 'draft' | 'reviewing' | 'published' | 'failed' | 'uncertain'

export interface BilibiliAccount {
  status: 'disconnected' | 'connected' | 'expired'
  name: string | null
  checkedAt: string | null
}

export interface BilibiliLogin {
  id: string
  status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
  qrCode: string | null
  message: string
  expiresAt: string
}

export interface BilibiliPublishInput {
  renderId: string
  type: BilibiliPublicationType
  mode: 'draft' | 'publish'
  videoMediaId?: string
  coverMediaId?: string
  title?: string
  desc?: string
  tags?: string
  partitionId?: number
}

export interface BilibiliPublication {
  id: string
  renderId: string
  title: string
  type: BilibiliPublicationType
  status: BilibiliPublicationStatus
  message: string
  url: string | null
  remoteId: string | null
  createdAt: string
  updatedAt: string
}

export interface BilibiliResolveInput {
  action: 'check' | 'not_published' | 'published'
  videoUrl?: string
}

export interface BilibiliPartition {
  id: number
  name: string
}

export const BILIBILI_PARTITIONS: BilibiliPartition[] = [
  { id: 231, name: '科技 · 计算机技术' },
  { id: 230, name: '科技 · 软件应用' },
  { id: 229, name: '科技 · 野生技术协会' },
  { id: 122, name: '知识 · 科学科普' },
  { id: 201, name: '知识 · 社科法律心理' },
  { id: 124, name: '知识 · 财经商业' },
  { id: 228, name: '知识 · 校园学习' },
  { id: 207, name: '知识 · 职业职场' },
  { id: 208, name: '知识 · 设计创意' },
  { id: 209, name: '知识 · 野生技能协会' },
  { id: 21, name: '生活 · 日常' },
  { id: 138, name: '搞笑' },
  { id: 188, name: '数码 · 手机平板' },
  { id: 95, name: '数码' },
  { id: 182, name: '影视 · 影视杂谈' },
  { id: 183, name: '影视 · 影视剪辑' },
  { id: 85, name: '影视 · 短片' },
  { id: 181, name: '影视 · 预告资讯' },
]

export interface BatchRenderInput {
  contentIds: string[]
  platforms: PlatformId[]
  options?: RenderOptions
  platformOptions?: PlatformOptionOverrides
}

export type BatchPublishPlatform = 'wechat' | 'zhihu' | 'weibo' | 'toutiao' | 'douban' | 'juejin' | 'csdn' | 'jianshu' | 'sspai' | 'blog'

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

export const PLATFORM_ORDER: PlatformId[] = ['wechat', 'wechatpic', 'xiaohongshu', 'zhihu', 'weibo', 'toutiao', 'baijiahao', 'douban', 'juejin', 'csdn', 'jianshu', 'v2ex', 'bilibili', 'douyin', 'sspai', 'blog']
