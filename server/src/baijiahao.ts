import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { load } from 'cheerio'
import type { BaijiahaoAccount, BaijiahaoLogin, BaijiahaoPublication, BaijiahaoPublishInput, BaijiahaoResolveInput } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey, type PublisherStorageState } from './publisher-session'
import { downloadPublisherImage, publisherImage, type PublisherImage } from './publisher-image'
import { UPLOAD_FILENAME_PATTERN } from './upload'
import { isBaijiahaoImageSrc, type BaijiahaoArticle, type BaijiahaoDriver, type BaijiahaoIdentity, type BaijiahaoLoginAttempt } from './baijiahao-browser'

const TTL = 5 * 60_000
const now = () => new Date().toISOString()
type LoginEntry = { userId: string; value: BaijiahaoLogin; attempt?: BaijiahaoLoginAttempt; timer: ReturnType<typeof setTimeout>; preparing?: Promise<void>; polling?: Promise<BaijiahaoLogin> }
/** The article handed to the driver after the service layer prepared images. */
type PreparedBaijiahaoArticle = BaijiahaoArticle & {
  /** Body image srcs that still need to be downloaded (external or data URLs). */
  external: string[]
  /** Cover src that still needs to be downloaded. */
  coverPending: string | null
}

/** Placeholder that keeps document order in the images map until the download replaces it. */
const PENDING_DOWNLOAD: PublisherImage = { name: 'pending', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) }

export function baijiahaoArticleUrl(remoteId: string): string { return `https://baijiahao.baidu.com/s?id=${remoteId}` }

export function parseBaijiahaoPublishedId(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    if (!['baijiahao.baidu.com', 'baijiahao.com', 'www.baijiahao.com'].includes(url.hostname.toLowerCase())) return null
    const match = url.pathname.match(/^\/s\/?$/) ? url.searchParams.get('id') : null
    return match && /^\d{6,30}$/.test(match) ? match : null
  } catch { return null }
}

export class BaijiahaoService {
  private readonly key: Buffer
  private readonly logins = new Map<string, LoginEntry>()
  private readonly active = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<BaijiahaoAccount>>()
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: BaijiahaoDriver) {
    this.key = loadPublisherKey(config.dataDir, 'baijiahao')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'baijiahao_unavailable', '百家号服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'baijiahao_busy', '百家号操作正在进行，请等待完成')
  }

  private state(userId: string, allowExpired = false): PublisherStorageState {
    const account = this.database.getBaijiahaoAccount(userId)
    if (!account || (account.status === 'expired' && !allowExpired)) throw new ApiError(409, 'baijiahao_session_expired', '请先在系统中扫码登录百家号')
    try { return decryptPublisherSession(account.encryptedSession, this.key, userId) }
    catch {
      this.database.saveBaijiahaoAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'baijiahao_session_expired', '百家号登录状态无法恢复，请重新扫码连接')
    }
  }

  private save(userId: string, state: PublisherStorageState, identity: BaijiahaoIdentity): void {
    if (!this.closed) this.database.saveBaijiahaoAccount(userId, { encryptedSession: encryptPublisherSession(state, this.key, userId), ...identity, status: 'connected', checkedAt: now() })
  }

  async account(userId: string): Promise<BaijiahaoAccount> {
    const current = this.database.getBaijiahaoAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    const view = { status: current.status, name: current.name, checkedAt: current.checkedAt }
    if (this.active.has(userId) || Date.now() - Date.parse(current.checkedAt) < TTL) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<BaijiahaoAccount> => {
      try {
        const result = await this.driver.checkSession(this.state(userId, current.status === 'expired'))
        const latest = this.database.getBaijiahaoAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.save(userId, result.state, result.identity)
        return { status: 'connected', name: result.identity.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'baijiahao_account_unbound') {
          const latest = this.database.getBaijiahaoAccount(userId)
          if (latest) this.database.saveBaijiahaoAccount(userId, { ...latest, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, checkedAt: now(), message: error.message }
        }
        if (error instanceof ApiError && error.code === 'baijiahao_session_expired' && this.database.getBaijiahaoAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveBaijiahaoAccount(userId, { ...current, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, checkedAt: now() }
        }
        throw error
      }
    })().finally(() => this.checks.delete(userId))
    this.checks.set(userId, check)
    return check
  }

  /** Persist a verified session created by the shared SMS-login manager. */
  async importPublisherSession(userId: string, state: PublisherStorageState): Promise<{ name: string }> {
    this.idle(userId)
    const result = await this.driver.checkSession(state)
    this.save(userId, result.state, result.identity)
    return { name: result.identity.name }
  }

  async startLogin(userId: string): Promise<BaijiahaoLogin> {
    this.idle(userId)
    const pending = [...this.logins.values()].find(entry => entry.userId === userId && entry.preparing)
    if (pending) return pending.value
    for (const [id, entry] of this.logins) {
      if (entry.userId === userId) { clearTimeout(entry.timer); this.logins.delete(id); void entry.attempt?.close().catch(() => {}) }
    }
    if (this.logins.size >= 8) throw new ApiError(503, 'baijiahao_busy', '当前登录请求较多，请稍后重试')
    const id = randomUUID()
    const value: BaijiahaoLogin = { id, status: 'waiting', qrCode: null, message: '正在准备百家号登录二维码，请稍候', expiresAt: new Date(Date.now() + TTL).toISOString() }
    const timer = setTimeout(() => { this.logins.delete(id); void entry.attempt?.close().catch(() => {}) }, TTL)
    timer.unref()
    const entry: LoginEntry = { userId, value, timer }
    this.logins.set(id, entry)
    entry.preparing = (async () => {
      try {
        const attempt = await this.driver.beginLogin()
        if (this.closed || this.logins.get(id) !== entry) { await attempt.close().catch(() => {}); return }
        entry.attempt = attempt
        this.refreshLogin(userId, id, entry)
      } catch (error) {
        if (this.logins.get(id) === entry) entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '获取百家号登录二维码失败，请重新连接' }
      }
    })().finally(() => { entry.preparing = undefined })
    return value
  }

  async pollLogin(userId: string, id: string): Promise<BaijiahaoLogin> {
    const entry = this.logins.get(id)
    if (!entry || entry.userId !== userId) throw notFound('百家号登录请求不存在或已过期，请重新连接')
    this.refreshLogin(userId, id, entry)
    return entry.value
  }

  private refreshLogin(userId: string, id: string, entry: LoginEntry): void {
    if (this.closed || !entry.attempt || entry.polling || !['waiting', 'scanned'].includes(entry.value.status)) return
    const attempt = entry.attempt
    entry.polling = (async () => {
      try {
        const result = await attempt.poll()
        if (this.logins.get(id) !== entry) throw notFound('百家号登录已取消')
        if (result.status === 'connected') {
          if (!result.state || !result.identity) throw new ApiError(502, 'baijiahao_login_failed', '百家号没有返回有效登录会话，请重试')
          this.save(userId, result.state, result.identity)
        }
        entry.value = { ...entry.value, status: result.status, qrCode: result.qrCode, message: result.message }
      } catch (error) {
        entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '读取百家号登录状态失败，请重新连接' }
      }
      if (!['waiting', 'scanned'].includes(entry.value.status)) await attempt.close().catch(() => {})
      return entry.value
    })().finally(() => { entry.polling = undefined })
  }

  async disconnect(userId: string): Promise<void> {
    this.idle(userId)
    this.active.add(userId)
    try {
      for (const [id, entry] of this.logins) {
        if (entry.userId === userId) { this.logins.delete(id); clearTimeout(entry.timer); await entry.attempt?.close().catch(() => {}) }
      }
      this.database.deleteBaijiahaoAccount(userId)
    } finally { this.active.delete(userId) }
  }

  /** Reads one of the user's uploaded image files, validating type and size. */
  private async mediaImage(userId: string, mediaId: string): Promise<PublisherImage> {
    const media = this.database.getMedia(userId, mediaId)
    if (!media || !UPLOAD_FILENAME_PATTERN.test(media.filename)) throw notFound('图片不存在或无权访问，请重新上传')
    if (media.kind !== 'image' || !['image/png', 'image/jpeg', 'image/gif'].includes(media.mimeType) || media.size > 10 * 1024 * 1024) {
      throw new ApiError(400, 'baijiahao_image_invalid', '百家号图片请使用 10 MB 以内的 JPG、PNG 或 GIF 格式')
    }
    try {
      return { ...publisherImage(await readFile(path.join(this.config.uploadsDir, media.filename))), name: media.filename }
    } catch {
      throw new ApiError(400, 'baijiahao_image_invalid', '图片文件丢失、格式无效或超过 10 MB，请重新上传')
    }
  }

  /** Resolves the article cover from `content.coverImage`, falling back to the first body image. */
  private async coverFrom(src: string, userId: string, baseUrl?: string): Promise<{ cover: PublisherImage | null; coverPending: string | null }> {
    if (!src) return { cover: null, coverPending: null }
    let url: URL
    try { url = new URL(src, 'https://multipush.invalid') } catch { throw new ApiError(400, 'baijiahao_cover_invalid', '封面图片地址无效，请重新设置封面') }
    const origin = this.config.publicBaseUrl || baseUrl
    const owned = url.origin === 'https://multipush.invalid' || !!origin && url.origin === new URL(origin).origin
    if (owned && url.pathname.startsWith('/uploads/')) {
      const filename = url.pathname.slice('/uploads/'.length)
      if (!UPLOAD_FILENAME_PATTERN.test(filename)) throw notFound('封面图片路径无效')
      const media = this.database.getMediaByFilename(userId, filename)
      if (!media) throw notFound('封面图片不存在或无权访问，请重新设置封面')
      return { cover: await this.mediaImage(userId, media.id), coverPending: null }
    }
    if (url.protocol === 'data:' || ['http:', 'https:'].includes(url.protocol)) return { cover: null, coverPending: src }
    throw new ApiError(400, 'baijiahao_cover_invalid', '封面图片地址无效，请重新设置封面')
  }

  /** Validates the 5 MB cover limit enforced by the Baijiahao cover dialog. */
  private coverChecked(cover: PublisherImage | null): PublisherImage | null {
    if (cover && cover.buffer.length > 5 * 1024 * 1024) {
      throw new ApiError(400, 'baijiahao_cover_size', '百家号封面不能超过 5 MB，请更换封面图片')
    }
    return cover
  }

  private async article(userId: string, input: BaijiahaoPublishInput, baseUrl?: string): Promise<PreparedBaijiahaoArticle> {
    const record = this.database.getRender(userId, input.renderId), render = record?.results.find(result => result.platform === 'baijiahao')
    if (!record || !render) throw notFound('百家号排版记录不存在，请先生成百家号排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'baijiahao_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'baijiahao_render_stale', '原文已修改，请重新生成百家号排版后发布')
    const title = render.title.trim()
    if (Array.from(title).length < 2 || Array.from(title).length > 30) throw new ApiError(400, 'baijiahao_title_invalid', '百家号标题需要 2–30 个字')
    if (!render.text?.trim()) throw new ApiError(400, 'baijiahao_body_empty', '请先填写文章正文')
    if (Buffer.byteLength(render.html) > 1024 * 1024) throw new ApiError(400, 'baijiahao_body_size', '正文 HTML 不能超过 1 MB')
    const $ = load(render.html, null, false)
    if ($('video,audio,iframe,svg').length || render.videos.length) throw new ApiError(400, 'baijiahao_media_unsupported', '百家号发布支持图文，请先移除视频、音频、嵌入内容或 SVG')
    if ($('img').length > 100) throw new ApiError(400, 'baijiahao_image_count', '百家号正文最多支持 100 张图片')
    // Collect body images in document order: local /uploads/ files resolve
    // directly, everything else (external CDN, data URLs) downloads before upload.
    const images = new Map<string, PublisherImage>(), external: string[] = []
    let firstImageSrc: string | null = null
    for (const node of $('img').toArray()) {
      const src = $(node).attr('src') || ''
      if (!firstImageSrc && src) firstImageSrc = src
      if (!src || images.has(src) || external.includes(src) || isBaijiahaoImageSrc(src)) continue
      let url: URL
      try { url = new URL(src, 'https://multipush.invalid') } catch { throw new ApiError(400, 'baijiahao_image_invalid', '正文包含无效图片地址，请重新上传图片') }
      const origin = this.config.publicBaseUrl || baseUrl
      const owned = url.origin === 'https://multipush.invalid' || !!origin && url.origin === new URL(origin).origin
      if (owned && url.pathname.startsWith('/uploads/')) {
        const filename = url.pathname.slice('/uploads/'.length)
        if (!UPLOAD_FILENAME_PATTERN.test(filename)) throw notFound('正文图片路径无效')
        const media = this.database.getMediaByFilename(userId, filename)
        if (!media) throw notFound('正文图片不存在或无权访问，请在编辑器重新上传')
        images.set(src, await this.mediaImage(userId, media.id))
      } else if (url.protocol === 'data:' || ['http:', 'https:'].includes(url.protocol)) {
        // Reserve the map slot now so the upload order follows the document;
        // run() replaces the placeholder with the downloaded bytes.
        external.push(src)
        images.set(src, PENDING_DOWNLOAD)
      } else {
        throw new ApiError(400, 'baijiahao_image_invalid', '正文包含无效图片地址，请重新上传图片')
      }
    }
    // Cover priority: content cover → first body image. Baijiahao refuses to
    // publish without one, so publish mode fails loudly when neither exists.
    // Drafts save without a cover (the platform allows that), so cover work is
    // skipped entirely in draft mode.
    const mode = input.mode === 'draft' ? 'draft' : 'publish'
    let cover: PublisherImage | null = null, coverPending: string | null = null
    if (mode === 'publish') {
      const coverSrc = this.coverSource(content.coverImage, baseUrl) || firstImageSrc
      const resolved = coverSrc ? await this.coverFrom(coverSrc, userId, baseUrl) : { cover: null, coverPending: null }
      if (!resolved.cover && !resolved.coverPending) {
        throw new ApiError(409, 'baijiahao_cover_required', '百家号发布必须设置封面：请先在原文中设置封面，或在正文里插入图片')
      }
      cover = this.coverChecked(resolved.cover)
      coverPending = resolved.coverPending
    }
    return { title, html: render.html, text: render.text, mode, images, cover, coverPending, external }
  }

  /** Cover candidates follow the same URL forms as body images. */
  private coverSource(coverImage: string | null | undefined, baseUrl?: string): string {
    const raw = (coverImage ?? '').trim()
    if (!raw || raw.startsWith('#')) return ''
    if (/^data:/i.test(raw) || /^https?:\/\//i.test(raw)) return raw
    if (!baseUrl) return raw
    try { return new URL(raw, `${baseUrl.replace(/\/+$/, '')}/`).href } catch { return raw }
  }

  list(userId: string): BaijiahaoPublication[] { return this.database.listBaijiahaoPublications(userId) }
  get(userId: string, id: string): BaijiahaoPublication {
    const value = this.database.getBaijiahaoPublication(userId, id)
    if (!value) throw notFound('百家号发布记录不存在')
    return value
  }

  async resolve(userId: string, id: string, input: BaijiahaoResolveInput): Promise<BaijiahaoPublication> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status !== 'uncertain') throw new ApiError(409, 'baijiahao_resolution_stale', '任务状态已变化，请刷新后再操作')
    this.active.add(userId)
    let handedOff = false
    try {
      if (input.action === 'check') {
        const state = this.state(userId)
        this.database.updateBaijiahaoPublication(userId, id, { status: 'running', message: '正在重新核实百家号发布结果' })
        const task = this.recheck(userId, id, state, current)
        this.jobs.set(id, task); handedOff = true
        void task.finally(() => { this.jobs.delete(id); this.active.delete(userId) }).catch(() => {})
        return this.get(userId, id)
      }
      let values: Pick<BaijiahaoPublication, 'status' | 'message' | 'url' | 'remoteId'>
      if (input.action === 'not_published') {
        values = { status: 'failed', message: '用户已核实未发布，已解除限制；再次提交会重新发布', url: current.url, remoteId: current.remoteId }
      } else {
        const remoteId = parseBaijiahaoPublishedId(input.articleUrl || '')
        if (!remoteId) throw new ApiError(400, 'baijiahao_article_url', '请填写 https://baijiahao.baidu.com/s?id=文章编号 格式的文章链接')
        values = { status: 'published', message: '用户已人工核实文章发布成功，并关联文章链接', remoteId, url: baijiahaoArticleUrl(remoteId) }
      }
      const result = this.database.resolveBaijiahaoPublication(userId, id, input.action, values)
      if (!result) throw new ApiError(409, 'baijiahao_resolution_stale', '任务状态已变化，请刷新后再操作')
      return result
    } finally { if (!handedOff) this.active.delete(userId) }
  }

  private async recheck(userId: string, id: string, state: PublisherStorageState, current: BaijiahaoPublication): Promise<void> {
    try {
      const result = current.remoteId
        ? await this.driver.checkPublication(state, current.remoteId, current.title)
        : { status: 'unknown', url: null, message: '没有可核对的文章编号，请到百家号创作中心核实后选择人工核实结果' }
      this.database.resolveBaijiahaoPublication(userId, id, 'check', { status: result.status === 'published' ? 'published' : 'uncertain', message: result.message, url: result.url || current.url, remoteId: current.remoteId })
    } catch (error) {
      this.expire(userId, error)
      this.database.resolveBaijiahaoPublication(userId, id, 'check', { status: 'uncertain', message: error instanceof ApiError ? error.message : '自动核实未完成，请稍后重试或填写人工核实结果', url: current.url, remoteId: current.remoteId })
    }
  }

  async publish(userId: string, input: BaijiahaoPublishInput, baseUrl?: string): Promise<BaijiahaoPublication> {
    this.idle(userId)
    if ([...this.logins.values()].some(entry => entry.userId === userId && ['waiting', 'scanned'].includes(entry.value.status))) throw new ApiError(409, 'baijiahao_busy', '请先完成百家号扫码登录')
    this.active.add(userId)
    let handedOff = false
    try {
      if (this.database.hasUncertainBaijiahaoPublication(userId)) throw new ApiError(409, 'baijiahao_result_uncertain', '请先核实所有结果待确认的头条任务，再提交新的发布')
      const checked = await this.driver.checkSession(this.state(userId))
      this.save(userId, checked.state, checked.identity)
      const article = await this.article(userId, input, baseUrl)
      // The idempotency key covers the cover file and every body image buffer so
      // re-submitting the same article cannot re-upload or re-publish it.
      const hash = createHash('sha256').update(JSON.stringify({ account: checked.identity.accountId, contentId: this.database.getRender(userId, input.renderId)?.contentId, title: article.title, html: article.html, mode: article.mode, external: article.external, coverPending: article.coverPending }))
      if (article.cover) hash.update(article.cover.buffer)
      for (const [src, image] of article.images) hash.update(src).update(image.buffer)
      const idempotencyKey = hash.digest('hex'), previous = this.database.findBaijiahaoPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return previous
      const publication = previous ?? this.database.createBaijiahaoPublication(userId, { renderId: input.renderId, title: article.title, mode: article.mode, idempotencyKey })
      this.database.updateBaijiahaoPublication(userId, publication.id, { status: 'running', message: '正在准备百家号正文' })
      const task = this.run(userId, publication.id, checked.state, article, checked.identity)
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
    const account = this.database.getBaijiahaoAccount(userId)
    if (account && error instanceof ApiError && error.code === 'baijiahao_session_expired') this.database.saveBaijiahaoAccount(userId, { ...account, status: 'expired', checkedAt: now() })
  }

  private async run(userId: string, id: string, state: PublisherStorageState, article: PreparedBaijiahaoArticle, identity: BaijiahaoIdentity): Promise<void> {
    try {
      // Download remaining body images first so a broken link fails the task
      // cleanly instead of submitting an article without its images.
      for (const [index, src] of article.external.entries()) {
        this.database.updateBaijiahaoPublication(userId, id, { status: 'running', message: `正在读取正文图片 ${index + 1}/${article.external.length}，随后上传到百家号图床` })
        article.images.set(src, await downloadPublisherImage(src, 'baijiahao'))
      }
      if (article.mode === 'publish' && !article.cover && article.coverPending) {
        this.database.updateBaijiahaoPublication(userId, id, { status: 'running', message: '正在读取百家号封面图片' })
        // A cover that reuses the first body image is already in the map.
        article.cover = article.images.get(article.coverPending) ?? await downloadPublisherImage(article.coverPending, 'baijiahao')
        article.coverPending = null
        this.coverChecked(article.cover)
      }
      const result = await this.driver.publish(state, article, progress => { this.database.updateBaijiahaoPublication(userId, id, progress) })
      this.save(userId, result.state, identity)
      this.database.updateBaijiahaoPublication(userId, id, { status: result.status, message: result.message, url: result.url, remoteId: result.remoteId })
    } catch (error) {
      this.expire(userId, error)
      const code = error instanceof ApiError ? error.code : ''
      const uncertain = !(error instanceof ApiError) || code === 'baijiahao_result_uncertain'
      this.database.updateBaijiahaoPublication(userId, id, { status: uncertain ? 'uncertain' : 'failed', message: error instanceof ApiError ? error.message : '百家号操作中断，结果未确认，请先核对创作中心，避免重复发布' })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const pending = [...this.logins.values()].flatMap(entry => [entry.preparing, entry.polling].filter(value => value !== undefined))
    for (const entry of this.logins.values()) { clearTimeout(entry.timer); await entry.attempt?.close().catch(() => {}) }
    this.logins.clear()
    await this.driver.close()
    await Promise.allSettled([...pending, ...this.jobs.values(), ...this.checks.values()])
  }
}
