import { chromium, type APIResponse, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { load } from 'cheerio'
import type { BaijiahaoPublication } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import type { PublisherImage } from './publisher-image'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'
import { qrReady } from './qr-capture'

export interface BaijiahaoIdentity { accountId: string; name: string }
export interface BaijiahaoArticle { title: string; html: string; text: string; mode: 'draft' | 'publish'; images: PublisherImage[] }
export interface BaijiahaoLoginAttempt {
  poll(): Promise<{ status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'; qrCode: string | null; message: string; state?: PublisherStorageState; identity?: BaijiahaoIdentity }>
  close(): Promise<void>
}
export interface BaijiahaoDriver {
  beginLogin(): Promise<BaijiahaoLoginAttempt>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: BaijiahaoIdentity }>
  checkPublication(state: PublisherStorageState, remoteId: string, title: string): Promise<{ state: PublisherStorageState; status: 'published' | 'missing' | 'unknown'; url: string | null; message: string }>
  publish(state: PublisherStorageState, article: BaijiahaoArticle, progress: (value: Partial<Pick<BaijiahaoPublication, 'message' | 'remoteId' | 'url'>>) => void): Promise<{ state: PublisherStorageState; status: 'draft' | 'published'; remoteId: string; url: string; message: string }>
  close(): Promise<void>
}

const HOME = 'https://baijiahao.baidu.com/'
const LOGIN = 'https://baijiahao.baidu.com/builder/theme/bjh/login'
const EDITOR = 'https://baijiahao.baidu.com/builder/rc/edit?type=news'
const LOGIN_INFO = 'https://baijiahao.baidu.com/userb/user/loginInfo'
const APP_INFO = 'https://baijiahao.baidu.com/builder/app/appinfo'
// Only the passport login QR. `img[class*="qrcode"]` also matches the marketing
// "下载百度APP / 创作中心" cards, which appear earlier in the DOM, so Playwright's
// `.first()` used to return those and we displayed the wrong QR entirely.
const QR = 'img.tang-pass-qrcode-img, img[src*="passport.baidu.com/v2/api/qrcode"]'
const TITLE = '[data-testid="news-title-input"] [contenteditable="true"], #newsTextArea [contenteditable="true"], [contenteditable="true"][placeholder*="标题"], textarea[placeholder*="标题"], input[placeholder*="标题"]'
const BODY_FRAME = '#ueditor_0'
const SESSION_ERRORS = [20040001, 10001401, 217100002]
type Data = Record<string, unknown>
function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {} }
function json(text: string): unknown { try { return JSON.parse(text) } catch { return null } }
const expired = () => new ApiError(409, 'baijiahao_session_expired', '百家号登录状态已失效，请重新扫码连接')
function log(...parts: unknown[]): void { console.log('[baijiahao]', ...parts) }
let lastProfileLog = 0
function logThrottled(...parts: unknown[]): void {
  if (Date.now() - lastProfileLog < 30_000) return
  lastProfileLog = Date.now()
  log(...parts)
}

/** Pulls the account out of a `{errno, data}` payload without assuming one exact shape. */
export function parseBaijiahaoProfile(value: unknown): BaijiahaoIdentity | null {
  const root = object(value)
  const code = Number(root.errno ?? root.code ?? root.status ?? -1)
  if (code !== 0) return null
  const data = object(root.data)
  const user = object(data.user)
  const pick = (keys: string[]): string => {
    for (const bag of [data, user]) {
      for (const key of keys) {
        const raw = bag[key]
        if (typeof raw === 'string' && raw.trim()) return raw.trim()
        if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
      }
    }
    return ''
  }
  const id = pick(['userid', 'user_id', 'author_id', 'authorid', 'uid', 'id'])
  const name = pick(['uname', 'name', 'nickname', 'author_name', 'authorname', 'screen_name'])
  if (!id && !name) return null
  return { accountId: id, name: name || '百家号作者' }
}

/** Finds an article id in the publish response, preferring explicit id fields. */
export function parseBaijiahaoPublished(value: unknown): { remoteId: string; url: string } | null {
  const root = object(value)
  if (Number(root.errno ?? root.code ?? -1) !== 0) return null
  const data = object(root.data)
  for (const key of ['id', 'article_id', 'articleId', 'nid', 'content_id', 'contentId', 'url']) {
    const raw = data[key]
    if (typeof raw !== 'string' && typeof raw !== 'number') continue
    const text = String(raw)
    const direct = /^\d{10,30}$/.test(text) ? text : null
    const fromUrl = /[?&]id=(\d{10,30})/.exec(text)?.[1] ?? null
    const id = direct ?? fromUrl
    if (id) return { remoteId: id, url: `https://baijiahao.baidu.com/s?id=${id}` }
  }
  // Some responses wrap the article in `data.article` or a list.
  const nested = object(data.article ?? data.data)
  const rawId = nested.id ?? nested.article_id ?? nested.articleId
  if (typeof rawId === 'string' || typeof rawId === 'number') {
    const id = String(rawId)
    if (/^\d{10,30}$/.test(id)) return { remoteId: id, url: `https://baijiahao.baidu.com/s?id=${id}` }
  }
  return null
}

export class PlaywrightBaijiahaoDriver implements BaijiahaoDriver {
  private browser: Promise<Browser> | null = null

  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = publisherExecutablePath('baijiahao')
      if (!executablePath) throw new ApiError(503, 'baijiahao_browser_unavailable', '服务器未安装可用的 Chrome / Chromium 浏览器')
      this.browser = chromium.launch({ executablePath, headless: true, chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1', args: ['--disable-dev-shm-usage'] }).then(browser => {
        browser.on('disconnected', () => { this.browser = null })
        return browser
      }).catch(() => { this.browser = null; throw new ApiError(503, 'baijiahao_browser_unavailable', '无法启动百家号浏览器，请检查服务器浏览器配置') })
    }
    const context = await (await this.browser).newContext({ storageState: state, locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(20_000)
    return context
  }

  private async readJson(response: APIResponse | null): Promise<unknown> {
    if (!response) return null
    return json(await response.text().catch(() => ''))
  }

  private async profile(context: BrowserContext): Promise<BaijiahaoIdentity | null> {
    const headers = { 'x-requested-with': 'XMLHttpRequest', Referer: `${HOME}builder/rc/home`, Accept: 'application/json' }
    const info = await this.readJson(await context.request.get(LOGIN_INFO, { headers, timeout: 20_000 }).catch(() => null))
    const identity = parseBaijiahaoProfile(info)
    if (identity) return identity
    const root = object(info)
    logThrottled('loginInfo did not report an account', 'errno=' + String(root.errno ?? root.code), 'keys=' + JSON.stringify(Object.keys(object(root.data))))
    // The builder shell exposes the same session through its app bootstrap.
    const app = await this.readJson(await context.request.get(APP_INFO, { headers, timeout: 20_000 }).catch(() => null))
    const fallback = parseBaijiahaoProfile(app)
    if (fallback) return fallback
    const appRoot = object(app)
    if (Number(appRoot.errno) !== 0) logThrottled('appinfo', 'errno=' + String(appRoot.errno))
    return null
  }

  private async security(page: Page): Promise<void> {
    const text = await page.locator('body').innerText().catch(() => '')
    if (/安全验证|风险验证|环境异常|请完成验证|开始验证/.test(text) || /wappass\.baidu\.com|verify|vcode/i.test(page.url())) {
      throw new ApiError(409, 'baijiahao_security_check', '百家号要求安全验证，已停止操作；请在官方页面完成验证后重新连接')
    }
  }

  private async loginPromptVisible(page: Page): Promise<boolean> {
    if (/\/login|passport\.baidu\.com/.test(page.url())) return true
    return page.getByText('扫码登录', { exact: false }).first().isVisible().catch(() => false)
  }

  async beginLogin(): Promise<BaijiahaoLoginAttempt> {
    const context = await this.context(), page = await context.newPage()
    let closed = false, qrCode: string | null = null, signedInAt = 0
    const close = async () => { if (!closed) { closed = true; await context.close().catch(() => {}) } }
    const deadline = Date.now() + 5 * 60_000
    const readQr = async (): Promise<string | null> => {
      const qr = page.locator(QR).first()
      if (!await qr.isVisible().catch(() => false)) return null
      // The page renders the QR at 100px but the source PNG is 265px, so fetch it.
      const src = await qr.getAttribute('src').catch(() => null)
      if (src && !/passport\.baidu\.com\/v2\/api\/qrcode/.test(src)) {
        log('ignoring non-login QR image', src.slice(0, 120))
        return null
      }
      if (src) {
        try {
          const response = await context.request.get(new URL(src, page.url()).href, { timeout: 15_000 })
          if (response.ok()) {
            const type = response.headers()['content-type'] || 'image/png'
            if (type.startsWith('image/')) return `data:${type.split(';')[0]};base64,${(await response.body()).toString('base64')}`
          }
        } catch { /* fall back to the element screenshot */ }
      }
      await qrReady(qr)
      return `data:image/png;base64,${(await qr.screenshot({ type: 'png', timeout: 5_000 })).toString('base64')}`
    }
    try {
      const response = await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (response?.status() === 403) throw new ApiError(409, 'baijiahao_security_check', '百家号登录页要求安全验证，请稍后重试')
      const trigger = page.getByText('登录', { exact: true }).first()
      if (await trigger.isVisible().catch(() => false)) await trigger.click({ timeout: 10_000 }).catch(() => {})
      await page.locator(QR).first().waitFor({ state: 'visible', timeout: 20_000 })
      qrCode = await readQr()
      log('login QR ready')
    } catch (error) {
      await close()
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'baijiahao_login_unavailable', '无法取得百家号官方登录二维码，请检查服务器网络或稍后重试')
    }
    return {
      close,
      poll: async () => {
        if (closed || Date.now() > deadline) return { status: 'expired', qrCode: null, message: '百家号登录二维码已过期，请重新获取' }
        const text = await page.locator('body').innerText().catch(() => '')
        if (/二维码已过期|二维码失效/.test(text)) return { status: 'expired', qrCode: null, message: '二维码已失效，请重新获取' }
        if (/安全验证|风险验证|环境异常/.test(text)) throw new ApiError(409, 'baijiahao_security_check', '百家号要求安全验证，请在官方页面完成验证后重新连接')
        const cookies = await context.cookies().catch(() => [])
        const signedIn = cookies.some(cookie => cookie.name === 'BDUSS' && cookie.value && /(^|\.)baidu\.com$/i.test(cookie.domain))
        if (signedIn) {
          if (!signedInAt) signedInAt = Date.now()
          const identity = await this.profile(context).catch(() => null)
          if (identity) {
            log('login completed', identity.accountId || '(uid unavailable)')
            return { status: 'connected', qrCode: null, message: '百家号已登录，登录状态已保存', state: await context.storageState(), identity }
          }
          // Never keep the user stuck on the nickname lookup once BDUSS exists.
          if (Date.now() - signedInAt > 8_000) {
            log('identity lookup kept failing; saving the session with a placeholder name')
            return { status: 'connected', qrCode: null, message: '百家号已登录，登录状态已保存', state: await context.storageState(), identity: { accountId: '', name: '百家号作者' } }
          }
          log('BDUSS cookie present but identity lookup failed; will retry')
        }
        const next = await readQr().catch(() => null)
        if (next) qrCode = next
        const scanned = /扫描成功|扫码成功|已扫描|请在手机.{0,8}确认|确认登录|登录成功/.test(text) || !await this.loginPromptVisible(page)
        return {
          status: scanned ? 'scanned' : 'waiting',
          qrCode,
          message: signedIn
            ? '百家号已登录，正在读取账号信息…'
            : scanned ? '已扫描，请在百度 App 中点击确认登录' : '请使用百度 App 扫描二维码登录',
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
      throw new ApiError(502, 'baijiahao_check_failed', '百家号连接检查未完成，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async checkPublication(state: PublisherStorageState, remoteId: string, title: string) {
    if (!/^\d{10,30}$/.test(remoteId)) throw new ApiError(400, 'baijiahao_article_invalid', '百家号文章编号无效')
    const context = await this.context(state)
    try {
      const response = await context.request.get(`https://baijiahao.baidu.com/s?id=${encodeURIComponent(remoteId)}`, { timeout: 20_000, headers: { Accept: 'text/html' } })
      if (response.status() === 404) return { state: await context.storageState(), status: 'missing' as const, url: null, message: '百家号文章不存在，可能已删除' }
      const html = await response.text().catch(() => '')
      const $ = load(html)
      const found = $('meta[property="og:title"]').attr('content') || $('title').text()
      if (response.status() === 200 && found && (!title || found.includes(title.slice(0, 10)))) {
        return { state: await context.storageState(), status: 'published' as const, url: `https://baijiahao.baidu.com/s?id=${remoteId}`, message: '已重新核实：百家号文章已发布' }
      }
      return { state: await context.storageState(), status: 'unknown' as const, url: null, message: response.status() === 200 && found ? '百家号文章存在，但标题与提交内容不一致，请人工核对' : '百家号暂未返回可确认的发布结果，请到百家号后台核对' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'baijiahao_check_failed', '重新核实百家号结果未完成，请稍后重试或人工核实')
    } finally { await context.close().catch(() => {}) }
  }

  private async dismiss(page: Page): Promise<void> {
    for (const label of ['我知道了', '知道了', '暂不开启', '关闭']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.isVisible().catch(() => false)) await button.click().catch(() => {})
    }
  }

  /** Fills the UEditor body, preferring its JS API over fragile DOM typing. */
  private async fillBody(page: Page, article: BaijiahaoArticle): Promise<void> {
    const viaApi = await page.evaluate(html => {
      const scope = globalThis as unknown as { editor?: { setContent?: (value: string) => void; sync?: () => void }; UE?: { getEditor?: (id: string) => { setContent?: (value: string) => void; sync?: () => void } | undefined } }
      const editor = scope.editor?.setContent ? scope.editor : scope.UE?.getEditor?.('editor')
      if (!editor?.setContent) return false
      editor.setContent(html)
      editor.sync?.()
      return true
    }, article.html).catch(() => false)
    if (viaApi) { await page.waitForTimeout(1_200); return }
    const frame = page.frameLocator(BODY_FRAME).locator('body').first()
    await frame.waitFor({ state: 'visible', timeout: 15_000 })
    await frame.evaluate((node, html) => {
      type EventCtor = new (type: string, init?: { bubbles?: boolean }) => unknown
      const body = node as unknown as {
        innerHTML: string
        dispatchEvent: (event: unknown) => boolean
        ownerDocument?: { defaultView?: { Event?: EventCtor; InputEvent?: EventCtor } }
      }
      body.innerHTML = html
      const view = body.ownerDocument?.defaultView
      const Input = view?.InputEvent ?? view?.Event
      if (Input) body.dispatchEvent(new Input('input', { bubbles: true }))
      if (view?.Event) body.dispatchEvent(new view.Event('change', { bubbles: true }))
    }, article.html).catch(async () => {
      await frame.click()
      await page.keyboard.insertText(article.text)
    })
    await page.waitForTimeout(1_200)
    const content = await frame.innerText().catch(() => '')
    if (article.text.trim() && !content.includes(article.text.trim().slice(0, 20))) {
      await frame.click()
      await page.keyboard.insertText(article.text)
      await page.waitForTimeout(600)
    }
  }

  /** Compact page snapshot written to journald when the editor or publish step fails. */
  private async diagnostics(page: Page): Promise<string> {
    const counts: string[] = []
    for (const selector of [TITLE, BODY_FRAME, 'button']) {
      counts.push(`${selector}=${await page.locator(selector).count().catch(() => 0)}`)
    }
    const body = await page.locator('body').innerText().catch(() => '')
    return `url=${page.url()} ; ${counts.join(' ; ')} ; body=${JSON.stringify(body.replace(/\s+/g, ' ').slice(0, 240))}`
  }

  async publish(state: PublisherStorageState, article: BaijiahaoArticle, progress: Parameters<BaijiahaoDriver['publish']>[2]) {
    const context = await this.context(state)
    let submitted = false, page: Page | null = null
    try {
      page = await context.newPage()
      await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      await this.security(page)
      if (await this.loginPromptVisible(page)) throw expired()
      const identity = await this.profile(context)
      if (!identity) throw expired()
      await this.dismiss(page)

      progress({ message: '正在填写百家号标题' })
      const title = page.locator(TITLE).first()
      await title.waitFor({ state: 'visible', timeout: 30_000 })
      await title.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.insertText(article.title)
      await page.waitForTimeout(300)
      const typed = await title.innerText().catch(() => '')
      if (!typed.includes(article.title.slice(0, 6))) throw new ApiError(409, 'baijiahao_title_mismatch', '百家号标题未填写成功，已停止发布')
      log('title filled')

      progress({ message: '正在填写百家号正文' })
      await this.fillBody(page, article)
      await this.security(page)
      log('body filled')

      progress({ message: '正在提交百家号发布' })
      const responsePromise = page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.hostname === 'baijiahao.baidu.com' && /\/pcui\/article\/publish\/?$/.test(url.pathname) && response.request().method() === 'POST'
      }, { timeout: 60_000 }).catch(() => null)
      // Never use has-text here: it would also match 定时发布.
      const publishButton = page.locator('button').filter({ hasText: /^\s*发布\s*$/ }).first()
      await publishButton.waitFor({ state: 'visible', timeout: 20_000 })
      if (!await publishButton.isEnabled()) throw new ApiError(409, 'baijiahao_publish_disabled', '百家号发布按钮不可用，请检查标题、正文和账号状态')
      submitted = true
      await publishButton.click({ timeout: 20_000 })
      await page.waitForTimeout(1_500)
      for (const label of ['确认发布', '确定', '确认']) {
        const confirm = page.locator('button').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).last()
        if (await confirm.isVisible().catch(() => false)) { await confirm.click().catch(() => {}); break }
      }
      const response = await responsePromise
      if (!response) {
        const body = await page.locator('body').innerText().catch(() => '')
        if (/发布成功|审核中|已提交|已发布/.test(body)) throw new ApiError(409, 'baijiahao_result_uncertain', '页面提示已提交，但未取得文章编号；请到百家号后台核对')
        throw new ApiError(409, 'baijiahao_result_uncertain', '已提交百家号，但未确认发布结果；请到百家号后台核对，避免重复发布')
      }
      const data = object(await response.json().catch(() => null))
      const errno = Number(data.errno ?? data.code ?? NaN)
      log('publish response', 'errno=' + String(errno), 'keys=' + JSON.stringify(Object.keys(data)))
      if (SESSION_ERRORS.includes(errno)) throw expired()
      if (errno !== 0) {
        const message = typeof data.errmsg === 'string' ? data.errmsg : typeof data.message === 'string' ? data.message : ''
        throw new ApiError(502, 'baijiahao_rejected', `百家号未确认发布成功${message ? `：${message}` : ''}`)
      }
      const result = parseBaijiahaoPublished(data)
      if (!result) throw new ApiError(409, 'baijiahao_result_uncertain', '百家号已受理，但未返回有效文章编号；请到百家号后台核对')
      return { state: await context.storageState(), status: 'published' as const, remoteId: result.remoteId, url: result.url, message: '百家号文章已发布' }
    } catch (error) {
      if (submitted && !(error instanceof ApiError && ['baijiahao_session_expired', 'baijiahao_security_check'].includes(error.code))) {
        throw new ApiError(409, 'baijiahao_result_uncertain', error instanceof ApiError ? error.message : '百家号提交后结果未确认；请到后台核对，避免重复发布')
      }
      if (page) log('publish failed', await this.diagnostics(page).catch(() => 'diagnostics unavailable'))
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'baijiahao_preparation_failed', '百家号发布准备失败，尚未提交；请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null
    if (browser) await browser.then(value => value.close()).catch(() => {})
  }
}
