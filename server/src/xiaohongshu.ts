import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { prepareXhsCaption } from '../../shared/render-workbench'
import type { XhsAccount, XhsLogin, XhsPublishInput, XhsPublication, XhsResolveInput } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { UPLOAD_FILENAME_PATTERN } from './upload'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey, type PublisherStorageState } from './publisher-session'
import { publisherImage, type PublisherImage } from './publisher-image'
import type { XhsArticle, XhsDriver, XhsIdentity, XhsLoginAttempt } from './xiaohongshu-browser'

const TTL = 5 * 60_000
const now = () => new Date().toISOString()
type LoginEntry = { userId: string; value: XhsLogin; attempt?: XhsLoginAttempt; timer: ReturnType<typeof setTimeout>; preparing?: Promise<void>; polling?: Promise<XhsLogin> }

export class XhsService {
  private readonly key: Buffer
  private readonly logins = new Map<string, LoginEntry>()
  private readonly active = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<XhsAccount>>()
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: XhsDriver) {
    this.key = loadPublisherKey(config.dataDir, 'xiaohongshu')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'xiaohongshu_unavailable', '小红书服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'xiaohongshu_busy', '小红书操作正在进行，请等待完成')
  }

  private state(userId: string): PublisherStorageState {
    const account = this.database.getXhsAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'xiaohongshu_session_expired', '请先在系统中扫码登录小红书')
    try { return decryptPublisherSession(account.encryptedSession, this.key, userId) }
    catch {
      this.database.saveXhsAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'xiaohongshu_session_expired', '小红书登录状态无法恢复，请重新扫码连接')
    }
  }

  private save(userId: string, state: PublisherStorageState, identity: XhsIdentity): void {
    if (!this.closed) this.database.saveXhsAccount(userId, { encryptedSession: encryptPublisherSession(state, this.key, userId), ...identity, status: 'connected', checkedAt: now() })
  }

  async account(userId: string): Promise<XhsAccount> {
    const current = this.database.getXhsAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    const view = { status: current.status, name: current.name, checkedAt: current.checkedAt }
    if (current.status === 'expired' || this.active.has(userId) || Date.now() - Date.parse(current.checkedAt) < TTL) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<XhsAccount> => {
      try {
        const result = await this.driver.checkSession(this.state(userId))
        const latest = this.database.getXhsAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.save(userId, result.state, result.identity)
        return { status: 'connected', name: result.identity.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'xiaohongshu_session_expired' && this.database.getXhsAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveXhsAccount(userId, { ...current, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, checkedAt: now() }
        }
        throw error
      }
    })().finally(() => this.checks.delete(userId))
    this.checks.set(userId, check)
    return check
  }

  async startLogin(userId: string): Promise<XhsLogin> {
    this.idle(userId)
    const pending = [...this.logins.values()].find(entry => entry.userId === userId && entry.preparing)
    if (pending) return pending.value
    for (const [id, entry] of this.logins) {
      if (entry.userId === userId) { clearTimeout(entry.timer); this.logins.delete(id); void entry.attempt?.close().catch(() => {}) }
    }
    if (this.logins.size >= 8) throw new ApiError(503, 'xiaohongshu_busy', '当前登录请求较多，请稍后重试')
    const id = randomUUID()
    const value: XhsLogin = { id, status: 'waiting', qrCode: null, message: '正在准备小红书官方登录二维码，请稍候', expiresAt: new Date(Date.now() + TTL).toISOString() }
    const timer = setTimeout(() => { this.logins.delete(id); void entry.attempt?.close().catch(() => {}) }, TTL)
    timer.unref()
    const entry: LoginEntry = { userId, value, timer }
    this.logins.set(id, entry)
    // Browser startup and Xhs page loading must never hold a public HTTP request open.
    entry.preparing = (async () => {
      try {
        const attempt = await this.driver.beginLogin()
        if (this.closed || this.logins.get(id) !== entry) { await attempt.close().catch(() => {}); return }
        entry.attempt = attempt
        this.refreshLogin(userId, id, entry)
      } catch (error) {
        if (this.logins.get(id) === entry) entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '获取小红书登录二维码失败，请重新连接' }
      }
    })().finally(() => { entry.preparing = undefined })
    return value
  }

  async pollLogin(userId: string, id: string): Promise<XhsLogin> {
    const entry = this.logins.get(id)
    if (!entry || entry.userId !== userId) throw notFound('小红书登录请求不存在或已过期，请重新连接')
    this.refreshLogin(userId, id, entry)
    return entry.value
  }

  private refreshLogin(userId: string, id: string, entry: LoginEntry): void {
    if (this.closed || !entry.attempt || entry.polling || !['waiting', 'scanned'].includes(entry.value.status)) return
    const attempt = entry.attempt
    entry.polling = (async () => {
      try {
        const result = await attempt.poll()
        if (this.logins.get(id) !== entry) throw notFound('小红书登录已取消')
        if (result.status === 'connected') {
          if (!result.state || !result.identity) throw new ApiError(502, 'xiaohongshu_login_failed', '小红书没有返回有效登录会话，请重试')
          this.save(userId, result.state, result.identity)
        }
        entry.value = { ...entry.value, status: result.status, qrCode: result.qrCode, message: result.message }
      } catch (error) {
        entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '读取小红书登录状态失败，请重新连接' }
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
      this.database.deleteXhsAccount(userId)
    } finally { this.active.delete(userId) }
  }

  private async image(userId: string, mediaId: string): Promise<PublisherImage> {
    const media = this.database.getMedia(userId, mediaId)
    if (!media || !UPLOAD_FILENAME_PATTERN.test(media.filename)) throw notFound('图片不存在或无权访问，请重新上传')
    if (media.kind !== 'image' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(media.mimeType) || media.size > 10 * 1024 * 1024) throw new ApiError(400, 'xiaohongshu_image_invalid', '小红书图片请使用 10 MB 以内的 JPG、PNG、GIF 或 WebP')
    try { return { ...publisherImage(await readFile(path.join(this.config.uploadsDir, media.filename)), true), name: media.filename } }
    catch { throw new ApiError(400, 'xiaohongshu_image_invalid', '图片文件丢失、格式无效或超过 10 MB，请重新上传') }
  }

  private async article(userId: string, input: XhsPublishInput, _baseUrl?: string): Promise<XhsArticle> {
    const record = this.database.getRender(userId, input.renderId), render = record?.results.find(result => result.platform === 'xiaohongshu')
    if (!record || !render) throw notFound('小红书排版不存在，请先生成排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'xiaohongshu_content_deleted', '原文已删除，请先恢复')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'xiaohongshu_render_stale', '原文已修改，请重新生成排版')
    const title = render.title.trim(), body = prepareXhsCaption(render).text
    if (!title || Array.from(title).length > 20) throw new ApiError(400, 'xiaohongshu_title_invalid', '小红书标题需要 1–20 个字')
    if (!body.trim() || Array.from(body).length > 1000) throw new ApiError(400, 'xiaohongshu_body_invalid', '正文和话题合计需要 1–1000 个字')
    if (render.videos.length) throw new ApiError(400, 'xiaohongshu_video_unsupported', '当前支持图文发布，请移除视频后重试')
    if (input.mode !== 'publish' || !input.imageMediaIds?.length || input.imageMediaIds.length > 18) throw new ApiError(400, 'xiaohongshu_images_invalid', '请选择 1–18 张图片')
    const images = new Map<string, PublisherImage>()
    for (const [index, id] of input.imageMediaIds.entries()) images.set(String(index), await this.image(userId, id))
    return { title, body, images }
  }

  list(userId: string): XhsPublication[] { return this.database.listXhsPublications(userId) }
  get(userId: string, id: string): XhsPublication {
    const value = this.database.getXhsPublication(userId, id)
    if (!value) throw notFound('小红书发布记录不存在')
    return value
  }

  async resolve(userId: string, id: string, input: XhsResolveInput): Promise<XhsPublication> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status !== 'uncertain') throw new ApiError(409, 'xiaohongshu_resolution_stale', '任务状态已变化，请刷新后再操作')
    this.active.add(userId)
    let handedOff = false
    try {
      if (input.action === 'check') {
        const state = this.state(userId)
        this.database.updateXhsPublication(userId, id, { status: 'running', message: '正在重新核实小红书发布结果' })
        const task = this.recheck(userId, id, state, current)
        this.jobs.set(id, task); handedOff = true
        void task.finally(() => { this.jobs.delete(id); this.active.delete(userId) }).catch(() => {})
        return this.get(userId, id)
      }
      let values: Pick<XhsPublication, 'status' | 'message' | 'url' | 'remoteId'>
      if (input.action === 'not_published') {
        values = { status: 'failed', message: '用户已核实未发布，已解除限制；再次提交将创建新的笔记', url: current.url, remoteId: current.remoteId }
      } else {
        let url: URL
        try { url = new URL(input.articleUrl || '') } catch { throw new ApiError(400, 'xiaohongshu_article_url', '请填写已发布的小红书笔记链接') }
        const match = url.pathname.match(/^\/explore\/([a-f0-9]{24})\/?$/)
        if (url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com' || url.port || url.username || url.password || !match) throw new ApiError(400, 'xiaohongshu_article_url', '请填写 https://www.xiaohongshu.com/explore/笔记编号 格式的笔记链接')
        values = { status: 'published', message: '用户已人工核实笔记发布成功，并关联笔记链接', remoteId: match[1], url: `https://www.xiaohongshu.com/explore/${match[1]}` }
      }
      const result = this.database.resolveXhsPublication(userId, id, input.action, values)
      if (!result) throw new ApiError(409, 'xiaohongshu_resolution_stale', '任务状态已变化，请刷新后再操作')
      return result
    } finally { if (!handedOff) this.active.delete(userId) }
  }

  private async recheck(userId: string, id: string, state: PublisherStorageState, current: XhsPublication): Promise<void> {
    try {
      const result = current.remoteId ? await this.driver.checkPublication(state, current.remoteId, current.title) : { status: 'unknown', url: null, message: '没有可核对的远端编号，请在小红书后台核实后选择人工核实结果' }
      this.database.resolveXhsPublication(userId, id, 'check', { status: result.status === 'published' ? 'published' : 'uncertain', message: result.message, url: result.url || current.url, remoteId: current.remoteId })
    } catch (error) {
      this.expire(userId, error)
      this.database.resolveXhsPublication(userId, id, 'check', { status: 'uncertain', message: error instanceof ApiError ? error.message : '自动核实未完成，请稍后重试或填写人工核实结果', url: current.url, remoteId: current.remoteId })
    }
  }

  async publish(userId: string, input: XhsPublishInput, baseUrl?: string): Promise<XhsPublication> {
    this.idle(userId)
    if ([...this.logins.values()].some(entry => entry.userId === userId && ['waiting', 'scanned'].includes(entry.value.status))) throw new ApiError(409, 'xiaohongshu_busy', '请先完成小红书扫码登录')
    this.active.add(userId)
    let handedOff = false
    try {
      if (this.database.hasUncertainXhsPublication(userId)) throw new ApiError(409, 'xiaohongshu_result_uncertain', '请先核实所有结果待确认的任务，再提交新的发布')
      const checked = await this.driver.checkSession(this.state(userId))
      this.save(userId, checked.state, checked.identity)
      const article = await this.article(userId, input, baseUrl)
      const hash = createHash('sha256').update(JSON.stringify({ account: checked.identity.accountId, contentId: this.database.getRender(userId, input.renderId)?.contentId, title: article.title, body: article.body, mode: input.mode }))
      for (const [src, image] of article.images) hash.update(src).update(image.buffer)
      const idempotencyKey = hash.digest('hex'), previous = this.database.findXhsPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return previous
      const publication = previous ?? this.database.createXhsPublication(userId, { renderId: input.renderId, title: article.title, mode: input.mode, idempotencyKey })
      this.database.updateXhsPublication(userId, publication.id, { status: 'running', message: '正在准备小红书正文及图片' })
      const task = this.run(userId, publication.id, checked, article)
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
    const account = this.database.getXhsAccount(userId)
    if (account && error instanceof ApiError && error.code === 'xiaohongshu_session_expired') this.database.saveXhsAccount(userId, { ...account, status: 'expired', checkedAt: now() })
  }

  private async run(userId: string, id: string, checked: Awaited<ReturnType<XhsDriver['checkSession']>>, article: XhsArticle): Promise<void> {
    try {
      const result = await this.driver.publish(checked.state, article, progress => { this.database.updateXhsPublication(userId, id, progress) })
      this.save(userId, result.state, checked.identity)
      this.database.updateXhsPublication(userId, id, result)
    } catch (error) {
      this.expire(userId, error)
      const uncertain = !(error instanceof ApiError) || error.code === 'xiaohongshu_result_uncertain'
      this.database.updateXhsPublication(userId, id, { status: uncertain ? 'uncertain' : 'failed', message: error instanceof ApiError ? error.message : '操作中断，请先核对小红书后台，避免重复发布' })
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
