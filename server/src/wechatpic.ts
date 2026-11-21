import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PublicationDeletion, WechatpicAccount, WechatpicConnectInput, WechatpicPublication, WechatpicPublishInput } from '../../shared/types'
import { getCaptionBody } from '../../shared/render-workbench'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { UPLOAD_FILENAME_PATTERN } from './upload'
import { decryptPublisherSecret, encryptPublisherSecret, loadPublisherKey } from './publisher-session'
import { STICKER_IMAGE_MAX_BYTES, type StickerDraft, type StickerImage, type WechatStickerCredentials, type WechatStickerDriver } from './wechatpic-api'

const TTL = 5 * 60_000
const MAX_IMAGES = 20
const MAX_BODY_CHARS = 20_000
/** 永久图片素材仅支持 JPG / PNG（10 MB）。 */
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png']
const now = () => new Date().toISOString()

export class WechatpicService {
  private readonly key: Buffer
  private readonly active = new Set<string>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly checks = new Map<string, Promise<WechatpicAccount>>()
  private closed = false

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly driver: WechatStickerDriver,
  ) {
    this.key = loadPublisherKey(config.dataDir, 'wechatpic')
  }

  private idle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'wechatpic_unavailable', '公众号贴图服务正在停止，请稍后重试')
    if (this.active.has(userId)) throw new ApiError(409, 'wechatpic_busy', '公众号贴图操作正在进行，请等待完成')
  }

  private credentials(userId: string): WechatStickerCredentials {
    const account = this.database.getWechatpicAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'wechatpic_auth_failed', '请先在系统中连接公众号（AppID / AppSecret）')
    try {
      const credentials = decryptPublisherSecret<WechatStickerCredentials>(account.encryptedCredentials, this.key, userId)
      if (!credentials.appId || !credentials.appSecret) throw new Error('invalid credentials')
      return credentials
    } catch {
      this.database.saveWechatpicAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'wechatpic_auth_failed', '公众号连接信息无法恢复，请重新输入 AppID 和 AppSecret')
    }
  }

  private save(userId: string, credentials: WechatStickerCredentials, identity: { accountId: string; name: string }): void {
    if (this.closed) return
    this.database.saveWechatpicAccount(userId, {
      encryptedCredentials: encryptPublisherSecret(credentials, this.key, userId),
      appId: credentials.appId,
      name: identity.name,
      status: 'connected',
      checkedAt: now(),
    })
  }

  async account(userId: string): Promise<WechatpicAccount> {
    const current = this.database.getWechatpicAccount(userId)
    if (!current) return { status: 'disconnected', name: null, appId: null, checkedAt: null }
    const view = { status: current.status, name: current.name, appId: current.appId, checkedAt: current.checkedAt }
    if (current.status === 'expired' || this.active.has(userId) || Date.now() - Date.parse(current.checkedAt) < TTL) return view
    if (this.checks.has(userId)) return this.checks.get(userId)!
    const check = (async (): Promise<WechatpicAccount> => {
      try {
        const credentials = this.credentials(userId)
        const result = await this.driver.checkSession(credentials)
        const latest = this.database.getWechatpicAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, appId: null, checkedAt: null }
        if (latest.encryptedCredentials !== current.encryptedCredentials) return { status: latest.status, name: latest.name, appId: latest.appId, checkedAt: latest.checkedAt }
        this.save(userId, credentials, result.identity)
        return { status: 'connected', name: result.identity.name, appId: credentials.appId, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'wechatpic_auth_failed' && this.database.getWechatpicAccount(userId)?.encryptedCredentials === current.encryptedCredentials) {
          this.database.saveWechatpicAccount(userId, { ...current, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, appId: current.appId, checkedAt: now() }
        }
        throw error
      }
    })().finally(() => this.checks.delete(userId))
    this.checks.set(userId, check)
    return check
  }

  async connect(userId: string, input: WechatpicConnectInput): Promise<WechatpicAccount> {
    this.idle(userId)
    const credentials: WechatStickerCredentials = { appId: input.appId.trim(), appSecret: input.appSecret.trim() }
    this.active.add(userId)
    try {
      const result = await this.driver.checkSession(credentials)
      this.save(userId, credentials, result.identity)
      return { status: 'connected', name: result.identity.name, appId: credentials.appId, checkedAt: now() }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'wechatpic_auth_failed') {
        const account = this.database.getWechatpicAccount(userId)
        if (account) this.database.saveWechatpicAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      }
      throw error
    } finally {
      this.active.delete(userId)
    }
  }

  async disconnect(userId: string): Promise<void> {
    this.idle(userId)
    this.active.add(userId)
    try {
      this.database.deleteWechatpicAccount(userId)
    } finally { this.active.delete(userId) }
  }

  /** Build the sticker payload from the saved wechatpic render. */
  private async sticker(userId: string, input: WechatpicPublishInput, baseUrl?: string): Promise<StickerDraft> {
    const record = this.database.getRender(userId, input.renderId)
    const render = record?.results.find((item) => item.platform === 'wechatpic')
    if (!record || !render) throw notFound('公众号贴图排版记录不存在，请先生成贴图排版')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'wechatpic_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'wechatpic_render_stale', '原文已修改，请重新生成公众号贴图排版后再发布')
    const title = render.title.trim()
    if (!title || Array.from(title).length > 32) throw new ApiError(400, 'wechatpic_title_invalid', '贴图标题需要 1–32 个字')
    const body = getCaptionBody(render).trim()
    if (!body) throw new ApiError(400, 'wechatpic_body_invalid', '请先填写贴图配文（图片消息正文必填）')
    if (Array.from(body).length > MAX_BODY_CHARS) throw new ApiError(400, 'wechatpic_body_invalid', '贴图配文不能超过 2 万字')
    if (render.videos.length) throw new ApiError(400, 'wechatpic_media_unsupported', '贴图仅支持图片，请先移除视频素材')
    const imageUrls = render.assets.filter((asset) => asset.kind === 'image').map((asset) => asset.url).slice(0, MAX_IMAGES)
    if (!imageUrls.length) throw new ApiError(400, 'wechatpic_image_required', '贴图至少需要 1 张正文图片')
    const allowedOrigin = this.config.publicBaseUrl || baseUrl
    const images: StickerImage[] = []
    for (const src of imageUrls) {
      let url: URL
      try { url = new URL(src, 'https://multipush.invalid') } catch { throw new ApiError(400, 'wechatpic_image_invalid', '贴图包含无效图片地址，请重新生成排版') }
      const ownedOrigin = url.origin === 'https://multipush.invalid' || (!!allowedOrigin && url.origin === new URL(allowedOrigin).origin)
      const filename = ownedOrigin && url.pathname.startsWith('/uploads/') ? url.pathname.slice('/uploads/'.length) : ''
      if (!filename) throw new ApiError(400, 'wechatpic_image_invalid', `贴图包含无法读取的图片地址，请使用本站上传的图片后重新生成排版`)
      if (!UPLOAD_FILENAME_PATTERN.test(filename)) throw notFound('图片路径无效')
      const media = this.database.getMediaByFilename(userId, filename)
      if (!media) throw notFound('贴图图片不存在或无权访问，请在编辑器重新上传')
      images.push(await this.imageFile(userId, media.id))
    }
    return { title, body, images }
  }

  private async imageFile(userId: string, mediaId: string): Promise<StickerImage> {
    const media = this.database.getMedia(userId, mediaId)
    if (!media) throw notFound('图片不存在或无权访问，请重新上传')
    if (media.kind !== 'image' || !IMAGE_MIME_TYPES.includes(media.mimeType)) {
      throw new ApiError(400, 'wechatpic_image_type', '贴图图片请使用 JPG 或 PNG（微信永久素材不支持 GIF），请转换格式后重新上传')
    }
    if (media.size > STICKER_IMAGE_MAX_BYTES) throw new ApiError(400, 'wechatpic_image_size', '贴图单张图片不能超过 10 MB')
    if (!UPLOAD_FILENAME_PATTERN.test(media.filename)) throw notFound('图片路径无效')
    try {
      const buffer = await readFile(path.join(this.config.uploadsDir, media.filename))
      if (buffer.length > STICKER_IMAGE_MAX_BYTES) throw new ApiError(400, 'wechatpic_image_size', '贴图单张图片不能超过 10 MB')
      return { name: media.filename, mimeType: media.mimeType, buffer }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(400, 'wechatpic_image_missing', '图片文件已丢失，请重新上传')
    }
  }

  list(userId: string): WechatpicPublication[] { return this.database.listWechatpicPublications(userId) }

  get(userId: string, id: string): WechatpicPublication {
    const publication = this.database.getWechatpicPublication(userId, id)
    if (!publication) throw notFound('贴图发布记录不存在')
    return publication
  }

  async remove(userId: string, id: string): Promise<PublicationDeletion> {
    this.idle(userId)
    const current = this.get(userId, id)
    if (current.status === 'running') throw new ApiError(409, 'wechatpic_delete_busy', '贴图任务正在处理，请等待完成后再删除')
    if (current.status === 'published') throw new ApiError(409, 'wechatpic_delete_published', '已发表的贴图记录不能删除；如需删除请到公众号后台操作')
    if (current.status === 'uncertain') throw new ApiError(409, 'wechatpic_delete_uncertain', '请先核实这条贴图任务的结果，再删除发布记录')
    this.active.add(userId)
    try {
      let remoteDeleted = false
      if (current.remoteId) {
        try {
          const result = await this.driver.deleteDraft(this.credentials(userId), current.remoteId)
          remoteDeleted = result.remoteDeleted
        } catch (error) {
          this.expire(userId, error)
          if (current.status === 'draft') throw error
        }
      }
      if (!this.database.deleteWechatpicPublication(userId, id)) throw notFound('贴图发布记录不存在')
      return { ok: true, remoteDeleted }
    } finally { this.active.delete(userId) }
  }

  async publish(userId: string, input: WechatpicPublishInput, baseUrl?: string): Promise<WechatpicPublication> {
    this.idle(userId)
    this.active.add(userId)
    let handedOff = false
    try {
      if (this.database.hasUncertainWechatpicPublication(userId)) throw new ApiError(409, 'wechatpic_result_uncertain', '请先核实或删除结果待确认的任务，再提交新的贴图草稿')
      const credentials = this.credentials(userId)
      const sticker = await this.sticker(userId, input, baseUrl)
      const account = this.database.getWechatpicAccount(userId)
      const hash = createHash('sha256').update(JSON.stringify({ appId: account?.appId ?? credentials.appId, contentId: this.database.getRender(userId, input.renderId)?.contentId, title: sticker.title, body: sticker.body }))
      for (const image of sticker.images) hash.update(image.buffer)
      const idempotencyKey = hash.digest('hex')
      const previous = this.database.findWechatpicPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return previous
      const publication = previous ?? this.database.createWechatpicPublication(userId, { renderId: input.renderId, title: sticker.title, mode: 'draft', idempotencyKey })
      this.database.updateWechatpicPublication(userId, publication.id, { status: 'running', message: '正在上传贴图图片并创建草稿' })
      const task = this.run(userId, publication.id, credentials, sticker)
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
    const account = this.database.getWechatpicAccount(userId)
    if (account && error instanceof ApiError && error.code === 'wechatpic_auth_failed') this.database.saveWechatpicAccount(userId, { ...account, status: 'expired', checkedAt: now() })
  }

  private async run(userId: string, id: string, credentials: WechatStickerCredentials, draft: StickerDraft): Promise<void> {
    let sawRemote = false
    try {
      const result = await this.driver.publish(credentials, draft, (update) => {
        if (update.remoteId) sawRemote = true
        this.database.updateWechatpicPublication(userId, id, update)
      })
      this.database.updateWechatpicPublication(userId, id, { status: result.status, message: result.message, remoteId: result.remoteId })
    } catch (error) {
      this.expire(userId, error)
      const current = this.database.getWechatpicPublication(userId, id)
      const message = error instanceof ApiError ? error.message : '贴图操作中断，结果未确认，请先到公众号后台核对草稿箱，避免重复创建'
      if (sawRemote || current?.remoteId) {
        // The draft exists; only the verification step failed.
        this.database.updateWechatpicPublication(userId, id, { status: 'draft', message: `${message}；草稿可能已创建，请到公众号后台核对` })
        return
      }
      const knownRejection = error instanceof ApiError && [
        'wechatpic_auth_failed',
        'wechatpic_ip_not_allowed',
        'wechatpic_unauthorized',
        'wechatpic_rate_limited',
        'wechatpic_token_failed',
        'wechatpic_rejected',
        'wechatpic_upload_failed',
        'wechatpic_upload_unverified',
        'wechatpic_draft_failed',
        'wechatpic_unreachable',
      ].includes(error.code)
      this.database.updateWechatpicPublication(userId, id, {
        status: knownRejection ? 'failed' : 'uncertain',
        message: knownRejection ? message : `${message}；请核对公众号后台草稿箱后删除本记录再重试`,
      })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.jobs.values(), ...this.checks.values()])
  }
}
