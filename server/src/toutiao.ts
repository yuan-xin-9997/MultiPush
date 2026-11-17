import { createHash, randomUUID } from 'node:crypto'
import { load } from 'cheerio'
import type { ToutiaoAccount, ToutiaoLogin, ToutiaoPublication, ToutiaoPublishInput, ToutiaoResolveInput } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey, type PublisherStorageState } from './publisher-session'
import type { ToutiaoArticle, ToutiaoDriver, ToutiaoIdentity, ToutiaoLoginAttempt } from './toutiao-browser'

const TTL = 5 * 60_000
const now = () => new Date().toISOString()
type LoginEntry = { userId: string; value: ToutiaoLogin; attempt?: ToutiaoLoginAttempt; timer: ReturnType<typeof setTimeout>; preparing?: Promise<void>; polling?: Promise<ToutiaoLogin> }

export function toutiaoArticleUrl(remoteId: string): string { return `https://www.toutiao.com/article/${remoteId}/` }

export function parseToutiaoPublishedId(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    if (!['www.toutiao.com', 'toutiao.com', 'm.toutiao.com'].includes(url.hostname)) return null
    const match = url.pathname.match(/^\/article\/(\d{6,30})\/?$/)
    return match ? match[1] : null
  } catch { return null }
}

export class ToutiaoService {
  private readonly key: Buffer
  private readonly logins = new Map<string, LoginEntry>()
  private readonly active = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<ToutiaoAccount>>()
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: ToutiaoDriver) {
    this.key = loadPublisherKey(config.dataDir, 'toutiao')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'toutiao_unavailable', '今日头条服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'toutiao_busy', '今日头条操作正在进行，请等待完成')
  }

  private state(userId: string): PublisherStorageState {
    const account = this.database.getToutiaoAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'toutiao_session_expired', '请先在系统中扫码登录今日头条')
    try { return decryptPublisherSession(account.encryptedSession, this.key, userId) }
    catch {
      this.database.saveToutiaoAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'toutiao_session_expired', '今日头条登录状态无法恢复，请重新扫码连接')
    }
  }

  private save(userId: string, state: PublisherStorageState, identity: ToutiaoIdentity): void {
    if (!this.closed) this.database.saveToutiaoAccount(userId, { encryptedSession: encryptPublisherSession(state, this.key, userId), ...identity, status: 'connected', checkedAt: now() })
  }

  async account(userId: string): Promise<ToutiaoAccount> {
    const current = this.database.getToutiaoAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    const view = { status: current.status, name: current.name, checkedAt: current.checkedAt }
    if (current.status === 'expired' || this.active.has(userId) || Date.now() - Date.parse(current.checkedAt) < TTL) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<ToutiaoAccount> => {
      try {
        const result = await this.driver.checkSession(this.state(userId))
        const latest = this.database.getToutiaoAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.save(userId, result.state, result.identity)
        return { status: 'connected', name: result.identity.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'toutiao_session_expired' && this.database.getToutiaoAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveToutiaoAccount(userId, { ...current, status: 'expired', checkedAt: now() })
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

  async startLogin(userId: string): Promise<ToutiaoLogin> {
    this.idle(userId)
    const pending = [...this.logins.values()].find(entry => entry.userId === userId && entry.preparing)
    if (pending) return pending.value
    for (const [id, entry] of this.logins) {
      if (entry.userId === userId) { clearTimeout(entry.timer); this.logins.delete(id); void entry.attempt?.close().catch(() => {}) }
    }
    if (this.logins.size >= 8) throw new ApiError(503, 'toutiao_busy', '当前登录请求较多，请稍后重试')
    const id = randomUUID()
    const value: ToutiaoLogin = { id, status: 'waiting', qrCode: null, message: '正在准备今日头条登录二维码，请稍候', expiresAt: new Date(Date.now() + TTL).toISOString() }
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
        if (this.logins.get(id) === entry) entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '获取今日头条登录二维码失败，请重新连接' }
      }
    })().finally(() => { entry.preparing = undefined })
    return value
  }

  async pollLogin(userId: string, id: string): Promise<ToutiaoLogin> {
    const entry = this.logins.get(id)
    if (!entry || entry.userId !== userId) throw notFound('今日头条登录请求不存在或已过期，请重新连接')
    this.refreshLogin(userId, id, entry)
    return entry.value
  }

  private refreshLogin(userId: string, id: string, entry: LoginEntry): void {
    if (this.closed || !entry.attempt || entry.polling || !['waiting', 'scanned'].includes(entry.value.status)) return
    const attempt = entry.attempt
    entry.polling = (async () => {
      try {
        const result = await attempt.poll()
        if (this.logins.get(id) !== entry) throw notFound('今日头条登录已取消')
        if (result.status === 'connected') {
          if (!result.state || !result.identity) throw new ApiError(502, 'toutiao_login_failed', '今日头条没有返回有效登录会话，请重试')
          this.save(userId, result.state, result.identity)
        }
        entry.value = { ...entry.value, status: result.status, qrCode: result.qrCode, message: result.message }
      } catch (error) {
        entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '读取今日头条登录状态失败，请重新连接' }
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
      this.database.deleteToutiaoAccount(userId)
    } finally { this.active.delete(userId) }
  }

  private async article(userId: string, input: ToutiaoPublishInput): Promise<ToutiaoArticle> {
    const record = this.database.getRender(userId, input.renderId), render = record?.results.find(result => result.platform === 'toutiao')
    if (!record || !render) throw notFound('今日头条排版记录不存在，请先生成今日头条排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'toutiao_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'toutiao_render_stale', '原文已修改，请重新生成今日头条排版后发布')
    const title = render.title.trim()
    if (Array.from(title).length < 2 || Array.from(title).length > 30) throw new ApiError(400, 'toutiao_title_invalid', '今日头条标题需要 2–30 个字')
    if (!render.text?.trim()) throw new ApiError(400, 'toutiao_body_empty', '请先填写文章正文')
    if (Buffer.byteLength(render.html) > 1024 * 1024) throw new ApiError(400, 'toutiao_body_size', '正文 HTML 不能超过 1 MB')
    const $ = load(render.html, null, false)
    if ($('video,audio,iframe,svg').length || render.videos.length) throw new ApiError(400, 'toutiao_media_unsupported', '今日头条发布支持图文，请先移除视频、音频、嵌入内容或 SVG')
    return { title, html: render.html, text: render.text, mode: input.mode === 'draft' ? 'draft' : 'publish', images: [] }
  }

  list(userId: string): ToutiaoPublication[] { return this.database.listToutiaoPublications(userId) }
  get(userId: string, id: string): ToutiaoPublication {
    const value = this.database.getToutiaoPublication(userId, id)
    if (!value) throw notFound('今日头条发布记录不存在')
    return value
  }

  async resolve(userId: string, id: string, input: ToutiaoResolveInput): Promise<ToutiaoPublication> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status !== 'uncertain') throw new ApiError(409, 'toutiao_resolution_stale', '任务状态已变化，请刷新后再操作')
    this.active.add(userId)
    let handedOff = false
    try {
      if (input.action === 'check') {
        const state = this.state(userId)
        this.database.updateToutiaoPublication(userId, id, { status: 'running', message: '正在重新核实今日头条发布结果' })
        const task = this.recheck(userId, id, state, current)
        this.jobs.set(id, task); handedOff = true
        void task.finally(() => { this.jobs.delete(id); this.active.delete(userId) }).catch(() => {})
        return this.get(userId, id)
      }
      let values: Pick<ToutiaoPublication, 'status' | 'message' | 'url' | 'remoteId'>
      if (input.action === 'not_published') {
        values = { status: 'failed', message: '用户已核实未发布，已解除限制；再次提交会重新发布', url: current.url, remoteId: current.remoteId }
      } else {
        const remoteId = parseToutiaoPublishedId(input.articleUrl || '')
        if (!remoteId) throw new ApiError(400, 'toutiao_article_url', '请填写 https://www.toutiao.com/article/文章编号/ 格式的文章链接')
        values = { status: 'published', message: '用户已人工核实文章发布成功，并关联文章链接', remoteId, url: toutiaoArticleUrl(remoteId) }
      }
      const result = this.database.resolveToutiaoPublication(userId, id, input.action, values)
      if (!result) throw new ApiError(409, 'toutiao_resolution_stale', '任务状态已变化，请刷新后再操作')
      return result
    } finally { if (!handedOff) this.active.delete(userId) }
  }

  private async recheck(userId: string, id: string, state: PublisherStorageState, current: ToutiaoPublication): Promise<void> {
    try {
      const result = current.remoteId
        ? await this.driver.checkPublication(state, current.remoteId, current.title)
        : { status: 'unknown', url: null, message: '没有可核对的文章编号，请到今日头条创作中心核实后选择人工核实结果' }
      this.database.resolveToutiaoPublication(userId, id, 'check', { status: result.status === 'published' ? 'published' : 'uncertain', message: result.message, url: result.url || current.url, remoteId: current.remoteId })
    } catch (error) {
      this.expire(userId, error)
      this.database.resolveToutiaoPublication(userId, id, 'check', { status: 'uncertain', message: error instanceof ApiError ? error.message : '自动核实未完成，请稍后重试或填写人工核实结果', url: current.url, remoteId: current.remoteId })
    }
  }

  async publish(userId: string, input: ToutiaoPublishInput, baseUrl?: string): Promise<ToutiaoPublication> {
    this.idle(userId)
    if ([...this.logins.values()].some(entry => entry.userId === userId && ['waiting', 'scanned'].includes(entry.value.status))) throw new ApiError(409, 'toutiao_busy', '请先完成今日头条扫码登录')
    this.active.add(userId)
    let handedOff = false
    try {
      if (this.database.hasUncertainToutiaoPublication(userId)) throw new ApiError(409, 'toutiao_result_uncertain', '请先核实所有结果待确认的头条任务，再提交新的发布')
      const checked = await this.driver.checkSession(this.state(userId))
      this.save(userId, checked.state, checked.identity)
      const article = await this.article(userId, input)
      const hash = createHash('sha256').update(JSON.stringify({ account: checked.identity.accountId, contentId: this.database.getRender(userId, input.renderId)?.contentId, title: article.title, html: article.html, mode: article.mode }))
      const idempotencyKey = hash.digest('hex'), previous = this.database.findToutiaoPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return previous
      const publication = previous ?? this.database.createToutiaoPublication(userId, { renderId: input.renderId, title: article.title, mode: article.mode, idempotencyKey })
      this.database.updateToutiaoPublication(userId, publication.id, { status: 'running', message: '正在准备今日头条正文' })
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
    const account = this.database.getToutiaoAccount(userId)
    if (account && error instanceof ApiError && error.code === 'toutiao_session_expired') this.database.saveToutiaoAccount(userId, { ...account, status: 'expired', checkedAt: now() })
  }

  private async run(userId: string, id: string, state: PublisherStorageState, article: ToutiaoArticle, identity: ToutiaoIdentity): Promise<void> {
    try {
      const result = await this.driver.publish(state, article, progress => { this.database.updateToutiaoPublication(userId, id, progress) })
      this.save(userId, result.state, identity)
      this.database.updateToutiaoPublication(userId, id, { status: result.status, message: result.message, url: result.url, remoteId: result.remoteId })
    } catch (error) {
      this.expire(userId, error)
      const code = error instanceof ApiError ? error.code : ''
      const uncertain = !(error instanceof ApiError) || code === 'toutiao_result_uncertain'
      this.database.updateToutiaoPublication(userId, id, { status: uncertain ? 'uncertain' : 'failed', message: error instanceof ApiError ? error.message : '今日头条操作中断，结果未确认，请先核对创作中心，避免重复发布' })
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
