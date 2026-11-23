import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { load } from 'cheerio'
import { BILIBILI_PARTITIONS, type BilibiliAccount, type BilibiliLogin, type BilibiliPartition, type BilibiliPublication, type BilibiliPublishInput, type BilibiliResolveInput, type MediaAsset, type PlatformRender } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { PlatformActionGuard } from './platform-actions'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey, type PublisherStorageState } from './publisher-session'
import { bilibiliCookies } from './bilibili-cookies'
import { checkBilibiliVideoStatus, publishBilibiliVideo } from './bilibili-api'
import type { BilibiliArticleImage, BilibiliDriver, BilibiliIdentity } from './bilibili-browser'

const now = () => new Date().toISOString()
const LOGIN_TTL = 3 * 60_000
const MAX_ARTICLE_IMAGES = 20
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function truncate(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('')
}

function imageMime(name: string): string {
  return /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : /\.gif$/i.test(name) ? 'image/gif' : 'image/jpeg'
}

export class BilibiliService {
  private readonly key: Buffer
  private readonly active = new Set<string>()
  private readonly checks = new Map<string, Promise<BilibiliAccount>>()
  private readonly actions: PlatformActionGuard
  private readonly logins = new Map<string, { userId: string; expiresAt: number; attempt: Awaited<ReturnType<BilibiliDriver['beginLogin']>> }>()
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: BilibiliDriver) {
    this.key = loadPublisherKey(config.dataDir, 'bilibili')
    this.actions = new PlatformActionGuard(database, 'bilibili')
  }

  close(): void {
    this.closed = true
    void this.driver.close()
    for (const login of this.logins.values()) void login.attempt.close()
    this.logins.clear()
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'bilibili_unavailable', 'B 站服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'bilibili_busy', 'B 站发布正在进行，请等待完成')
  }

  private state(userId: string): PublisherStorageState {
    const account = this.database.getBilibiliAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'bilibili_session_expired', '请先扫码连接 B 站账号')
    try {
      return decryptPublisherSession(account.encryptedSession, this.key, userId)
    } catch {
      this.database.saveBilibiliAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'bilibili_session_expired', 'B 站登录状态无法恢复，请重新扫码登录')
    }
  }

  private save(userId: string, state: PublisherStorageState, identity: BilibiliIdentity): void {
    if (!this.closed) {
      this.database.saveBilibiliAccount(userId, {
        encryptedSession: encryptPublisherSession(state, this.key, userId),
        accountId: identity.accountId,
        name: identity.name,
        status: 'connected',
        checkedAt: now(),
      })
    }
  }

  async account(userId: string, force = false): Promise<BilibiliAccount> {
    const current = this.database.getBilibiliAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    const view = { status: current.status, name: current.name, checkedAt: current.checkedAt }
    if (!force || current.status === 'expired' || this.active.has(userId)) return view
    if (!this.actions.allowSessionCheck(userId)) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<BilibiliAccount> => {
      try {
        const result = await this.driver.checkSession(this.state(userId))
        const latest = this.database.getBilibiliAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.save(userId, result.state, result.identity)
        return { status: 'connected', name: result.identity.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'bilibili_session_expired' && this.database.getBilibiliAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveBilibiliAccount(userId, { ...current, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, checkedAt: now() }
        }
        throw error
      }
    })().finally(() => this.checks.delete(userId))
    this.checks.set(userId, check)
    return check
  }

  async beginLogin(userId: string): Promise<BilibiliLogin> {
    this.idle(userId)
    this.actions.assertLogin(userId)
    const attempt = await this.driver.beginLogin()
    const id = randomUUID()
    const expiresAt = Date.now() + LOGIN_TTL
    this.logins.set(id, { userId, expiresAt, attempt })
    const initial = await attempt.poll()
    if (initial.status === 'connected' && initial.state && initial.identity) {
      this.save(userId, initial.state, initial.identity)
      await attempt.close().catch(() => {})
      return { id, status: 'connected', qrCode: null, message: initial.message, expiresAt: new Date(expiresAt).toISOString() }
    }
    return { id, status: initial.status, qrCode: initial.qrCode, message: initial.message, expiresAt: new Date(expiresAt).toISOString() }
  }

  async loginStatus(userId: string, id: string): Promise<BilibiliLogin> {
    const login = this.logins.get(id)
    if (!login || login.userId !== userId) throw notFound('登录会话不存在或已过期')
    if (Date.now() > login.expiresAt) {
      this.logins.delete(id)
      await login.attempt.close().catch(() => {})
      return { id, status: 'expired', qrCode: null, message: '二维码已过期，请重新获取', expiresAt: new Date(login.expiresAt).toISOString() }
    }
    const result = await login.attempt.poll()
    if (result.status === 'connected' && result.state && result.identity) {
      this.save(userId, result.state, result.identity)
      this.logins.delete(id)
      await login.attempt.close().catch(() => {})
      return { id, status: 'connected', qrCode: null, message: result.message, expiresAt: new Date(login.expiresAt).toISOString() }
    }
    if (result.status === 'expired' || result.status === 'failed') {
      this.logins.delete(id)
      await login.attempt.close().catch(() => {})
    }
    return { id, status: result.status, qrCode: result.qrCode, message: result.message, expiresAt: new Date(login.expiresAt).toISOString() }
  }

  async disconnect(userId: string): Promise<void> {
    this.idle(userId)
    this.database.deleteBilibiliAccount(userId)
  }

  partitions(): BilibiliPartition[] {
    return BILIBILI_PARTITIONS
  }

  list(userId: string): BilibiliPublication[] {
    return this.database.listBilibiliPublications(userId)
  }

  get(userId: string, id: string): BilibiliPublication {
    const publication = this.database.getBilibiliPublication(userId, id)
    if (!publication) throw notFound('B 站发布记录不存在')
    return publication
  }

  async remove(userId: string, id: string): Promise<{ ok: true }> {
    const publication = this.get(userId, id)
    if (!['draft', 'failed', 'uncertain'].includes(publication.status)) throw new ApiError(409, 'bilibili_locked', '已提交、已发布或处理中的记录不能删除')
    this.database.deleteBilibiliPublication(userId, id)
    return { ok: true }
  }

  private render(userId: string, renderId: string): { record: ReturnType<Database['getRender']>; result: PlatformRender } {
    const record = this.database.getRender(userId, renderId)
    if (!record) throw notFound('渲染记录不存在')
    const result = record.results.find((item) => item.platform === 'bilibili')
    if (!result) throw new ApiError(400, 'bilibili_render_missing', '这份记录没有 B 站排版，请先重新渲染')
    return { record, result }
  }

  private mediaPath(media: MediaAsset): string {
    return path.join(this.config.uploadsDir, media.filename)
  }

  private async readMedia(media: MediaAsset): Promise<Buffer> {
    const file = this.mediaPath(media)
    if (!existsSync(file)) throw new ApiError(400, 'bilibili_media_missing', `素材文件不存在：${media.originalName}`)
    return readFile(file)
  }

  private coverFallback(userId: string, result: PlatformRender): MediaAsset | null {
    const image = result.assets.find((asset) => asset.kind === 'image')
    if (!image) return null
    try {
      const parsed = new URL(image.url, this.config.publicBaseUrl || 'http://localhost')
      const filename = path.basename(parsed.pathname)
      const media = this.database.getMediaByFilename?.(userId, filename)
      return media ?? null
    } catch {
      return null
    }
  }

  private async articleImages(result: PlatformRender): Promise<{ html: string; plain: string; images: BilibiliArticleImage[] }> {
    const $ = load(result.html, null, false)
    const images: BilibiliArticleImage[] = []
    const elements = $('img').toArray().slice(0, MAX_ARTICLE_IMAGES)
    for (const [index, element] of elements.entries()) {
      const src = $(element).attr('src') ?? ''
      if (!src) continue
      try {
        let buffer: Buffer | null = null
        let mime = 'image/jpeg'
        if (src.startsWith('data:')) {
          const match = /^data:([^;]+);base64,(.+)$/i.exec(src)
          if (match) { mime = match[1]; buffer = Buffer.from(match[2], 'base64') }
        } else {
          const parsed = new URL(src, this.config.publicBaseUrl || 'http://localhost')
          if (parsed.pathname.startsWith('/uploads/')) {
            const filename = path.basename(parsed.pathname)
            const file = path.join(this.config.uploadsDir, filename)
            if (existsSync(file)) { buffer = await readFile(file); mime = imageMime(filename) }
          } else {
            const response = await fetch(src, { signal: AbortSignal.timeout(15_000) })
            if (response.ok) {
              const array = Buffer.from(await response.arrayBuffer())
              if (array.length <= MAX_IMAGE_BYTES) { buffer = array; mime = response.headers.get('content-type')?.split(';')[0] || mime }
            }
          }
        }
        if (buffer && buffer.length > 0 && buffer.length <= MAX_IMAGE_BYTES) {
          const imageIndex = images.length
          const $image = $(element)
          const $parent = $image.parent()
          const $figure = $image.closest('figure')
          const inFigure = $figure.length > 0
          const $caption = $figure.find('figcaption').first()
          const captionText = $caption.text().trim()
          const alt = captionText || $image.attr('alt')?.trim() || ''
          const isImageOnlyParagraph = $parent.is('p') && !$parent.text().trim()
          // Bilibili uses the image alt as its visible caption. Move a figure
          // caption into alt and remove the figcaption; otherwise the editor
          // renders both an image caption and a duplicate paragraph.
          if (alt) $image.attr('alt', alt)
          if ($caption.length) $caption.remove()
          // Image-only paragraphs can safely become a block figure. Images
          // inside a figure or a text paragraph remain inline wrappers so the
          // surrounding text/caption stays intact.
          const block = !inFigure && !$parent.is('p')
          const marker = `<span data-multipush-image="${imageIndex}" data-multipush-block="${block || isImageOnlyParagraph ? '1' : '0'}"></span>`
          images.push({ name: `image-${index + 1}`, mime, buffer, alt })
          if (isImageOnlyParagraph) $parent.replaceWith(marker)
          else $image.replaceWith(marker)
        }
      } catch {
        // Skip unreachable images; the editor text is still saved.
      }
    }
    $('img').remove()
    const plain = $.root().text().replace(/\n{3,}/g, '\n\n').trim() || result.text || result.title
    return { html: $.html(), plain, images }
  }

  private tags(input: BilibiliPublishInput, result: PlatformRender): string {
    const raw = (input.tags ?? result.meta.tags.join(',')).split(/[,，]/).map((tag) => tag.trim()).filter(Boolean)
    return raw.slice(0, 10).join(',')
  }

  async publish(userId: string, input: BilibiliPublishInput): Promise<BilibiliPublication> {
    this.idle(userId)
    const { result } = this.render(userId, input.renderId)
    if (input.type === 'video' && input.mode !== 'publish') throw new ApiError(400, 'bilibili_video_mode', 'B 站视频投稿没有草稿模式，提交后会直接进入审核')
    if (input.type === 'video' && result.previewMode !== 'video') throw new ApiError(400, 'bilibili_type_mismatch', '这份排版不是 B 站视频，不能按视频投稿')
    if (input.type === 'article' && result.previewMode !== 'article') throw new ApiError(400, 'bilibili_type_mismatch', '这份排版不是 B 站图文，不能按图文发布')

    const titleLimit = input.type === 'video' ? 80 : 40
    const title = truncate((input.title ?? result.title).trim(), titleLimit)
    if (!title) throw new ApiError(400, 'bilibili_title', 'B 站标题不能为空')

    this.actions.assertPublish(userId)
    const publication = this.database.createBilibiliPublication(userId, {
      renderId: input.renderId,
      title,
      type: input.type,
      mode: input.mode,
      idempotencyKey: randomUUID(),
    })

    this.active.add(userId)
    void (input.type === 'video'
      ? this.runVideo(userId, publication, result, input, title)
      : this.runArticle(userId, publication, result, input, title)
    ).finally(() => this.active.delete(userId))
    return publication
  }

  private async runVideo(userId: string, publication: BilibiliPublication, result: PlatformRender, input: BilibiliPublishInput, title: string): Promise<void> {
    let phase = 'prepare'
    try {
      const account = this.database.getBilibiliAccount(userId)
      if (!account || account.status !== 'connected') throw new ApiError(409, 'bilibili_session_expired', '请先扫码连接 B 站账号')
      const state = this.state(userId)
      const videoMedia = input.videoMediaId
        ? this.database.getMedia(userId, input.videoMediaId)
        : this.latestExportMedia(userId, publication.renderId)
      if (!videoMedia || videoMedia.kind !== 'video') throw new ApiError(400, 'bilibili_video_missing', 'B 站视频投稿需要选择一段视频成片')
      const coverMedia = input.coverMediaId
        ? this.database.getMedia(userId, input.coverMediaId)
        : this.coverFallback(userId, result)
      if (!coverMedia || coverMedia.kind !== 'image') throw new ApiError(400, 'bilibili_cover_missing', 'B 站视频投稿需要 16:9 封面图，请在发布页选择')
      if (!/\.(png|jpe?g)$/i.test(coverMedia.originalName)) throw new ApiError(400, 'bilibili_cover_format', 'B 站封面需要 PNG 或 JPG 图片')
      const desc = truncate((input.desc ?? result.text ?? '').replace(title, '').trim(), 2000)
      if (!desc) throw new ApiError(400, 'bilibili_desc', 'B 站视频简介不能为空')
      const tags = this.tags(input, result)
      if (!tags) throw new ApiError(400, 'bilibili_tags', 'B 站视频标签不能为空')
      phase = 'upload'
      this.database.updateBilibiliPublication(userId, publication.id, { status: 'reviewing', message: '正在上传视频并提交 B 站审核' })
      const coverBuffer = await this.readMedia(coverMedia)
      const resultVideo = await publishBilibiliVideo(bilibiliCookies(state), {
        videoPath: this.mediaPath(videoMedia),
        videoName: videoMedia.originalName,
        coverBuffer,
        coverMime: imageMime(coverMedia.originalName),
        title,
        desc,
        tags,
        partitionId: input.partitionId,
      }, (message) => {
        if (phase === 'upload' && message.startsWith('正在提交')) phase = 'submit'
        if (!this.closed) this.database.updateBilibiliPublication(userId, publication.id, { status: 'reviewing', message })
      })
      this.database.updateBilibiliPublication(userId, publication.id, {
        status: 'reviewing',
        message: '已提交 B 站审核，审核通过后会公开',
        url: resultVideo.url,
        remoteId: resultVideo.bvid,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.database.updateBilibiliPublication(userId, publication.id, {
        status: phase === 'submit' ? 'uncertain' : 'failed',
        message: phase === 'submit' ? `${message}；投稿可能已提交，请到 B 站创作中心核实，避免重复投稿` : message,
      })
    }
  }

  private latestExportMedia(userId: string, contentId: string): MediaAsset | null {
    const exports = this.database.listVideoExports(userId, contentId)
    for (const item of exports) {
      if (item.status === 'completed' && item.outputMedia) return item.outputMedia
    }
    return null
  }

  private async runArticle(userId: string, publication: BilibiliPublication, result: PlatformRender, input: BilibiliPublishInput, title: string): Promise<void> {
    try {
      const state = this.state(userId)
      const prepared = await this.articleImages(result)
      this.database.updateBilibiliPublication(userId, publication.id, { status: 'running', message: '正在写入 B 站图文编辑器' })
      const outcome = await this.driver.publishArticle(state, {
        title,
        html: prepared.html,
        plain: prepared.plain,
        images: prepared.images,
      }, input.mode, (message) => {
        if (!this.closed) this.database.updateBilibiliPublication(userId, publication.id, { status: 'running', message })
      })
      const current = this.database.getBilibiliAccount(userId)
      this.save(userId, outcome.state, { accountId: current?.accountId || 'bilibili', name: current?.name || 'B 站账号' })
      this.database.updateBilibiliPublication(userId, publication.id, {
        status: outcome.result.status === 'draft' ? 'draft' : outcome.result.status === 'published' ? 'published' : 'uncertain',
        message: outcome.result.message,
        url: outcome.result.url,
        remoteId: outcome.result.remoteId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failedBeforeSubmit = error instanceof ApiError || message.includes('未找到「发布」')
      this.database.updateBilibiliPublication(userId, publication.id, {
        status: failedBeforeSubmit ? 'failed' : 'uncertain',
        message: failedBeforeSubmit ? message : `${message}；请到 B 站创作中心确认结果，避免重复发布`,
      })
    }
  }

  async resolve(userId: string, id: string, input: BilibiliResolveInput): Promise<BilibiliPublication> {
    const publication = this.get(userId, id)
    if (input.action === 'not_published') {
      const updated = this.database.resolveBilibiliPublication(userId, id, 'not_published', { status: 'failed', message: '已确认未发布，可以重新提交', url: null, remoteId: publication.remoteId })
      if (!updated) throw new ApiError(409, 'bilibili_locked', '当前记录不能执行此操作')
      return updated
    }
    if (input.action === 'published') {
      const url = input.videoUrl?.trim() || publication.url
      if (!url) throw new ApiError(400, 'bilibili_url', '请填写 B 站公开链接')
      const updated = this.database.resolveBilibiliPublication(userId, id, 'published', { status: 'published', message: '已人工确认发布成功', url, remoteId: publication.remoteId })
      if (!updated) throw new ApiError(409, 'bilibili_locked', '当前记录不能执行此操作')
      return updated
    }
    if (publication.type === 'video' && publication.remoteId) {
      const state = this.state(userId)
      const check = await checkBilibiliVideoStatus(bilibiliCookies(state), publication.remoteId)
      const status = check.state === 'published' ? 'published' : check.state === 'missing' ? 'failed' : 'reviewing'
      const updated = this.database.updateBilibiliPublication(userId, id, {
        status,
        message: check.message,
        url: check.state === 'published' ? publication.url : publication.url,
      })
      if (!updated) throw notFound('B 站发布记录不存在')
      return updated
    }
    throw new ApiError(400, 'bilibili_check', '图文发布结果需要在 B 站创作中心人工核实')
  }
}
