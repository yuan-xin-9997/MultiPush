import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { load } from 'cheerio'
import type { WechatAccount, WechatLogin, WechatPublication, WechatPublishInput } from '../../shared/types'
import type { AppConfig } from './config'
import type { Database } from './db'
import { ApiError, notFound } from './errors'
import { UPLOAD_FILENAME_PATTERN } from './upload'
import type { WechatBrowserDriver, WechatLoginAttempt, WechatStorageState } from './wechat-browser'

const LOGIN_TTL = 5 * 60_000
const CHECK_TTL = 5 * 60_000
const now = () => new Date().toISOString()

// A separate key preserves platform sessions when the application's JWT secret rotates.
export function loadWechatKey(dataDir: string): Buffer {
  const file = path.join(dataDir, '.wechat-session-key')
  try { writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const key = readFileSync(file)
  if (key.length !== 32) throw new Error('Invalid WeChat session encryption key')
  return key
}

export function encryptWechatSession(state: WechatStorageState, key: Buffer, userId: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(userId))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function decryptWechatSession(value: string, key: Buffer, userId: string): WechatStorageState {
  const buffer = Buffer.from(value, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12))
  decipher.setAAD(Buffer.from(userId))
  decipher.setAuthTag(buffer.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8')) as WechatStorageState
}

type LoginEntry = { userId: string; value: WechatLogin; attempt: WechatLoginAttempt; timer: ReturnType<typeof setTimeout>; polling?: Promise<WechatLogin> }
type Article = Parameters<WechatBrowserDriver['publish']>[1]

export class WechatService {
  private readonly key: Buffer
  private readonly logins = new Map<string, LoginEntry>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly activeUsers = new Set<string>()
  private readonly startingLogins = new Set<string>()
  private readonly checks = new Map<string, Promise<WechatAccount>>()
  private readonly qrCodes = new Map<string, string>()
  private closed = false

  constructor(private readonly database: Database, private readonly config: AppConfig, private readonly driver: WechatBrowserDriver) {
    this.key = loadWechatKey(config.dataDir)
  }

  private assertIdle(userId: string): void {
    if (this.closed) throw new ApiError(503, 'wechat_unavailable', '公众号服务正在停止，请稍后重试')
    if (this.activeUsers.has(userId) || this.startingLogins.has(userId)) throw new ApiError(409, 'wechat_busy', '公众号操作正在进行，请等待完成')
  }

  private readState(userId: string): WechatStorageState {
    const account = this.database.getWechatAccount(userId)
    if (!account || account.status === 'expired') throw new ApiError(409, 'wechat_session_expired', '请先扫码登录微信公众号')
    try { return decryptWechatSession(account.encryptedSession, this.key, userId) }
    catch {
      this.database.saveWechatAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      throw new ApiError(409, 'wechat_session_expired', '公众号会话无法恢复，请重新扫码登录')
    }
  }

  private saveState(userId: string, state: WechatStorageState, name?: string): void {
    if (this.closed) return
    this.database.saveWechatAccount(userId, {
      encryptedSession: encryptWechatSession(state, this.key, userId),
      name: name ?? this.database.getWechatAccount(userId)?.name ?? null,
      status: 'connected', checkedAt: now(),
    })
  }

  async account(userId: string): Promise<WechatAccount> {
    const current = this.database.getWechatAccount(userId)
    if (!current) return { status: 'disconnected', name: null, checkedAt: null }
    if (current.status === 'expired' || this.activeUsers.has(userId) || this.startingLogins.has(userId) || Date.now() - Date.parse(current.checkedAt) < CHECK_TTL) {
      return { status: current.status, name: current.name, checkedAt: current.checkedAt }
    }
    const pending = this.checks.get(userId)
    if (pending) return pending
    const check = (async (): Promise<WechatAccount> => {
      try {
        const checked = await this.driver.checkSession(this.readState(userId))
        // A disconnect during a read-only status check must not restore deleted credentials.
        const latest = this.database.getWechatAccount(userId)
        if (!latest) return { status: 'disconnected', name: null, checkedAt: null }
        if (latest.encryptedSession !== current.encryptedSession) return { status: latest.status, name: latest.name, checkedAt: latest.checkedAt }
        this.saveState(userId, checked.state, checked.name)
        return { status: 'connected', name: checked.name, checkedAt: now() }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'wechat_session_expired' && this.database.getWechatAccount(userId)?.encryptedSession === current.encryptedSession) {
          this.database.saveWechatAccount(userId, { ...current, status: 'expired', checkedAt: now() })
          return { status: 'expired', name: current.name, checkedAt: now() }
        }
        throw error
      }
    })().finally(() => this.checks.delete(userId))
    this.checks.set(userId, check)
    return check
  }

  async startLogin(userId: string): Promise<WechatLogin> {
    this.assertIdle(userId)
    this.startingLogins.add(userId)
    try {
      for (const [id, entry] of this.logins) {
        if (entry.userId !== userId) continue
        this.logins.delete(id)
        clearTimeout(entry.timer)
        await entry.attempt.close().catch(() => {})
      }
      const pendingLogins = [...this.logins.values()].filter((entry) => ['waiting', 'scanned'].includes(entry.value.status)).length
      if (pendingLogins + this.startingLogins.size > 8) throw new ApiError(503, 'wechat_busy', '当前扫码登录较多，请稍后重试')
      const attempt = await this.driver.beginLogin()
      const id = randomUUID()
      const value: WechatLogin = { id, status: 'waiting', qrCode: null, message: '请用管理员微信扫码，并在手机上选择公众号', expiresAt: new Date(Date.now() + LOGIN_TTL).toISOString() }
      const timer = setTimeout(() => {
        const entry = this.logins.get(id)
        if (!entry) return
        entry.value = { ...entry.value, status: 'expired', qrCode: null, message: '二维码已过期，请重新登录' }
        void attempt.close().catch(() => {})
        this.logins.delete(id)
      }, LOGIN_TTL)
      timer.unref()
      this.logins.set(id, { userId, value, attempt, timer })
      return await this.pollLogin(userId, id)
    } finally { this.startingLogins.delete(userId) }
  }

  async pollLogin(userId: string, id: string): Promise<WechatLogin> {
    const entry = this.logins.get(id)
    if (!entry || entry.userId !== userId) throw notFound('登录请求不存在或已过期，请重新扫码')
    if (!['waiting', 'scanned'].includes(entry.value.status)) return entry.value
    if (entry.polling) return entry.polling
    entry.polling = (async () => {
      try {
        const result = await entry.attempt.poll()
        if (this.logins.get(id) !== entry) throw notFound('登录已取消，请重新扫码')
        entry.value = { ...entry.value, status: result.status, qrCode: result.qrCode, message: result.message }
        if (result.status === 'connected') {
          if (!result.state) throw new ApiError(502, 'wechat_login_failed', '微信没有返回有效会话，请重新扫码')
          this.saveState(userId, result.state, result.name)
        }
        if (!['waiting', 'scanned'].includes(result.status)) await entry.attempt.close()
      } catch (error) {
        entry.value = { ...entry.value, status: 'failed', qrCode: null, message: error instanceof ApiError ? error.message : '读取登录状态失败，请刷新二维码重试' }
        await entry.attempt.close().catch(() => {})
      }
      return entry.value
    })().finally(() => { entry.polling = undefined })
    return entry.polling
  }

  async disconnect(userId: string): Promise<void> {
    this.assertIdle(userId)
    for (const [id, entry] of this.logins) {
      if (entry.userId !== userId) continue
      this.logins.delete(id)
      clearTimeout(entry.timer)
      await entry.attempt.close().catch(() => {})
    }
    this.database.deleteWechatAccount(userId)
  }

  private async mediaFile(userId: string, mediaId: string): Promise<Article['cover']> {
    const media = this.database.getMedia(userId, mediaId)
    if (!media) throw notFound('图片不存在或无权访问，请重新上传')
    if (media.kind !== 'image' || !['image/jpeg', 'image/png', 'image/gif'].includes(media.mimeType)) {
      throw new ApiError(400, 'wechat_image_type', '公众号图片请使用 JPG、PNG 或 GIF 格式')
    }
    if (media.size > 10 * 1024 * 1024) throw new ApiError(400, 'wechat_image_size', '公众号图片不能超过 10 MB')
    if (!UPLOAD_FILENAME_PATTERN.test(media.filename)) throw notFound('图片路径无效')
    try {
      const buffer = await readFile(path.join(this.config.uploadsDir, media.filename))
      if (buffer.length > 10 * 1024 * 1024) throw new ApiError(400, 'wechat_image_size', '公众号图片不能超过 10 MB')
      return { name: media.filename, mimeType: media.mimeType, buffer }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(400, 'wechat_image_missing', '图片文件已丢失，请重新上传')
    }
  }

  private async article(userId: string, input: WechatPublishInput, baseUrl?: string): Promise<Article> {
    const record = this.database.getRender(userId, input.renderId)
    const render = record?.results.find((item) => item.platform === 'wechat')
    if (!record || !render) throw notFound('公众号渲染记录不存在')
    const content = this.database.getContentDetail(userId, record.contentId)
    if (!content || content.deletedAt) throw new ApiError(400, 'wechat_content_deleted', '原文已删除，请先恢复内容')
    if (render.sourceUpdatedAt && render.sourceUpdatedAt !== content.updatedAt) throw new ApiError(409, 'wechat_render_stale', '原文已修改，请重新生成公众号排版后发布')
    const title = render.title.trim()
    const $ = load(render.html, {}, false)
    if (!title || Array.from(title).length > 64) throw new ApiError(400, 'wechat_title_invalid', '公众号标题需要 1–64 个字')
    if (!$('*').text().trim()) throw new ApiError(400, 'wechat_body_empty', '请先填写公众号正文')
    if (Buffer.byteLength(render.html) > 1024 * 1024) throw new ApiError(400, 'wechat_body_size', '公众号正文 HTML 不能超过 1 MB')
    if ($('video,audio,iframe').length || render.videos.length) throw new ApiError(400, 'wechat_video_unsupported', '请先移除视频或音频；当前自动发布支持图文文章')
    if ($('img').length > 100) throw new ApiError(400, 'wechat_image_count', '公众号正文最多支持 100 张图片')
    const images: Article['images'] = new Map()
    for (const element of $('img').toArray()) {
      const src = $(element).attr('src') || ''
      $(element).removeAttr('srcset')
      if (images.has(src)) continue
      let url: URL
      try { url = new URL(src, 'https://multipush.invalid') } catch { throw new ApiError(400, 'wechat_image_invalid', '正文包含无效图片地址，请重新上传图片') }
      if (url.protocol === 'https:' && ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'mmecoa.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) continue
      // Read only owned uploads; never make server-side requests to arbitrary image URLs.
      const allowedOrigin = this.config.publicBaseUrl || baseUrl
      const ownedOrigin = url.origin === 'https://multipush.invalid' || (allowedOrigin && url.origin === new URL(allowedOrigin).origin)
      const filename = ownedOrigin && url.pathname.startsWith('/uploads/') ? url.pathname.slice('/uploads/'.length) : ''
      if (!UPLOAD_FILENAME_PATTERN.test(filename)) throw new ApiError(400, 'wechat_external_image', '正文含外链图片，请在编辑器上传该图片后重新渲染；微信会过滤外链图片')
      const media = this.database.getMediaByFilename(userId, filename)
      if (!media) throw notFound('正文图片不存在或无权访问，请在编辑器重新上传')
      images.set(src, await this.mediaFile(userId, media.id))
    }
    return { title, html: $.html(), author: input.author ?? Array.from(render.authorName ?? '').slice(0, 8).join(''), digest: input.digest ?? Array.from(render.meta.summary ?? '').slice(0, 120).join(''), cover: await this.mediaFile(userId, input.coverMediaId), images }
  }

  private withQr(publication: WechatPublication): WechatPublication {
    return { ...publication, qrCode: this.qrCodes.get(publication.id) ?? null }
  }

  list(userId: string): WechatPublication[] { return this.database.listWechatPublications(userId).map((item) => this.withQr(item)) }

  get(userId: string, id: string): WechatPublication {
    const publication = this.database.getWechatPublication(userId, id)
    if (!publication) throw notFound('发布记录不存在')
    return this.withQr(publication)
  }

  async publish(userId: string, input: WechatPublishInput, baseUrl?: string): Promise<WechatPublication> {
    this.assertIdle(userId)
    if ([...this.logins.values()].some((entry) => entry.userId === userId && ['waiting', 'scanned'].includes(entry.value.status))) {
      throw new ApiError(409, 'wechat_busy', '请先完成公众号登录')
    }
    this.activeUsers.add(userId)
    let handedOff = false
    try {
      const checked = await this.driver.checkSession(this.readState(userId))
      this.saveState(userId, checked.state, checked.name)
      const article = await this.article(userId, input, baseUrl)
      const identity = checked.state.cookies.filter((cookie) => ['bizuin', 'data_bizuin', 'slave_user'].includes(cookie.name)).map((cookie) => `${cookie.name}=${cookie.value}`).sort()
      const idempotencyKey = createHash('sha256').update(JSON.stringify({ identity: identity.length ? identity : checked.name, contentId: this.database.getRender(userId, input.renderId)?.contentId, mode: input.mode, author: article.author, digest: article.digest, title: article.title, html: article.html })).update(article.cover.buffer).digest('hex')
      const previous = this.database.findWechatPublication(userId, idempotencyKey)
      if (previous && previous.status !== 'failed') return this.withQr(previous)
      const publication = previous ?? this.database.createWechatPublication(userId, { renderId: input.renderId, title: article.title, mode: input.mode, idempotencyKey })
      if (previous?.remoteId) return this.withQr(previous)
      this.database.updateWechatPublication(userId, publication.id, { status: 'running', message: '正在上传图片并创建公众号草稿' })
      const task = this.runPublication(userId, publication.id, checked.state, article, input.mode)
      this.jobs.set(publication.id, task)
      handedOff = true
      void task.finally(() => { this.jobs.delete(publication.id); this.activeUsers.delete(userId); this.qrCodes.delete(publication.id) }).catch(() => {})
      return this.get(userId, publication.id)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'wechat_session_expired') {
        const account = this.database.getWechatAccount(userId)
        if (account) this.database.saveWechatAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      }
      throw error
    } finally { if (!handedOff) this.activeUsers.delete(userId) }
  }

  private async runPublication(userId: string, id: string, state: WechatStorageState, article: Article, mode: WechatPublishInput['mode']): Promise<void> {
    try {
      const result = await this.driver.publish(state, article, mode, (update) => {
        const { qrCode, ...values } = update
        if (qrCode) this.qrCodes.set(id, qrCode)
        else if (qrCode === null) this.qrCodes.delete(id)
        this.database.updateWechatPublication(userId, id, values)
      })
      this.saveState(userId, result.state)
      this.database.updateWechatPublication(userId, id, { status: result.status, message: result.message, url: result.url, remoteId: result.remoteId })
    } catch (error) {
      const account = this.database.getWechatAccount(userId)
      if (error instanceof ApiError && error.code === 'wechat_session_expired' && account) this.database.saveWechatAccount(userId, { ...account, status: 'expired', checkedAt: now() })
      const knownRejection = error instanceof ApiError && ['wechat_session_expired', 'wechat_rejected', 'wechat_preparation_failed', 'wechat_browser_unavailable', 'wechat_publish_not_submitted', 'wechat_notification_unverified'].includes(error.code)
      this.database.updateWechatPublication(userId, id, {
        status: knownRejection ? 'failed' : 'uncertain',
        message: error instanceof ApiError ? error.message : '公众号操作中断，结果未确认。请到微信后台核实草稿与发表记录，避免重复发表。',
      })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const entry of this.logins.values()) { clearTimeout(entry.timer); await entry.attempt.close().catch(() => {}) }
    this.logins.clear()
    await this.driver.close()
    await Promise.allSettled([...this.jobs.values(), ...this.checks.values()])
  }
}
