import { chromium, type APIResponse, type Browser, type BrowserContext, type Page } from 'playwright-core'
import type { WeiboPublication } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import type { PublisherImage } from './publisher-image'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'

export interface WeiboIdentity { accountId: string; name: string }
export interface WeiboArticle { text: string; images: PublisherImage[] }
export interface WeiboLoginAttempt {
  poll(): Promise<{ status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'; qrCode: string | null; message: string; state?: PublisherStorageState; identity?: WeiboIdentity }>
  close(): Promise<void>
}
export interface WeiboDriver {
  beginLogin(): Promise<WeiboLoginAttempt>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: WeiboIdentity }>
  checkPublication(state: PublisherStorageState, remoteId: string, text: string): Promise<{ state: PublisherStorageState; status: 'published' | 'missing' | 'unknown'; url: string | null; message: string }>
  publish(state: PublisherStorageState, article: WeiboArticle, progress: (value: Partial<Pick<WeiboPublication, 'message' | 'remoteId' | 'url'>>) => void): Promise<{ state: PublisherStorageState; status: 'published'; remoteId: string; url: string; message: string }>
  close(): Promise<void>
}

const HOME = 'https://weibo.com/'
const LOGIN = 'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog'
const QR = 'img[src*="qr.weibo.cn"], img[src*="qrcode"]'
const COMPOSER = 'textarea[placeholder*="有什么新鲜事"], textarea[placeholder*="分享"], div[contenteditable="true"][data-placeholder*="新鲜事"], div[contenteditable="true"][aria-label*="微博"]'
type Data = Record<string, unknown>
function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {} }
const expired = () => new ApiError(409, 'weibo_session_expired', '微博登录状态已失效，请重新扫码连接')

async function weiboJson(response: APIResponse, action: string): Promise<Data> {
  const data = object(await response.json().catch(() => null))
  if (response.status() === 401 || response.status() === 403) throw expired()
  return { ...data, __status: response.status() }
}

export function parseWeiboProfile(value: unknown): WeiboIdentity | null {
  const root = object(value)
  if (Number(root.ok) !== 1) return null
  const payload = object(root.data)
  const user = object(payload.user ?? payload)
  const id = user.idstr ?? user.id
  const name = typeof user.screen_name === 'string' ? user.screen_name : typeof user.name === 'string' ? user.name : ''
  if (typeof id !== 'string' && typeof id !== 'number') return null
  return { accountId: String(id), name: name || '微博用户' }
}

export function parseWeiboPublished(value: unknown): { remoteId: string; url: string } | null {
  const root = object(value)
  if (Number(root.ok) !== 1) return null
  const data = object(root.data)
  const raw = data.idstr ?? data.id ?? data.mid ?? data.mblogid
  const id = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
  if (!/^\d{6,30}$/.test(id)) return null
  return { remoteId: id, url: `https://m.weibo.cn/detail/${id}` }
}

export function parseWeiboStatus(value: unknown, remoteId: string): { id: string; text: string } | null {
  const root = object(value)
  if (Number(root.ok) !== 1) return null
  const data = object(root.data)
  const id = String(data.idstr ?? data.id ?? data.mid ?? '')
  if (id !== remoteId) return null
  return { id, text: typeof data.text === 'string' ? data.text : '' }
}

export class PlaywrightWeiboDriver implements WeiboDriver {
  private browser: Promise<Browser> | null = null

  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = publisherExecutablePath('weibo')
      if (!executablePath) throw new ApiError(503, 'weibo_browser_unavailable', '服务器未安装可用的 Chrome / Chromium 浏览器')
      this.browser = chromium.launch({ executablePath, headless: true, chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1', args: ['--disable-dev-shm-usage'] }).then(browser => {
        browser.on('disconnected', () => { this.browser = null })
        return browser
      }).catch(() => { this.browser = null; throw new ApiError(503, 'weibo_browser_unavailable', '无法启动微博浏览器，请检查服务器浏览器配置') })
    }
    const context = await (await this.browser).newContext({ storageState: state, locale: 'zh-CN', viewport: { width: 1360, height: 1000 } })
    context.setDefaultTimeout(20_000)
    return context
  }

  private async profile(context: BrowserContext): Promise<WeiboIdentity | null> {
    const response = await context.request.get(`${HOME}ajax/profile/info`, {
      headers: { 'x-requested-with': 'XMLHttpRequest', Referer: HOME, Accept: 'application/json' },
      timeout: 20_000,
    })
    if (response.status() === 401 || response.status() === 403) return null
    const data = object(await response.json().catch(() => null))
    return parseWeiboProfile(data)
  }

  private async security(page: Page): Promise<void> {
    const text = await page.locator('body').innerText().catch(() => '')
    if (/安全验证|请完成验证|访问过于频繁|操作频繁|异常访问|身份验证/.test(text)) {
      throw new ApiError(409, 'weibo_security_check', '微博要求安全验证，已停止操作；请在官方页面完成验证后重新连接')
    }
  }

  async beginLogin(): Promise<WeiboLoginAttempt> {
    const context = await this.context(), page = await context.newPage()
    let closed = false, qrCode: string | null = null
    const close = async () => { if (!closed) { closed = true; await context.close().catch(() => {}) } }
    const deadline = Date.now() + 5 * 60_000
    const readQr = async (): Promise<string | null> => {
      const qr = page.locator(QR).first()
      if (!await qr.isVisible().catch(() => false)) return null
      return `data:image/png;base64,${(await qr.screenshot({ type: 'png', timeout: 5_000 })).toString('base64')}`
    }
    try {
      const response = await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (response?.status() === 403) throw new ApiError(409, 'weibo_security_check', '微博登录页要求安全验证，请稍后重试')
      await page.locator(QR).first().waitFor({ state: 'visible', timeout: 20_000 })
      qrCode = await readQr()
    } catch (error) {
      await close()
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'weibo_login_unavailable', '无法取得微博官方登录二维码，请检查服务器网络或稍后重试')
    }
    return {
      close,
      poll: async () => {
        if (closed || Date.now() > deadline) return { status: 'expired', qrCode: null, message: '微博登录二维码已过期，请重新获取' }
        const text = await page.locator('body').innerText().catch(() => '')
        if (/二维码已过期|二维码失效/.test(text)) return { status: 'expired', qrCode: null, message: '二维码已失效，请重新获取' }
        const cookies = await context.cookies().catch(() => [])
        if (cookies.some(cookie => cookie.name === 'SUB' && cookie.value && /(^|\.)weibo\.com$/i.test(cookie.domain))) {
          const identity = await this.profile(context).catch(() => null)
          if (identity) return { status: 'connected', qrCode: null, message: '微博已登录，登录状态已保存', state: await context.storageState(), identity }
        }
        const next = await readQr().catch(() => null)
        if (next) qrCode = next
        const scanned = /扫码成功|已扫码|请在手机上确认|在手机微博中确认/.test(text)
        return { status: scanned ? 'scanned' : 'waiting', qrCode, message: scanned ? '请在微博 App 中确认登录' : '请使用微博 App 扫描二维码登录' }
      },
    }
  }

  async checkSession(state: PublisherStorageState) {
    const context = await this.context(state)
    try {
      const identity = await this.profile(context)
      if (!identity) throw expired()
      return { state: await context.storageState(), identity }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'weibo_check_failed', '微博连接检查未完成，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async checkPublication(state: PublisherStorageState, remoteId: string, text: string) {
    if (!/^\d{6,30}$/.test(remoteId)) throw new ApiError(400, 'weibo_status_invalid', '微博编号无效')
    const context = await this.context(state)
    try {
      const response = await context.request.get(`${HOME}ajax/statuses/show?id=${encodeURIComponent(remoteId)}`, {
        headers: { 'x-requested-with': 'XMLHttpRequest', Referer: HOME, Accept: 'application/json' },
        timeout: 20_000,
      })
      if (response.status() === 404) return { state: await context.storageState(), status: 'missing' as const, url: null, message: '微博不存在，可能已删除' }
      const data = await weiboJson(response, '核对微博')
      if (Number(data.ok) === -100) throw expired()
      const status = parseWeiboStatus(data, remoteId)
      if (status) return { state: await context.storageState(), status: 'published' as const, url: `https://m.weibo.cn/detail/${remoteId}`, message: text && !status.text.includes(text.slice(0, 20)) ? '微博存在，但正文与提交内容不一致，请人工核对' : '已重新核实：微博已发布' }
      return { state: await context.storageState(), status: 'unknown' as const, url: null, message: '微博暂未返回可确认的发布结果，请到微博主页核对' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'weibo_check_failed', '重新核实微博结果未完成，请稍后重试或人工核实')
    } finally { await context.close().catch(() => {}) }
  }

  async publish(state: PublisherStorageState, article: WeiboArticle, progress: Parameters<WeiboDriver['publish']>[2]) {
    const context = await this.context(state)
    let submitted = false
    try {
      const page = await context.newPage()
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await this.security(page)
      if (/login|passport/.test(page.url())) throw expired()
      const identity = await this.profile(context)
      if (!identity) throw expired()

      progress({ message: '正在填写微博正文' })
      const composer = page.locator(COMPOSER).first()
      await composer.waitFor({ state: 'visible', timeout: 30_000 })
      await composer.fill(article.text)
      if (await composer.inputValue().catch(() => article.text) !== article.text) throw new ApiError(409, 'weibo_content_mismatch', '微博编辑器内容不一致，已停止发布')

      if (article.images.length) {
        progress({ message: `正在上传 ${article.images.length} 张微博图片` })
        const input = page.locator('input[type="file"][accept*="image"]').first()
        if (!await input.count()) throw new ApiError(502, 'weibo_upload_unavailable', '微博图片上传入口不可用，请稍后重试')
        await input.setInputFiles(article.images.map((image, index) => ({ name: `${index + 1}-${image.name}`, mimeType: image.mimeType, buffer: image.buffer })))
        await page.waitForTimeout(3_000)
        await this.security(page)
        const errorText = await page.locator('body').innerText().catch(() => '')
        if (/图片上传失败|上传失败|图片格式不支持/.test(errorText)) throw new ApiError(502, 'weibo_image_upload_failed', '微博图片上传失败，请检查图片后重试')
      }

      await this.security(page)
      const button = page.getByRole('button', { name: '发送', exact: true }).first()
      await button.waitFor({ state: 'visible', timeout: 15_000 })
      if (!await button.isEnabled()) throw new ApiError(409, 'weibo_publish_disabled', '微博发送按钮不可用，请检查账号状态和内容')
      progress({ message: '正在提交微博，请勿重复操作' })
      const responsePromise = page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.hostname.endsWith('weibo.com') && /\/ajax\/statuses\/update\/?$/.test(url.pathname) && response.request().method() === 'POST'
      }, { timeout: 45_000 }).catch(() => null)
      submitted = true
      await button.click()
      const response = await responsePromise
      if (!response) {
        const bodyText = await page.locator('body').innerText().catch(() => '')
        if (/发布成功|发送成功/.test(bodyText)) throw new ApiError(409, 'weibo_result_uncertain', '微博页面提示成功，但未取得发布编号；请到微博主页核对')
        throw new ApiError(409, 'weibo_result_uncertain', '已提交微博，但未确认发布结果；请到微博主页核对，避免重复发布')
      }
      const data = object(await response.json().catch(() => null))
      if (Number(data.ok) === -100) throw expired()
      if (Number(data.ok) !== 1) {
        const message = typeof data.message === 'string' ? data.message : typeof data.msg === 'string' ? data.msg : ''
        throw new ApiError(502, 'weibo_rejected', `微博未确认发布成功${message ? `：${message}` : ''}`)
      }
      const result = parseWeiboPublished(data)
      if (!result) throw new ApiError(409, 'weibo_result_uncertain', '微博已受理，但未返回有效发布编号；请到微博主页核对')
      return {
        state: await context.storageState(),
        status: 'published' as const,
        remoteId: result.remoteId,
        url: identity.accountId ? `https://weibo.com/${identity.accountId}/${result.remoteId}` : result.url,
        message: '微博已发布',
      }
    } catch (error) {
      if (submitted && !(error instanceof ApiError && ['weibo_session_expired', 'weibo_security_check'].includes(error.code))) {
        throw new ApiError(409, 'weibo_result_uncertain', error instanceof ApiError ? error.message : '微博提交后结果未确认；请到微博主页核对，避免重复发布')
      }
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'weibo_preparation_failed', '微博发布准备失败，尚未提交；请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null
    if (browser) await browser.then(value => value.close()).catch(() => {})
  }
}
