import { createHash, randomUUID } from 'node:crypto'
import { load } from 'cheerio'
import type { DoubanAccount, DoubanLogin, DoubanPublication, DoubanPublishInput, DoubanResolveInput } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey, type PublisherStorageState } from './publisher-session'
import { downloadPublisherImage, type PublisherImage } from './publisher-image'
import { doubanNoteUrl, parseDoubanNoteId, prepareDoubanContent } from './douban-content'
import type { DoubanArticle, DoubanDriver, DoubanIdentity, DoubanLoginAttempt } from './douban-browser'

const TTL = 5 * 60_000
const MAX_IMAGES = 100
const now = () => new Date().toISOString()
type LoginEntry = { userId: string; value: DoubanLogin; attempt?: DoubanLoginAttempt; timer: ReturnType<typeof setTimeout>; preparing?: Promise<void>; polling?: Promise<DoubanLogin> }

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const tags: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const tag = raw.replace(/^#+/, '').replace(/\s+/g, ' ').trim()
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    tags.push(Array.from(tag).slice(0, 24).join(''))
    if (tags.length >= 10) break
  }
  return tags
}

export class DoubanService {
  private readonly key: Buffer
  private readonly logins = new Map<string, LoginEntry>()
  private readonly active = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<DoubanAccount>>()
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: DoubanDriver) {
    this.key = loadPublisherKey(config.dataDir, 'douban')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'douban_unavailable', '豆瓣服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'douban_busy', '豆瓣操作正在进行，请等待完成')
  }

  private state(userId: string): PublisherStorageState {
    const account = this.database.getDoubanAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'douban_session_expired', '请先在系统中扫码登录豆瓣')
    try { return decryptPublisherSession(account.encryptedSession, this.key, userId) }
    catch {
      this.database.saveDoubanAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'douban_session_expired', '豆瓣登录状态无法恢复，请重新扫码连接')
    }
  }

  private save(userId: string, state: PublisherStorageState, identity: DoubanIdentity): void {
    if (!this.closed) this.database.saveDoubanAccount(userId, { encryptedSession: encryptPublisherSession(state, this.key, userId), ...identity, status: 'connected', checkedAt: now() })
  }

  async account(userId: string): Promise<DoubanAccount> {
    const current = this.database.getDoubanAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    const view = { status: current.status, name: current.name, checkedAt: current.checkedAt }
    if (current.status === 'expired' || this.active.has(userId) || Date.now() - Date.parse(current.checkedAt) < TTL) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<DoubanAccount> => {
      try {
        const result = await this.driver.checkSession(this.state(userId))
        const latest = this.database.getDoubanAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.save(userId, result.state, result.identity)
        return { status: 'connected', name: result.identity.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'douban_session_expired' && this.database.getDoubanAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveDoubanAccount(userId, { ...current, status: 'expired', checkedAt: now() })
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

  async startLogin(userId: string): Promise<DoubanLogin> {
    this.idle(userId)
    const pending = [...this.logins.values()].find(entry => entry.userId === userId && entry.preparing)
    if (pending) return pending.value
    for (const [id, entry] of this.logins) {
      if (entry.userId === userId) { clearTimeout(entry.timer); this.logins.delete(id); void entry.attempt?.close().catch(() => {}) }
    }
    if (this.logins.size >= 8) throw new ApiError(503, 'douban_busy', '当前登录请求较多，请稍后重试')
    const id = randomUUID()
    const value: DoubanLogin = { id, status: 'waiting', qrCode: null, message: '正在准备豆瓣登录二维码，请稍候', expiresAt: new Date(Date.now() + TTL).toISOString() }
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
        if (this.logins.get(id) === entry) entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '获取豆瓣登录二维码失败，请重新连接' }
      }
    })().finally(() => { entry.preparing = undefined })
    return value
  }

  async pollLogin(userId: string, id: string): Promise<DoubanLogin> {
    const entry = this.logins.get(id)
    if (!entry || entry.userId !== userId) throw notFound('豆瓣登录请求不存在或已过期，请重新连接')
    this.refreshLogin(userId, id, entry)
    return entry.value
  }

  private refreshLogin(userId: string, id: string, entry: LoginEntry): void {
    if (this.closed || !entry.attempt || entry.polling || !['waiting', 'scanned'].includes(entry.value.status)) return
    const attempt = entry.attempt
    entry.polling = (async () => {
      try {
        const result = await attempt.poll()
        if (this.logins.get(id) !== entry) throw notFound('豆瓣登录已取消')
        if (result.status === 'connected') {
          if (!result.state || !result.identity) throw new ApiError(502, 'douban_login_failed', '豆瓣没有返回有效登录会话，请重试')
          this.save(userId, result.state, result.identity)
        }
        entry.value = { ...entry.value, status: result.status, qrCode: result.qrCode, message: result.message }
      } catch (error) {
        entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '读取豆瓣登录状态失败，请重新连接' }
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
      this.database.deleteDoubanAccount(userId)
    } finally { this.active.delete(userId) }
  }

  private async article(userId: string, input: DoubanPublishInput): Promise<DoubanArticle & { external: string[] }> {
    const record = this.database.getRender(userId, input.renderId)
    const render = record?.results.find(result => result.platform === 'douban')
    if (!record || !render) throw notFound('豆瓣日记排版记录不存在，请先生成豆瓣排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'douban_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'douban_render_stale', '原文已修改，请重新生成豆瓣排版后发布')
    const title = render.title.trim()
    if (Array.from(title).length < 1 || Array.from(title).length > 100) throw new ApiError(400, 'douban_title_invalid', '豆瓣日记标题需要 1–100 个字')
    if (!render.text?.trim()) throw new ApiError(400, 'douban_body_empty', '请先填写日记正文')
    if (Buffer.byteLength(render.html) > 1024 * 1024) throw new ApiError(400, 'douban_body_size', '日记 HTML 不能超过 1 MB')
    const $ = load(render.html, null, false)
    if ($('video,audio,iframe').length || render.videos.length) throw new ApiError(400, 'douban_media_unsupported', '豆瓣日记发布支持图文，请先移除视频、音频或嵌入内容')
    const images: string[] = []
    for (const node of $('img').toArray()) {
      const src = $(node).attr('src') || ''
      if (!src || images.includes(src)) continue
      images.push(src)
      if (images.length > MAX_IMAGES) throw new ApiError(400, 'douban_image_count', '豆瓣日记最多支持 100 张图片')
    }
    const html = prepareDoubanContent(render.html)
    return {
      title,
      html,
      text: render.text,
      images: new Map<string, PublisherImage>(),
      external: images,
      privacy: input.privacy === 'private' ? 'private' : 'public',
      tags: normalizeTags(input.tags ?? render.meta.tags),
    }
  }

  list(userId: string): DoubanPublication[] { return this.database.listDoubanPublications(userId) }
  get(userId: string, id: string): DoubanPublication {
    const value = this.database.getDoubanPublication(userId, id)
    if (!value) throw notFound('豆瓣发布记录不存在')
    return value
  }

  async resolve(userId: string, id: string, input: DoubanResolveInput): Promise<DoubanPublication> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status !== 'uncertain') throw new ApiError(409, 'douban_resolution_stale', '任务状态已变化，请刷新后再操作')
    this.active.add(userId)
    let handedOff = false
    try {
      if (input.action === 'check') {
        const state = this.state(userId)
        this.database.updateDoubanPublication(userId, id, { status: 'running', message: '正在重新核实豆瓣发布结果' })
        const task = this.recheck(userId, id, state, current)
        this.jobs.set(id, task); handedOff = true
        void task.finally(() => { this.jobs.delete(id); this.active.delete(userId) }).catch(() => {})
        return this.get(userId, id)
      }
      let values: Pick<DoubanPublication, 'status' | 'message' | 'url' | 'remoteId'>
      if (input.action === 'not_published') {
        values = { status: 'failed', message: '用户已核实未发布，已解除限制；再次提交会重新发布', url: current.url, remoteId: current.remoteId }
      } else {
        const remoteId = parseDoubanNoteId(input.articleUrl || '')
        if (!remoteId) throw new ApiError(400, 'douban_article_url', '请填写 https://www.douban.com/note/日记编号/ 格式的日记链接')
        values = { status: 'published', message: '用户已人工核实日记发布成功，并关联日记链接', remoteId, url: doubanNoteUrl(remoteId) }
      }
      const result = this.database.resolveDoubanPublication(userId, id, input.action, values)
      if (!result) throw new ApiError(409, 'douban_resolution_stale', '任务状态已变化，请刷新后再操作')
      return result
    } finally { if (!handedOff) this.active.delete(userId) }
  }

  private async recheck(userId: string, id: string, state: PublisherStorageState, current: DoubanPublication): Promise<void> {
    try {
      const result = current.remoteId
        ? await this.driver.checkPublication(state, current.remoteId, current.title)
        : { status: 'unknown', url: null, message: '没有可核对的日记编号，请到豆瓣日记列表核实后选择人工核实结果' }
      this.database.resolveDoubanPublication(userId, id, 'check', { status: result.status === 'published' ? 'published' : 'uncertain', message: result.message, url: result.url || current.url, remoteId: current.remoteId })
    } catch (error) {
      this.expire(userId, error)
      this.database.resolveDoubanPublication(userId, id, 'check', { status: 'uncertain', message: error instanceof ApiError ? error.message : '自动核实未完成，请稍后重试或填写人工核实结果', url: current.url, remoteId: current.remoteId })
    }
  }

  async publish(userId: string, input: DoubanPublishInput): Promise<DoubanPublication> {
    this.idle(userId)
    if ([...this.logins.values()].some(entry => entry.userId === userId && ['waiting', 'scanned'].includes(entry.value.status))) throw new ApiError(409, 'douban_busy', '请先完成豆瓣扫码登录')
    this.active.add(userId)
    let handedOff = false
    try {
      if (this.database.hasUncertainDoubanPublication(userId)) throw new ApiError(409, 'douban_result_uncertain', '请先核实所有结果待确认的豆瓣任务，再提交新的发布')
      const checked = await this.driver.checkSession(this.state(userId))
      this.save(userId, checked.state, checked.identity)
      const article = await this.article(userId, input)
      const mode = input.mode === 'draft' ? 'draft' : 'publish'
      const hash = createHash('sha256').update(JSON.stringify({ account: checked.identity.accountId, contentId: this.database.getRender(userId, input.renderId)?.contentId, title: article.title, html: article.html, privacy: article.privacy, tags: article.tags, mode }))
      const idempotencyKey = hash.digest('hex'), previous = this.database.findDoubanPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return previous
      const publication = previous ?? this.database.createDoubanPublication(userId, { renderId: input.renderId, title: article.title, mode, idempotencyKey })
      if (mode === 'draft') {
        this.database.updateDoubanPublication(userId, publication.id, { status: 'draft', message: '已保存为 MultiPush 本地草稿；豆瓣网页端没有草稿箱，请在渲染页复制正文或打开豆瓣编辑器发布' })
        return this.get(userId, publication.id)
      }
      this.database.updateDoubanPublication(userId, publication.id, { status: 'running', message: '正在准备豆瓣日记正文' })
      const task = this.run(userId, publication.id, checked.state, article)
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
    const account = this.database.getDoubanAccount(userId)
    if (account && error instanceof ApiError && error.code === 'douban_session_expired') this.database.saveDoubanAccount(userId, { ...account, status: 'expired', checkedAt: now() })
  }

  private async run(userId: string, id: string, state: PublisherStorageState, article: DoubanArticle & { external: string[] }): Promise<void> {
    try {
      for (const [index, src] of article.external.entries()) {
        this.database.updateDoubanPublication(userId, id, { message: `正在读取并上传正文图片 ${index + 1}/${article.external.length}` })
        article.images.set(src, await downloadPublisherImage(src, 'douban'))
      }
      const result = await this.driver.publish(state, article, progress => { this.database.updateDoubanPublication(userId, id, { message: progress.message }) })
      const account = this.database.getDoubanAccount(userId)
      if (account) {
        // The driver refreshed the session; preserve the stored identity.
        this.database.saveDoubanAccount(userId, { ...account, encryptedSession: encryptPublisherSession(result.state, this.key, userId), status: 'connected', checkedAt: now() })
      }
      this.database.updateDoubanPublication(userId, id, { status: 'published', message: result.message, url: result.url, remoteId: result.remoteId })
    } catch (error) {
      this.expire(userId, error)
      const code = error instanceof ApiError ? error.code : ''
      const uncertain = !(error instanceof ApiError) || ['douban_result_uncertain', 'douban_content_mismatch', 'douban_security_check'].includes(code)
      this.database.updateDoubanPublication(userId, id, { status: uncertain ? 'uncertain' : 'failed', message: error instanceof ApiError ? error.message : '豆瓣操作中断，结果未确认，请先核对豆瓣日记列表，避免重复发布' })
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
