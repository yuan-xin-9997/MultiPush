import { chromium, type APIResponse, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { load } from 'cheerio'
import type { SspaiPublication } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import type { PublisherImage } from './publisher-image'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'
import { prepareSspaiContent, sspaiEditorContent, sspaiImageUrl, verifySspaiContent } from './sspai-content'

export interface SspaiIdentity { accountId: string; name: string }
export interface SspaiArticle { title: string; html: string; tags: string[]; images: Map<string, PublisherImage>; cover?: PublisherImage }
export interface SspaiLoginAttempt {
  poll(): Promise<{ status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'; qrCode: string | null; message: string; state?: PublisherStorageState; identity?: SspaiIdentity }>
  close(): Promise<void>
}
export interface SspaiDriver {
  beginLogin(): Promise<SspaiLoginAttempt>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: SspaiIdentity }>
  checkPublication(state: PublisherStorageState, remoteId: string, title: string): Promise<{ state: PublisherStorageState; status: 'published' | 'draft' | 'missing' | 'unknown'; url: string | null; message: string }>
  publish(state: PublisherStorageState, article: SspaiArticle, mode: 'draft' | 'publish', progress: (value: Partial<Pick<SspaiPublication, 'message' | 'remoteId' | 'url'>>) => void, resumeId?: string): Promise<{ state: PublisherStorageState; status: 'draft' | 'published'; remoteId: string; url: string; message: string }>
  deleteDraft(state: PublisherStorageState, remoteId: string): Promise<{ state: PublisherStorageState; message: string }>
  close(): Promise<void>
}

const HOME = 'https://sspai.com/'
const LOGIN = 'https://sspai.com/login'
const WRITE = 'https://sspai.com/write'
const API = 'https://sspai.com/api/v1'
const CDN = 'https://cdnfile.sspai.com/'
const QR = 'img.web_qrcode_img, img[src^="/connect/qrcode/"]'
type Data = Record<string, unknown>
function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {} }
const expired = () => new ApiError(409, 'sspai_session_expired', '少数派登录状态已失效，请重新扫码连接')

async function storageToken(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const storage = (globalThis as unknown as { localStorage?: { getItem(key: string): string | null } }).localStorage
    return storage?.getItem('ssToken') ?? null
  }).catch(() => null)
}

export function sspaiPublicationUrl(remoteId: string): string { return `https://sspai.com/post/${remoteId}` }
export function sspaiDraftUrl(remoteId: string): string { return `${WRITE}/${remoteId}` }

export function parseSspaiPublishedId(value: unknown): string | null {
  const match = /^https:\/\/sspai\.com\/post\/(\d{1,20})\/?(?:[?#].*)?$/.exec(String(value))
  return match ? match[1] : null
}

export function sspaiTokenFromState(state: PublisherStorageState): string | null {
  for (const origin of state.origins) {
    if (!/^https?:\/\/sspai\.com$/i.test(origin.origin)) continue
    const token = origin.localStorage.find((item) => item.name === 'ssToken')?.value
    if (token && token.trim()) return token.trim()
  }
  return null
}

function sspaiNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

export async function sspaiData(response: APIResponse, action: string, requireData = true): Promise<Data> {
  if (response.status() === 401) throw expired()
  if (response.status() === 403) throw new ApiError(409, 'sspai_security_check', '少数派要求安全验证或暂时限制了当前请求，请在少数派完成验证后重试')
  if (!/json/i.test(response.headers()['content-type'] || '')) throw new ApiError(502, 'sspai_bad_response', `${action}返回了非接口内容，可能触发了安全验证或网关错误，请稍后重试`)
  const payload = object(await response.json().catch(() => null))
  const code = Number(payload.error ?? (payload as { code?: unknown }).code ?? 0)
  if (code === 3004) throw expired()
  if (!response.ok() || (Number.isFinite(code) && code !== 0)) {
    const message = typeof payload.msg === 'string' && payload.msg.trim() ? payload.msg.trim() : typeof payload.message === 'string' ? payload.message : ''
    throw new ApiError(502, 'sspai_rejected', `${action}失败${message ? `：${message}` : `（HTTP ${response.status()}）`}，请检查少数派账号权限或稍后重试`)
  }
  const data = payload.data
  if (!data || typeof data !== 'object') {
    if (!requireData) return {}
    throw new ApiError(502, 'sspai_bad_response', `${action}未返回有效数据，请稍后重试`)
  }
  return object(data)
}

async function articleInfo(context: BrowserContext, token: string, id: string): Promise<Data | null> {
  const response = await context.request.get(`${API}/matrix/editor/article/single/info/get?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}`, Referer: `${WRITE}/${id}`, 'x-requested-with': 'fetch' },
    timeout: 20_000,
  })
  if (response.status() === 404) return null
  if (!/json/i.test(response.headers()['content-type'] || '')) return null
  const payload = object(await response.json().catch(() => null))
  const code = Number(payload.error ?? 0)
  if (code === 3004 || response.status() === 401) throw expired()
  if (response.status() === 403) throw new ApiError(409, 'sspai_security_check', '少数派要求安全验证或暂时限制了当前请求，请在少数派完成验证后重试')
  if (!response.ok() || (Number.isFinite(code) && code !== 0) || !payload.data) return null
  return object(payload.data)
}

async function uploadImage(context: BrowserContext, token: string, image: PublisherImage): Promise<{ key: string; id: number; url: string }> {
  const cname = image.name.includes('.') ? image.name : `${image.name}.png`
  const ticket = await sspaiData(await context.request.get(`${API}/matrix/editor/attachment/upload/token/get?cname=${encodeURIComponent(cname)}`, {
    headers: { Authorization: `Bearer ${token}`, Referer: WRITE, 'x-requested-with': 'fetch' },
    timeout: 20_000,
  }), '获取少数派图片上传凭证')
  const uploadToken = typeof ticket.token === 'string' ? ticket.token : ''
  const key = typeof ticket.key === 'string' ? ticket.key : ''
  const id = sspaiNumber(ticket.id)
  if (!uploadToken || !key || id === null) throw new ApiError(502, 'sspai_image_upload', '少数派未返回有效的图片上传凭证，已停止发布')
  const uploaded = await context.request.post('https://upload.qiniup.com/', {
    multipart: { file: image, token: uploadToken, key },
    timeout: 30_000,
  })
  if (!uploaded.ok()) throw new ApiError(502, 'sspai_image_upload', `少数派图片上传失败（HTTP ${uploaded.status()}），请稍后重试`)
  const body = object(await uploaded.json().catch(() => null))
  const stored = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : key
  if (!stored) throw new ApiError(502, 'sspai_image_upload', '少数派图片上传未返回素材地址，已停止发布')
  return { key: stored, id, url: `${CDN}${stored}` }
}

export class PlaywrightSspaiDriver implements SspaiDriver {
  private browser: Promise<Browser> | null = null

  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = publisherExecutablePath('sspai')
      if (!executablePath) throw new ApiError(503, 'sspai_browser_unavailable', '服务器未安装可用的 Chrome / Chromium 浏览器')
      this.browser = chromium.launch({ executablePath, headless: true, chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1', args: ['--disable-dev-shm-usage'] }).then(browser => {
        browser.on('disconnected', () => { this.browser = null })
        return browser
      }).catch(() => { this.browser = null; throw new ApiError(503, 'sspai_browser_unavailable', '无法启动少数派浏览器，请检查服务器浏览器配置') })
    }
    const context = await (await this.browser).newContext({ storageState: state, locale: 'zh-CN', viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 })
    context.setDefaultTimeout(20_000)
    return context
  }

  private async token(context: BrowserContext, state?: PublisherStorageState): Promise<string> {
    const fromState = state ? sspaiTokenFromState(state) : null
    if (fromState) return fromState
    const page = await context.newPage()
    try {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      const token = await storageToken(page)
      if (token && token.trim()) return token.trim()
    } catch { /* mapped below */ }
    finally { await page.close().catch(() => {}) }
    throw expired()
  }

  private async identity(context: BrowserContext, token: string): Promise<SspaiIdentity> {
    const user = await sspaiData(await context.request.get(`${API}/user/info/get`, {
      headers: { Authorization: `Bearer ${token}`, Referer: HOME, 'x-requested-with': 'fetch' },
      timeout: 20_000,
    }), '检查少数派登录状态')
    const id = sspaiNumber(user.id)
    const name = [user.nickname, user.name, user.slug].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
    if (id === null) throw expired()
    return { accountId: String(id), name: name || '少数派用户' }
  }

  async beginLogin(): Promise<SspaiLoginAttempt> {
    const context = await this.context(), page = await context.newPage()
    let closed = false, qrCode: string | null = null
    const close = async () => { if (!closed) { closed = true; await context.close().catch(() => {}) } }
    const deadline = Date.now() + 5 * 60_000
    const loadQr = async (): Promise<string | null> => {
      const src = await page.locator(QR).first().getAttribute('src').catch(() => null)
      if (!src) return null
      try {
        const dataUrl = await page.evaluate(`(async () => {
          const response = await fetch(${JSON.stringify(src)}, { credentials: 'include' })
          if (!response.ok) return null
          const blob = await response.blob()
          return await new Promise((resolve) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result)
            reader.readAsDataURL(blob)
          })
        })()`)
        if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) return dataUrl
      } catch { /* screenshot fallback below */ }
      await page.waitForFunction(`(() => { const img = document.querySelector(${JSON.stringify(QR)}); return !!img && img.complete && img.naturalWidth > 0 })()`, null, { timeout: 5_000 }).catch(() => {})
      const image = page.locator(QR).first()
      if (!await image.isVisible().catch(() => false)) return null
      return `data:image/png;base64,${(await image.screenshot({ type: 'png', timeout: 5_000 })).toString('base64')}`
    }
    try {
      const response = await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (response?.status() === 403) throw new ApiError(409, 'sspai_security_check', '少数派登录页要求安全验证，请稍后重试或在少数派解除账号限制')
      // The login form is hydrated by Vue; retry the switch briefly instead of
      // clicking before the WeChat handler exists.
      await page.waitForTimeout(1500)
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await page.locator(QR).first().isVisible().catch(() => false)) break
        const wechat = page.locator('button.btn__login__by__other').first()
        if (await wechat.isVisible().catch(() => false)) await wechat.click({ timeout: 10_000 }).catch(() => {})
        else {
          const label = page.getByText('微信', { exact: false }).first()
          if (await label.isVisible().catch(() => false)) await label.click().catch(() => {})
        }
        await page.waitForTimeout(1_000)
      }
      await page.locator(QR).first().waitFor({ state: 'visible', timeout: 15_000 })
      qrCode = await loadQr()
    } catch (error) {
      await close()
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'sspai_login_unavailable', '无法取得少数派微信登录二维码，请检查服务器网络或稍后重试')
    }
    return {
      close,
      poll: async () => {
        if (closed || Date.now() > deadline) return { status: 'expired', qrCode: null, message: '少数派登录二维码已过期，请重新获取' }
        for (const current of context.pages()) {
          const token = await storageToken(current)
          if (!token || !token.trim()) continue
          try {
            const identity = await this.identity(context, token.trim())
            return { status: 'connected', qrCode: null, message: '少数派已登录，登录状态已保存', state: await context.storageState(), identity }
          } catch (error) {
            if (!(error instanceof ApiError && error.code === 'sspai_session_expired')) throw error
          }
        }
        const text = await page.locator('body').innerText().catch(() => '')
        if (/二维码已失效|二维码已过期/.test(text)) return { status: 'expired', qrCode: null, message: '二维码已失效，请重新获取' }
        const next = await loadQr().catch(() => null)
        if (next) qrCode = next
        const scanned = /扫码成功|已扫码|在手机上确认/.test(text)
        return { status: scanned ? 'scanned' : 'waiting', qrCode, message: scanned ? '请在微信中确认登录少数派' : '请使用微信扫描二维码登录少数派' }
      },
    }
  }

  async checkSession(state: PublisherStorageState) {
    const context = await this.context(state)
    try {
      const token = await this.token(context, state)
      const identity = await this.identity(context, token)
      return { state: await context.storageState(), identity }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'sspai_check_failed', '少数派连接检查未完成，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async checkPublication(state: PublisherStorageState, remoteId: string, title: string) {
    if (!/^\d{1,20}$/.test(remoteId)) throw new ApiError(400, 'sspai_draft_invalid', '远端编号无效，无法自动核实')
    const context = await this.context(state)
    try {
      const token = await this.token(context, state)
      await this.identity(context, token)
      const data = await articleInfo(context, token, remoteId)
      if (!data) return { state: await context.storageState(), status: 'missing' as const, url: null, message: '原少数派文章与草稿均不存在。请确认未发布；确认后再次提交会重新创建' }
      if (String(data.id) !== remoteId || String(data.title_last ?? data.title ?? '') !== title) {
        return { state: await context.storageState(), status: 'unknown' as const, url: null, message: '少数派文章编号或标题已变化，请到少数派后台核对后选择人工核实结果' }
      }
      const type = sspaiNumber(data.type)
      if (type === 5) return { state: await context.storageState(), status: 'published' as const, url: sspaiPublicationUrl(remoteId), message: '已重新核实：少数派确认该文章已发布' }
      if (type === 1 || type === 2) return { state: await context.storageState(), status: 'unknown' as const, url: sspaiDraftUrl(remoteId), message: '少数派文章已进入审核或被编辑锁定，暂不能确认发布状态，请到少数派后台核对' }
      if (type === 4) return { state: await context.storageState(), status: 'draft' as const, url: sspaiDraftUrl(remoteId), message: '少数派仍有这份草稿。请确认未通过其他记录发布，再选择“已核实未发布，允许重试”' }
      return { state: await context.storageState(), status: 'unknown' as const, url: sspaiDraftUrl(remoteId), message: '少数派文章状态无法确认（可能已被推荐、付费锁定或改版），请到少数派后台人工核对' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'sspai_check_failed', '重新核实少数派结果未完成，请稍后重试或人工核实')
    } finally { await context.close().catch(() => {}) }
  }

  async deleteDraft(state: PublisherStorageState, remoteId: string) {
    if (!/^\d{1,20}$/.test(remoteId)) throw new ApiError(400, 'sspai_draft_invalid', '少数派草稿编号无效')
    const context = await this.context(state)
    try {
      const token = await this.token(context, state)
      await this.identity(context, token)
      const headers = { Authorization: `Bearer ${token}`, Referer: `${WRITE}/${remoteId}`, 'x-requested-with': 'fetch' }
      const article = await articleInfo(context, token, remoteId)
      if (!article) return { state: await context.storageState(), message: '少数派草稿已不存在，已清理本地发布记录' }
      const type = sspaiNumber(article.type)
      if (type === 5) throw new ApiError(409, 'sspai_delete_published', '该少数派文章已经发布，不能作为草稿删除；如需删除已发布文章，请到少数派后台操作')
      if (type !== 4) throw new ApiError(409, 'sspai_delete_unsupported', '该少数派内容不在草稿状态，请到少数派后台核对后再处理')
      const payload = { ...article, id: Number(remoteId), token: typeof article.token === 'string' ? article.token : '', delete_status: true }
      await sspaiData(await context.request.post(`${API}/matrix/editor/article/update`, { headers, data: payload, timeout: 30_000 }), '删除少数派草稿', false)
      const stored = await articleInfo(context, token, remoteId)
      if (stored && stored.delete_status !== true && Number(stored.delete_status) !== 1) {
        throw new ApiError(502, 'sspai_draft_delete_unverified', '少数派未确认草稿已删除，请到少数派后台核对后重试')
      }
      return { state: await context.storageState(), message: '已删除少数派草稿' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'sspai_draft_delete_failed', '删除少数派草稿未完成，请稍后重试或到少数派后台手动删除')
    } finally { await context.close().catch(() => {}) }
  }

  async publish(state: PublisherStorageState, article: SspaiArticle, mode: 'draft' | 'publish', progress: Parameters<SspaiDriver['publish']>[3], resumeId?: string) {
    if (resumeId && !/^\d{1,20}$/.test(resumeId)) throw new ApiError(400, 'sspai_draft_invalid', '少数派草稿编号无效')
    const context = await this.context(state)
    let remoteId = resumeId || '', updateSubmitted = false
    try {
      const token = await this.token(context, state)
      await this.identity(context, token)
      const headers = { Authorization: `Bearer ${token}`, Referer: WRITE, 'x-requested-with': 'fetch' }
      const $ = load(article.html, null, false)
      const uploaded = new Map<string, string>()
      let banner = '', bannerId = 0
      progress({ message: '正在上传少数派正文图片与封面' })
      for (const [src, image] of article.images) {
        const result = await uploadImage(context, token, image)
        uploaded.set(src, result.url)
      }
      for (const node of $('img').toArray()) {
        const src = $(node).attr('src') || ''
        if (sspaiImageUrl(src)) continue
        const url = uploaded.get(src)
        if (!url) throw new ApiError(400, 'sspai_external_image', '正文仍含未上传到少数派的图片，已停止发布')
        $(node).attr('src', url).removeAttr('data-original')
      }
      if (article.cover) {
        const cover = await uploadImage(context, token, article.cover)
        banner = cover.key
        bannerId = cover.id
      }
      const body = sspaiEditorContent($.html())
      const ready = load(body, null, false)
      if (ready('img').toArray().some((node) => !sspaiImageUrl(ready(node).attr('src')))) throw new ApiError(400, 'sspai_external_image', '正文仍含未上传到少数派的图片，已停止发布')
      let articleData: Data
      if (resumeId) {
        progress({ message: '正在恢复已有少数派草稿', remoteId, url: sspaiDraftUrl(remoteId) })
        const existing = await articleInfo(context, token, remoteId)
        if (!existing) throw new ApiError(409, 'sspai_draft_missing', '原少数派草稿已不存在，请核实发布结果；确认未发布后可重新创建')
        if (String(existing.title_last ?? existing.title ?? '') !== article.title) throw new ApiError(409, 'sspai_draft_changed', '已有少数派草稿标题已变更，已停止重试，请到少数派核对')
        const type = sspaiNumber(existing.type)
        if (type === 5) {
          return { state: await context.storageState(), status: 'published' as const, remoteId, url: sspaiPublicationUrl(remoteId), message: '少数派该文章已发布，已关联原文章，未重复提交' }
        }
        if (type !== 4) throw new ApiError(409, 'sspai_draft_changed', '已有少数派文章状态已变更（可能已投稿、被推荐或锁定），已停止重试，请到少数派核对')
        articleData = existing
      } else {
        progress({ message: '正在创建少数派草稿' })
        articleData = await sspaiData(await context.request.post(`${API}/matrix/editor/article/add`, {
          headers,
          data: { type: 4, banner: '', banner_id: 0, title: article.title, title_last: article.title, body: '', body_last: '', allow_comment: true, tags: [], custom_tags: article.tags, delete_status: false },
          timeout: 30_000,
        }), '创建少数派草稿')
        const created = sspaiNumber(articleData.id)
        if (created === null) throw new ApiError(502, 'sspai_draft_unverified', '少数派未返回有效草稿编号，请检查草稿箱，避免重复创建')
        remoteId = String(created)
      }
      const targetType = mode === 'publish' ? 5 : 4
      const payload: Data = {
        ...articleData,
        id: Number(remoteId),
        token: typeof articleData.token === 'string' ? articleData.token : '',
        type: targetType,
        title: article.title,
        title_last: article.title,
        body,
        body_last: body,
        banner: banner || articleData.banner || '',
        banner_id: bannerId || sspaiNumber(articleData.banner_id) || 0,
        allow_comment: true,
        tags: [],
        custom_tags: article.tags,
        delete_status: false,
        benefits_statement_on: false,
        benefits_statement_id: 0,
      }
      progress({ message: mode === 'publish' ? '正在提交少数派发布' : '正在保存少数派正文', remoteId, url: mode === 'publish' ? sspaiPublicationUrl(remoteId) : sspaiDraftUrl(remoteId) })
      updateSubmitted = true
      await sspaiData(await context.request.post(`${API}/matrix/editor/article/update`, { headers, data: payload, timeout: 30_000 }), mode === 'publish' ? '提交少数派发布' : '保存少数派草稿', false)
      const stored = await articleInfo(context, token, remoteId)
      if (!stored) throw new ApiError(502, 'sspai_content_mismatch', '少数派保存后的文章无法回读，已停止发布')
      const storedTitle = String(stored.title_last ?? stored.title ?? '')
      if (storedTitle !== article.title || typeof stored.body_last !== 'string') throw new ApiError(502, 'sspai_content_mismatch', '少数派保存后的标题或正文无法核对，已停止发布')
      verifySspaiContent(body, stored.body_last)
      const storedType = sspaiNumber(stored.type)
      if (mode === 'publish' && storedType !== 5) throw new ApiError(502, 'sspai_publish_unverified', '少数派尚未确认文章发布状态，请到少数派后台核实，避免重复发布')
      if (mode === 'draft') return { state: await context.storageState(), status: 'draft' as const, remoteId, url: sspaiDraftUrl(remoteId), message: '已保存少数派草稿，并核对标题、正文、图片与链接' }
      return { state: await context.storageState(), status: 'published' as const, remoteId, url: sspaiPublicationUrl(remoteId), message: '已发布到少数派，并核对文章内容与发布状态；平台可能仍需审核后才公开展示' }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : ''
      if (updateSubmitted && !['sspai_rejected', 'sspai_session_expired', 'sspai_security_check'].includes(code)) {
        throw new ApiError(502, 'sspai_result_uncertain', '少数派请求已提交，但最终结果未能核实；请先查看少数派草稿和文章，避免重复发布')
      }
      // A draft may already exist even when a later step failed. Never create a
      // second draft silently: require the user to check it first.
      if (remoteId && !['sspai_session_expired', 'sspai_security_check', 'sspai_draft_missing'].includes(code)) {
        throw new ApiError(502, 'sspai_result_uncertain', '少数派草稿可能已创建，但后续步骤失败；请先查看少数派草稿，避免重复发布')
      }
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'sspai_preparation_failed', remoteId ? '少数派操作中断，已保留草稿，请在少数派后台检查' : '少数派准备步骤失败，尚未提交文章，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null
    if (browser) await browser.then(value => value.close()).catch(() => {})
  }
}
