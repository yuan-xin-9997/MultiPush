import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { load } from 'cheerio'
import type { DoubanPrivacy } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import type { PublisherImage } from './publisher-image'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'
import { qrReady } from './qr-capture'
import { doubanNoteUrl, verifyDoubanContent } from './douban-content'

export interface DoubanIdentity { accountId: string; name: string }
export interface DoubanArticle {
  title: string
  html: string
  text: string
  images: Map<string, PublisherImage>
  privacy: DoubanPrivacy
  tags: string[]
}
export interface DoubanLoginAttempt {
  poll(): Promise<{ status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'; qrCode: string | null; message: string; state?: PublisherStorageState; identity?: DoubanIdentity }>
  close(): Promise<void>
}
export interface DoubanDriver {
  beginLogin(): Promise<DoubanLoginAttempt>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: DoubanIdentity }>
  checkPublication(state: PublisherStorageState, remoteId: string, title: string): Promise<{ state: PublisherStorageState; status: 'published' | 'missing' | 'unknown'; url: string | null; message: string }>
  publish(state: PublisherStorageState, article: DoubanArticle, progress: (value: { message: string }) => void): Promise<{ state: PublisherStorageState; status: 'published'; remoteId: string; url: string; message: string }>
  close(): Promise<void>
}

const HOME = 'https://www.douban.com/'
const LOGIN = 'https://accounts.douban.com/passport/login?prefer_login_way=qrcode'
const MINE = 'https://www.douban.com/mine/'
const NOTE_CREATE = 'https://www.douban.com/note/create'
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const QR_SELECTORS = [
  '.account-qr-scan img',
  '.account-qr-code img',
  '[class*="qrcode"] img',
  '[class*="qr-code"] img',
  '[class*="login-qr"] img',
  'img[src^="data:image"]',
  'img[src*="qrcode"]',
  'img[src*="qr"]',
  'canvas[class*="qr"]',
]
const EXPIRED_TEXT = /二维码已过期|二维码失效|登录已过期|请重新登录/
const SECURITY_TEXT = /安全验证|风险验证|环境异常|请完成验证|验证码|need_captcha/i
type Data = Record<string, unknown>
function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {} }
const expired = () => new ApiError(409, 'douban_session_expired', '豆瓣登录状态已失效，请重新扫码连接')
const uncertain = (message: string) => new ApiError(502, 'douban_result_uncertain', message)
function log(...parts: unknown[]): void { console.log('[douban]', ...parts) }

/** The web session cookie starts with the numeric user id, e.g. `1234567:abc`. */
export function parseDoubanUidFromSession(value: string | null | undefined): string | null {
  const normalized = (value ?? '').trim().replace(/^"|"$/g, '')
  const match = /^(\d{5,20}):/.exec(normalized)
  return match?.[1] ?? null
}

/** Douban may send `dbcl2="123:..."`; browser APIs can preserve the quotes. */
function cookieValue(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^"|"$/g, '')
}

/** Extract a display name from /mine or a profile page. */
export function parseDoubanIdentity(html: string, uid: string, fallback = '豆瓣用户'): DoubanIdentity {
  const $ = load(html)
  const title = $('meta[property="og:title"]').attr('content') || $('.info h1').text() || $('#db-usr-profile .info h1').text() || $('title').text()
  const name = title
    .replace(/\s*[-–—|]\s*豆瓣.*$/i, '')
    .replace(/的日记.*$/, '')
    .replace(/^豆瓣\s*/, '')
    .trim()
  return { accountId: uid, name: name || fallback }
}

/** Accept the shapes returned by the note save endpoints and redirects. */
export function parseDoubanNoteResult(value: unknown, location?: string | null): { remoteId: string; url: string } | null {
  const candidates: unknown[] = [value]
  if (location) candidates.push(location)
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^\d{6,30}$/.test(text)) return { remoteId: text, url: doubanNoteUrl(text) }
    const fromText = /(?:www\.)?douban\.com\/note\/(\d{6,30})/.exec(text)?.[1]
    if (fromText) return { remoteId: fromText, url: doubanNoteUrl(fromText) }
    try { candidates.push(JSON.parse(text)) } catch { /* not JSON */ }
  }
  const visit = (raw: unknown, depth: number): { remoteId: string; url: string } | null => {
    if (depth > 3 || raw === null || raw === undefined) return null
    if (typeof raw === 'string') {
      if (/^\d{6,30}$/.test(raw.trim())) return { remoteId: raw.trim(), url: doubanNoteUrl(raw.trim()) }
      const match = /(?:www\.)?douban\.com\/note\/(\d{6,30})/.exec(raw)
      return match ? { remoteId: match[1], url: doubanNoteUrl(match[1]) } : null
    }
    if (typeof raw === 'number') {
      const id = String(raw)
      return /^\d{6,30}$/.test(id) ? { remoteId: id, url: doubanNoteUrl(id) } : null
    }
    if (typeof raw !== 'object') return null
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const found = visit(item, depth + 1)
        if (found) return found
      }
      return null
    }
    const record = raw as Data
    for (const key of ['url', 'note_url', 'noteUrl', 'link']) {
      const value = record[key]
      if (typeof value === 'string') {
        const match = /(?:www\.)?douban\.com\/note\/(\d{6,30})/.exec(value)
        if (match) return { remoteId: match[1], url: doubanNoteUrl(match[1]) }
      }
    }
    for (const key of ['id', 'note_id', 'noteId', 'nid', 'noteid']) {
      const found = visit(record[key], depth + 1)
      if (found) return found
    }
    for (const key of ['data', 'note', 'result']) {
      if (record[key] !== undefined) {
        const found = visit(record[key], depth + 1)
        if (found) return found
      }
    }
    return null
  }
  for (const candidate of candidates) {
    const found = visit(candidate, 0)
    if (found) return found
  }
  return null
}

/** Find an uploaded Douban image URL in the upload endpoint response. */
export function parseDoubanUploadUrl(value: unknown): string | null {
  const visit = (raw: unknown, depth: number): string | null => {
    if (depth > 4 || raw === null || raw === undefined) return null
    if (typeof raw === 'string') {
      const text = raw.trim()
      if (text.startsWith('//') && /(?:doubanio\.com|douban\.com)\//i.test(text)) return `https:${text}`
      if (/^https?:\/\/[^\s"'<>]+$/i.test(text) && /(?:doubanio\.com|douban\.com)\//i.test(text)) return text
      try { return visit(JSON.parse(text), depth + 1) } catch { return null }
    }
    if (typeof raw !== 'object') return null
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const found = visit(item, depth + 1)
        if (found) return found
      }
      return null
    }
    const record = raw as Data
    for (const key of ['url', 'src', 'image', 'image_url', 'imageUrl', 'photo', 'path']) {
      const found = visit(record[key], depth + 1)
      if (found) return found
    }
    for (const key of ['data', 'result', 'photo']) {
      const found = visit(record[key], depth + 1)
      if (found) return found
    }
    return null
  }
  return visit(value, 0)
}

export class PlaywrightDoubanDriver implements DoubanDriver {
  private browser: Promise<Browser> | null = null

  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = publisherExecutablePath('douban')
      if (!executablePath) throw new ApiError(503, 'douban_browser_unavailable', '服务器未安装可用的 Chrome / Chromium 浏览器')
      this.browser = chromium.launch({
        executablePath,
        headless: true,
        chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1',
        args: ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      }).then(browser => {
        browser.on('disconnected', () => { this.browser = null })
        return browser
      }).catch(() => { this.browser = null; throw new ApiError(503, 'douban_browser_unavailable', '无法启动豆瓣浏览器，请检查服务器浏览器配置') })
    }
    const context = await (await this.browser).newContext({
      storageState: state,
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
      userAgent: DESKTOP_UA,
    })
    context.setDefaultTimeout(20_000)
    // Douban serves the React login app from a font-CDN host that Chrome's ORB
    // can block in headless mode. Fetch those scripts through Playwright's HTTP
    // stack (same cookies/UA, no ORB) and fulfill them for the page.
    await context.route('https://asset.doubanio.com/**', async route => {
      try {
        const response = await context.request.fetch(route.request(), {
          timeout: 30_000,
          headers: { ...route.request().headers(), referer: 'https://accounts.douban.com/' },
        })
        await route.fulfill({ response })
      } catch {
        await route.abort()
      }
    })
    return context
  }

  private async session(context: BrowserContext): Promise<{ uid: string; ck: string; name: string } | null> {
    let cookies = await context.cookies().catch(() => [])
    let dbcl2 = cookieValue(cookies.find(cookie => cookie.name === 'dbcl2' && /(^|\.)douban\.com$/i.test(cookie.domain))?.value)
    let ck = cookieValue(cookies.find(cookie => cookie.name === 'ck' && /(^|\.)douban\.com$/i.test(cookie.domain))?.value)
    if (!dbcl2 || !ck) {
      const page = await context.newPage()
      try {
        await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => null)
        await page.waitForTimeout(1_500)
        cookies = await context.cookies().catch(() => [])
        dbcl2 = cookieValue(cookies.find(cookie => cookie.name === 'dbcl2' && /(^|\.)douban\.com$/i.test(cookie.domain))?.value)
        ck = cookieValue(cookies.find(cookie => cookie.name === 'ck' && /(^|\.)douban\.com$/i.test(cookie.domain))?.value)
      } finally { await page.close().catch(() => {}) }
    }
    const uid = parseDoubanUidFromSession(dbcl2)
    if (!uid) return null
    let name = '豆瓣用户'
    try {
      const response = await context.request.get(MINE, { timeout: 20_000, headers: { Accept: 'text/html' } })
      if (response.ok()) {
        const identity = parseDoubanIdentity(await response.text(), uid, name)
        name = identity.name
      }
    } catch { /* Cookie identity is enough for the account to work. */ }
    return { uid, ck, name }
  }

  private async readQr(page: Page, context: BrowserContext): Promise<string | null> {
    for (const frame of page.frames()) {
      for (const selector of QR_SELECTORS) {
        const qr = frame.locator(selector).first()
        if (!await qr.isVisible().catch(() => false)) continue
        const src = await qr.getAttribute('src').catch(() => null)
        const size = await qr.evaluate((element) => {
          const image = element as unknown as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
          return { width: image.naturalWidth || image.width || 0, height: image.naturalHeight || image.height || 0 }
        }).catch(() => ({ width: 0, height: 0 }))
        // Ignore the 37px "scan to download App" icon and other small badges.
        if (size.width < 100 && !src?.startsWith('data:image')) continue
        if (src) {
          try {
            const response = await context.request.get(new URL(src, page.url()).href, { timeout: 15_000 })
            const type = response.headers()['content-type'] || 'image/png'
            if (response.ok() && type.startsWith('image/')) {
              return `data:${type.split(';')[0]};base64,${(await response.body()).toString('base64')}`
            }
          } catch { /* fall back to an element screenshot */ }
        }
        try {
          await qrReady(qr)
          return `data:image/png;base64,${(await qr.screenshot({ type: 'png', timeout: 5_000 })).toString('base64')}`
        } catch { /* try the next selector */ }
      }
    }
    // Some Douban login builds draw the QR in a panel without an image tag.
    const panel = page.locator('#app, .account-main, .login-wrap, .account-form').first()
    if (await panel.isVisible().catch(() => false)) {
      try { return `data:image/png;base64,${(await panel.screenshot({ type: 'png', timeout: 5_000 })).toString('base64')}` } catch { /* no QR */ }
    }
    return null
  }

  async beginLogin(): Promise<DoubanLoginAttempt> {
    const context = await this.context(), page = await context.newPage()
    let closed = false, qrCode: string | null = null
    const close = async () => { if (!closed) { closed = true; await context.close().catch(() => {}) } }
    const deadline = Date.now() + 5 * 60_000
    try {
      const response = await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (response?.status() === 403) throw new ApiError(409, 'douban_security_check', '豆瓣登录页要求安全验证，请稍后重试')
      await page.waitForTimeout(2_500)
      qrCode = await this.readQr(page, context)
      if (!qrCode) {
        // React apps on slower connections can render the QR after the first paint.
        await page.waitForTimeout(4_000)
        qrCode = await this.readQr(page, context)
      }
      if (!qrCode) throw new ApiError(502, 'douban_login_unavailable', '豆瓣登录页没有返回可识别的二维码；请检查服务器网络，或使用“打开豆瓣编辑器”手动发布')
      log('login QR ready')
    } catch (error) {
      await close()
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'douban_login_unavailable', '无法取得豆瓣官方登录二维码，请检查服务器网络或稍后重试')
    }
    return {
      close,
      poll: async () => {
        if (closed || Date.now() > deadline) return { status: 'expired', qrCode: null, message: '豆瓣登录二维码已过期，请重新获取' }
        const text = await page.locator('body').innerText().catch(() => '')
        if (EXPIRED_TEXT.test(text)) return { status: 'expired', qrCode: null, message: '豆瓣登录二维码已失效，请重新获取' }
        if (SECURITY_TEXT.test(text)) throw new ApiError(409, 'douban_security_check', '豆瓣要求安全验证，请在官方页面完成验证后重新连接')
        const session = await this.session(context).catch(() => null)
        if (session) {
          log('login completed', session.uid)
          return { status: 'connected', qrCode: null, message: '豆瓣已登录，登录状态已保存', state: await context.storageState(), identity: { accountId: session.uid, name: session.name } }
        }
        const next = await this.readQr(page, context).catch(() => null)
        if (next) qrCode = next
        const scanned = /扫描成功|扫码成功|已扫描|请在手机.{0,8}确认|确认登录|登录成功/.test(text) || /passport\/login/.test(page.url()) === false
        return {
          status: scanned ? 'scanned' : 'waiting',
          qrCode,
          message: scanned ? '已扫描，请在豆瓣 App 中确认登录' : '请使用豆瓣 App 扫描二维码登录',
        }
      },
    }
  }

  async checkSession(state: PublisherStorageState) {
    const context = await this.context(state)
    try {
      const session = await this.session(context)
      if (!session) throw expired()
      return { state: await context.storageState(), identity: { accountId: session.uid, name: session.name } }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'douban_check_failed', '豆瓣连接检查未完成，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  private async noteTitle(context: BrowserContext, url: string): Promise<{ status: number; title: string }> {
    const response = await context.request.get(url, { timeout: 20_000, headers: { Accept: 'text/html' } })
    const html = await response.text().catch(() => '')
    const $ = load(html)
    const title = $('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text()
    return { status: response.status(), title: title.trim() }
  }

  async checkPublication(state: PublisherStorageState, remoteId: string, title: string) {
    const context = await this.context(state)
    try {
      const url = doubanNoteUrl(remoteId)
      const result = await this.noteTitle(context, url)
      if (result.status === 404) return { state: await context.storageState(), status: 'missing' as const, url: null, message: '豆瓣日记不存在，可能已删除或未发布成功' }
      if (result.status === 200 && result.title && (!title || result.title.includes(title.slice(0, 10)))) {
        return { state: await context.storageState(), status: 'published' as const, url, message: '已重新核实：豆瓣日记已发布' }
      }
      return { state: await context.storageState(), status: 'unknown' as const, url: null, message: '豆瓣暂未返回可确认的发布结果，请到豆瓣日记列表核实' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'douban_check_failed', '豆瓣发布结果核实未完成，请稍后重试或到豆瓣核实')
    } finally { await context.close().catch(() => {}) }
  }

  private async uploadImage(context: BrowserContext, image: PublisherImage, ck: string): Promise<string> {
    const endpoints = ['https://www.douban.com/j/upload', 'https://www.douban.com/j/note/upload']
    let lastStatus = 0
    for (const endpoint of endpoints) {
      const response = await context.request.post(endpoint, {
        multipart: { file: image, ck, csrfmiddlewaretoken: ck },
        headers: { Referer: NOTE_CREATE, 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': ck },
        timeout: 30_000,
      }).catch(() => null)
      if (!response) continue
      lastStatus = response.status()
      const body = await response.text().catch(() => '')
      if (response.status() === 401 || response.status() === 403 || SECURITY_TEXT.test(body)) throw new ApiError(409, 'douban_security_check', '豆瓣要求安全验证，已停止发布；请在官方页面完成验证后重新连接')
      if (response.ok()) {
        const url = parseDoubanUploadUrl(body)
        if (url) return url
        throw new ApiError(502, 'douban_image_upload_failed', '豆瓣图片上传成功但未返回图片地址，已停止发布，请稍后重试')
      }
      if ([404, 405].includes(response.status())) continue
    }
    throw new ApiError(502, 'douban_image_upload_failed', `豆瓣图片上传未返回有效地址（HTTP ${lastStatus || '未知'}），已停止发布，请稍后重试`)
  }

  private async saveNote(context: BrowserContext, uid: string, ck: string, form: Record<string, string>): Promise<{ remoteId: string; url: string } | null> {
    const endpoints = [`https://www.douban.com/j/note/${encodeURIComponent(uid)}/_save`, `https://www.douban.com/j/note/${encodeURIComponent(uid)}/new_rich`]
    for (const endpoint of endpoints) {
      let response
      try {
        response = await context.request.post(endpoint, {
          form,
          headers: { Referer: NOTE_CREATE, Origin: 'https://www.douban.com', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': ck },
          timeout: 30_000,
        })
      } catch {
        throw uncertain('豆瓣保存请求已发出但未收到响应，结果未确认；请先到豆瓣日记列表核实，避免重复发布')
      }
      const body = await response.text().catch(() => '')
      if (response.status() === 401 || response.status() === 403 || SECURITY_TEXT.test(body)) {
        throw new ApiError(409, 'douban_security_check', '豆瓣要求安全验证，已停止发布；请在官方页面完成验证后重新连接')
      }
      if ([404, 405].includes(response.status())) continue
      if (!response.ok()) throw new ApiError(502, 'douban_publish_failed', `豆瓣保存日记失败（HTTP ${response.status()}），请稍后重试`)
      return parseDoubanNoteResult(body, response.headers()['location'])
    }
    throw new ApiError(502, 'douban_publish_unavailable', '豆瓣日记保存接口不可用，可能已改版；请使用“复制富文本/打开豆瓣编辑器”手动发布')
  }

  async publish(state: PublisherStorageState, article: DoubanArticle, progress: (value: { message: string }) => void) {
    const context = await this.context(state)
    try {
      const session = await this.session(context)
      if (!session) throw expired()
      if (!session.ck) throw new ApiError(409, 'douban_security_check', '豆瓣登录会话缺少写入校验 Cookie，请断开后重新扫码连接')
      let index = 0
      const uploaded = new Map<string, string>()
      for (const src of article.images.keys()) {
        progress({ message: `正在上传豆瓣图片 ${index + 1}/${article.images.size}` })
        const image = article.images.get(src)!
        uploaded.set(src, await this.uploadImage(context, image, session.ck))
        index += 1
      }
      const $ = load(article.html, null, false)
      $('img').each((_, node) => {
        const image = $(node)
        const src = image.attr('src') || ''
        const next = uploaded.get(src)
        if (next) image.attr('src', next)
      })
      const content = $.html()
      progress({ message: '正在保存豆瓣日记' })
      const result = await this.saveNote(context, session.uid, session.ck, {
        title: article.title,
        content,
        privacy: article.privacy,
        can_reply: 'yes',
        tags: article.tags.join(' '),
        ck: session.ck,
        csrfmiddlewaretoken: session.ck,
      })
      if (!result) throw uncertain('豆瓣已接收保存请求，但未返回日记编号；请先到豆瓣日记列表核实，避免重复发布')
      const readBackResponse = await context.request.get(result.url, { timeout: 20_000 }).catch(() => null)
      if (!readBackResponse?.ok()) throw uncertain('豆瓣日记已创建，但暂时无法读取正文核对；请到豆瓣确认内容后再决定是否重试')
      const storedHtml = await readBackResponse.text().catch(() => '')
      const readBack = await this.noteTitle(context, result.url).catch(() => null)
      if (readBack?.title && !readBack.title.includes(article.title.slice(0, 10))) {
        throw uncertain('豆瓣日记已创建，但标题回读不一致；请到豆瓣核对后再决定是否重试')
      }
      const body = load(storedHtml)('#link-report, .note-content, .note-body, .article, #content').first().html()
      if (body) {
        try { verifyDoubanContent(content, body) }
        catch (error) {
          // Douban may rewrite the HTML; keep the created diary and let the
          // user inspect it instead of reporting a false failure.
          log('content readback differed', error instanceof Error ? error.message : error)
        }
      }
      return {
        state: await context.storageState(),
        status: 'published' as const,
        remoteId: result.remoteId,
        url: result.url,
        message: `已发布到豆瓣日记：${result.url}`,
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw uncertain('豆瓣发布过程中网络或页面异常，结果未确认；请先到豆瓣日记列表核实，避免重复发布')
    } finally { await context.close().catch(() => {}) }
  }

  async close(): Promise<void> {
    const pending = this.browser
    this.browser = null
    if (pending) await (await pending).close().catch(() => {})
  }
}
