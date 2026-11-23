import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { load } from 'cheerio'
import type { BlogAccount, BlogConnectInput, BlogPublication, BlogPublishInput, BlogResolveInput, PublicationDeletion } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { PlatformActionGuard } from './platform-actions'
import { UPLOAD_FILENAME_PATTERN } from './upload'
import { decryptPublisherSecret, encryptPublisherSecret, loadPublisherKey } from './publisher-session'
import { downloadPublisherImage, publisherImage, type PublisherImage } from './publisher-image'
import { blogImagePath, prepareBlogContent, verifyBlogContent } from './blog-content'
import { HaloBlogDriver, canonicalBlogBaseUrl, type BlogArticle, type BlogCredentials, type BlogDriver } from './blog-halo'

const MAX_IMAGES = 200
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const now = () => new Date().toISOString()

export class BlogService {
  private readonly key: Buffer
  private readonly active = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<BlogAccount>>()
  private readonly actions: PlatformActionGuard
  private closed = false

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly driver: BlogDriver = new HaloBlogDriver(config.allowPrivateNetwork),
    private readonly canonicalize: (input: string) => Promise<string> = (input) => canonicalBlogBaseUrl(input, config.allowPrivateNetwork),
  ) {
    this.key = loadPublisherKey(config.dataDir, 'blog')
    this.actions = new PlatformActionGuard(database, 'blog')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'blog_unavailable', '个人博客服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'blog_busy', '个人博客操作正在进行，请等待完成')
  }

  private credentials(userId: string): BlogCredentials {
    const account = this.database.getBlogAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'blog_auth_failed', '请先在系统中连接个人博客')
    try {
      const credentials = decryptPublisherSecret<BlogCredentials>(account.encryptedCredentials, this.key, userId)
      if (!credentials.baseUrl || !credentials.token) throw new Error('invalid credentials')
      return credentials
    } catch {
      this.database.saveBlogAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'blog_auth_failed', '个人博客连接信息无法恢复，请重新输入地址和令牌')
    }
  }

  private save(userId: string, credentials: BlogCredentials, identity: { accountId: string; name: string }): void {
    if (this.closed) return
    this.database.saveBlogAccount(userId, {
      encryptedCredentials: encryptPublisherSecret(credentials, this.key, userId),
      accountId: identity.accountId,
      baseUrl: credentials.baseUrl,
      name: identity.name,
      status: 'connected',
      checkedAt: now(),
    })
  }

  async account(userId: string, force = false): Promise<BlogAccount> {
    const current = this.database.getBlogAccount(userId)
    if (!current) return { status: 'disconnected', name: null, baseUrl: null, checkedAt: null }
    const view = { status: current.status, name: current.name, baseUrl: current.baseUrl, checkedAt: current.checkedAt }
    if (!force || current.status === 'expired' || this.active.has(userId)) return view
    if (!this.actions.allowSessionCheck(userId)) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<BlogAccount> => {
      try {
        const credentials = this.credentials(userId)
        const result = await this.driver.checkSession(credentials)
        const latest = this.database.getBlogAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, baseUrl: null, checkedAt: null }
        if (latest.encryptedCredentials !== current.encryptedCredentials) return { status: latest.status, name: latest.name, baseUrl: latest.baseUrl, checkedAt: latest.checkedAt }
        this.save(userId, credentials, result.identity)
        return { status: 'connected', name: result.identity.name, baseUrl: credentials.baseUrl, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'blog_auth_failed' && this.database.getBlogAccount(userId)?.encryptedCredentials === current.encryptedCredentials) {
          this.database.saveBlogAccount(userId, { ...current, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, baseUrl: current.baseUrl, checkedAt: now() }
        }
        throw error
      }
    })().finally(() => this.checks.delete(userId))
    this.checks.set(userId, check)
    return check
  }

  async connect(userId: string, input: BlogConnectInput): Promise<BlogAccount> {
    this.idle(userId)
    const token = input.token.trim()
    if (!token) throw new ApiError(400, 'blog_token_invalid', '请输入 Halo 个人令牌')
    if (token.length > 4096) throw new ApiError(400, 'blog_token_invalid', '个人令牌过长')
    const baseUrl = await this.canonicalize(input.baseUrl)
    this.active.add(userId)
    try {
      const credentials: BlogCredentials = { baseUrl, token }
      const result = await this.driver.checkSession(credentials)
      this.save(userId, credentials, result.identity)
      return { status: 'connected', name: result.identity.name, baseUrl, checkedAt: now() }
    } finally {
      this.active.delete(userId)
    }
  }

  async disconnect(userId: string): Promise<void> {
    this.idle(userId)
    this.active.add(userId)
    try {
      this.database.deleteBlogAccount(userId)
    } finally { this.active.delete(userId) }
  }

  private async image(userId: string, mediaId: string): Promise<PublisherImage> {
    const media = this.database.getMedia(userId, mediaId)
    if (!media || !UPLOAD_FILENAME_PATTERN.test(media.filename)) throw notFound('图片不存在或无权访问，请重新上传')
    if (media.kind !== 'image' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(media.mimeType) || media.size > MAX_IMAGE_BYTES) throw new ApiError(400, 'blog_image_invalid', '个人博客图片请使用 10 MB 以内的 JPG、PNG、GIF 或 WebP')
    try { return { ...publisherImage(await readFile(path.join(this.config.uploadsDir, media.filename)), true), name: media.filename } }
    catch { throw new ApiError(400, 'blog_image_invalid', '图片文件丢失、格式无效或超过 10 MB，请重新上传') }
  }

  private async article(userId: string, input: BlogPublishInput, baseUrl: string): Promise<BlogArticle & { external: string[] }> {
    const record = this.database.getRender(userId, input.renderId), render = record?.results.find(result => result.platform === 'blog')
    if (!record || !render) throw notFound('个人博客排版记录不存在，请先生成个人博客排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'blog_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'blog_render_stale', '原文已修改，请重新生成个人博客排版后发布')
    const title = render.title.trim()
    if (!title || Array.from(title).length > 120) throw new ApiError(400, 'blog_title_invalid', '个人博客标题需要 1–120 个字')
    const raw = load(render.html, null, false)
    if (!raw.text().trim() && !raw('img').length) throw new ApiError(400, 'blog_body_empty', '请先填写文章正文')
    if (Buffer.byteLength(render.html) > 1024 * 1024) throw new ApiError(400, 'blog_body_size', '正文 HTML 不能超过 1 MB')
    if (raw('video,audio,iframe,svg').length || render.videos.length) throw new ApiError(400, 'blog_media_unsupported', '个人博客发布支持图文，请先移除视频、音频、嵌入内容或 SVG')
    if (raw('img').length > MAX_IMAGES) throw new ApiError(400, 'blog_image_count', `个人博客正文最多支持 ${MAX_IMAGES} 张图片`)
    const html = prepareBlogContent(render.html), $ = load(html, null, false), images = new Map<string, PublisherImage>(), external: string[] = []
    for (const node of $('img').toArray()) {
      const src = $(node).attr('src') || ''
      if (images.has(src) || external.includes(src) || blogImagePath(src, baseUrl)) continue
      let url: URL
      try { url = new URL(src, 'https://multipush.invalid') } catch { throw new ApiError(400, 'blog_image_invalid', '正文包含无效图片地址') }
      const origin = this.config.publicBaseUrl || baseUrl
      const owned = url.origin === 'https://multipush.invalid' || !!origin && url.origin === new URL(origin).origin
      if (owned && url.pathname.startsWith('/uploads/')) {
        const filename = url.pathname.slice('/uploads/'.length)
        if (!UPLOAD_FILENAME_PATTERN.test(filename)) throw notFound('图片路径无效')
        const media = this.database.getMediaByFilename(userId, filename)
        if (!media) throw notFound('正文图片不存在或无权访问，请重新上传')
        images.set(src, await this.image(userId, media.id))
      } else if (url.protocol === 'data:' || !owned && ['http:', 'https:'].includes(url.protocol)) external.push(src)
      else throw new ApiError(400, 'blog_image_invalid', '正文包含无效图片地址，请重新上传')
    }
    const tags = (render.meta.tags || []).map(tag => tag.trim()).filter(Boolean).slice(0, 8)
    return { title, html, tags, images, external, slugSeed: content.id, ...(input.coverMediaId ? { cover: await this.image(userId, input.coverMediaId) } : {}) }
  }

  list(userId: string): BlogPublication[] { return this.database.listBlogPublications(userId) }
  get(userId: string, id: string): BlogPublication {
    const value = this.database.getBlogPublication(userId, id)
    if (!value) throw notFound('个人博客发布记录不存在')
    return value
  }

  async remove(userId: string, id: string): Promise<PublicationDeletion> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status === 'running') throw new ApiError(409, 'blog_delete_busy', '个人博客任务正在处理，请等待完成后再删除')
    if (current.status === 'published') throw new ApiError(409, 'blog_delete_published', '已发布文章记录不能删除；如需删除文章请到博客后台操作')
    if (current.status === 'uncertain') throw new ApiError(409, 'blog_delete_uncertain', '请先核实这条个人博客任务的结果，再删除发布记录')
    this.active.add(userId)
    try {
      let remoteDeleted = false
      if (current.mode === 'draft' && current.remoteId) {
        try {
          await this.driver.deleteDraft(this.credentials(userId), current.remoteId)
          remoteDeleted = true
        } catch (error) {
          this.expire(userId, error)
          if (current.status === 'draft') throw error
        }
      }
      if (!this.database.deleteBlogPublication(userId, id)) throw notFound('个人博客发布记录不存在')
      return { ok: true, remoteDeleted }
    } finally { this.active.delete(userId) }
  }

  async resolve(userId: string, id: string, input: BlogResolveInput): Promise<BlogPublication> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status !== 'uncertain') throw new ApiError(409, 'blog_resolution_stale', '任务状态已变化，请刷新后再操作')
    this.active.add(userId)
    let handedOff = false
    try {
      if (input.action === 'check') {
        const credentials = this.credentials(userId)
        this.database.updateBlogPublication(userId, id, { status: 'running', message: '正在重新核实个人博客发布结果' })
        const task = this.recheck(userId, id, credentials, current)
        this.jobs.set(id, task); handedOff = true
        void task.finally(() => { this.jobs.delete(id); this.active.delete(userId) }).catch(() => {})
        return this.get(userId, id)
      }
      let values: Pick<BlogPublication, 'status' | 'message' | 'url' | 'remoteId'>
      if (input.action === 'not_published') {
        values = { status: 'failed', message: '用户已核实未发布，已解除限制；再次提交会优先复用原草稿', url: current.url, remoteId: current.remoteId }
      } else {
        const account = this.database.getBlogAccount(userId)
        if (!account) throw new ApiError(409, 'blog_auth_failed', '请先连接个人博客')
        let url: URL
        try { url = new URL(input.articleUrl || '') } catch { throw new ApiError(400, 'blog_article_url', '请填写已发布的个人博客文章链接') }
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(account.baseUrl).origin || url.username || url.password) throw new ApiError(400, 'blog_article_url', '请填写当前个人博客域名下的文章链接')
        values = { status: 'published', message: '用户已人工核实文章发布成功，并关联文章链接', remoteId: current.remoteId, url: url.href }
      }
      const result = this.database.resolveBlogPublication(userId, id, input.action, values)
      if (!result) throw new ApiError(409, 'blog_resolution_stale', '任务状态已变化，请刷新后再操作')
      return result
    } finally { if (!handedOff) this.active.delete(userId) }
  }

  private async recheck(userId: string, id: string, credentials: BlogCredentials, current: BlogPublication): Promise<void> {
    try {
      const result = current.remoteId
        ? await this.driver.checkPublication(credentials, current.remoteId, current.title)
        : { status: 'unknown', url: null, message: '没有可核对的远端编号，请在个人博客后台核实后选择人工核实结果' }
      this.database.resolveBlogPublication(userId, id, 'check', { status: result.status === 'published' ? 'published' : 'uncertain', message: result.message, url: result.url || current.url, remoteId: current.remoteId })
    } catch (error) {
      this.expire(userId, error)
      this.database.resolveBlogPublication(userId, id, 'check', { status: 'uncertain', message: error instanceof ApiError ? error.message : '自动核实未完成，请稍后重试或填写人工核实结果', url: current.url, remoteId: current.remoteId })
    }
  }

  async publish(userId: string, input: BlogPublishInput, baseUrl: string): Promise<BlogPublication> {
    this.idle(userId)
    this.active.add(userId)
    let handedOff = false
    try {
      if (this.database.hasUncertainBlogPublication(userId)) throw new ApiError(409, 'blog_result_uncertain', '请先核实所有结果待确认的任务，再提交新的发布')
      const credentials = this.credentials(userId)
      const checked = await this.driver.checkSession(credentials)
      this.save(userId, credentials, checked.identity)
      const article = await this.article(userId, input, baseUrl)
      const hash = createHash('sha256').update(JSON.stringify({ account: checked.identity.accountId, baseUrl: credentials.baseUrl, contentId: this.database.getRender(userId, input.renderId)?.contentId, title: article.title, html: article.html, tags: article.tags, mode: input.mode }))
      if (article.cover) hash.update(article.cover.buffer)
      for (const [src, image] of article.images) hash.update(src).update(image.buffer)
      for (const src of article.external) hash.update(src)
      const idempotencyKey = hash.digest('hex'), previous = this.database.findBlogPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return previous
      this.actions.assertPublish(userId)
      const publication = previous ?? this.database.createBlogPublication(userId, { renderId: input.renderId, title: article.title, mode: input.mode, idempotencyKey })
      this.database.updateBlogPublication(userId, publication.id, { status: 'running', message: '正在准备个人博客正文及图片' })
      const task = this.run(userId, publication.id, credentials, article, input.mode, previous?.remoteId || undefined, previous?.resolutions?.some(entry => entry.action === 'not_published') || false)
      this.jobs.set(publication.id, task)
      handedOff = true
      void task.finally(() => { this.jobs.delete(publication.id); this.active.delete(userId) }).catch(() => {})
      return this.get(userId, publication.id)
    } catch (error) {
      this.expire(userId, error)
      throw error
    } finally { if (!handedOff) this.active.delete(userId) }
  }

  private expire(userId: string, error: unknown): void {
    const account = this.database.getBlogAccount(userId)
    if (account && error instanceof ApiError && error.code === 'blog_auth_failed') this.database.saveBlogAccount(userId, { ...account, status: 'expired', checkedAt: now() })
  }

  private async run(userId: string, id: string, credentials: BlogCredentials, article: BlogArticle & { external: string[] }, mode: 'draft' | 'publish', resumeId?: string, confirmedUnpublished = false): Promise<void> {
    try {
      for (const [index, src] of article.external.entries()) {
        this.database.updateBlogPublication(userId, id, { message: `正在读取正文图片 ${index + 1}/${article.external.length}，随后上传到个人博客` })
        article.images.set(src, await downloadPublisherImage(src, 'blog'))
      }
      let result
      try {
        result = await this.driver.publish(credentials, article, mode, progress => { this.database.updateBlogPublication(userId, id, progress) }, resumeId)
      } catch (error) {
        if (resumeId && confirmedUnpublished && error instanceof ApiError && error.code === 'blog_draft_missing') {
          this.database.updateBlogPublication(userId, id, { remoteId: null, url: null, message: '已确认未发布，原草稿失效，正在重新上传图片并创建草稿' })
          result = await this.driver.publish(credentials, article, mode, progress => { this.database.updateBlogPublication(userId, id, progress) })
        } else throw error
      }
      this.database.updateBlogPublication(userId, id, result)
    } catch (error) {
      this.expire(userId, error)
      const code = error instanceof ApiError ? error.code : ''
      const uncertain = !(error instanceof ApiError) || ['blog_result_uncertain', 'blog_draft_missing', 'blog_draft_changed', 'blog_content_mismatch', 'blog_publish_unverified'].includes(code)
      this.database.updateBlogPublication(userId, id, { status: uncertain ? 'uncertain' : 'failed', message: error instanceof ApiError ? error.message : '个人博客操作中断，结果未确认，请先核对博客后台，避免重复提交' })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.jobs.values(), ...this.checks.values()])
  }
}
