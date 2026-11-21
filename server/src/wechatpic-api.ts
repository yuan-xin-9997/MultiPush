import { ApiError } from './errors'
import type { WechatpicPublication } from '../../shared/types'

/**
 * Official WeChat API driver for 公众号贴图 (图片消息, `article_type: newspic`).
 *
 * Unlike the QR-login browser flow in `wechat-browser.ts`, this talks to
 * `api.weixin.qq.com` with an AppID/AppSecret pair. Personal accounts can
 * create sticker drafts this way; the final publish step stays manual in the
 * WeChat backend because `freepublish` requires a verified account.
 */

export interface WechatStickerCredentials {
  appId: string
  appSecret: string
}

export interface WechatStickerIdentity {
  accountId: string
  name: string
}

export interface StickerImage {
  name: string
  mimeType: string
  buffer: Buffer
}

export interface StickerDraft {
  title: string
  body: string
  images: StickerImage[]
}

export interface WechatStickerDriver {
  checkSession(credentials: WechatStickerCredentials): Promise<{ identity: WechatStickerIdentity }>
  publish(credentials: WechatStickerCredentials, draft: StickerDraft, progress: (value: Partial<Pick<WechatpicPublication, 'message' | 'remoteId'>>) => void): Promise<{ status: 'draft'; remoteId: string; message: string }>
  deleteDraft(credentials: WechatStickerCredentials, remoteId: string): Promise<{ message: string; remoteDeleted: boolean }>
}

const API = 'https://api.weixin.qq.com/cgi-bin'
const TIMEOUT_MS = 30_000
const TOKEN_MARGIN_MS = 300_000
/** Official permanent-material limits for images. */
export const STICKER_IMAGE_MAX_BYTES = 10 * 1024 * 1024

type Json = Record<string, unknown>

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function errcode(payload: Json): number {
  const code = payload.errcode
  return typeof code === 'number' ? code : 0
}

function errmsg(payload: Json): string {
  const message = payload.errmsg
  return typeof message === 'string' ? message : ''
}

function toApiError(payload: Json, fallbackCode: string, fallbackMessage: string): ApiError {
  const code = errcode(payload)
  const message = errmsg(payload)
  if (code === 40164 || /not in whitelist|无效.*IP|ip.*whitelist/i.test(message)) {
    const ip = /invalid ip ([0-9a-fA-F:.]+)/.exec(message)?.[1]
    return new ApiError(409, 'wechatpic_ip_not_allowed', `本机出口 IP 不在公众号 IP 白名单${ip ? `（当前 IP：${ip}）` : ''}。请在微信开发者平台「我的业务 → 公众号/服务号 → 基础信息 → 开发密钥 → API IP 白名单」添加后重试。${message ? `（微信返回：${message}）` : ''}`)
  }
  if (code === 40001 || code === 40013 || code === 40125 || code === 41002 || code === 41004) {
    return new ApiError(409, 'wechatpic_auth_failed', 'AppID 或 AppSecret 无效，请核对后重新连接')
  }
  if (code === 48001) {
    return new ApiError(409, 'wechatpic_unauthorized', '该公众号没有调用此接口的权限，请在微信开发者平台「我的业务 → 公众号/服务号 → 接口管理 → 接口权限与额度」确认接口权限')
  }
  if (code === 45009) {
    return new ApiError(429, 'wechatpic_rate_limited', '调用超过微信接口频率限制，请稍后再试')
  }
  return new ApiError(502, fallbackCode, `${fallbackMessage}${message ? `（微信返回：${code ? `${code} ` : ''}${message}）` : ''}`)
}

/** Wrap fetch failures (network, DNS, timeout) into a stable ApiError. */
async function requestJson(url: string, init: RequestInit, unreachableCode: string): Promise<Json> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    throw new ApiError(502, unreachableCode, `无法连接微信接口：${error instanceof Error ? error.message : '网络错误'}`)
  }
  const text = await response.text()
  let payload: unknown = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = null }
  if (!object(payload) && text) {
    throw new ApiError(502, 'wechatpic_bad_response', '微信接口返回了无法解析的内容，请稍后重试')
  }
  return object(payload)
}

interface CachedToken {
  token: string
  expiresAt: number
}

export class WechatStickerApiClient {
  private readonly tokens = new Map<string, CachedToken>()

  private async accessToken(credentials: WechatStickerCredentials): Promise<string> {    const cached = this.tokens.get(credentials.appId)
    if (cached && cached.expiresAt > Date.now() + TOKEN_MARGIN_MS) return cached.token
    const url = `${API}/token?grant_type=client_credential&appid=${encodeURIComponent(credentials.appId)}&secret=${encodeURIComponent(credentials.appSecret)}`
    const payload = await requestJson(url, { method: 'GET' }, 'wechatpic_unreachable')
    if (errcode(payload)) throw toApiError(payload, 'wechatpic_token_failed', '获取微信接口凭证失败')
    const token = typeof payload.access_token === 'string' ? payload.access_token : ''
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 7200
    if (!token) throw new ApiError(502, 'wechatpic_token_failed', '微信没有返回有效凭证，请稍后重试')
    this.tokens.set(credentials.appId, { token, expiresAt: Date.now() + expiresIn * 1000 })
    return token
  }

  /** Prove the credentials by fetching a token; throws on auth/IP errors. */
  async verifyToken(credentials: WechatStickerCredentials): Promise<void> {
    await this.accessToken(credentials)
  }

  private async post<T extends Json>(credentials: WechatStickerCredentials, path: string, body: unknown, fallbackCode: string, fallbackMessage: string, query = '', unreachableCode = 'wechatpic_unreachable'): Promise<T> {
    const token = await this.accessToken(credentials)
    const payload = await requestJson(`${API}${path}?access_token=${encodeURIComponent(token)}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, unreachableCode)
    if (errcode(payload)) throw toApiError(payload, fallbackCode, fallbackMessage)
    return payload as T
  }

  /** Upload one image as a permanent material; returns its media_id. */
  async uploadImage(credentials: WechatStickerCredentials, image: StickerImage): Promise<string> {
    const token = await this.accessToken(credentials)
    const form = new FormData()
    form.append('media', new Blob([new Uint8Array(image.buffer)], { type: image.mimeType }), image.name)
    let response: Response
    try {
      response = await fetch(`${API}/material/add_material?access_token=${encodeURIComponent(token)}&type=image`, { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      throw new ApiError(502, 'wechatpic_unreachable', `无法连接微信接口：${error instanceof Error ? error.message : '网络错误'}`)
    }
    const text = await response.text()
    let payload: unknown = null
    try { payload = text ? JSON.parse(text) : null } catch { payload = null }
    const json = object(payload)
    if (errcode(json)) throw toApiError(json, 'wechatpic_upload_failed', '上传贴图图片到微信失败')
    const mediaId = typeof json.media_id === 'string' ? json.media_id : ''
    if (!mediaId) throw new ApiError(502, 'wechatpic_upload_unverified', '微信没有返回图片素材 ID，已停止创建草稿，请检查草稿箱避免重复')
    return mediaId
  }

  async createDraft(credentials: WechatStickerCredentials, draft: { title: string; body: string; mediaIds: string[] }): Promise<string> {
    // A network failure here leaves "draft created?" unknown, so the caller
    // treats this code as an uncertain result instead of a clean failure.
    const payload = await this.post<{ media_id?: unknown }>(credentials, '/draft/add', {
      articles: [{
        article_type: 'newspic',
        title: draft.title,
        content: draft.body,
        need_open_comment: 0,
        image_info: { image_list: draft.mediaIds.map((image_media_id) => ({ image_media_id })) },
      }],
    }, 'wechatpic_draft_failed', '创建贴图草稿失败', '', 'wechatpic_result_uncertain')
    const mediaId = typeof payload.media_id === 'string' ? payload.media_id : ''
    if (!mediaId) throw new ApiError(502, 'wechatpic_draft_unverified', '微信没有返回草稿编号，请到公众号后台检查草稿箱，避免重复创建')
    return mediaId
  }

  /** Read the draft back; a missing draft maps to `null` instead of throwing. */
  async getDraft(credentials: WechatStickerCredentials, mediaId: string): Promise<{ found: boolean; title: string; imageCount: number | null } | null> {
    const token = await this.accessToken(credentials)
    const payload = await requestJson(`${API}/draft/get?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_id: mediaId }),
    }, 'wechatpic_unreachable')
    const code = errcode(payload)
    if (code) {
      // 40007 invalid media_id: the draft was published (WeChat removes
      // published stickers from the draft box) or already deleted.
      if (code === 40007) return null
      throw toApiError(payload, 'wechatpic_verify_failed', '读取贴图草稿失败')
    }
    const newsItem = Array.isArray(payload.news_item) ? payload.news_item.map(object) : []
    const first = newsItem[0] ?? {}
    const imageInfo = object(first.image_info)
    const imageList = Array.isArray(imageInfo.image_list) ? imageInfo.image_list : null
    return {
      found: newsItem.length > 0,
      title: typeof first.title === 'string' ? first.title : '',
      imageCount: imageList ? imageList.length : null,
    }
  }

  /** Delete a draft; a missing draft (published or already gone) maps to `missing`. */
  async deleteDraft(credentials: WechatStickerCredentials, mediaId: string): Promise<'deleted' | 'missing'> {
    const token = await this.accessToken(credentials)
    const payload = await requestJson(`${API}/draft/delete?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_id: mediaId }),
    }, 'wechatpic_unreachable')
    const code = errcode(payload)
    if (code && code !== 40007) throw toApiError(payload, 'wechatpic_draft_delete_failed', '删除贴图草稿失败')
    return code === 40007 ? 'missing' : 'deleted'
  }

  async accountBasicInfo(credentials: WechatStickerCredentials): Promise<{ nickname: string } | null> {
    let payload: Json
    try {
      const token = await this.accessToken(credentials)
      payload = await requestJson(`${API}/account/getaccountbasicinfo?access_token=${encodeURIComponent(token)}`, { method: 'POST' }, 'wechatpic_unreachable')
    } catch {
      // Basic info is cosmetic; a permission gap or a hiccup must not block the
      // connection once the token itself has been verified.
      return null
    }
    if (errcode(payload)) return null
    const nickname = typeof payload.nickname === 'string' ? payload.nickname.trim() : ''
    return nickname ? { nickname } : null
  }
}

export class WechatStickerApiDriver implements WechatStickerDriver {
  private readonly client = new WechatStickerApiClient()

  async checkSession(credentials: WechatStickerCredentials): Promise<{ identity: WechatStickerIdentity }> {
    // The token fetch proves the credentials; basic info only names the account.
    await this.client.verifyToken(credentials)
    const info = await this.client.accountBasicInfo(credentials).catch(() => null)
    return { identity: { accountId: credentials.appId, name: info?.nickname || credentials.appId } }
  }

  async publish(credentials: WechatStickerCredentials, draft: StickerDraft, progress: Parameters<WechatStickerDriver['publish']>[2]) {
    const mediaIds: string[] = []
    for (const [index, image] of draft.images.entries()) {
      progress({ message: `正在上传贴图图片 ${index + 1}/${draft.images.length}` })
      mediaIds.push(await this.client.uploadImage(credentials, image))
    }
    progress({ message: '正在创建贴图草稿' })
    const remoteId = await this.client.createDraft(credentials, { title: draft.title, body: draft.body, mediaIds })
    progress({ message: '正在核对贴图草稿', remoteId })
    const verify = await this.client.getDraft(credentials, remoteId).catch(() => null)
    if (verify && verify.found && verify.title && verify.title !== draft.title) {
      throw new ApiError(502, 'wechatpic_verify_failed', `贴图草稿标题不一致（草稿：${verify.title}），请到公众号后台核对`)
    }
    if (verify && verify.imageCount !== null && verify.imageCount !== draft.images.length) {
      throw new ApiError(502, 'wechatpic_verify_failed', `贴图草稿图片数量不一致（草稿 ${verify.imageCount} 张 / 预期 ${draft.images.length} 张），请到公众号后台核对`)
    }
    return { status: 'draft' as const, remoteId, message: '已创建公众号贴图草稿，请在公众号后台手动发表' }
  }

  async deleteDraft(credentials: WechatStickerCredentials, remoteId: string) {
    const result = await this.client.deleteDraft(credentials, remoteId)
    return { message: result === 'missing' ? '草稿已不存在（可能已发表或已删除），已清理本地发布记录' : '已删除公众号贴图草稿', remoteDeleted: result === 'deleted' }
  }
}
