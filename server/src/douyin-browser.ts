import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import type { DouyinPublication } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import type { PublisherImage } from './publisher-image'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'

export interface DouyinIdentity { accountId: string; name: string }
export interface DouyinArticle { title: string; body: string; images: Map<string, PublisherImage>; video?: PublisherImage }
export interface DouyinLoginAttempt {
  poll(): Promise<{ status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'; qrCode: string | null; message: string; state?: PublisherStorageState; identity?: DouyinIdentity }>
  close(): Promise<void>
}
export interface DouyinDriver {
  beginLogin(): Promise<DouyinLoginAttempt>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: DouyinIdentity }>
  checkPublication(state: PublisherStorageState, remoteId: string, title: string): Promise<{ state: PublisherStorageState; status: 'unknown'; url: null; message: string }>
  publish(state: PublisherStorageState, article: DouyinArticle, progress: (value: Partial<Pick<DouyinPublication, 'message' | 'remoteId' | 'url'>>) => void): Promise<{ state: PublisherStorageState; status: 'published'; remoteId: string | null; url: string | null; message: string }>
  close(): Promise<void>
}

const HOME = 'https://creator.douyin.com/'
const UPLOAD = `${HOME}creator-micro/content/upload`
const QR = '#animate_qrcode_container img, [class*="animate_qrcode_container"] img, [class*="scan_qrcode_login_content"] img, img[aria-label="二维码"]'
const expired = () => new ApiError(409, 'douyin_session_expired', '抖音登录已失效，请重新扫码')

export function douyinPublishedResult(value: unknown): { remoteId: string; url: string } | null {
  if (!value || typeof value !== 'object') return null
  const data = value as { status_code?: unknown; aweme?: { aweme_id?: unknown }; aweme_id?: unknown; data?: { aweme_id?: unknown } }
  const id = data.aweme?.aweme_id ?? data.aweme_id ?? data.data?.aweme_id
  if (data.status_code !== 0 || typeof id !== 'string' || !/^\d{10,30}$/.test(id)) return null
  return { remoteId: id, url: `https://www.douyin.com/video/${id}` }
}

export class PlaywrightDouyinDriver implements DouyinDriver {
  private browser: Promise<Browser> | null = null
  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = publisherExecutablePath('douyin')
      if (!executablePath) throw new ApiError(503, 'douyin_browser_unavailable', '服务器需要 Chrome / Chromium，可设置 DOUYIN_BROWSER_PATH')
      this.browser = chromium.launch({ executablePath, headless: true, chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1', args: ['--disable-dev-shm-usage'] }).then(browser => {
        browser.on('disconnected', () => { this.browser = null }); return browser
      }).catch(() => { this.browser = null; throw new ApiError(503, 'douyin_browser_unavailable', '抖音浏览器启动失败，请检查配置') })
    }
    const context = await (await this.browser).newContext({ storageState: state, locale: 'zh-CN', viewport: { width: 1280, height: 1000 } })
    context.setDefaultTimeout(15_000)
    return context
  }
  private async security(page: Page) {
    const text = await page.locator('body').innerText()
    if (/安全验证|请完成验证|拖动滑块|操作频繁|访问异常|身份验证|短信验证/.test(text)) throw new ApiError(409, 'douyin_security_check', '抖音要求安全验证，已停止操作；请在官方创作者中心处理后重新连接')
  }
  private async identity(page: Page): Promise<DouyinIdentity | null> {
    await this.security(page)
    if (!page.url().startsWith(`${HOME}creator-micro/`) || await page.getByText('扫码登录', { exact: true }).isVisible().catch(() => false)) return null
    // A rendered authenticated page and a stable user cookie must both be present.
    const cookies = await page.context().cookies(HOME)
    const uid = cookies.find(cookie => ['uid_tt', 'uid_tt_ss'].includes(cookie.name))?.value
    if (!uid || !cookies.some(cookie => cookie.name === 'sessionid' && cookie.value)) return null
    if (!await page.getByText(/发布视频|发布作品|作品管理|上传视频/).first().isVisible().catch(() => false)) return null
    return { accountId: uid, name: '抖音创作者账号' }
  }
  async beginLogin(): Promise<DouyinLoginAttempt> {
    const context = await this.context(), page = await context.newPage()
    let closed = false
    const deadline = Date.now() + 5 * 60_000
    const close = async () => { closed = true; await context.close().catch(() => {}) }
    try {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await this.security(page)
      await page.locator(QR).first().waitFor({ state: 'visible', timeout: 60_000 })
    } catch (error) { await close(); if (error instanceof ApiError) throw error; throw new ApiError(502, 'douyin_login_failed', '无法获取抖音官方二维码，请检查网络后重试') }
    return { close, poll: async () => {
      if (closed || Date.now() > deadline) return { status: 'expired', qrCode: null, message: '二维码已过期，请重新连接' }
      const identity = await this.identity(page)
      if (identity) return { status: 'connected', qrCode: null, message: '已连接抖音', identity, state: await context.storageState() }
      const text = await page.locator('body').innerText()
      if (/二维码失效|二维码已过期/.test(text)) return { status: 'expired', qrCode: null, message: '二维码已过期，请重新连接' }
      const qr = page.locator(QR).first()
      const qrCode = await qr.isVisible().catch(() => false) ? `data:image/png;base64,${(await qr.screenshot()).toString('base64')}` : null
      return { status: qrCode ? 'waiting' : 'scanned', qrCode, message: qrCode ? '请使用抖音 App 扫码并确认登录' : '正在确认登录，请查看手机上的提示' }
    } }
  }
  async checkSession(state: PublisherStorageState) {
    const context = await this.context(state)
    try {
      const page = await context.newPage()
      await page.goto(UPLOAD, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.locator('input[type="file"], ' + QR).first().waitFor({ state: 'attached', timeout: 30_000 })
      const identity = await this.identity(page)
      if (!identity) throw expired()
      return { identity, state: await context.storageState() }
    } finally { await context.close().catch(() => {}) }
  }
  async checkPublication(state: PublisherStorageState, _remoteId: string, _title: string) {
    // shortcut: without a verified query API, ask the user to verify in creator center.
    return { state, status: 'unknown' as const, url: null, message: '请到抖音创作者中心核实作品，再选择已发布或未发布' }
  }
  async publish(state: PublisherStorageState, article: DouyinArticle, progress: (value: Partial<Pick<DouyinPublication, 'message'>>) => void) {
    const context = await this.context(state)
    let submitted = false
    try {
      const page = await context.newPage()
      await page.goto(UPLOAD, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await this.security(page)
      if (!page.url().startsWith(`${HOME}creator-micro/`)) throw expired()
      if (!article.video) await page.getByText('发布图文', { exact: true }).first().click()
      progress({ message: article.video ? '正在上传抖音视频' : '正在上传抖音图片' })
      const files = article.video ? [article.video] : [...article.images.values()]
      await page.locator(article.video ? 'input.upload-btn-input, input[type="file"][accept*="video"]' : 'input[type="file"][accept*="image"]').first().setInputFiles(files.map(file => ({ name: file.name, mimeType: file.mimeType, buffer: file.buffer })))
      const title = page.locator('input[placeholder*="填写作品标题"]').first()
      await title.waitFor({ state: 'visible', timeout: 180_000 })
      await title.fill(article.title)
      const body = page.locator('div.zone-container[contenteditable="true"]').first()
      await body.fill(article.body)
      await body.press('Escape')
      if (await title.inputValue() !== article.title || (await body.innerText()).replace(/\r/g, '').trim() !== article.body.replace(/\r/g, '').trim()) throw new ApiError(409, 'douyin_content_mismatch', '抖音编辑器内容不一致，已停止提交')
      await this.security(page)
      const button = page.getByRole('button', { name: '发布', exact: true })
      await button.waitFor({ state: 'visible' })
      if (!await button.isEnabled()) throw new ApiError(409, 'douyin_publish_disabled', '发布按钮不可用，请检查素材、封面与账号权限')
      progress({ message: '正在提交抖音审核，请勿重复操作' })
      const response = page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.hostname === 'creator.douyin.com' && /\/aweme\/(?:.*\/)?create\/?$/.test(url.pathname) && response.request().method() === 'POST'
      }, { timeout: 30_000 }).catch(() => null)
      submitted = true
      await button.click()
      const upstream = await response
      const result = upstream?.ok() ? douyinPublishedResult(await upstream.json().catch(() => null)) : null
      if (!result) throw new ApiError(409, 'douyin_result_uncertain', '已尝试提交，请先在抖音后台核实结果，系统不会自动重发')
      return { ...result, state: await context.storageState(), status: 'published' as const, message: '抖音已确认提交，最终展示以审核结果为准' }
    } catch (error) {
      if (submitted) throw new ApiError(409, 'douyin_result_uncertain', '已尝试提交，结果待核实；请先检查抖音创作者中心')
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'douyin_prepare_failed', '抖音页面加载、上传或填写失败，尚未提交；请检查平台页面与网络')
    } finally { await context.close().catch(() => {}) }
  }
  async close() { if (this.browser) await (await this.browser).close().catch(() => {}); this.browser = null }
}
