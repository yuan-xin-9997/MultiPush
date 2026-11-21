import type {
  BatchJob,
  BatchJobItem,
  BatchPublishInput,
  BatchRenderInput,
  ContentDetail,
  PlatformId,
  RenderOptions,
} from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { renderPlatforms } from './renderers'
import { latestExportOutputUrl } from './video'
import type { WechatService } from './wechat'
import type { ZhihuService } from './zhihu'
import type { SspaiService } from './sspai'
import type { BlogService } from './blog'
import type { WeiboService } from './weibo'
import type { ToutiaoService } from './toutiao'
import type { DoubanService } from './douban'
import type { JuejinService } from './juejin'
import type { JianshuService } from './jianshu'
import type { CsdnService } from './csdn'

const MAX_RENDER_ITEMS = 30
const MAX_PUBLISH_ITEMS = 10
const PUBLISH_POLL_MS = 1_500
const PUBLISH_TIMEOUT_MS = 5 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Sequential background batches. The platform services deliberately allow only
 * one active job per user, so a batch must wait for each publication to reach a
 * terminal state before submitting the next one.
 */
export class BatchService {
  private readonly activeUsers = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private closed = false

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly wechat: WechatService,
    private readonly zhihu: ZhihuService,
    private readonly sspai: SspaiService,
    private readonly blog: BlogService,
    private readonly weibo: WeiboService,
    private readonly toutiao: ToutiaoService,
    private readonly douban: DoubanService,
    private readonly juejin: JuejinService,
    private readonly jianshu: JianshuService,
    private readonly csdn: CsdnService,
  ) {}

  private assertIdle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'batch_unavailable', '批量服务正在停止，请稍后重试')
    if (this.activeUsers.has(userId)) throw new ApiError(409, 'batch_busy', '已有批量任务正在执行，请等待完成后再提交')
  }

  private itemsFor(userId: string, contentIds: string[]): BatchJobItem[] {
    return contentIds.map((contentId, index) => {
      const content = this.database.getContentSummary(userId, contentId)
      return {
        index,
        contentId,
        title: content?.title ?? '未知内容',
        status: 'pending',
        message: content ? '等待处理' : '内容不存在或无权访问',
      }
    })
  }

  createRenderJob(userId: string, input: BatchRenderInput, baseUrl: string): BatchJob {
    this.assertIdle(userId)
    const contentIds = Array.from(new Set(input.contentIds)).filter(Boolean)
    if (!contentIds.length) throw new ApiError(400, 'batch_empty', '请选择要批量渲染的内容')
    if (contentIds.length > MAX_RENDER_ITEMS) throw new ApiError(400, 'batch_too_large', `一次最多批量渲染 ${MAX_RENDER_ITEMS} 篇内容`)
    const platforms = Array.from(new Set(input.platforms))
    if (!platforms.length) throw new ApiError(400, 'batch_platforms', '请至少选择一个渲染平台')
    const job = this.database.createBatchJob(userId, {
      kind: 'render',
      total: contentIds.length,
      message: '批量渲染已排队',
      input: { ...input, contentIds, baseUrl },
      items: this.itemsFor(userId, contentIds),
    })
    this.start(userId, job.id, this.runRender(userId, job.id, { ...input, contentIds }, baseUrl))
    return job
  }

  createPublishJob(userId: string, input: BatchPublishInput, baseUrl: string): BatchJob {
    this.assertIdle(userId)
    const contentIds = Array.from(new Set(input.contentIds)).filter(Boolean)
    if (!contentIds.length) throw new ApiError(400, 'batch_empty', '请选择要批量发布的内容')
    if (contentIds.length > MAX_PUBLISH_ITEMS) throw new ApiError(400, 'batch_too_large', `一次最多批量发布 ${MAX_PUBLISH_ITEMS} 篇内容`)
    if (input.platform === 'wechat' && input.mode !== 'draft') throw new ApiError(400, 'batch_wechat_mode', '公众号批量发布仅支持保存草稿；正式发表请在发布管理中逐篇完成')
    if (input.platform === 'juejin' && !['draft', 'publish'].includes(input.mode)) throw new ApiError(400, 'batch_juejin_mode', '掘金批量发布需要选择草稿或发布模式')
    if (input.platform === 'jianshu' && !['draft', 'publish'].includes(input.mode)) throw new ApiError(400, 'batch_jianshu_mode', '简书批量发布需要选择草稿或发布模式')
    if (input.platform === 'csdn' && !['draft', 'publish'].includes(input.mode)) throw new ApiError(400, 'batch_csdn_mode', 'CSDN 批量发布需要选择草稿或发布模式')
    if (input.platform === 'wechat' && !input.coverMediaId) {
      const missing = contentIds.filter(id => {
        const content = this.database.getContentDetail(userId, id)
        return content ? !this.coverFromContent(userId, content) : true
      })
      if (missing.length) throw new ApiError(400, 'batch_cover_required', '公众号批量发布需要选择统一封面，或确保所选内容都有已上传的封面图片')
    }
    const job = this.database.createBatchJob(userId, {
      kind: 'publish',
      total: contentIds.length,
      message: '批量发布已排队',
      input: { ...input, contentIds, baseUrl },
      items: this.itemsFor(userId, contentIds),
    })
    this.start(userId, job.id, this.runPublish(userId, job.id, { ...input, contentIds }, baseUrl))
    return job
  }

  list(userId: string): BatchJob[] {
    return this.database.listBatchJobs(userId)
  }

  get(userId: string, id: string): BatchJob {
    const job = this.database.getBatchJob(userId, id)
    if (!job) throw notFound('批量任务不存在')
    return job
  }

  private start(userId: string, id: string, task: Promise<void>): void {
    this.activeUsers.add(userId)
    const tracked = task
      .catch((error) => {
        this.database.updateBatchJob(userId, id, {
          status: 'failed',
          message: error instanceof Error ? error.message : '批量任务执行失败',
        })
      })
      .finally(() => {
        this.activeUsers.delete(userId)
        this.jobs.delete(id)
      })
    this.jobs.set(id, tracked)
    void tracked
  }

  private async runRender(userId: string, jobId: string, input: BatchRenderInput, baseUrl: string): Promise<void> {
    const platforms = Array.from(new Set(input.platforms))
    this.database.updateBatchJob(userId, jobId, { status: 'running', message: '正在批量渲染' })
    const user = this.database.findUserById(userId)
    const authorName = user?.displayName || user?.username || 'MultiPush'
    let done = 0
    let succeeded = 0
    let items = this.get(userId, jobId).items
    for (const item of items) {
      if (this.closed) break
      items = this.patchItem(items, item.index, { status: 'running', message: '正在渲染' })
      this.database.updateBatchJob(userId, jobId, { items, message: `正在渲染 ${item.index + 1}/${items.length}` })
      try {
        const content = this.database.getContentDetail(userId, item.contentId)
        if (!content || content.deletedAt) throw new ApiError(404, 'content_not_found', '内容不存在或在回收站')
        const results = await renderPlatforms({
          content,
          platforms,
          options: input.options ?? {},
          platformOptions: input.platformOptions,
          authorName,
          baseUrl,
          videoUrl: latestExportOutputUrl(this.database, userId, content.id),
        })
        const render = this.database.createRender(userId, {
          contentId: content.id,
          contentTitle: content.title,
          platforms,
          options: input.options ?? {},
          platformOptions: input.platformOptions,
          results,
        })
        done += 1
        succeeded += 1
        items = this.patchItem(items, item.index, {
          status: 'done',
          message: `已生成 ${results.length} 个平台排版`,
          renderId: render.id,
        })
      } catch (error) {
        done += 1
        items = this.patchItem(items, item.index, {
          status: 'failed',
          message: error instanceof Error ? error.message : '渲染失败',
        })
      }
      this.database.updateBatchJob(userId, jobId, { done, items, message: `已处理 ${done}/${items.length}` })
    }
    this.database.updateBatchJob(userId, jobId, {
      status: succeeded > 0 ? 'completed' : 'failed',
      done,
      items,
      message: succeeded === items.length ? `批量渲染完成，共 ${succeeded} 篇` : `批量渲染结束：成功 ${succeeded} 篇，失败 ${items.length - succeeded} 篇`,
    })
  }

  private async runPublish(userId: string, jobId: string, input: BatchPublishInput, baseUrl: string): Promise<void> {
    this.database.updateBatchJob(userId, jobId, { status: 'running', message: '正在批量发布' })
    const user = this.database.findUserById(userId)
    const authorName = user?.displayName || user?.username || 'MultiPush'
    let done = 0
    let succeeded = 0
    let items = this.get(userId, jobId).items
    for (const item of items) {
      if (this.closed) break
      items = this.patchItem(items, item.index, { status: 'running', message: '正在生成发布排版' })
      this.database.updateBatchJob(userId, jobId, { items, message: `正在发布 ${item.index + 1}/${items.length}` })
      try {
        const content = this.database.getContentDetail(userId, item.contentId)
        if (!content || content.deletedAt) throw new ApiError(404, 'content_not_found', '内容不存在或在回收站')
        const results = await renderPlatforms({
          content,
          platforms: [input.platform],
          options: input.options ?? {},
          authorName,
          baseUrl,
          videoUrl: latestExportOutputUrl(this.database, userId, content.id),
        })
        const render = this.database.createRender(userId, {
          contentId: content.id,
          contentTitle: content.title,
          platforms: [input.platform],
          options: input.options ?? {},
          results,
        })
        items = this.patchItem(items, item.index, { message: '正在提交到平台', renderId: render.id })
        const coverMediaId = input.coverMediaId ?? this.coverFromContent(userId, content) ?? undefined
        const publication = await this.publishOne(userId, input.platform, input.mode, render.id, coverMediaId, baseUrl)
        items = this.patchItem(items, item.index, { publicationId: publication.id, publicationStatus: publication.status })
        const final = await this.waitPublication(userId, input.platform, publication.id)
        items = this.patchItem(items, item.index, {
          publicationStatus: final.status,
          ...(final.url ? { url: final.url } : {}),
        })
        if (final.status === 'published' || final.status === 'draft') {
          done += 1
          succeeded += 1
          items = this.patchItem(items, item.index, { status: 'done', message: final.message })
        } else if (final.status === 'awaiting_confirmation') {
          items = this.skipPending(this.patchItem(items, item.index, {
            status: 'skipped',
            message: '需要管理员扫码确认，请在发布管理中完成',
          }), '未执行：批量任务已暂停')
          this.database.updateBatchJob(userId, jobId, { done, items, status: 'failed', message: '批量发布已暂停：微信公众号需要管理员扫码确认，请到发布管理完成后再处理剩余内容' })
          return
        } else if (final.status === 'uncertain') {
          items = this.skipPending(this.patchItem(items, item.index, { status: 'failed', message: final.message }), '未执行：批量任务已停止')
          this.database.updateBatchJob(userId, jobId, { done, items, status: 'failed', message: '批量发布已停止：出现结果待核实任务，请先到发布管理核实，避免重复发布' })
          return
        } else {
          done += 1
          items = this.patchItem(items, item.index, { status: 'failed', message: final.message })
        }
      } catch (error) {
        done += 1
        items = this.patchItem(items, item.index, {
          status: 'failed',
          message: error instanceof Error ? error.message : '发布失败',
        })
      }
      this.database.updateBatchJob(userId, jobId, { done, items, message: `已处理 ${done}/${items.length}` })
    }
    this.database.updateBatchJob(userId, jobId, {
      status: succeeded > 0 ? 'completed' : 'failed',
      done,
      items,
      message: succeeded === items.length ? `批量发布完成，共 ${succeeded} 篇` : `批量发布结束：成功 ${succeeded} 篇，失败 ${items.length - succeeded} 篇`,
    })
  }

  private patchItem(items: BatchJobItem[], index: number, patch: Partial<BatchJobItem>): BatchJobItem[] {
    return items.map(item => item.index === index ? { ...item, ...patch } : item)
  }

  private skipPending(items: BatchJobItem[], message: string): BatchJobItem[] {
    return items.map(item => item.status === 'pending' ? { ...item, status: 'skipped', message } : item)
  }

  private coverFromContent(userId: string, content: ContentDetail): string | null {
    const cover = content.coverImage
    if (!cover) return null
    let filename = ''
    try {
      const url = new URL(cover, 'http://multipush.local')
      if (url.pathname.startsWith('/uploads/')) filename = decodeURIComponent(url.pathname.slice('/uploads/'.length))
    } catch { return null }
    if (!filename) return null
    return this.database.getMediaByFilename(userId, filename)?.id ?? null
  }

  private async publishOne(userId: string, platform: BatchPublishInput['platform'], mode: BatchPublishInput['mode'], renderId: string, coverMediaId: string | undefined, baseUrl: string) {
    switch (platform) {
      case 'wechat':
        if (mode !== 'draft') throw new ApiError(400, 'batch_wechat_mode', '公众号批量发布仅支持保存草稿；正式发表请在发布管理中逐篇完成')
        if (!coverMediaId) throw new ApiError(400, 'batch_cover_required', '公众号批量发布需要封面图片')
        return this.wechat.publish(userId, { renderId, mode, coverMediaId }, baseUrl)
      case 'zhihu':
        return this.zhihu.publish(userId, { renderId, mode, ...(coverMediaId ? { coverMediaId } : {}) })
      case 'sspai':
        return this.sspai.publish(userId, { renderId, mode, ...(coverMediaId ? { coverMediaId } : {}) })
      case 'blog':
        return this.blog.publish(userId, { renderId, mode, ...(coverMediaId ? { coverMediaId } : {}) }, baseUrl)
      case 'weibo':
        return this.weibo.publish(userId, { renderId, mode }, baseUrl)
      case 'toutiao':
        return this.toutiao.publish(userId, { renderId, mode }, baseUrl)
      case 'douban':
        return this.douban.publish(userId, { renderId, mode })
      case 'juejin':
        return this.juejin.publish(userId, { renderId, mode })
      case 'jianshu':
        return this.jianshu.publish(userId, { renderId, mode })
      case 'csdn':
        return this.csdn.publish(userId, { renderId, mode })
      default:
        throw new ApiError(400, 'batch_platform_unsupported', '该平台暂不支持批量发布')
    }
  }

  private async waitPublication(userId: string, platform: BatchPublishInput['platform'], publicationId: string) {
    const deadline = Date.now() + PUBLISH_TIMEOUT_MS
    while (Date.now() < deadline && !this.closed) {
      const item = this.publication(userId, platform, publicationId)
      if (!item) return { status: 'failed', message: '发布记录不存在', url: null as string | null }
      if (!['running', 'awaiting_confirmation'].includes(item.status)) {
        return { status: item.status, message: item.message, url: item.url }
      }
      if (item.status === 'awaiting_confirmation') {
        return { status: item.status, message: item.message, url: item.url }
      }
      await sleep(PUBLISH_POLL_MS)
    }
    return { status: 'uncertain', message: this.closed ? '服务正在停止，批量任务已中断' : '等待平台结果超时，请到发布管理核实', url: null as string | null }
  }

  private publication(userId: string, platform: BatchPublishInput['platform'], id: string) {
    switch (platform) {
      case 'wechat': return this.database.getWechatPublication(userId, id)
      case 'zhihu': return this.database.getZhihuPublication(userId, id)
      case 'sspai': return this.database.getSspaiPublication(userId, id)
      case 'blog': return this.database.getBlogPublication(userId, id)
      case 'weibo': return this.database.getWeiboPublication(userId, id)
      case 'toutiao': return this.database.getToutiaoPublication(userId, id)
      case 'douban': return this.database.getDoubanPublication(userId, id)
      case 'juejin': return this.database.getJuejinPublication(userId, id)
      case 'jianshu': return this.database.getJianshuPublication(userId, id)
      case 'csdn': return this.database.getCsdnPublication(userId, id)
      default: return null
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.jobs.values()])
  }
}
