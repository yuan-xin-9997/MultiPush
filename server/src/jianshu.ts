import { createHash } from 'node:crypto'
import type { JianshuAccount, JianshuConnectInput, JianshuPublication, JianshuPublishInput, JianshuResolveInput } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey, type PublisherStorageState } from './publisher-session'
import type { JianshuArticle, JianshuDriver, JianshuIdentity } from './jianshu-browser'

const now = () => new Date().toISOString()
const TTL = 5 * 60_000

function slugFromUrl(value: string | null): string | null {
  if (!value) return null
  try { return /\/p\/([^/?#]+)/.exec(new URL(value).pathname)?.[1] ?? null } catch { return null }
}

export class JianshuService {
  private readonly key: Buffer
  private readonly active = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<JianshuAccount>>()
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: JianshuDriver) {
    this.key = loadPublisherKey(config.dataDir, 'jianshu')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'jianshu_unavailable', '简书服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'jianshu_busy', '简书操作正在进行，请等待完成')
  }

  private state(userId: string): PublisherStorageState {
    const account = this.database.getJianshuAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'jianshu_session_expired', '请先连接简书账号')
    try { return decryptPublisherSession(account.encryptedSession, this.key, userId) }
    catch {
      this.database.saveJianshuAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'jianshu_session_expired', '简书登录状态无法恢复，请重新复制 Cookie 连接')
    }
  }

  private save(userId: string, state: PublisherStorageState, identity: JianshuIdentity): void {
    if (!this.closed) this.database.saveJianshuAccount(userId, { encryptedSession: encryptPublisherSession(state, this.key, userId), ...identity, status: 'connected', checkedAt: now() })
  }

  async account(userId: string): Promise<JianshuAccount> {
    const current = this.database.getJianshuAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    const view = { status: current.status, name: current.name, checkedAt: current.checkedAt }
    if (current.status === 'expired' || this.active.has(userId) || Date.now() - Date.parse(current.checkedAt) < TTL) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<JianshuAccount> => {
      try {
        const result = await this.driver.checkSession(this.state(userId))
        const latest = this.database.getJianshuAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.save(userId, result.state, result.identity)
        return { status: 'connected', name: result.identity.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'jianshu_session_expired' && this.database.getJianshuAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveJianshuAccount(userId, { ...current, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, checkedAt: now() }
        }
        throw error
      }
    })().finally(() => this.checks.delete(userId))
    this.checks.set(userId, check)
    return check
  }

  async connect(userId: string, input: JianshuConnectInput): Promise<JianshuAccount> {
    this.idle(userId)
    this.active.add(userId)
    try {
      const result = await this.driver.connect(input.cookie)
      this.save(userId, result.state, result.identity)
      return { status: 'connected', name: result.identity.name, checkedAt: now() }
    } finally { this.active.delete(userId) }
  }

  async disconnect(userId: string): Promise<void> {
    this.idle(userId)
    this.active.add(userId)
    try { this.database.deleteJianshuAccount(userId) } finally { this.active.delete(userId) }
  }

  private async article(userId: string, input: JianshuPublishInput): Promise<JianshuArticle> {
    const record = this.database.getRender(userId, input.renderId)
    const render = record?.results.find(result => result.platform === 'jianshu')
    if (!record || !render) throw notFound('简书排版记录不存在，请先生成简书排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'jianshu_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'jianshu_render_stale', '原文已修改，请重新生成简书排版后发布')
    const title = render.title.trim()
    if (Array.from(title).length < 1 || Array.from(title).length > 100) throw new ApiError(400, 'jianshu_title_invalid', '简书标题需要 1–100 个字')
    if (!render.markdown?.trim()) throw new ApiError(400, 'jianshu_body_empty', '请先填写文章正文')
    if (Buffer.byteLength(render.markdown) > 1024 * 1024) throw new ApiError(400, 'jianshu_body_size', '文章 Markdown 不能超过 1 MB')
    if (render.videos.length) throw new ApiError(400, 'jianshu_media_unsupported', '简书暂不支持视频，请先移除视频')
    const lines = render.markdown.split('\n')
    if (lines.length > 1 && /^#\s+/.test(lines[0]) && lines[0].replace(/^#\s+/, '').trim() === title) lines.shift()
    const markdown = lines.join('\n').trim()
    if (!markdown) throw new ApiError(400, 'jianshu_body_empty', '请先填写文章正文')
    return {
      title,
      markdown,
      text: render.text ?? '',
      mode: input.mode === 'draft' ? 'draft' : 'publish',
      notebookId: typeof input.notebookId === 'string' && /^\d{5,30}$/.test(input.notebookId) ? input.notebookId : undefined,
    }
  }

  list(userId: string): JianshuPublication[] { return this.database.listJianshuPublications(userId) }
  get(userId: string, id: string): JianshuPublication {
    const value = this.database.getJianshuPublication(userId, id)
    if (!value) throw notFound('简书发布记录不存在')
    return value
  }

  async resolve(userId: string, id: string, input: JianshuResolveInput): Promise<JianshuPublication> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status !== 'uncertain') throw new ApiError(409, 'jianshu_resolution_stale', '任务状态已变化，请刷新后再操作')
    this.active.add(userId)
    let handedOff = false
    try {
      if (input.action === 'check') {
        const state = this.state(userId)
        this.database.updateJianshuPublication(userId, id, { status: 'running', message: '正在重新核实简书发布结果' })
        const task = this.recheck(userId, id, state, current)
        this.jobs.set(id, task); handedOff = true
        void task.finally(() => { this.jobs.delete(id); this.active.delete(userId) }).catch(() => {})
        return this.get(userId, id)
      }
      let values: Pick<JianshuPublication, 'status' | 'message' | 'url' | 'remoteId'>
      if (input.action === 'not_published') {
        values = { status: 'failed', message: '用户已核实未发布，已解除限制；再次提交会重新发布', url: current.url, remoteId: current.remoteId }
      } else {
        const url = input.articleUrl || ''
        if (!/^https:\/\/www\.jianshu\.com\/p\/[A-Za-z0-9_-]+\/?$/.test(url)) throw new ApiError(400, 'jianshu_article_url', '请填写 https://www.jianshu.com/p/文章编号 格式的文章链接')
        values = { status: 'published', message: '用户已人工核实文章发布成功，并关联文章链接', remoteId: current.remoteId, url }
      }
      const result = this.database.resolveJianshuPublication(userId, id, input.action, values)
      if (!result) throw new ApiError(409, 'jianshu_resolution_stale', '任务状态已变化，请刷新后再操作')
      return result
    } finally { if (!handedOff) this.active.delete(userId) }
  }

  private async recheck(userId: string, id: string, state: PublisherStorageState, current: JianshuPublication): Promise<void> {
    try {
      const slug = slugFromUrl(current.url)
      const result = current.remoteId
        ? await this.driver.checkPublication(state, current.remoteId, current.title, slug)
        : { status: 'unknown', url: null, message: '没有可核对的文章编号，请到简书后台核实后选择人工核实结果' }
      this.database.resolveJianshuPublication(userId, id, 'check', { status: result.status === 'published' ? 'published' : 'uncertain', message: result.message, url: result.url || current.url, remoteId: current.remoteId })
    } catch (error) {
      this.expire(userId, error)
      this.database.resolveJianshuPublication(userId, id, 'check', { status: 'uncertain', message: error instanceof ApiError ? error.message : '自动核实未完成，请稍后重试或填写人工核实结果', url: current.url, remoteId: current.remoteId })
    }
  }

  async publish(userId: string, input: JianshuPublishInput): Promise<JianshuPublication> {
    this.idle(userId)
    this.active.add(userId)
    let handedOff = false
    try {
      if (this.database.hasUncertainJianshuPublication(userId)) throw new ApiError(409, 'jianshu_result_uncertain', '请先核实所有结果待确认的简书任务，再提交新的发布')
      const checked = await this.driver.checkSession(this.state(userId))
      this.save(userId, checked.state, checked.identity)
      const article = await this.article(userId, input)
      const hash = createHash('sha256').update(JSON.stringify({ account: checked.identity.accountId, contentId: this.database.getRender(userId, input.renderId)?.contentId, title: article.title, markdown: article.markdown, mode: article.mode, notebookId: article.notebookId }))
      const idempotencyKey = hash.digest('hex'), previous = this.database.findJianshuPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return previous
      const publication = previous ?? this.database.createJianshuPublication(userId, { renderId: input.renderId, title: article.title, mode: article.mode, idempotencyKey })
      this.database.updateJianshuPublication(userId, publication.id, { status: 'running', message: '正在准备简书正文' })
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
    const account = this.database.getJianshuAccount(userId)
    if (account && error instanceof ApiError && error.code === 'jianshu_session_expired') this.database.saveJianshuAccount(userId, { ...account, status: 'expired', checkedAt: now() })
  }

  private async run(userId: string, id: string, state: PublisherStorageState, article: JianshuArticle): Promise<void> {
    try {
      const result = await this.driver.publish(state, article, progress => { this.database.updateJianshuPublication(userId, id, progress) })
      const account = this.database.getJianshuAccount(userId)
      if (account) this.database.saveJianshuAccount(userId, { ...account, encryptedSession: encryptPublisherSession(result.state, this.key, userId), status: 'connected', checkedAt: now() })
      this.database.updateJianshuPublication(userId, id, { status: result.status, message: result.message, url: result.url, remoteId: result.remoteId })
    } catch (error) {
      this.expire(userId, error)
      const code = error instanceof ApiError ? error.code : ''
      const uncertain = !(error instanceof ApiError) || ['jianshu_result_uncertain'].includes(code)
      this.database.updateJianshuPublication(userId, id, { status: uncertain ? 'uncertain' : 'failed', message: error instanceof ApiError ? error.message : '简书操作中断，结果未确认，请先核对简书草稿箱和文章列表，避免重复发布' })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const check of this.checks.values()) await check.catch(() => {})
    await this.driver.close()
    await Promise.allSettled([...this.jobs.values(), ...this.checks.values()])
  }
}
