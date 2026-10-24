import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { load } from 'cheerio'
import type { ZhihuAccount, ZhihuLogin, ZhihuPublishInput, ZhihuPublication } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { UPLOAD_FILENAME_PATTERN } from './upload'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey, type PublisherStorageState } from './publisher-session'
import { downloadPublisherImage, publisherImage, type PublisherImage } from './publisher-image'
import { prepareZhihuContent, zhihuImageUrl } from './zhihu-content'
import type { ZhihuArticle, ZhihuDriver, ZhihuIdentity, ZhihuLoginAttempt } from './zhihu-browser'

const TTL = 5 * 60_000
const now = () => new Date().toISOString()
type LoginEntry = { userId: string; value: ZhihuLogin; attempt: ZhihuLoginAttempt; timer: ReturnType<typeof setTimeout>; polling?: Promise<ZhihuLogin> }

export class ZhihuService {
  private readonly key: Buffer
  private readonly logins = new Map<string, LoginEntry>()
  private readonly active = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<ZhihuAccount>>()
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: ZhihuDriver) {
    this.key = loadPublisherKey(config.dataDir, 'zhihu')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'zhihu_unavailable', '知乎服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'zhihu_busy', '知乎操作正在进行，请等待完成')
  }

  private state(userId: string): PublisherStorageState {
    const account = this.database.getZhihuAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'zhihu_session_expired', '请先在系统中扫码登录知乎')
    try { return decryptPublisherSession(account.encryptedSession, this.key, userId) }
    catch {
      this.database.saveZhihuAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'zhihu_session_expired', '知乎登录状态无法恢复，请重新扫码连接')
    }
  }

  private save(userId: string, state: PublisherStorageState, identity: ZhihuIdentity): void {
    if (!this.closed) this.database.saveZhihuAccount(userId, { encryptedSession: encryptPublisherSession(state, this.key, userId), ...identity, status: 'connected', checkedAt: now() })
  }

  async account(userId: string): Promise<ZhihuAccount> {
    const current = this.database.getZhihuAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    const view = { status: current.status, name: current.name, checkedAt: current.checkedAt }
    if (current.status === 'expired' || this.active.has(userId) || Date.now() - Date.parse(current.checkedAt) < TTL) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<ZhihuAccount> => {
      try {
        const result = await this.driver.checkSession(this.state(userId))
        const latest = this.database.getZhihuAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.save(userId, result.state, result.identity)
        return { status: 'connected', name: result.identity.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'zhihu_session_expired' && this.database.getZhihuAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveZhihuAccount(userId, { ...current, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, checkedAt: now() }
        }
        throw error
      }
    })().finally(() => this.checks.delete(userId))
    this.checks.set(userId, check)
    return check
  }

  async startLogin(userId: string): Promise<ZhihuLogin> {
    this.idle(userId)
    this.active.add(userId)
    try {
      for (const [id, entry] of this.logins) {
        if (entry.userId === userId) { clearTimeout(entry.timer); this.logins.delete(id); await entry.attempt.close().catch(() => {}) }
      }
      if (this.logins.size >= 8) throw new ApiError(503, 'zhihu_busy', '当前登录请求较多，请稍后重试')
      const attempt = await this.driver.beginLogin(), id = randomUUID()
      const value: ZhihuLogin = { id, status: 'waiting', qrCode: null, message: '请使用知乎 App 扫码登录', expiresAt: new Date(Date.now() + TTL).toISOString() }
      const timer = setTimeout(() => { this.logins.delete(id); void attempt.close().catch(() => {}) }, TTL)
      timer.unref()
      this.logins.set(id, { userId, value, attempt, timer })
      return await this.pollLogin(userId, id)
    } finally { this.active.delete(userId) }
  }

  async pollLogin(userId: string, id: string): Promise<ZhihuLogin> {
    const entry = this.logins.get(id)
    if (!entry || entry.userId !== userId) throw notFound('知乎登录请求不存在或已过期，请重新连接')
    if (!['waiting', 'scanned'].includes(entry.value.status)) return entry.value
    if (entry.polling) return entry.polling
    entry.polling = (async () => {
      try {
        const result = await entry.attempt.poll()
        if (this.logins.get(id) !== entry) throw notFound('知乎登录已取消')
        if (result.status === 'connected') {
          if (!result.state || !result.identity) throw new ApiError(502, 'zhihu_login_failed', '知乎没有返回有效登录会话，请重试')
          this.save(userId, result.state, result.identity)
        }
        entry.value = { ...entry.value, status: result.status, qrCode: result.qrCode, message: result.message }
      } catch (error) {
        entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '读取知乎登录状态失败，请重新连接' }
      }
      if (!['waiting', 'scanned'].includes(entry.value.status)) await entry.attempt.close().catch(() => {})
      return entry.value
    })().finally(() => { entry.polling = undefined })
    return entry.polling
  }

  async disconnect(userId: string): Promise<void> {
    this.idle(userId)
    this.active.add(userId)
    try {
      for (const [id, entry] of this.logins) {
        if (entry.userId === userId) { this.logins.delete(id); clearTimeout(entry.timer); await entry.attempt.close().catch(() => {}) }
      }
      this.database.deleteZhihuAccount(userId)
    } finally { this.active.delete(userId) }
  }

  private async image(userId: string, mediaId: string): Promise<PublisherImage> {
    const media = this.database.getMedia(userId, mediaId)
    if (!media || !UPLOAD_FILENAME_PATTERN.test(media.filename)) throw notFound('图片不存在或无权访问，请重新上传')
    if (media.kind !== 'image' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(media.mimeType) || media.size > 10 * 1024 * 1024) throw new ApiError(400, 'zhihu_image_invalid', '知乎图片请使用 10 MB 以内的 JPG、PNG、GIF 或 WebP')
    try { return { ...publisherImage(await readFile(path.join(this.config.uploadsDir, media.filename)), true), name: media.filename } }
    catch { throw new ApiError(400, 'zhihu_image_invalid', '图片文件丢失、格式无效或超过 10 MB，请重新上传') }
  }

  private async article(userId: string, input: ZhihuPublishInput, baseUrl?: string): Promise<ZhihuArticle & { external: string[] }> {
    const record = this.database.getRender(userId, input.renderId), render = record?.results.find(result => result.platform === 'zhihu')
    if (!record || !render) throw notFound('知乎排版记录不存在，请先生成知乎排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'zhihu_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'zhihu_render_stale', '原文已修改，请重新生成知乎排版后发布')
    const title = render.title.trim(), raw = load(render.html, null, false)
    if (!title || Array.from(title).length > 100) throw new ApiError(400, 'zhihu_title_invalid', '知乎标题需要 1–100 个字')
    if (!raw.text().trim()) throw new ApiError(400, 'zhihu_body_empty', '请先填写文章正文')
    if (Buffer.byteLength(render.html) > 1024 * 1024) throw new ApiError(400, 'zhihu_body_size', '正文 HTML 不能超过 1 MB')
    if (raw('video,audio,iframe,svg').length || render.videos.length) throw new ApiError(400, 'zhihu_media_unsupported', '当前知乎发布支持图文，请先移除视频、音频、嵌入内容或 SVG')
    if (raw('img').length > 100) throw new ApiError(400, 'zhihu_image_count', '知乎正文最多支持 100 张图片')
    const html = prepareZhihuContent(render.html), $ = load(html, null, false), images = new Map<string, PublisherImage>(), external: string[] = []
    for (const node of $('img').toArray()) {
      const src = $(node).attr('src') || ''
      if (images.has(src) || external.includes(src) || zhihuImageUrl(src)) continue
      let url: URL
      try { url = new URL(src, 'https://multipush.invalid') } catch { throw new ApiError(400, 'zhihu_image_invalid', '正文包含无效图片地址') }
      const origin = this.config.publicBaseUrl || baseUrl
      const owned = url.origin === 'https://multipush.invalid' || !!origin && url.origin === new URL(origin).origin
      if (owned && url.pathname.startsWith('/uploads/')) {
        const filename = url.pathname.slice('/uploads/'.length)
        if (!UPLOAD_FILENAME_PATTERN.test(filename)) throw notFound('图片路径无效')
        const media = this.database.getMediaByFilename(userId, filename)
        if (!media) throw notFound('正文图片不存在或无权访问，请重新上传')
        images.set(src, await this.image(userId, media.id))
      } else if (url.protocol === 'data:' || !owned && ['http:', 'https:'].includes(url.protocol)) external.push(src)
      else throw new ApiError(400, 'zhihu_image_invalid', '正文包含无效图片地址，请重新上传')
    }
    return { title, html, images, external, ...(input.coverMediaId ? { cover: await this.image(userId, input.coverMediaId) } : {}) }
  }

  list(userId: string): ZhihuPublication[] { return this.database.listZhihuPublications(userId) }
  get(userId: string, id: string): ZhihuPublication {
    const value = this.database.getZhihuPublication(userId, id)
    if (!value) throw notFound('知乎发布记录不存在')
    return value
  }

  async publish(userId: string, input: ZhihuPublishInput, baseUrl?: string): Promise<ZhihuPublication> {
    this.idle(userId)
    if ([...this.logins.values()].some(entry => entry.userId === userId && ['waiting', 'scanned'].includes(entry.value.status))) throw new ApiError(409, 'zhihu_busy', '请先完成知乎扫码登录')
    this.active.add(userId)
    let handedOff = false
    try {
      const checked = await this.driver.checkSession(this.state(userId))
      this.save(userId, checked.state, checked.identity)
      const article = await this.article(userId, input, baseUrl)
      const hash = createHash('sha256').update(JSON.stringify({ account: checked.identity.accountId, contentId: this.database.getRender(userId, input.renderId)?.contentId, title: article.title, html: article.html, mode: input.mode }))
      if (article.cover) hash.update(article.cover.buffer)
      for (const [src, image] of article.images) hash.update(src).update(image.buffer)
      const idempotencyKey = hash.digest('hex'), previous = this.database.findZhihuPublication(userId, idempotencyKey)
      if (previous && (previous.status !== 'failed' || previous.remoteId)) return previous
      const publication = previous ?? this.database.createZhihuPublication(userId, { renderId: input.renderId, title: article.title, mode: input.mode, idempotencyKey })
      this.database.updateZhihuPublication(userId, publication.id, { status: 'running', message: '正在准备知乎正文及图片' })
      const task = this.run(userId, publication.id, checked, article, input.mode)
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
    const account = this.database.getZhihuAccount(userId)
    if (account && error instanceof ApiError && error.code === 'zhihu_session_expired') this.database.saveZhihuAccount(userId, { ...account, status: 'expired', checkedAt: now() })
  }

  private async run(userId: string, id: string, checked: Awaited<ReturnType<ZhihuDriver['checkSession']>>, article: ZhihuArticle & { external: string[] }, mode: 'draft' | 'publish'): Promise<void> {
    try {
      for (const [index, src] of article.external.entries()) {
        this.database.updateZhihuPublication(userId, id, { message: `正在读取正文图片 ${index + 1}/${article.external.length}，随后上传到知乎` })
        article.images.set(src, await downloadPublisherImage(src, 'zhihu'))
      }
      const result = await this.driver.publish(checked.state, article, mode, progress => { this.database.updateZhihuPublication(userId, id, progress) })
      this.save(userId, result.state, checked.identity)
      this.database.updateZhihuPublication(userId, id, result)
    } catch (error) {
      this.expire(userId, error)
      const uncertain = !(error instanceof ApiError) || error.code === 'zhihu_result_uncertain'
      this.database.updateZhihuPublication(userId, id, { status: uncertain ? 'uncertain' : 'failed', message: error instanceof ApiError ? error.message : '知乎操作中断，结果未确认，请先核对知乎后台，避免重复提交' })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const entry of this.logins.values()) { clearTimeout(entry.timer); await entry.attempt.close().catch(() => {}) }
    this.logins.clear()
    await this.driver.close()
    await Promise.allSettled([...this.jobs.values(), ...this.checks.values()])
  }
}
