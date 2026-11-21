import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PublicationDeletion, WeiboAccount, WeiboLogin, WeiboPublication, WeiboPublishInput, WeiboResolveInput } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { UPLOAD_FILENAME_PATTERN } from './upload'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey, type PublisherStorageState } from './publisher-session'
import { downloadPublisherImage, publisherImage, type PublisherImage } from './publisher-image'
import type { WeiboArticle, WeiboDriver, WeiboIdentity, WeiboLoginAttempt } from './weibo-browser'

const TTL = 5 * 60_000
const MAX_IMAGES = 9
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const now = () => new Date().toISOString()
type LoginEntry = { userId: string; value: WeiboLogin; attempt?: WeiboLoginAttempt; timer: ReturnType<typeof setTimeout>; preparing?: Promise<void>; polling?: Promise<WeiboLogin> }

export function weiboPublicationUrl(remoteId: string): string {
  return `https://m.weibo.cn/detail/${remoteId}`
}

export function parseWeiboPublishedId(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    const detail = url.hostname === 'm.weibo.cn' && url.pathname.match(/^\/detail\/(\d{6,30})\/?$/)
    if (detail) return detail[1]
    if (!['weibo.com', 'www.weibo.com'].includes(url.hostname)) return null
    const match = url.pathname.match(/^\/(?:\d+\/)?(\d{6,30})\/?$/)
    return match ? match[1] : null
  } catch { return null }
}

export class WeiboService {
  private readonly key: Buffer
  private readonly logins = new Map<string, LoginEntry>()
  private readonly active = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<WeiboAccount>>()
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: WeiboDriver) {
    this.key = loadPublisherKey(config.dataDir, 'weibo')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'weibo_unavailable', '微博服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'weibo_busy', '微博操作正在进行，请等待完成')
  }

  private state(userId: string): PublisherStorageState {
    const account = this.database.getWeiboAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'weibo_session_expired', '请先在系统中扫码登录微博')
    try { return decryptPublisherSession(account.encryptedSession, this.key, userId) }
    catch {
      this.database.saveWeiboAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'weibo_session_expired', '微博登录状态无法恢复，请重新扫码连接')
    }
  }

  private save(userId: string, state: PublisherStorageState, identity: WeiboIdentity): void {
    if (!this.closed) this.database.saveWeiboAccount(userId, { encryptedSession: encryptPublisherSession(state, this.key, userId), ...identity, status: 'connected', checkedAt: now() })
  }

  async account(userId: string): Promise<WeiboAccount> {
    const current = this.database.getWeiboAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    const view = { status: current.status, name: current.name, checkedAt: current.checkedAt }
    if (current.status === 'expired' || this.active.has(userId) || Date.now() - Date.parse(current.checkedAt) < TTL) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<WeiboAccount> => {
      try {
        const result = await this.driver.checkSession(this.state(userId))
        const latest = this.database.getWeiboAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.save(userId, result.state, result.identity)
        return { status: 'connected', name: result.identity.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'weibo_session_expired' && this.database.getWeiboAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveWeiboAccount(userId, { ...current, status: 'expired', checkedAt: now() })
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

  async startLogin(userId: string): Promise<WeiboLogin> {
    this.idle(userId)
    const pending = [...this.logins.values()].find(entry => entry.userId === userId && entry.preparing)
    if (pending) return pending.value
    for (const [id, entry] of this.logins) {
      if (entry.userId === userId) { clearTimeout(entry.timer); this.logins.delete(id); void entry.attempt?.close().catch(() => {}) }
    }
    if (this.logins.size >= 8) throw new ApiError(503, 'weibo_busy', '当前登录请求较多，请稍后重试')
    const id = randomUUID()
    const value: WeiboLogin = { id, status: 'waiting', qrCode: null, message: '正在准备微博登录二维码，请稍候', expiresAt: new Date(Date.now() + TTL).toISOString() }
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
        if (this.logins.get(id) === entry) entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '获取微博登录二维码失败，请重新连接' }
      }
    })().finally(() => { entry.preparing = undefined })
    return value
  }

  async pollLogin(userId: string, id: string): Promise<WeiboLogin> {
    const entry = this.logins.get(id)
    if (!entry || entry.userId !== userId) throw notFound('微博登录请求不存在或已过期，请重新连接')
    this.refreshLogin(userId, id, entry)
    return entry.value
  }

  private refreshLogin(userId: string, id: string, entry: LoginEntry): void {
    if (this.closed || !entry.attempt || entry.polling || !['waiting', 'scanned'].includes(entry.value.status)) return
    const attempt = entry.attempt
    entry.polling = (async () => {
      try {
        const result = await attempt.poll()
        if (this.logins.get(id) !== entry) throw notFound('微博登录已取消')
        if (result.status === 'connected') {
          if (!result.state || !result.identity) throw new ApiError(502, 'weibo_login_failed', '微博没有返回有效登录会话，请重试')
          this.save(userId, result.state, result.identity)
        }
        entry.value = { ...entry.value, status: result.status, qrCode: result.qrCode, message: result.message }
      } catch (error) {
        entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '读取微博登录状态失败，请重新连接' }
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
      this.database.deleteWeiboAccount(userId)
    } finally { this.active.delete(userId) }
  }

  private async image(userId: string, src: string, baseUrl?: string): Promise<PublisherImage> {
    let url: URL
    try { url = new URL(src, baseUrl || this.config.publicBaseUrl || 'http://multipush.invalid') } catch { throw new ApiError(400, 'weibo_image_invalid', '微博图片地址无效') }
    const origin = this.config.publicBaseUrl || baseUrl
    const owned = url.origin === 'http://multipush.invalid' || !!origin && url.origin === new URL(origin).origin
    if (owned && url.pathname.startsWith('/uploads/')) {
      const filename = url.pathname.slice('/uploads/'.length)
      if (!UPLOAD_FILENAME_PATTERN.test(filename)) throw notFound('图片路径无效')
      const media = this.database.getMediaByFilename(userId, filename)
      if (!media) throw notFound('正文图片不存在或无权访问，请重新上传')
      if (media.kind !== 'image' || media.size > MAX_IMAGE_BYTES) throw new ApiError(400, 'weibo_image_invalid', '微博图片请使用 10 MB 以内的 JPG、PNG 或 GIF')
      try { return { ...publisherImage(await readFile(path.join(this.config.uploadsDir, media.filename))), name: media.filename } }
      catch { throw new ApiError(400, 'weibo_image_invalid', '图片文件丢失、格式无效或超过 10 MB，请重新上传') }
    }
    if (url.protocol === 'data:' || ['http:', 'https:'].includes(url.protocol)) return downloadPublisherImage(url.href, 'weibo')
    throw new ApiError(400, 'weibo_image_invalid', '微博正文包含无效图片地址，请重新上传')
  }

  private async article(userId: string, input: WeiboPublishInput, baseUrl?: string): Promise<WeiboArticle & { title: string }> {
    const record = this.database.getRender(userId, input.renderId), render = record?.results.find(result => result.platform === 'weibo')
    if (!record || !render) throw notFound('微博排版记录不存在，请先生成微博排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'weibo_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'weibo_render_stale', '原文已修改，请重新生成微博排版后发布')
    const text = (render.text ?? '').trim()
    if (!text) throw new ApiError(400, 'weibo_body_empty', '请先填写微博正文')
    if (Array.from(text).length > 2000) throw new ApiError(400, 'weibo_body_too_long', '微博正文不能超过 2000 字')
    if (render.videos.length) throw new ApiError(400, 'weibo_media_unsupported', '微博发布暂不支持视频，请移除视频后重试')
    const urls = Array.from(new Set(render.assets.filter(asset => asset.kind === 'image').map(asset => asset.url))).slice(0, MAX_IMAGES)
    const images: PublisherImage[] = []
    for (const [index, src] of urls.entries()) {
      const image = await this.image(userId, src, baseUrl)
      images.push({ ...image, name: `weibo-${index + 1}-${image.name}` })
    }
    return { text, images, title: render.title || content.title }
  }

  list(userId: string): WeiboPublication[] { return this.database.listWeiboPublications(userId) }
  get(userId: string, id: string): WeiboPublication {
    const value = this.database.getWeiboPublication(userId, id)
    if (!value) throw notFound('微博发布记录不存在')
    return value
  }

  async remove(userId: string, id: string): Promise<PublicationDeletion> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status === 'running') throw new ApiError(409, 'weibo_delete_busy', '微博任务正在处理，请等待完成后再删除')
    if (current.status === 'uncertain') throw new ApiError(409, 'weibo_delete_uncertain', '请先核实这条微博任务的结果，再删除发布记录')
    if (current.status === 'published') throw new ApiError(409, 'weibo_delete_published', '已发布的微博不能通过这里删除；如需删除请到微博主页操作')
    if (!this.database.deleteWeiboPublication(userId, id)) throw notFound('微博发布记录不存在')
    return { ok: true, remoteDeleted: false }
  }

  async resolve(userId: string, id: string, input: WeiboResolveInput): Promise<WeiboPublication> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status !== 'uncertain') throw new ApiError(409, 'weibo_resolution_stale', '任务状态已变化，请刷新后再操作')
    this.active.add(userId)
    let handedOff = false
    try {
      if (input.action === 'check') {
        const state = this.state(userId)
        this.database.updateWeiboPublication(userId, id, { status: 'running', message: '正在重新核实微博发布结果' })
        const task = this.recheck(userId, id, state, current)
        this.jobs.set(id, task); handedOff = true
        void task.finally(() => { this.jobs.delete(id); this.active.delete(userId) }).catch(() => {})
        return this.get(userId, id)
      }
      let values: Pick<WeiboPublication, 'status' | 'message' | 'url' | 'remoteId'>
      if (input.action === 'not_published') {
        values = { status: 'failed', message: '用户已核实未发布，已解除限制；再次提交会重新发布', url: current.url, remoteId: current.remoteId }
      } else {
        const remoteId = parseWeiboPublishedId(input.articleUrl || '')
        if (!remoteId) throw new ApiError(400, 'weibo_article_url', '请填写 https://weibo.com/用户编号/微博编号 或 https://m.weibo.cn/detail/微博编号 格式的微博链接')
        values = { status: 'published', message: '用户已人工核实微博发布成功，并关联微博链接', remoteId, url: weiboPublicationUrl(remoteId) }
      }
      const result = this.database.resolveWeiboPublication(userId, id, input.action, values)
      if (!result) throw new ApiError(409, 'weibo_resolution_stale', '任务状态已变化，请刷新后再操作')
      return result
    } finally { if (!handedOff) this.active.delete(userId) }
  }

  private async recheck(userId: string, id: string, state: PublisherStorageState, current: WeiboPublication): Promise<void> {
    try {
      const result = current.remoteId
        ? await this.driver.checkPublication(state, current.remoteId, current.title)
        : { status: 'unknown', url: null, message: '没有可核对的微博编号，请到微博主页核实后选择人工核实结果' }
      this.database.resolveWeiboPublication(userId, id, 'check', { status: result.status === 'published' ? 'published' : 'uncertain', message: result.message, url: result.url || current.url, remoteId: current.remoteId })
    } catch (error) {
      this.expire(userId, error)
      this.database.resolveWeiboPublication(userId, id, 'check', { status: 'uncertain', message: error instanceof ApiError ? error.message : '自动核实未完成，请稍后重试或填写人工核实结果', url: current.url, remoteId: current.remoteId })
    }
  }

  async publish(userId: string, input: WeiboPublishInput, baseUrl?: string): Promise<WeiboPublication> {
    this.idle(userId)
    if ([...this.logins.values()].some(entry => entry.userId === userId && ['waiting', 'scanned'].includes(entry.value.status))) throw new ApiError(409, 'weibo_busy', '请先完成微博扫码登录')
    this.active.add(userId)
    let handedOff = false
    try {
      if (this.database.hasUncertainWeiboPublication(userId)) throw new ApiError(409, 'weibo_result_uncertain', '请先核实所有结果待确认的微博任务，再提交新的发布')
      const checked = await this.driver.checkSession(this.state(userId))
      this.save(userId, checked.state, checked.identity)
      const article = await this.article(userId, input, baseUrl)
      const mode = input.mode === 'draft' ? 'draft' : 'publish'
      const hash = createHash('sha256').update(JSON.stringify({ account: checked.identity.accountId, contentId: this.database.getRender(userId, input.renderId)?.contentId, text: article.text, mode }))
      for (const image of article.images) hash.update(image.buffer)
      const idempotencyKey = hash.digest('hex'), previous = this.database.findWeiboPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return previous
      const publication = previous ?? this.database.createWeiboPublication(userId, { renderId: input.renderId, title: article.title, mode, idempotencyKey })
      if (mode === 'draft') {
        this.database.updateWeiboPublication(userId, publication.id, { status: 'draft', message: '已保存为 MultiPush 本地草稿；微博网页端没有草稿箱，请在渲染页复制文案/图片后手动发布' })
        return this.get(userId, publication.id)
      }
      this.database.updateWeiboPublication(userId, publication.id, { status: 'running', message: '正在准备微博正文及图片' })
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
    const account = this.database.getWeiboAccount(userId)
    if (account && error instanceof ApiError && error.code === 'weibo_session_expired') this.database.saveWeiboAccount(userId, { ...account, status: 'expired', checkedAt: now() })
  }

  private async run(userId: string, id: string, state: PublisherStorageState, article: WeiboArticle, identity: WeiboIdentity): Promise<void> {
    try {
      const result = await this.driver.publish(state, article, progress => { this.database.updateWeiboPublication(userId, id, progress) })
      this.save(userId, result.state, identity)
      this.database.updateWeiboPublication(userId, id, { status: 'published', message: result.message, url: result.url, remoteId: result.remoteId })
    } catch (error) {
      this.expire(userId, error)
      const code = error instanceof ApiError ? error.code : ''
      const uncertain = !(error instanceof ApiError) || code === 'weibo_result_uncertain'
      this.database.updateWeiboPublication(userId, id, { status: uncertain ? 'uncertain' : 'failed', message: error instanceof ApiError ? error.message : '微博操作中断，结果未确认，请先核对微博主页，避免重复发布' })
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
