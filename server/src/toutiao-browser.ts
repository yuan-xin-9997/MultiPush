import { chromium, type APIResponse, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { load } from 'cheerio'
import type { ToutiaoPublication } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import type { PublisherImage } from './publisher-image'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'
import { qrReady } from './qr-capture'

export interface ToutiaoIdentity { accountId: string; name: string }
export interface ToutiaoArticle { title: string; html: string; text: string; images: PublisherImage[] }
export interface ToutiaoLoginAttempt {
  poll(): Promise<{ status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'; qrCode: string | null; message: string; state?: PublisherStorageState; identity?: ToutiaoIdentity }>
  close(): Promise<void>
}
export interface ToutiaoDriver {
  beginLogin(): Promise<ToutiaoLoginAttempt>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: ToutiaoIdentity }>
  checkPublication(state: PublisherStorageState, remoteId: string, title: string): Promise<{ state: PublisherStorageState; status: 'published' | 'missing' | 'unknown'; url: string | null; message: string }>
  publish(state: PublisherStorageState, article: ToutiaoArticle, progress: (value: Partial<Pick<ToutiaoPublication, 'message' | 'remoteId' | 'url'>>) => void): Promise<{ state: PublisherStorageState; status: 'published'; remoteId: string; url: string; message: string }>
  close(): Promise<void>
}

const HOME = 'https://mp.toutiao.com/'
const LOGIN = 'https://mp.toutiao.com/auth/page/login'
const PUBLISH = 'https://mp.toutiao.com/profile_v4/graphic/publish'
const QR = 'img[class*="web-login-scan-code"][class*="qrcode"], img[class*="qrcode"], img[src^="data:image"][class*="login"]'
const TITLE = 'input[placeholder*="请输入文章标题"], input[placeholder*="标题"], textarea[placeholder*="标题"], .article-title input, [class*="title"] input'
const EDITOR = 'div.ProseMirror[contenteditable="true"], div[contenteditable="true"][data-placeholder*="正文"], div[contenteditable="true"]'
type Data = Record<string, unknown>
function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {} }
const expired = () => new ApiError(409, 'toutiao_session_expired', '今日头条登录状态已失效，请重新扫码连接')
function log(...parts: unknown[]): void { console.log('[toutiao]', ...parts) }


export function parseToutiaoLogin(value: unknown): ToutiaoIdentity | null {
  const root = object(value)
  if (Number(root.code) !== 0) return null
  const data = object(root.data)
  if (![true, 1, '1'].includes(data.is_login as boolean | number | string)) return null
  const user = object(data.user), media = object(data.media)
  const raw = user.user_id ?? user.id ?? media.media_id ?? media.id ?? media.user_id
  const id = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
  const name = [user.screen_name, user.name, media.name, media.screen_name, media.media_name]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? ''
  if (!id) return null
  return { accountId: id, name: name || '今日头条作者' }
}

export function parseToutiaoPublished(value: unknown): { remoteId: string; url: string } | null {
  const root = object(value)
  if (Number(root.code ?? 0) !== 0) return null
  const data = object(root.data)
  const raw = data.pgc_id ?? data.item_id ?? data.group_id ?? data.article_id ?? data.id
  const id = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
  if (!/^\d{6,30}$/.test(id)) return null
  return { remoteId: id, url: `https://www.toutiao.com/article/${id}/` }
}

export class PlaywrightToutiaoDriver implements ToutiaoDriver {
  private browser: Promise<Browser> | null = null

  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = publisherExecutablePath('toutiao')
      if (!executablePath) throw new ApiError(503, 'toutiao_browser_unavailable', '服务器未安装可用的 Chrome / Chromium 浏览器')
      this.browser = chromium.launch({ executablePath, headless: true, chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1', args: ['--disable-dev-shm-usage'] }).then(browser => {
        browser.on('disconnected', () => { this.browser = null })
        return browser
      }).catch(() => { this.browser = null; throw new ApiError(503, 'toutiao_browser_unavailable', '无法启动今日头条浏览器，请检查服务器浏览器配置') })
    }
    const context = await (await this.browser).newContext({ storageState: state, locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(20_000)
    return context
  }

  private async profile(context: BrowserContext, verbose = false): Promise<ToutiaoIdentity | null> {
    const response = await context.request.get(`${HOME}mp/agw/media/user_login_status_api`, {
      headers: { 'x-requested-with': 'XMLHttpRequest', Referer: `${HOME}profile_v4/index`, Accept: 'application/json' },
      timeout: 20_000,
    }).catch(() => null)
    if (!response) { if (verbose) log('login status request failed'); return null }
    if (response.status() === 401 || response.status() === 403) { if (verbose) log('login status', response.status()); return null }
    const body = await response.text().catch(() => '')
    let parsed: unknown = null
    try { parsed = JSON.parse(body) } catch {}
    const identity = parseToutiaoLogin(parsed)
    if (!identity && verbose) {
      const root = object(parsed), data = object(root.data)
      log('login status did not report a signed-in account', 'status=' + response.status(), 'code=' + String(root.code), 'is_login=' + String(data.is_login))
    }
    return identity
  }

  private async security(page: Page): Promise<void> {
    const text = await page.locator('body').innerText().catch(() => '')
    if (/安全验证|请完成验证|操作频繁|访问异常|身份验证|滑块/.test(text)) throw new ApiError(409, 'toutiao_security_check', '今日头条要求安全验证，已停止操作；请在官方页面完成验证后重新连接')
  }

  private async dismiss(page: Page): Promise<void> {
    for (const label of ['我知道了', '知道了', '暂不开启', '关闭']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.isVisible().catch(() => false)) await button.click().catch(() => {})
    }
  }

  async beginLogin(): Promise<ToutiaoLoginAttempt> {
    const context = await this.context(), page = await context.newPage()
    let closed = false, qrCode: string | null = null
    const close = async () => { if (!closed) { closed = true; await context.close().catch(() => {}) } }
    const deadline = Date.now() + 5 * 60_000
    const readQr = async (): Promise<string | null> => {
      const qr = page.locator(QR).first()
      if (!await qr.isVisible().catch(() => false)) return null
      await qrReady(qr)
      return `data:image/png;base64,${(await qr.screenshot({ type: 'png', timeout: 5_000 })).toString('base64')}`
    }
    try {
      const response = await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (response?.status() === 403) throw new ApiError(409, 'toutiao_security_check', '今日头条登录页要求安全验证，请稍后重试')
      await page.locator(QR).first().waitFor({ state: 'visible', timeout: 20_000 })
      qrCode = await readQr()
      log('login QR ready')
    } catch (error) {
      await close()
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'toutiao_login_unavailable', '无法取得今日头条官方登录二维码，请检查服务器网络或稍后重试')
    }
    return {
      close,
      poll: async () => {
        if (closed || Date.now() > deadline) return { status: 'expired', qrCode: null, message: '今日头条登录二维码已过期，请重新获取' }
        const text = await page.locator('body').innerText().catch(() => '')
        if (/二维码已过期|二维码失效/.test(text)) return { status: 'expired', qrCode: null, message: '二维码已失效，请重新获取' }
        // Leaving the login page means the scan was accepted and the session is being created.
        const leftLogin = !/\/auth\/page\/login|passport/i.test(page.url())
        const identity = await this.profile(context, leftLogin).catch(() => null)
        if (identity) {
          log('login completed', identity.accountId)
          return { status: 'connected', qrCode: null, message: '今日头条已登录，登录状态已保存', state: await context.storageState(), identity }
        }
        const next = await readQr().catch(() => null)
        if (next) qrCode = next
        const scanned = /成功扫描|扫描成功|扫码成功|已扫码|请在手机.{0,8}确认|在今日头条App中确认|登录成功/.test(text) || leftLogin
        return {
          status: scanned ? 'scanned' : 'waiting',
          qrCode,
          message: leftLogin
            ? '今日头条已登录，正在读取账号信息…'
            : scanned ? '已扫描，请在今日头条 App 中点击确认登录' : '请使用今日头条 App 扫描二维码登录',
        }
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
      throw new ApiError(502, 'toutiao_check_failed', '今日头条连接检查未完成，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async checkPublication(state: PublisherStorageState, remoteId: string, title: string) {
    if (!/^\d{6,30}$/.test(remoteId)) throw new ApiError(400, 'toutiao_article_invalid', '今日头条文章编号无效')
    const context = await this.context(state)
    try {
      const response = await context.request.get(`https://www.toutiao.com/article/${remoteId}/`, { timeout: 20_000, headers: { Accept: 'text/html' } })
      if (response.status() === 404) return { state: await context.storageState(), status: 'missing' as const, url: null, message: '今日头条文章不存在，可能已删除' }
      const html = await response.text().catch(() => '')
      const $ = load(html)
      const found = $('meta[property="og:title"]').attr('content') || $('title').text()
      if (response.status() === 200 && found && (!title || found.includes(title.slice(0, 10)))) {
        return { state: await context.storageState(), status: 'published' as const, url: `https://www.toutiao.com/article/${remoteId}/`, message: '已重新核实：今日头条文章已发布' }
      }
      return { state: await context.storageState(), status: 'unknown' as const, url: null, message: response.status() === 200 && found ? '今日头条文章存在，但标题与提交内容不一致，请人工核对' : '今日头条暂未返回可确认的发布结果，请到创作中心核对' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'toutiao_check_failed', '重新核实今日头条结果未完成，请稍后重试或人工核实')
    } finally { await context.close().catch(() => {}) }
  }

  private async fillEditor(page: Page, article: ToutiaoArticle, progress: (value: Partial<Pick<ToutiaoPublication, 'message' | 'remoteId' | 'url'>>) => void): Promise<void> {
    progress({ message: '正在填写今日头条正文' })
    const editor = page.locator(EDITOR).first()
    await editor.waitFor({ state: 'visible', timeout: 30_000 })
    await editor.click()
    try {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://mp.toutiao.com' })
      await page.evaluate(async ({ html, text }) => {
        const clipboard = (navigator as unknown as { clipboard: { write(items: unknown[]): Promise<void> } }).clipboard
        const ClipboardItemImpl = (globalThis as unknown as { ClipboardItem: new (items: Record<string, Blob>) => unknown }).ClipboardItem
        const items: Record<string, Blob> = { 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) }
        await clipboard.write([new ClipboardItemImpl(items)])
      }, { html: article.html, text: article.text })
      await page.keyboard.press('Control+V')
      await page.waitForTimeout(1_500)
    } catch {
      await editor.fill(article.text)
      await page.waitForTimeout(500)
    }
    const content = await editor.innerText().catch(() => '')
    if (article.text.trim() && !content.includes(article.text.trim().slice(0, 20))) {
      await editor.fill(article.text)
      await page.waitForTimeout(500)
    }
  }

  async publish(state: PublisherStorageState, article: ToutiaoArticle, progress: Parameters<ToutiaoDriver['publish']>[2]) {
    const context = await this.context(state)
    let submitted = false
    try {
      const page = await context.newPage()
      await page.goto(PUBLISH, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await this.security(page)
      if (/auth\/page\/login|passport/.test(page.url())) throw expired()
      const identity = await this.profile(context)
      if (!identity) throw expired()
      await this.dismiss(page)

      progress({ message: '正在填写今日头条标题' })
      const title = page.locator(TITLE).first()
      await title.waitFor({ state: 'visible', timeout: 20_000 })
      await title.fill(article.title)
      await this.fillEditor(page, article, progress)
      await this.security(page)

      progress({ message: '正在提交今日头条发布' })
      const responsePromise = page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.hostname === 'mp.toutiao.com' && /\/mp\/agw\/article\/publish\/?$/.test(url.pathname) && response.request().method() === 'POST'
      }, { timeout: 60_000 }).catch(() => null)
      const publishButton = page.getByRole('button', { name: /^(?:预览并发布|发布|发表)$/ }).first()
      await publishButton.waitFor({ state: 'visible', timeout: 15_000 })
      if (!await publishButton.isEnabled()) throw new ApiError(409, 'toutiao_publish_disabled', '今日头条发布按钮不可用，请检查标题、正文和账号状态')
      submitted = true
      await publishButton.click()
      await page.waitForTimeout(1_000)
      for (const label of ['确认发布', '确认', '发布']) {
        const confirm = page.getByRole('button', { name: label, exact: true }).last()
        if (await confirm.isVisible().catch(() => false)) { await confirm.click().catch(() => {}); break }
      }
      const response = await responsePromise
      if (!response) {
        const body = await page.locator('body').innerText().catch(() => '')
        if (/发布成功|发表成功/.test(body)) throw new ApiError(409, 'toutiao_result_uncertain', '页面提示发布成功，但未取得文章编号；请到今日头条创作中心核对')
        throw new ApiError(409, 'toutiao_result_uncertain', '已提交今日头条，但未确认发布结果；请到创作中心核对，避免重复发布')
      }
      const data = object(await response.json().catch(() => null))
      if (Number(data.code) === -100 || Number(data.code) === 401) throw expired()
      if (Number(data.code ?? 0) !== 0) {
        const message = typeof data.message === 'string' ? data.message : ''
        throw new ApiError(502, 'toutiao_rejected', `今日头条未确认发布成功${message ? `：${message}` : ''}`)
      }
      const result = parseToutiaoPublished(data)
      if (!result) throw new ApiError(409, 'toutiao_result_uncertain', '今日头条已受理，但未返回有效文章编号；请到创作中心核对')
      return { state: await context.storageState(), status: 'published' as const, remoteId: result.remoteId, url: result.url, message: '今日头条文章已发布' }
    } catch (error) {
      if (submitted && !(error instanceof ApiError && ['toutiao_session_expired', 'toutiao_security_check'].includes(error.code))) {
        throw new ApiError(409, 'toutiao_result_uncertain', error instanceof ApiError ? error.message : '今日头条提交后结果未确认；请到创作中心核对，避免重复发布')
      }
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'toutiao_preparation_failed', '今日头条发布准备失败，尚未提交；请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null
    if (browser) await browser.then(value => value.close()).catch(() => {})
  }
}
