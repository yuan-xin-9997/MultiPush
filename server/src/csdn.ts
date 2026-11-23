import { createHash, randomUUID } from 'node:crypto'
import type { CsdnAccount, CsdnLogin, CsdnPublication, CsdnPublishInput, CsdnResolveInput, PublicationDeletion } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { PlatformActionGuard } from './platform-actions'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey, type PublisherStorageState } from './publisher-session'
import { csdnArticleUrl, parseCsdnArticleId } from './csdn-browser'
import type { CsdnArticle, CsdnDriver, CsdnIdentity, CsdnLoginAttempt } from './csdn-browser'

const TTL = 5 * 60_000
const now = () => new Date().toISOString()
type LoginEntry = { userId: string; value: CsdnLogin; attempt?: CsdnLoginAttempt; timer: ReturnType<typeof setTimeout>; preparing?: Promise<void>; polling?: Promise<CsdnLogin> }

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const tags: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const tag = raw.replace(/^#+/, '').replace(/\s+/g, ' ').trim()
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    tags.push(Array.from(tag).slice(0, 20).join(''))
    if (tags.length >= 5) break
  }
  return tags
}

export class CsdnService {
  private readonly key: Buffer
  private readonly logins = new Map<string, LoginEntry>()
  private readonly active = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<CsdnAccount>>()
  private readonly actions: PlatformActionGuard
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: CsdnDriver) {
    this.key = loadPublisherKey(config.dataDir, 'csdn')
    this.actions = new PlatformActionGuard(database, 'csdn')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'csdn_unavailable', 'CSDN 服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'csdn_busy', 'CSDN 操作正在进行，请等待完成')
  }

  private state(userId: string): PublisherStorageState {
    const account = this.database.getCsdnAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'csdn_session_expired', '请先在系统中扫码登录 CSDN')
    try { return decryptPublisherSession(account.encryptedSession, this.key, userId) }
    catch {
      this.database.saveCsdnAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'csdn_session_expired', 'CSDN 登录状态无法恢复，请重新扫码连接')
    }
  }

  private save(userId: string, state: PublisherStorageState, identity: CsdnIdentity): void {
    if (!this.closed) this.database.saveCsdnAccount(userId, { encryptedSession: encryptPublisherSession(state, this.key, userId), ...identity, status: 'connected', checkedAt: now() })
  }

  async account(userId: string, force = false): Promise<CsdnAccount> {
    const current = this.database.getCsdnAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    const view = { status: current.status, name: current.name, checkedAt: current.checkedAt }
    if (!force || current.status === 'expired' || this.active.has(userId)) return view
    if (!this.actions.allowSessionCheck(userId)) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<CsdnAccount> => {
      try {
        const result = await this.driver.checkSession(this.state(userId))
        const latest = this.database.getCsdnAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.save(userId, result.state, result.identity)
        return { status: 'connected', name: result.identity.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'csdn_session_expired' && this.database.getCsdnAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveCsdnAccount(userId, { ...current, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, checkedAt: now() }
        }
        throw error
      }
    })().finally(() => this.checks.delete(userId))
    this.checks.set(userId, check)
    return check
  }

  async startLogin(userId: string): Promise<CsdnLogin> {
    this.idle(userId)
    const pending = [...this.logins.values()].find(entry => entry.userId === userId && entry.preparing)
    if (pending) return pending.value
    this.actions.assertLogin(userId)
    for (const [id, entry] of this.logins) {
      if (entry.userId === userId) { clearTimeout(entry.timer); this.logins.delete(id); void entry.attempt?.close().catch(() => {}) }
    }
    if (this.logins.size >= 8) throw new ApiError(503, 'csdn_busy', '当前登录请求较多，请稍后重试')
    const id = randomUUID()
    const value: CsdnLogin = { id, status: 'waiting', qrCode: null, message: '正在准备 CSDN 登录二维码，请稍候', expiresAt: new Date(Date.now() + TTL).toISOString() }
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
        if (this.logins.get(id) === entry) entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '获取 CSDN 登录二维码失败，请重新连接' }
      }
    })().finally(() => { entry.preparing = undefined })
    return value
  }

  async pollLogin(userId: string, id: string): Promise<CsdnLogin> {
    const entry = this.logins.get(id)
    if (!entry || entry.userId !== userId) throw notFound('CSDN 登录请求不存在或已过期，请重新连接')
    this.refreshLogin(userId, id, entry)
    return entry.value
  }

  private refreshLogin(userId: string, id: string, entry: LoginEntry): void {
    if (this.closed || !entry.attempt || entry.polling || !['waiting', 'scanned'].includes(entry.value.status)) return
    const attempt = entry.attempt
    entry.polling = (async () => {
      try {
        const result = await attempt.poll()
        if (this.logins.get(id) !== entry) throw notFound('CSDN 登录已取消')
        if (result.status === 'connected') {
          if (!result.state || !result.identity) throw new ApiError(502, 'csdn_login_failed', 'CSDN 没有返回有效登录会话，请重试')
          this.save(userId, result.state, result.identity)
        }
        entry.value = { ...entry.value, status: result.status, qrCode: result.qrCode, message: result.message }
      } catch (error) {
        entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '读取 CSDN 登录状态失败，请重新连接' }
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
      this.database.deleteCsdnAccount(userId)
    } finally { this.active.delete(userId) }
  }

  private async article(userId: string, input: CsdnPublishInput): Promise<CsdnArticle> {
    const record = this.database.getRender(userId, input.renderId)
    const render = record?.results.find(result => result.platform === 'csdn')
    if (!record || !render) throw notFound('CSDN 排版记录不存在，请先生成 CSDN 排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'csdn_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'csdn_render_stale', '原文已修改，请重新生成 CSDN 排版后发布')
    const title = render.title.trim()
    const titleLength = Array.from(title).length
    if (titleLength < 5 || titleLength > 100) throw new ApiError(400, 'csdn_title_invalid', 'CSDN 标题需要 5–100 个字')
    if (!render.markdown?.trim()) throw new ApiError(400, 'csdn_body_empty', '请先填写文章正文')
    if (Buffer.byteLength(render.markdown) > 1024 * 1024) throw new ApiError(400, 'csdn_body_size', '文章 Markdown 不能超过 1 MB')
    if (render.videos.length) throw new ApiError(400, 'csdn_media_unsupported', 'CSDN 文章暂不支持视频，请先移除视频')
    const lines = render.markdown.split('\n')
    // The renderer always emits the article title as the leading H1; drop it so
    // CSDN's separate title field does not duplicate the heading, including
    // after the title was edited in the workbench.
    if (lines.length > 1 && /^#\s+/.test(lines[0])) lines.shift()
    const markdown = lines.join('\n').trim()
    if (!markdown) throw new ApiError(400, 'csdn_body_empty', '请先填写文章正文')
    return {
      title,
      markdown,
      text: render.text ?? '',
      mode: input.mode === 'draft' ? 'draft' : 'publish',
      tags: normalizeTags(input.tags ?? render.meta.tags),
    }
  }

  list(userId: string): CsdnPublication[] { return this.database.listCsdnPublications(userId) }
  get(userId: string, id: string): CsdnPublication {
    const value = this.database.getCsdnPublication(userId, id)
    if (!value) throw notFound('CSDN 发布记录不存在')
    return value
  }

  async remove(userId: string, id: string): Promise<PublicationDeletion> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status === 'running') throw new ApiError(409, 'csdn_delete_busy', 'CSDN 任务正在处理，请等待完成后再删除')
    if (current.status === 'uncertain') throw new ApiError(409, 'csdn_delete_uncertain', '请先核实这条 CSDN 任务的结果，再删除发布记录')
    if (current.status === 'published') throw new ApiError(409, 'csdn_delete_published', '已发布的 CSDN 文章不能删除；如需下架请到 CSDN 后台处理')
    this.active.add(userId)
    try {
      let remoteDeleted = false
      if (current.remoteId && current.mode === 'draft') {
        const account = this.database.getCsdnAccount(userId)
        try {
          const result = await this.driver.deleteDraft(this.state(userId), current.remoteId)
          if (account) this.save(userId, result.state, { accountId: account.accountId, name: account.name || account.accountId })
          remoteDeleted = result.remoteDeleted
        } catch (error) {
          this.expire(userId, error)
          if (current.status === 'draft') throw error
        }
      }
      if (!this.database.deleteCsdnPublication(userId, id)) throw notFound('CSDN 发布记录不存在')
      return { ok: true, remoteDeleted }
    } finally { this.active.delete(userId) }
  }

  async resolve(userId: string, id: string, input: CsdnResolveInput): Promise<CsdnPublication> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status !== 'uncertain') throw new ApiError(409, 'csdn_resolution_stale', '任务状态已变化，请刷新后再操作')
    this.active.add(userId)
    let handedOff = false
    try {
      if (input.action === 'check') {
        const state = this.state(userId)
        this.database.updateCsdnPublication(userId, id, { status: 'running', message: '正在重新核实 CSDN 发布结果' })
        const task = this.recheck(userId, id, state, current)
        this.jobs.set(id, task); handedOff = true
        void task.finally(() => { this.jobs.delete(id); this.active.delete(userId) }).catch(() => {})
        return this.get(userId, id)
      }
      let values: Pick<CsdnPublication, 'status' | 'message' | 'url' | 'remoteId'>
      if (input.action === 'not_published') {
        values = { status: 'failed', message: '用户已核实未发布，已解除限制；再次提交会重新发布', url: current.url, remoteId: current.remoteId }
      } else {
        const articleUrl = (input.articleUrl || '').trim()
        const remoteId = parseCsdnArticleId(articleUrl)
        if (!remoteId || !/^(?:https?:\/\/)?blog\.csdn\.net\//i.test(articleUrl)) throw new ApiError(400, 'csdn_article_url', '请填写包含 /article/details/文章编号 的 CSDN 博客文章链接')
        const account = this.database.getCsdnAccount(userId)
        const url = account?.accountId ? csdnArticleUrl(account.accountId, remoteId) : current.url?.includes(remoteId) ? current.url : `https://blog.csdn.net/article/details/${remoteId}`
        values = { status: 'published', message: '用户已人工核实文章发布成功，并关联文章链接', remoteId, url }
      }
      const result = this.database.resolveCsdnPublication(userId, id, input.action, values)
      if (!result) throw new ApiError(409, 'csdn_resolution_stale', '任务状态已变化，请刷新后再操作')
      return result
    } finally { if (!handedOff) this.active.delete(userId) }
  }

  private async recheck(userId: string, id: string, state: PublisherStorageState, current: CsdnPublication): Promise<void> {
    try {
      const result = current.remoteId
        ? await this.driver.checkPublication(state, current.remoteId, current.title, current.url)
        : { status: 'unknown', url: null, message: '没有可核对的文章编号，请到 CSDN 后台核实后选择人工核实结果' }
      this.database.resolveCsdnPublication(userId, id, 'check', { status: result.status === 'published' ? 'published' : 'uncertain', message: result.message, url: result.url || current.url, remoteId: current.remoteId })
    } catch (error) {
      this.expire(userId, error)
      this.database.resolveCsdnPublication(userId, id, 'check', { status: 'uncertain', message: error instanceof ApiError ? error.message : '自动核实未完成，请稍后重试或填写人工核实结果', url: current.url, remoteId: current.remoteId })
    }
  }

  async publish(userId: string, input: CsdnPublishInput): Promise<CsdnPublication> {
    this.idle(userId)
    if ([...this.logins.values()].some(entry => entry.userId === userId && ['waiting', 'scanned'].includes(entry.value.status))) throw new ApiError(409, 'csdn_busy', '请先完成 CSDN 扫码登录')
    this.active.add(userId)
    let handedOff = false
    try {
      if (this.database.hasUncertainCsdnPublication(userId)) throw new ApiError(409, 'csdn_result_uncertain', '请先核实所有结果待确认的 CSDN 任务，再提交新的发布')
      const state = this.state(userId)
      const account = this.database.getCsdnAccount(userId)
      if (!account) throw new ApiError(409, 'csdn_session_expired', '请先在系统中扫码登录 CSDN')
      const article = await this.article(userId, input)
      const hash = createHash('sha256').update(JSON.stringify({ account: account.accountId, contentId: this.database.getRender(userId, input.renderId)?.contentId, title: article.title, markdown: article.markdown, mode: article.mode, tags: article.tags }))
      const idempotencyKey = hash.digest('hex'), previous = this.database.findCsdnPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return previous
      this.actions.assertPublish(userId)
      const publication = previous ?? this.database.createCsdnPublication(userId, { renderId: input.renderId, title: article.title, mode: article.mode, idempotencyKey })
      this.database.updateCsdnPublication(userId, publication.id, { status: 'running', message: '正在准备 CSDN 正文' })
      const task = this.run(userId, publication.id, state, article)
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
    const account = this.database.getCsdnAccount(userId)
    if (account && error instanceof ApiError && error.code === 'csdn_session_expired') this.database.saveCsdnAccount(userId, { ...account, status: 'expired', checkedAt: now() })
  }

  private async run(userId: string, id: string, state: PublisherStorageState, article: CsdnArticle): Promise<void> {
    try {
      const result = await this.driver.publish(state, article, progress => { this.database.updateCsdnPublication(userId, id, progress) })
      const account = this.database.getCsdnAccount(userId)
      if (account) this.database.saveCsdnAccount(userId, { ...account, encryptedSession: encryptPublisherSession(result.state, this.key, userId), status: 'connected', checkedAt: now() })
      this.database.updateCsdnPublication(userId, id, { status: result.status, message: result.message, url: result.url, remoteId: result.remoteId })
    } catch (error) {
      this.expire(userId, error)
      const code = error instanceof ApiError ? error.code : ''
      const uncertain = !(error instanceof ApiError) || ['csdn_result_uncertain', 'csdn_security_check'].includes(code)
      this.database.updateCsdnPublication(userId, id, { status: uncertain ? 'uncertain' : 'failed', message: error instanceof ApiError ? error.message : 'CSDN 操作中断，结果未确认，请先核对 CSDN 草稿箱和文章列表，避免重复发布' })
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
