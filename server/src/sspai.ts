import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { load } from 'cheerio'
import type { SspaiAccount, SspaiLogin, SspaiPublishInput, SspaiPublication, SspaiResolveInput } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { UPLOAD_FILENAME_PATTERN } from './upload'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey, type PublisherStorageState } from './publisher-session'
import { downloadPublisherImage, publisherImage, type PublisherImage } from './publisher-image'
import { prepareSspaiContent, sspaiImageUrl } from './sspai-content'
import { parseSspaiPublishedId, sspaiPublicationUrl, type SspaiArticle, type SspaiDriver, type SspaiIdentity, type SspaiLoginAttempt } from './sspai-browser'

const TTL = 5 * 60_000
const MAX_IMAGES = 100
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const now = () => new Date().toISOString()
type LoginEntry = { userId: string; value: SspaiLogin; attempt?: SspaiLoginAttempt; timer: ReturnType<typeof setTimeout>; preparing?: Promise<void>; polling?: Promise<SspaiLogin> }

export class SspaiService {
  private readonly key: Buffer
  private readonly logins = new Map<string, LoginEntry>()
  private readonly active = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<SspaiAccount>>()
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: SspaiDriver) {
    this.key = loadPublisherKey(config.dataDir, 'sspai')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'sspai_unavailable', '少数派服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'sspai_busy', '少数派操作正在进行，请等待完成')
  }

  private state(userId: string): PublisherStorageState {
    const account = this.database.getSspaiAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'sspai_session_expired', '请先在系统中扫码登录少数派')
    try { return decryptPublisherSession(account.encryptedSession, this.key, userId) }
    catch {
      this.database.saveSspaiAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'sspai_session_expired', '少数派登录状态无法恢复，请重新扫码连接')
    }
  }

  private save(userId: string, state: PublisherStorageState, identity: SspaiIdentity): void {
    if (!this.closed) this.database.saveSspaiAccount(userId, { encryptedSession: encryptPublisherSession(state, this.key, userId), ...identity, status: 'connected', checkedAt: now() })
  }

  async account(userId: string): Promise<SspaiAccount> {
    const current = this.database.getSspaiAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    const view = { status: current.status, name: current.name, checkedAt: current.checkedAt }
    if (current.status === 'expired' || this.active.has(userId) || Date.now() - Date.parse(current.checkedAt) < TTL) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<SspaiAccount> => {
      try {
        const result = await this.driver.checkSession(this.state(userId))
        const latest = this.database.getSspaiAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.save(userId, result.state, result.identity)
        return { status: 'connected', name: result.identity.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'sspai_session_expired' && this.database.getSspaiAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveSspaiAccount(userId, { ...current, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, checkedAt: now() }
        }
        throw error
      }
    })().finally(() => this.checks.delete(userId))
    this.checks.set(userId, check)
    return check
  }

  async startLogin(userId: string): Promise<SspaiLogin> {
    this.idle(userId)
    const pending = [...this.logins.values()].find(entry => entry.userId === userId && entry.preparing)
    if (pending) return pending.value
    for (const [id, entry] of this.logins) {
      if (entry.userId === userId) { clearTimeout(entry.timer); this.logins.delete(id); void entry.attempt?.close().catch(() => {}) }
    }
    if (this.logins.size >= 8) throw new ApiError(503, 'sspai_busy', '当前登录请求较多，请稍后重试')
    const id = randomUUID()
    const value: SspaiLogin = { id, status: 'waiting', qrCode: null, message: '正在准备少数派微信登录二维码，请稍候', expiresAt: new Date(Date.now() + TTL).toISOString() }
    const timer = setTimeout(() => { this.logins.delete(id); void entry.attempt?.close().catch(() => {}) }, TTL)
    timer.unref()
    const entry: LoginEntry = { userId, value, timer }
    this.logins.set(id, entry)
    // Browser startup and the login page must never hold a public HTTP request open.
    entry.preparing = (async () => {
      try {
        const attempt = await this.driver.beginLogin()
        if (this.closed || this.logins.get(id) !== entry) { await attempt.close().catch(() => {}); return }
        entry.attempt = attempt
        this.refreshLogin(userId, id, entry)
      } catch (error) {
        if (this.logins.get(id) === entry) entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '获取少数派登录二维码失败，请重新连接' }
      }
    })().finally(() => { entry.preparing = undefined })
    return value
  }

  async pollLogin(userId: string, id: string): Promise<SspaiLogin> {
    const entry = this.logins.get(id)
    if (!entry || entry.userId !== userId) throw notFound('少数派登录请求不存在或已过期，请重新连接')
    this.refreshLogin(userId, id, entry)
    return entry.value
  }

  private refreshLogin(userId: string, id: string, entry: LoginEntry): void {
    if (this.closed || !entry.attempt || entry.polling || !['waiting', 'scanned'].includes(entry.value.status)) return
    const attempt = entry.attempt
    entry.polling = (async () => {
      try {
        const result = await attempt.poll()
        if (this.logins.get(id) !== entry) throw notFound('少数派登录已取消')
        if (result.status === 'connected') {
          if (!result.state || !result.identity) throw new ApiError(502, 'sspai_login_failed', '少数派没有返回有效登录会话，请重试')
          this.save(userId, result.state, result.identity)
        }
        entry.value = { ...entry.value, status: result.status, qrCode: result.qrCode, message: result.message }
      } catch (error) {
        entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '读取少数派登录状态失败，请重新连接' }
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
      this.database.deleteSspaiAccount(userId)
    } finally { this.active.delete(userId) }
  }

  private async image(userId: string, mediaId: string): Promise<PublisherImage> {
    const media = this.database.getMedia(userId, mediaId)
    if (!media || !UPLOAD_FILENAME_PATTERN.test(media.filename)) throw notFound('图片不存在或无权访问，请重新上传')
    if (media.kind !== 'image' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(media.mimeType) || media.size > MAX_IMAGE_BYTES) throw new ApiError(400, 'sspai_image_invalid', '少数派图片请使用 10 MB 以内的 JPG、PNG、GIF 或 WebP')
    try { return { ...publisherImage(await readFile(path.join(this.config.uploadsDir, media.filename)), true), name: media.filename } }
    catch { throw new ApiError(400, 'sspai_image_invalid', '图片文件丢失、格式无效或超过 10 MB，请重新上传') }
  }

  private async article(userId: string, input: SspaiPublishInput, baseUrl?: string): Promise<SspaiArticle & { external: string[] }> {
    const record = this.database.getRender(userId, input.renderId), render = record?.results.find(result => result.platform === 'sspai')
    if (!record || !render) throw notFound('少数派排版记录不存在，请先生成少数派排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'sspai_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'sspai_render_stale', '原文已修改，请重新生成少数派排版后发布')
    const title = render.title.trim()
    if (!title || Array.from(title).length > 32) throw new ApiError(400, 'sspai_title_invalid', '少数派标题需要 1–32 个字')
    const raw = load(render.html, null, false)
    if (!raw.text().trim() && !raw('img').length) throw new ApiError(400, 'sspai_body_empty', '请先填写文章正文')
    if (Buffer.byteLength(render.html) > 1024 * 1024) throw new ApiError(400, 'sspai_body_size', '正文 HTML 不能超过 1 MB')
    if (raw('video,audio,iframe,svg').length || render.videos.length) throw new ApiError(400, 'sspai_media_unsupported', '少数派发布支持图文，请先移除视频、音频、嵌入内容或 SVG')
    if (raw('img').length > MAX_IMAGES) throw new ApiError(400, 'sspai_image_count', `少数派正文最多支持 ${MAX_IMAGES} 张图片`)
    const html = prepareSspaiContent(render.html), $ = load(html, null, false), images = new Map<string, PublisherImage>(), external: string[] = []
    for (const node of $('img').toArray()) {
      const src = $(node).attr('src') || ''
      if (images.has(src) || external.includes(src) || sspaiImageUrl(src)) continue
      let url: URL
      try { url = new URL(src, 'https://multipush.invalid') } catch { throw new ApiError(400, 'sspai_image_invalid', '正文包含无效图片地址') }
      const origin = this.config.publicBaseUrl || baseUrl
      const owned = url.origin === 'https://multipush.invalid' || !!origin && url.origin === new URL(origin).origin
      if (owned && url.pathname.startsWith('/uploads/')) {
        const filename = url.pathname.slice('/uploads/'.length)
        if (!UPLOAD_FILENAME_PATTERN.test(filename)) throw notFound('图片路径无效')
        const media = this.database.getMediaByFilename(userId, filename)
        if (!media) throw notFound('正文图片不存在或无权访问，请重新上传')
        images.set(src, await this.image(userId, media.id))
      } else if (url.protocol === 'data:' || !owned && ['http:', 'https:'].includes(url.protocol)) external.push(src)
      else throw new ApiError(400, 'sspai_image_invalid', '正文包含无效图片地址，请重新上传')
    }
    const tags = (render.meta.tags || []).map(tag => tag.trim()).filter(Boolean).slice(0, 5)
    return { title, html, tags, images, external, ...(input.coverMediaId ? { cover: await this.image(userId, input.coverMediaId) } : {}) }
  }

  list(userId: string): SspaiPublication[] { return this.database.listSspaiPublications(userId) }
  get(userId: string, id: string): SspaiPublication {
    const value = this.database.getSspaiPublication(userId, id)
    if (!value) throw notFound('少数派发布记录不存在')
    return value
  }

  async resolve(userId: string, id: string, input: SspaiResolveInput): Promise<SspaiPublication> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status !== 'uncertain') throw new ApiError(409, 'sspai_resolution_stale', '任务状态已变化，请刷新后再操作')
    this.active.add(userId)
    let handedOff = false
    try {
      if (input.action === 'check') {
        const state = this.state(userId)
        this.database.updateSspaiPublication(userId, id, { status: 'running', message: '正在重新核实少数派发布结果' })
        const task = this.recheck(userId, id, state, current)
        this.jobs.set(id, task); handedOff = true
        void task.finally(() => { this.jobs.delete(id); this.active.delete(userId) }).catch(() => {})
        return this.get(userId, id)
      }
      let values: Pick<SspaiPublication, 'status' | 'message' | 'url' | 'remoteId'>
      if (input.action === 'not_published') {
        values = { status: 'failed', message: '用户已核实未发布，已解除限制；再次提交会优先复用原草稿', url: current.url, remoteId: current.remoteId }
      } else {
        const remoteId = parseSspaiPublishedId(input.articleUrl || '')
        if (!remoteId) throw new ApiError(400, 'sspai_article_url', '请填写 https://sspai.com/post/文章编号 格式的文章链接')
        values = { status: 'published', message: '用户已人工核实文章发布成功，并关联文章链接', remoteId, url: sspaiPublicationUrl(remoteId) }
      }
      const result = this.database.resolveSspaiPublication(userId, id, input.action, values)
      if (!result) throw new ApiError(409, 'sspai_resolution_stale', '任务状态已变化，请刷新后再操作')
      return result
    } finally { if (!handedOff) this.active.delete(userId) }
  }

  private async recheck(userId: string, id: string, state: PublisherStorageState, current: SspaiPublication): Promise<void> {
    try {
      const result = current.remoteId
        ? await this.driver.checkPublication(state, current.remoteId, current.title)
        : { status: 'unknown', url: null, message: '没有可核对的远端编号，请在少数派后台核实后选择人工核实结果' }
      this.database.resolveSspaiPublication(userId, id, 'check', { status: result.status === 'published' ? 'published' : 'uncertain', message: result.message, url: result.url || current.url, remoteId: current.remoteId })
    } catch (error) {
      this.expire(userId, error)
      this.database.resolveSspaiPublication(userId, id, 'check', { status: 'uncertain', message: error instanceof ApiError ? error.message : '自动核实未完成，请稍后重试或填写人工核实结果', url: current.url, remoteId: current.remoteId })
    }
  }

  async publish(userId: string, input: SspaiPublishInput, baseUrl?: string): Promise<SspaiPublication> {
    this.idle(userId)
    if ([...this.logins.values()].some(entry => entry.userId === userId && ['waiting', 'scanned'].includes(entry.value.status))) throw new ApiError(409, 'sspai_busy', '请先完成少数派扫码登录')
    this.active.add(userId)
    let handedOff = false
    try {
      if (this.database.hasUncertainSspaiPublication(userId)) throw new ApiError(409, 'sspai_result_uncertain', '请先核实所有结果待确认的任务，再提交新的发布')
      const checked = await this.driver.checkSession(this.state(userId))
      this.save(userId, checked.state, checked.identity)
      const article = await this.article(userId, input, baseUrl)
      const hash = createHash('sha256').update(JSON.stringify({ account: checked.identity.accountId, contentId: this.database.getRender(userId, input.renderId)?.contentId, title: article.title, html: article.html, tags: article.tags, mode: input.mode }))
      if (article.cover) hash.update(article.cover.buffer)
      for (const [src, image] of article.images) hash.update(src).update(image.buffer)
      for (const src of article.external) hash.update(src)
      const idempotencyKey = hash.digest('hex'), previous = this.database.findSspaiPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return previous
      const publication = previous ?? this.database.createSspaiPublication(userId, { renderId: input.renderId, title: article.title, mode: input.mode, idempotencyKey })
      this.database.updateSspaiPublication(userId, publication.id, { status: 'running', message: '正在准备少数派正文及图片' })
      const task = this.run(userId, publication.id, checked, article, input.mode, previous?.remoteId || undefined, previous?.resolutions?.some(entry => entry.action === 'not_published') || false)
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
    const account = this.database.getSspaiAccount(userId)
    if (account && error instanceof ApiError && error.code === 'sspai_session_expired') this.database.saveSspaiAccount(userId, { ...account, status: 'expired', checkedAt: now() })
  }

  private async run(userId: string, id: string, checked: Awaited<ReturnType<SspaiDriver['checkSession']>>, article: SspaiArticle & { external: string[] }, mode: 'draft' | 'publish', resumeId?: string, confirmedUnpublished = false): Promise<void> {
    try {
      for (const [index, src] of article.external.entries()) {
        this.database.updateSspaiPublication(userId, id, { message: `正在读取正文图片 ${index + 1}/${article.external.length}，随后上传到少数派` })
        article.images.set(src, await downloadPublisherImage(src, 'sspai'))
      }
      let result
      try {
        result = await this.driver.publish(checked.state, article, mode, progress => { this.database.updateSspaiPublication(userId, id, progress) }, resumeId)
      } catch (error) {
        if (resumeId && confirmedUnpublished && error instanceof ApiError && error.code === 'sspai_draft_missing') {
          this.database.updateSspaiPublication(userId, id, { remoteId: null, url: null, message: '已确认未发布，原草稿失效，正在重新上传图片并创建草稿' })
          result = await this.driver.publish(checked.state, article, mode, progress => { this.database.updateSspaiPublication(userId, id, progress) })
        } else throw error
      }
      this.save(userId, result.state, checked.identity)
      this.database.updateSspaiPublication(userId, id, result)
    } catch (error) {
      this.expire(userId, error)
      const code = error instanceof ApiError ? error.code : ''
      const uncertain = !(error instanceof ApiError) || ['sspai_result_uncertain', 'sspai_draft_missing', 'sspai_content_mismatch', 'sspai_publish_unverified'].includes(code)
      this.database.updateSspaiPublication(userId, id, { status: uncertain ? 'uncertain' : 'failed', message: error instanceof ApiError ? error.message : '少数派操作中断，结果未确认，请先核对少数派后台，避免重复提交' })
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
