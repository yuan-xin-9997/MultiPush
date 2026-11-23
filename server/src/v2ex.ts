import { createHash } from 'node:crypto'
import { V2EX_COMMON_NODES, type V2exAccount, type V2exConnectInput, type V2exNode, type V2exPublication, type V2exPublishInput, type V2exResolveInput } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { PlatformActionGuard } from './platform-actions'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey, type PublisherStorageState } from './publisher-session'
import type { V2exArticle, V2exDriver, V2exIdentity } from './v2ex-browser'

const now = () => new Date().toISOString()

function topicIdFromUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (!/(^|\.)v2ex\.com$/i.test(parsed.hostname)) return null
    return parsed.pathname.match(/^\/t\/(\d{1,30})\/?$/)?.[1] ?? null
  } catch {
    return null
  }
}

export class V2exService {
  private readonly key: Buffer
  private readonly active = new Set<string>()
  private readonly checks = new Map<string, Promise<V2exAccount>>()
  private readonly actions: PlatformActionGuard
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: V2exDriver) {
    this.key = loadPublisherKey(config.dataDir, 'v2ex')
    this.actions = new PlatformActionGuard(database, 'v2ex')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'v2ex_unavailable', 'V2EX 服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'v2ex_busy', 'V2EX 操作正在进行，请等待完成')
  }

  private state(userId: string): PublisherStorageState {
    const account = this.database.getV2exAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'v2ex_session_expired', '请先连接 V2EX 账号')
    try {
      return decryptPublisherSession(account.encryptedSession, this.key, userId)
    } catch {
      this.database.saveV2exAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'v2ex_session_expired', 'V2EX 登录状态无法恢复，请重新复制 Cookie 连接')
    }
  }

  private save(userId: string, state: PublisherStorageState, identity: V2exIdentity): void {
    if (!this.closed) {
      this.database.saveV2exAccount(userId, {
        encryptedSession: encryptPublisherSession(state, this.key, userId),
        accountId: identity.accountId,
        name: identity.name,
        status: 'connected',
        checkedAt: now(),
      })
    }
  }

  async account(userId: string, force = false): Promise<V2exAccount> {
    const current = this.database.getV2exAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    const view = { status: current.status, name: current.name, checkedAt: current.checkedAt }
    if (!force || current.status === 'expired' || this.active.has(userId)) return view
    if (!this.actions.allowSessionCheck(userId)) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<V2exAccount> => {
      try {
        const result = await this.driver.checkSession(this.state(userId))
        const latest = this.database.getV2exAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.save(userId, result.state, result.identity)
        return { status: 'connected', name: result.identity.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'v2ex_session_expired' && this.database.getV2exAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveV2exAccount(userId, { ...current, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, checkedAt: now() }
        }
        throw error
      }
    })().finally(() => this.checks.delete(userId))
    this.checks.set(userId, check)
    return check
  }

  async connect(userId: string, input: V2exConnectInput): Promise<V2exAccount> {
    this.idle(userId)
    this.active.add(userId)
    try {
      const result = await this.driver.connect(input.cookie)
      this.save(userId, result.state, result.identity)
      return { status: 'connected', name: result.identity.name, checkedAt: now() }
    } finally {
      this.active.delete(userId)
    }
  }

  async disconnect(userId: string): Promise<void> {
    this.idle(userId)
    this.active.add(userId)
    try {
      this.database.deleteV2exAccount(userId)
    } finally {
      this.active.delete(userId)
    }
  }

  async nodes(userId: string): Promise<V2exNode[]> {
    const account = this.database.getV2exAccount(userId)
    if (!account || account.status === 'expired') return V2EX_COMMON_NODES
    try {
      const nodes = await this.driver.listNodes(this.state(userId))
      return nodes.length > 0 ? nodes : V2EX_COMMON_NODES
    } catch {
      return V2EX_COMMON_NODES
    }
  }

  private article(userId: string, input: V2exPublishInput): V2exArticle {
    const record = this.database.getRender(userId, input.renderId)
    const render = record?.results.find(result => result.platform === 'v2ex')
    if (!record || !render) throw notFound('V2EX 排版记录不存在，请先生成 V2EX 排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'v2ex_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'v2ex_render_stale', '原文已修改，请重新生成 V2EX 排版后发布')
    const title = render.title.trim()
    if (title.length === 0 || title.length > 120) throw new ApiError(400, 'v2ex_title_invalid', 'V2EX 主题标题需要 1–120 个字符')
    const nodeName = input.nodeName.trim()
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(nodeName)) throw new ApiError(400, 'v2ex_node_invalid', '请选择或填写有效的 V2EX 节点')
    if (render.videos.length) throw new ApiError(400, 'v2ex_media_unsupported', 'V2EX 主题暂不支持视频，请先移除视频')
    const lines = (render.markdown ?? '').split('\n')
    if (lines.length > 1 && /^#\s+/.test(lines[0]) && lines[0].replace(/^#\s+/, '').trim() === title) lines.shift()
    const markdown = lines.join('\n').trim()
    if (!markdown) throw new ApiError(400, 'v2ex_body_empty', '请先填写主题正文')
    if (markdown.length > 20_000) throw new ApiError(400, 'v2ex_body_size', 'V2EX 主题正文不能超过 20000 个字符')
    return { title, markdown, nodeName }
  }

  list(userId: string): V2exPublication[] {
    return this.database.listV2exPublications(userId)
  }

  get(userId: string, id: string): V2exPublication {
    const value = this.database.getV2exPublication(userId, id)
    if (!value) throw notFound('V2EX 发布记录不存在')
    return value
  }

  async publish(userId: string, input: V2exPublishInput): Promise<V2exPublication> {
    this.idle(userId)
    this.active.add(userId)
    try {
      if (this.database.hasUncertainV2exPublication(userId)) throw new ApiError(409, 'v2ex_result_uncertain', '请先核实所有结果待确认的 V2EX 任务，再提交新的发布')
      const state = this.state(userId)
      const account = this.database.getV2exAccount(userId)
      if (!account) throw new ApiError(409, 'v2ex_session_expired', '请先在系统中扫码登录 V2EX')
      const article = this.article(userId, input)
      const hash = createHash('sha256').update(JSON.stringify({
        account: account.accountId,
        contentId: this.database.getRender(userId, input.renderId)?.contentId,
        title: article.title,
        nodeName: article.nodeName,
        markdown: article.markdown,
      }))
      const idempotencyKey = hash.digest('hex')
      const previous = this.database.findV2exPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return previous
      this.actions.assertPublish(userId)
      const publication = previous ?? this.database.createV2exPublication(userId, {
        renderId: input.renderId,
        title: article.title,
        nodeName: article.nodeName,
        idempotencyKey,
      })
      this.database.updateV2exPublication(userId, publication.id, { status: 'running', message: '正在打开 V2EX 发帖页' })
      try {
        const result = await this.driver.publish(state, article, ({ message }) => {
          this.database.updateV2exPublication(userId, publication.id, { message })
        })
        const account = this.database.getV2exAccount(userId)
        if (account) {
          this.database.saveV2exAccount(userId, {
            ...account,
            encryptedSession: encryptPublisherSession(result.state, this.key, userId),
            status: 'connected',
            checkedAt: now(),
          })
        }
        return this.database.updateV2exPublication(userId, publication.id, {
          status: 'published',
          message: result.message,
          url: result.url,
          remoteId: result.remoteId,
        }) ?? this.get(userId, publication.id)
      } catch (error) {
        this.expire(userId, error)
        const code = error instanceof ApiError ? error.code : ''
        const uncertain = code === 'v2ex_result_uncertain'
        return this.database.updateV2exPublication(userId, publication.id, {
          status: uncertain ? 'uncertain' : 'failed',
          message: error instanceof ApiError ? error.message : 'V2EX 操作中断，结果未确认，请先到 V2EX 核实，避免重复发布',
        }) ?? this.get(userId, publication.id)
      }
    } catch (error) {
      this.expire(userId, error)
      throw error
    } finally {
      this.active.delete(userId)
    }
  }

  async remove(userId: string, id: string): Promise<{ ok: true; remoteDeleted: boolean }> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status === 'running') throw new ApiError(409, 'v2ex_delete_busy', 'V2EX 任务正在处理，请等待完成后再删除')
    if (current.status === 'uncertain') throw new ApiError(409, 'v2ex_delete_uncertain', '请先核实这条 V2EX 任务的结果，再删除发布记录')
    if (current.status === 'published') throw new ApiError(409, 'v2ex_delete_published', '已发布的 V2EX 主题不能删除；如需下架请到 V2EX 后台处理')
    if (!this.database.deleteV2exPublication(userId, id)) throw notFound('V2EX 发布记录不存在')
    return { ok: true, remoteDeleted: false }
  }

  async resolve(userId: string, id: string, input: V2exResolveInput): Promise<V2exPublication> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status !== 'uncertain') throw new ApiError(409, 'v2ex_resolution_stale', '任务状态已变化，请刷新后再操作')
    this.active.add(userId)
    try {
      if (input.action === 'check') {
        this.database.updateV2exPublication(userId, id, { status: 'running', message: '正在重新核实 V2EX 发布结果' })
        try {
          const result = await this.driver.checkPublication(this.state(userId), current.url || '', current.title)
          return this.database.resolveV2exPublication(userId, id, 'check', {
            status: result.status === 'published' ? 'published' : 'uncertain',
            message: result.message,
            url: result.url || current.url,
            remoteId: current.remoteId,
          }) ?? this.get(userId, id)
        } catch (error) {
          this.expire(userId, error)
          return this.database.resolveV2exPublication(userId, id, 'check', {
            status: 'uncertain',
            message: error instanceof ApiError ? error.message : '自动核实未完成，请稍后重试或填写人工核实结果',
            url: current.url,
            remoteId: current.remoteId,
          }) ?? this.get(userId, id)
        }
      }
      if (input.action === 'not_published') {
        return this.database.resolveV2exPublication(userId, id, 'not_published', {
          status: 'failed',
          message: '用户已核实未发布，已解除限制；再次提交会重新发布',
          url: current.url,
          remoteId: current.remoteId,
        }) ?? this.get(userId, id)
      }
      const topicUrl = (input.topicUrl ?? '').trim()
      const remoteId = topicIdFromUrl(topicUrl)
      if (!remoteId) throw new ApiError(400, 'v2ex_topic_url', '请填写 https://www.v2ex.com/t/主题编号 格式的主题链接')
      return this.database.resolveV2exPublication(userId, id, 'published', {
        status: 'published',
        message: '用户已人工核实主题发布成功，并关联主题链接',
        url: topicUrl,
        remoteId,
      }) ?? this.get(userId, id)
    } finally {
      this.active.delete(userId)
    }
  }

  private expire(userId: string, error: unknown): void {
    const account = this.database.getV2exAccount(userId)
    if (account && error instanceof ApiError && error.code === 'v2ex_session_expired') {
      this.database.saveV2exAccount(userId, { ...account, status: 'expired', checkedAt: now() })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const check of this.checks.values()) await check.catch(() => {})
    await this.driver.close()
  }
}
