import { load } from 'cheerio'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import type { XhsPublication } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import type { PublisherImage } from './publisher-image'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'

export interface XhsIdentity { accountId: string; name: string }
export interface XhsArticle { title: string; body: string; images: Map<string, PublisherImage> }
export interface XhsLoginAttempt {
  poll(): Promise<{ status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'; qrCode: string | null; message: string; state?: PublisherStorageState; identity?: XhsIdentity }>
  close(): Promise<void>
}
export interface XhsDriver {
  beginLogin(): Promise<XhsLoginAttempt>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: XhsIdentity }>
  checkPublication(state: PublisherStorageState, remoteId: string, title: string): Promise<{ state: PublisherStorageState; status: 'unknown'; url: null; message: string }>
  publish(state: PublisherStorageState, article: XhsArticle, progress: (value: Partial<Pick<XhsPublication, 'message' | 'remoteId' | 'url'>>) => void): Promise<{ state: PublisherStorageState; status: 'published'; remoteId: string | null; url: string | null; message: string }>
  close(): Promise<void>
}
const HOME = 'https://www.xiaohongshu.com/explore'
const CREATOR = 'https://creator.xiaohongshu.com/publish/publish?source=official'
const QR = '.login-container .qrcode-img'
const LOGIN = '#login-btn, .side-bar-component .login-btn'
const expired = () => new ApiError(409, 'xiaohongshu_session_expired', '小红书登录已失效，请重新扫码')

// Xiaohongshu rejects the default "HeadlessChrome" user agent with a security
// restriction page (error 300012) instead of the login QR code.
export function xhsUserAgent(version: string): string {
  const major = version.split('.')[0] || '140'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

export function xhsPublishedResult(value: unknown): { remoteId: string; url: string } | null {
  if (!value || typeof value !== 'object') return null
  const data = value as { code?: unknown; success?: unknown; data?: { id?: unknown; note_id?: unknown } }
  if (data.code !== 0 || data.success !== true) return null
  const id = data.data?.note_id ?? data.data?.id
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) return null
  return { remoteId: id, url: `https://www.xiaohongshu.com/explore/${id}` }
}

/** Recover editor paragraphs without innerText's browser-dependent block spacing. */
export function xhsEditorText(html: string): string {
  const $ = load(html, null, false)
  $('br.ProseMirror-trailingBreak').remove()
  $('br').replaceWith('\n')
  const nodes = $.root().contents().toArray()
  return nodes.map((node, index) => {
    const text = $(node).text()
    const block = node.type === 'tag' && ['p', 'div'].includes(node.name)
    return text + (block && index < nodes.length - 1 ? '\n' : '')
  }).join('')
}

export function normalizeXhsEditorText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
}

export const XHS_IMAGE_INPUT = 'input[type="file"][accept*="image/"], input[type="file"][accept*=".jpg"], input[type="file"][accept*=".jpeg"], input[type="file"][accept*=".png"], input[type="file"][accept*=".webp"]'

export async function clickXhsImageTab(page: Page): Promise<void> {
  const tabs = page.locator('div.creator-tab:not([aria-hidden="true"])').filter({ hasText: '上传图文' })
  await tabs.first().waitFor({ state: 'attached' })
  const viewport = page.viewportSize()
  if (!viewport) throw new ApiError(502, 'xiaohongshu_image_tab_missing', '无法确定创作中心窗口大小，尚未提交，请重新连接')
  for (let index = 0; index < await tabs.count(); index++) {
    const tab = tabs.nth(index), box = await tab.boundingBox()
    // Layout measurement copies can have a size while remaining outside the viewport.
    if (!box || box.width <= 0 || box.height <= 0 || !await tab.isVisible()) continue
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) continue
    await tab.click()
    return
  }
  throw new ApiError(502, 'xiaohongshu_image_tab_missing', '未找到可操作的上传图文入口，尚未提交，请检查小红书创作中心页面')
}

export class PlaywrightXhsDriver implements XhsDriver {
  private browser: Promise<Browser> | null = null
  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = publisherExecutablePath('xiaohongshu')
      if (!executablePath) throw new ApiError(503, 'xiaohongshu_browser_unavailable', '服务器需要安装 Chrome / Chromium 或设置 XHS_BROWSER_PATH')
      this.browser = chromium.launch({ executablePath, headless: true, chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1', args: ['--disable-dev-shm-usage'] }).then(browser => {
        browser.on('disconnected', () => { this.browser = null }); return browser
      }).catch(() => { this.browser = null; throw new ApiError(503, 'xiaohongshu_browser_unavailable', '无法启动小红书浏览器，请检查配置') })
    }
    const browser = await this.browser
    const context = await browser.newContext({ storageState: state, locale: 'zh-CN', viewport: { width: 1280, height: 1000 }, userAgent: xhsUserAgent(browser.version()) })
    context.setDefaultTimeout(15_000)
    return context
  }
  private async security(page: Page): Promise<void> {
    const text = await page.locator('body').innerText()
    if (/安全验证|安全限制|访问异常|IP存在风险|请完成验证|拖动滑块|操作频繁|账号异常/.test(text)) throw new ApiError(409, 'xiaohongshu_security_check', '小红书要求安全验证或限制了当前网络，请更换网络环境或稍后重试')
  }
  private async currentIdentity(page: Page): Promise<XhsIdentity | null> {
    return page.evaluate(() => {
      const unwrap = (value: unknown): unknown => {
        if (value && typeof value === 'object') {
          if ('value' in value) return value.value
          if ('_value' in value) return value._value
        }
        return value
      }
      const root = globalThis as unknown as {
        __INITIAL_STATE__?: { user?: { loggedIn?: unknown; userInfo?: unknown } }
        document?: { querySelector: (selector: string) => { getAttribute: (name: string) => string | null } | null }
      }
      const state = root.__INITIAL_STATE__?.user
      const user = unwrap(state?.userInfo) as { guest?: boolean; nickname?: string; userId?: string; user_id?: string } | undefined
      // Read only the current user's sidebar link, never profile links in the feed.
      const ownLink = root.document?.querySelector('.main-container .user a[href*="/user/profile/"], .side-bar .user a[href*="/user/profile/"], .side-bar-component.user a[href*="/user/profile/"]')
      const href = ownLink?.getAttribute('href') || ''
      const profile = href.match(/^(?:https:\/\/www\.xiaohongshu\.com)?\/user\/profile\/([a-f0-9]{24})(?:[/?#]|$)/)
      const id = user?.userId || user?.user_id
      if (user?.guest !== true && typeof id === 'string' && /^[a-f0-9]{24}$/.test(id) && (unwrap(state?.loggedIn) === true || user?.guest === false || profile?.[1] === id)) {
        return { accountId: id, name: user?.nickname || '小红书账号' }
      }
      if (profile) return { accountId: profile[1], name: user?.nickname || '小红书账号' }
      return null
    })
  }
  private async identity(page: Page): Promise<XhsIdentity> {
    await this.security(page)
    const identity = await this.currentIdentity(page)
    if (!identity) throw expired()
    return identity
  }
  async beginLogin(): Promise<XhsLoginAttempt> {
    const context = await this.context(), page = await context.newPage()
    const deadline = Date.now() + 5 * 60_000
    let closed = false, qrMissingSince: number | null = null, refreshed = false
    const close = async () => { closed = true; await context.close().catch(() => {}) }
    try {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await this.security(page)
      const qr = page.locator(QR)
      if (!await qr.isVisible().catch(() => false)) {
        const login = page.locator(LOGIN).first()
        if (await login.isVisible().catch(() => false)) await login.click()
      }
      if (!await qr.isVisible().catch(() => false)) {
        const scan = page.getByText('扫码', { exact: true }).first()
        if (await scan.isVisible().catch(() => false)) await scan.click()
      }
      await qr.waitFor({ state: 'visible' })
    } catch (error) { await close(); if (error instanceof ApiError) throw error; throw new ApiError(502, 'xiaohongshu_login_failed', '无法获取官方二维码，请检查网络或稍后重试') }
    return { close, poll: async () => {
      if (closed || Date.now() > deadline) return { status: 'expired', qrCode: null, message: '二维码已过期，请重新连接' }
      await this.security(page)
      const identity = await this.currentIdentity(page)
      if (identity) return { status: 'connected', qrCode: null, message: '已连接小红书', identity, state: await context.storageState() }
      const text = await page.locator('body').innerText()
      if (/二维码已失效|二维码已过期/.test(text)) return { status: 'expired', qrCode: null, message: '二维码已过期，请重新连接' }
      const qr = page.locator(QR)
      const qrCode = await qr.isVisible().catch(() => false)
        ? await qr.screenshot({ type: 'png', timeout: 5000 }).then(buffer => `data:image/png;base64,${buffer.toString('base64')}`).catch(() => null)
        : null
      if (!qrCode) {
        qrMissingSince ??= Date.now()
        // Login updates the SPA but can leave __INITIAL_STATE__ as a guest snapshot.
        if (!refreshed && Date.now() - qrMissingSince >= 5000) {
          refreshed = true
          await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          await this.security(page)
          const identity = await this.currentIdentity(page)
          if (identity) return { status: 'connected', qrCode: null, message: '已连接小红书', identity, state: await context.storageState() }
        }
        if (Date.now() - qrMissingSince >= 60_000) return { status: 'failed', qrCode: null, message: '扫码后仍未取得有效登录状态，请确认手机已同意登录，再重新获取二维码' }
        return { status: 'scanned', qrCode: null, message: '二维码已关闭，正在确认登录状态；如手机仍有确认提示，请同意登录' }
      }
      qrMissingSince = null
      const scanned = /扫码成功|已扫码|在手机上确认/.test(text)
      return { status: scanned ? 'scanned' : 'waiting', qrCode, message: scanned ? '请在小红书 App 确认登录' : '请用小红书 App 扫描官方二维码' }
    } }
  }
  async checkSession(state: PublisherStorageState) {
    const context = await this.context(state)
    try {
      const page = await context.newPage()
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await this.security(page)
      await page.waitForFunction(() => {
        const root = globalThis as unknown as {
          __INITIAL_STATE__?: { user?: { loggedIn?: boolean | { value?: boolean; _value?: boolean } } }
          document?: { querySelector: (selector: string) => unknown }
        }
        const flag = root.__INITIAL_STATE__?.user?.loggedIn
        return flag === true || typeof flag === 'object' && (flag?.value === true || flag?._value === true) || !!root.document?.querySelector('.login-container .qrcode-img, .user a[href*="/user/profile/"]')
      }, undefined, { timeout: 15_000 })
      const identity = await this.identity(page)
      return { state: await context.storageState(), identity }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'xiaohongshu_check_failed', '小红书连接检查未完成，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }
  async checkPublication(state: PublisherStorageState, _remoteId: string, _title: string) {
    // shortcut: no reliable public query for creator publish results; require manual verification.
    return { state, status: 'unknown' as const, url: null, message: '请在小红书创作中心核实笔记，再选择已发布或未发布' }
  }
  async publish(state: PublisherStorageState, article: XhsArticle, progress: (value: Partial<Pick<XhsPublication, 'message'>>) => void) {
    const context = await this.context(state)
    let submitted = false, stage = '打开创作中心'
    const step = (message: string) => { stage = message; progress({ message: `正在${message}` }) }
    try {
      const page = await context.newPage()
      step('打开创作中心')
      await page.goto(CREATOR, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await this.security(page)
      if (new URL(page.url()).pathname.includes('login')) throw expired()
      step('切换到上传图文')
      await clickXhsImageTab(page)
      for (const [index, image] of [...article.images.values()].entries()) {
        await this.security(page)
        step(`上传图片 ${index + 1}/${article.images.size}`)
        await page.locator(XHS_IMAGE_INPUT).first().setInputFiles({ name: image.name, mimeType: image.mimeType, buffer: image.buffer })
        step(`等待图片处理 ${index + 1}/${article.images.size}`)
        await page.locator('.img-preview-area .pr').nth(index).waitFor({ state: 'visible', timeout: 60_000 })
      }
      const title = page.locator('div.d-input input').first(), body = page.locator('.tiptap[contenteditable="true"], [role="textbox"][contenteditable="true"]').first()
      step('填写标题')
      await title.fill(article.title)
      step('填写正文')
      await body.fill(article.body)
      if (await title.inputValue() !== article.title || normalizeXhsEditorText(xhsEditorText(await body.innerHTML())) !== normalizeXhsEditorText(article.body)) throw new ApiError(409, 'xiaohongshu_content_mismatch', '小红书编辑器内容与预期不同，已停止发布')
      await this.security(page)
      step('检查发布按钮')
      const button = page.locator('xhs-publish-btn:not([is-publish="false"]):visible, .publish-page-publish-btn button.bg-red:visible').first()
      await button.waitFor({ state: 'visible' })
      if (await button.getAttribute('submit-disabled') === 'true' || await button.isDisabled()) throw new ApiError(409, 'xiaohongshu_publish_disabled', '小红书发布按钮不可用，请检查内容与账号权限')
      step('提交小红书审核')
      const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).hostname.endsWith('.xiaohongshu.com') && /\/api\/sns\/web\/v\d+\/note(?:\/publish)?$/.test(new URL(r.url()).pathname), { timeout: 20_000 }).catch(() => null)
      submitted = true
      await button.click()
      const upstream = await response
      const confirmed = upstream?.ok() ? xhsPublishedResult(await upstream.json().catch(() => null)) : null
      if (!confirmed) throw new ApiError(409, 'xiaohongshu_result_uncertain', '提交结果未得到明确确认，请在小红书创作中心核实，系统不会自动重发')
      return { state: await context.storageState(), status: 'published' as const, ...confirmed, message: '小红书已确认提交成功，最终展示以平台审核结果为准' }
    } catch (error) {
      if (submitted) throw new ApiError(409, 'xiaohongshu_result_uncertain', '已尝试提交，结果待核实。请检查小红书创作中心后确认结果')
      if (error instanceof ApiError) throw error
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      console.warn(`[multipush:xiaohongshu] preparation_failed stage=${stage} reason=${timedOut ? 'timeout' : 'operation_failed'}`)
      throw new ApiError(502, 'xiaohongshu_prepare_failed', `小红书${stage}${timedOut ? '超时' : '失败'}，尚未提交，请检查网络和创作中心页面后重试`)
    } finally { await context.close().catch(() => {}) }
  }
  async close(): Promise<void> { if (this.browser) await (await this.browser).close().catch(() => {}); this.browser = null }
}
