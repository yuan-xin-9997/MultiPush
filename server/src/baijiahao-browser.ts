import { chromium, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { load, type Cheerio } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { BaijiahaoPublication } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import type { PublisherImage } from './publisher-image'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'
import { qrReady } from './qr-capture'

export interface BaijiahaoIdentity { accountId: string; name: string }
/** Body images keyed by the exact `<img src>` they replace; cover is a separate file. */
export interface BaijiahaoArticle { title: string; html: string; text: string; mode: 'draft' | 'publish'; images: Map<string, PublisherImage>; cover: PublisherImage | null }
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
// Real editor endpoints, captured from the live editor in 2026-11:
// body images POST multipart field `media`; the cover dialog converts to base64.
const UPLOAD_IMAGE = 'https://baijiahao.baidu.com/materialui/picture/uploadProxy'
// Only the passport login QR. `img[class*="qrcode"]` also matches the marketing
// "下载百度APP / 创作中心" cards, which appear earlier in the DOM, so Playwright's
// `.first()` used to return those and we displayed the wrong QR entirely.
const QR = 'img.tang-pass-qrcode-img, img[src*="passport.baidu.com/v2/api/qrcode"]'
const TITLE = '[data-testid="news-title-input"] [contenteditable="true"], #newsTextArea [contenteditable="true"], [contenteditable="true"][placeholder*="标题"], textarea[placeholder*="标题"], input[placeholder*="标题"]'
const BODY_FRAME = '#ueditor_0'
const COVER_FILE_INPUT = 'input[name="media"][type="file"][accept="image/*"]'
/** The placeholder UEditor swaps remote images for when its own fetch fails. */
export const BAIJIAHAO_PLACEHOLDER_HASH = 'df3e567d6f16d040326c7a0ea29a4f41'
/** Hosts that count as "already on the Baijiahao CDN". */
export const BAIJIAHAO_IMAGE_HOSTS = ['baidu.com', 'bdstatic.com', 'bdimg.com', 'bcebos.com', 'baidubce.com']
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

/** True when the src already points at Baijiahao's own image CDN. */
export function isBaijiahaoImageSrc(src: string): boolean {
  try {
    const url = new URL(src)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    return BAIJIAHAO_IMAGE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  } catch { return false }
}

/** Detects the placeholder GIF UEditor inserts when remote image fetching fails. */
export function isBaijiahaoPlaceholder(src: string): boolean {
  return src.includes(BAIJIAHAO_PLACEHOLDER_HASH)
}

/** Pulls the uploaded CDN URL out of a `materialui/picture/uploadProxy` payload. */
export function parseBaijiahaoUpload(value: unknown): string | null {
  const root = object(value)
  if (Number(root.errno ?? root.error_code ?? root.code ?? -1) !== 0) return null
  const ret = object(root.ret)
  for (const key of ['https_url', 'httpsUrl']) {
    const raw = ret[key]
    if (typeof raw === 'string' && /^https:\/\//i.test(raw)) return raw
  }
  // bos/org urls come back as http://; the same host serves https.
  for (const key of ['bos_url', 'org_url', 'url']) {
    const raw = ret[key]
    if (typeof raw === 'string' && /^http:\/\//i.test(raw)) return raw.replace(/^http:/i, 'https:')
  }
  return null
}

/**
 * Rewrites article HTML into the exact markup the Baijiahao editor produces when
 * an image is inserted through its own uploader, with every `<img src>` replaced
 * by the uploaded CDN URL. Figure captions become native Baijiahao image
 * captions when they fit (≤18 chars) and stay as styled paragraphs otherwise so
 * caption text is never dropped.
 */
export interface BaijiahaoBodyImage { src: string; url: string; alt: string | null; width: string | null; height: string | null; caption: string }
export function buildBaijiahaoBodyHtml(html: string, uploads: Map<string, string>): { html: string; images: BaijiahaoBodyImage[] } {
  const $ = load(html, null, false)
  const images: BaijiahaoBodyImage[] = []
  let captionId = 0

  const uploadedUrl = (src: string): string => {
    const url = uploads.get(src)
    if (!url) throw new ApiError(400, 'baijiahao_image_upload_failed', `正文图片尚未上传到百家号图床：${src.slice(0, 120)}`)
    return url
  }
  const prepareImage = (image: Cheerio<AnyNode>, src: string): void => {
    const url = uploadedUrl(src)
    image.attr({
      src: url,
      'data-bjh-origin-src': url,
      'data-bjh-type': 'IMG',
      ...(image.attr('width') ? { 'data-w': image.attr('width')! } : {}),
      ...(image.attr('height') ? { 'data-h': image.attr('height')! } : {}),
    })
    image.removeAttr('srcset data-src data-original data-lazy-src style')
    images.push({ src, url, alt: image.attr('alt') || null, width: image.attr('width') || null, height: image.attr('height') || null, caption: '' })
  }
  const appendCaption = (container: Cheerio<AnyNode>, text: string): void => {
    const caption = images[images.length - 1]
    if (caption) caption.caption = text
    const compact = text.replace(/\s+/g, ' ').trim()
    if (Array.from(compact).length <= 18) {
      // Native Baijiahao caption: the editor keeps `data-bjh-caption-for` paired
      // with the container's `data-bjh-caption-id` and renders it under the image.
      container.after($('<p></p>').attr('class', 'bjh-image-caption ue_t').attr('data-bjh-caption-for', container.attr('data-bjh-caption-id') || '').text(compact))
    } else {
      // Long captions would be truncated by the native form; keep them verbatim
      // as a centered note paragraph, which survives publishing.
      container.after($('<p></p>').attr('style', 'font-size:13px;line-height:1.6;color:#8a8f99;text-align:center;').text(compact))
    }
  }

  // Canonical render HTML puts every captioned image inside `<figure>`; convert
  // those into the editor's own container+caption structure.
  for (const node of $('figure').toArray()) {
    const $figure = $(node)
    const imgs = $figure.find('img')
    if (imgs.length !== 1) continue
    const $image = $(imgs[0])
    const src = $image.attr('src') || ''
    if (!src || isBaijiahaoImageSrc(src)) continue
    prepareImage($image, src)
    const text = ($figure.find('figcaption').first().text() || '').replace(/\s+/g, ' ').trim()
    const container = $('<p></p>').attr('class', 'bjh-image-container').attr('data-bjh-caption-id', `cap-mp-${++captionId}`)
    container.append($image)
    $figure.replaceWith(container)
    if (text) appendCaption(container, text)
  }

  // Remaining images: bare paragraphs holding a single image become containers;
  // inline images inside mixed paragraphs keep their position with a new src.
  for (const node of $('img').toArray()) {
    const $image = $(node)
    if ($image.attr('data-bjh-type') === 'IMG') continue
    const src = $image.attr('src') || ''
    if (isBaijiahaoImageSrc(src)) {
      // Already on the CDN: just drop stale lazy-load attributes.
      $image.removeAttr('srcset data-src data-original data-lazy-src style')
      continue
    }
    if (!src) continue
    prepareImage($image, src)
    const parent = $image.parent()
    if ((parent.is('p') || parent.is('div')) && parent.children().length === 1 && !parent.text().trim() && !parent.closest('figure').length) {
      const container = $('<p></p>').attr('class', 'bjh-image-container')
      container.append($image)
      parent.replaceWith(container)
    }
  }

  return { html: $.html(), images }
}

/** Fails unless every `<img src>` in the final HTML points at Baijiahao's CDN. */
export function assertBaijiahaoBodyImages(html: string): void {
  const $ = load(html, null, false)
  for (const node of $('img').toArray()) {
    const src = $(node).attr('src') || ''
    if (isBaijiahaoPlaceholder(src)) {
      throw new ApiError(400, 'baijiahao_image_upload_failed', '正文图片被替换为百家号占位图，已停止发布；请检查图片是否可公开访问后重试')
    }
    if (!src || !isBaijiahaoImageSrc(src)) {
      throw new ApiError(400, 'baijiahao_image_upload_failed', `正文仍含未上传到百家号图床的图片：${src.slice(0, 120)}`)
    }
  }
}

/** Reads the `<img src>` list inside the UEditor iframe (falls back to the editor API). */
async function readEditorImageSources(page: Page): Promise<string[] | null> {
  const fromFrame = await page.evaluate(() => {
    const scope = globalThis as unknown as {
      document?: {
        querySelector: (selector: string) => {
          contentDocument?: {
            querySelectorAll: (selector: string) => ArrayLike<{ getAttribute: (name: string) => string | null }>
          } | null
        } | null
      }
    }
    const doc = scope.document?.querySelector('#ueditor_0')?.contentDocument
    if (!doc) return null
    return Array.from(doc.querySelectorAll('img'), (img) => img.getAttribute('src') || '')
  }).catch(() => null)
  if (fromFrame) return fromFrame
  const html = await page.evaluate(() => {
    const scope = globalThis as unknown as { editor?: { getContent?: () => string } }
    return scope.editor?.getContent?.() ?? null
  }).catch(() => null)
  if (!html) return null
  const $ = load(html, null, false)
  return $('img').toArray().map(node => $(node).attr('src') || '')
}

/** Distinguishes successfully uploaded body images from leftover external ones. */
export function verifyEditorImages(actual: string[] | null, expected: string[]): void {
  if (!actual) throw new ApiError(400, 'baijiahao_image_upload_failed', '无法读取百家号编辑器正文，已停止发布')
  if (actual.length !== expected.length) {
    throw new ApiError(400, 'baijiahao_image_upload_failed', `编辑器内图片数量不符：预期 ${expected.length} 张，实际 ${actual.length} 张，已停止发布`)
  }
  for (const src of actual) {
    if (isBaijiahaoPlaceholder(src)) throw new ApiError(400, 'baijiahao_image_upload_failed', '编辑器内出现百家号占位图，正文图片未上传成功，已停止发布')
    if (!isBaijiahaoImageSrc(src)) throw new ApiError(400, 'baijiahao_image_upload_failed', `编辑器内仍是外链图片，未上传到百家号图床：${src.slice(0, 120)}`)
  }
  const remaining = [...expected]
  for (const src of actual) {
    const index = remaining.indexOf(src)
    if (index >= 0) remaining.splice(index, 1)
  }
  if (remaining.length) {
    throw new ApiError(400, 'baijiahao_image_upload_failed', `编辑器内有 ${remaining.length} 张图片与上传结果不一致，已停止发布`)
  }
}

/** Counts distinct Baijiahao CDN images in a published article page. */
export function countBaijiahaoFeedImages(html: string): number {
  const paths = new Set<string>()
  for (const match of html.matchAll(/(?:pics\d*\.baidu\.com\/feed|pic\.rmb\.bdstatic\.com\/bjh|bjh\.bces\.baidubce\.com)\/([^"'?\s<>)]{8,200}?)\.(?:jpg|jpeg|png|gif|webp)/gi)) {
    paths.add(match[1])
  }
  return paths.size
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
  const id = pick(['uk', 'userid', 'user_id', 'author_id', 'authorid', 'uid', 'id'])
  const name = pick(['uname', 'name', 'nickname', 'author_name', 'authorname', 'screen_name'])
  if (!id && !name) return null
  return { accountId: id, name: name || '百家号作者' }
}

/** Distinguish "Baidu login is valid but has no Baijiahao author profile" from an expired session. */
export function parseBaijiahaoProfileIssue(value: unknown): string | null {
  const root = object(value)
  const code = Number(root.errno ?? root.code ?? root.status ?? -1)
  const message = String(root.errmsg ?? root.message ?? '')
  if (code === 20040000 || /未绑定百家号|用户没有注册/.test(message)) {
    return '当前百度账号尚未开通百家号，登录本身有效；请用已开通百家号的百度账号登录，或先到 baijiahao.baidu.com 完成作者注册'
  }
  return null
}

/** Finds an article id in the publish/save response. The live endpoint returns it inside `ret`. */
export function parseBaijiahaoPublished(value: unknown): { remoteId: string; url: string } | null {
  const root = object(value)
  if (Number(root.errno ?? root.code ?? -1) !== 0) return null
  // Legacy responses keep the article under `data`; live ones under `ret`.
  const bags: Data[] = [object(root.data), object(root.ret), object(object(root.ret).data)]
  for (const bag of bags) {
    for (const key of ['article_id', 'articleId', 'content_id', 'contentId', 'id']) {
      const raw = bag[key]
      if (typeof raw !== 'string' && typeof raw !== 'number') continue
      const text = String(raw)
      const direct = /^\d{10,30}$/.test(text) ? text : null
      const fromUrl = /[?&]id=(\d{10,30})/.exec(text)?.[1] ?? null
      const id = direct ?? fromUrl
      if (id) return { remoteId: id, url: `https://baijiahao.baidu.com/s?id=${id}` }
    }
  }
  // Some responses wrap the article in `data.article` or a list.
  for (const bag of bags) {
    const nested = object(bag.article ?? bag.data)
    const rawId = nested.id ?? nested.article_id ?? nested.articleId
    if (typeof rawId === 'string' || typeof rawId === 'number') {
      const id = String(rawId)
      if (/^\d{10,30}$/.test(id)) return { remoteId: id, url: `https://baijiahao.baidu.com/s?id=${id}` }
    }
  }
  // Historic payloads exposed the article link in `data.url` only; that URL
  // already carries the public id. `ret.url` is a preview link keyed by the
  // internal nid, so it is deliberately not trusted.
  for (const key of ['url']) {
    const raw = object(root.data)[key]
    if (typeof raw !== 'string') continue
    const fromUrl = /[?&]id=(\d{10,30})/.exec(raw)?.[1] ?? null
    if (fromUrl) return { remoteId: fromUrl, url: `https://baijiahao.baidu.com/s?id=${fromUrl}` }
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
    const infoIssue = parseBaijiahaoProfileIssue(info)
    const identity = parseBaijiahaoProfile(info)
    if (identity) return identity
    const root = object(info)
    logThrottled('loginInfo did not report an account', 'errno=' + String(root.errno ?? root.code), 'keys=' + JSON.stringify(Object.keys(object(root.data))))
    // The builder shell exposes the same session through its app bootstrap.
    const app = await this.readJson(await context.request.get(APP_INFO, { headers, timeout: 20_000 }).catch(() => null))
    const fallback = parseBaijiahaoProfile(app)
    if (fallback) return fallback
    const appIssue = parseBaijiahaoProfileIssue(app)
    const appRoot = object(app)
    if (Number(appRoot.errno) !== 0) logThrottled('appinfo', 'errno=' + String(appRoot.errno))
    if (infoIssue || appIssue) throw new ApiError(409, 'baijiahao_account_unbound', infoIssue || appIssue || '当前百度账号尚未开通百家号')
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
          let profileError: unknown = null
          const identity = await this.profile(context).catch((error) => { profileError = error; return null })
          if (identity) {
            log('login completed', identity.accountId || '(uid unavailable)')
            return { status: 'connected', qrCode: null, message: '百家号已登录，登录状态已保存', state: await context.storageState(), identity }
          }
          if (profileError instanceof ApiError && profileError.code === 'baijiahao_account_unbound') {
            log('login completed but the Baidu account has no Baijiahao profile')
            return { status: 'failed', qrCode: null, message: profileError.message }
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

  /**
   * Closes marketing modals (`我知道了`/`暂不开启`/关闭 buttons and the delayed
   * `.cheetah-modal` "立即体验" popup that otherwise intercepts clicks on the
   * title, body and publish button). Cover dialogs (they also use
   * `.cheetah-modal` but own the image file input) are left untouched.
   */
  private async dismiss(page: Page): Promise<void> {
    for (const label of ['我知道了', '知道了', '暂不开启', '关闭']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.isVisible().catch(() => false)) await button.click().catch(() => {})
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const modals = page.locator('.cheetah-modal')
      if (!await modals.count().catch(() => 0)) break
      let closedAny = false
      for (const node of await modals.all()) {
        if (await node.locator(COVER_FILE_INPUT).count().catch(() => 0)) continue
        const close = node.locator('button[aria-label="关闭"], button[aria-label="Close"]').first()
        if (await close.isVisible().catch(() => false)) {
          await close.click().catch(() => {})
          closedAny = true
        }
      }
      await page.waitForTimeout(400)
      if (!closedAny) break
    }
    // Do not continue while a modal mask could still swallow the next click.
    await page.locator('.cheetah-modal-wrap').first().waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {})
  }

  /** Uploads one image to the editor's own material endpoint and returns its CDN URL. */
  private async uploadImage(request: APIRequestContext, image: PublisherImage): Promise<string> {
    const response = await request.post(UPLOAD_IMAGE, {
      multipart: { media: { name: image.name, mimeType: image.mimeType, buffer: image.buffer } },
      headers: { Referer: EDITOR, Origin: new URL(HOME).origin },
      timeout: 60_000,
    }).catch((error) => {
      throw new ApiError(502, 'baijiahao_image_upload_failed', `上传百家号图床失败：${error instanceof Error ? error.message : '网络错误'}`)
    })
    const payload = await response.text().then((text) => json(text)).catch(() => null)
    const url = parseBaijiahaoUpload(payload)
    if (!url) throw new ApiError(502, 'baijiahao_image_upload_failed', '百家号图床未返回有效图片地址，已停止发布')
    return url
  }

  /**
   * Uploads every body image in document order, rewrites the HTML into the
   * editor's own image markup and fails loudly unless every `<img>` ends up on
   * the Baijiahao CDN.
   */
  private async prepareBody(page: Page, article: BaijiahaoArticle, progress: Parameters<BaijiahaoDriver['publish']>[2]): Promise<{ html: string; expected: string[] }> {
    const uploads = new Map<string, string>()
    const entries = [...article.images.entries()]
    for (const [index, [src, image]] of entries.entries()) {
      if (isBaijiahaoImageSrc(src)) {
        uploads.set(src, src)
        continue
      }
      progress({ message: `正在上传正文图片 ${index + 1}/${entries.length} 到百家号图床` })
      uploads.set(src, await this.uploadImage(page.context().request, image))
      log('body image uploaded', `${index + 1}/${entries.length}`)
    }
    const built = buildBaijiahaoBodyHtml(article.html, uploads)
    assertBaijiahaoBodyImages(built.html)
    return { html: built.html, expected: built.images.map((image) => image.url) }
  }

  /** Fills the UEditor body, preferring its JS API over fragile DOM typing. */
  private async fillBody(page: Page, article: BaijiahaoArticle, html: string): Promise<void> {
    const viaApi = await page.evaluate(value => {
      const scope = globalThis as unknown as { editor?: { setContent?: (value: string) => void; sync?: () => void }; UE?: { getEditor?: (id: string) => { setContent?: (value: string) => void; sync?: () => void } | undefined } }
      const editor = scope.editor?.setContent ? scope.editor : scope.UE?.getEditor?.('editor')
      if (!editor?.setContent) return false
      editor.setContent(value)
      editor.sync?.()
      return true
    }, html).catch(() => false)
    if (viaApi) { await page.waitForTimeout(1_500); return }
    const frame = page.frameLocator(BODY_FRAME).locator('body').first()
    await frame.waitFor({ state: 'visible', timeout: 15_000 })
    await frame.evaluate((node, value) => {
      type EventCtor = new (type: string, init?: { bubbles?: boolean }) => unknown
      const body = node as unknown as {
        innerHTML: string
        dispatchEvent: (event: unknown) => boolean
        ownerDocument?: { defaultView?: { Event?: EventCtor; InputEvent?: EventCtor } }
      }
      body.innerHTML = value
      const view = body.ownerDocument?.defaultView
      const Input = view?.InputEvent ?? view?.Event
      if (Input) body.dispatchEvent(new Input('input', { bubbles: true }))
      if (view?.Event) body.dispatchEvent(new view.Event('change', { bubbles: true }))
    }, html).catch(async () => {
      await frame.click()
      await page.keyboard.insertText(article.text)
    })
    await page.waitForTimeout(1_500)
    const content = await frame.innerText().catch(() => '')
    if (article.text.trim() && !content.includes(article.text.trim().slice(0, 20))) {
      await frame.click()
      await page.keyboard.insertText(article.text)
      await page.waitForTimeout(600)
    }
  }

  /**
   * Opens the cover dialog, uploads the cover through `input[name="media"]` and
   * confirms with the `/^确定/` button (it reads `确定 (1)` after the upload).
   * Baijiahao refuses to publish without a cover, so failures stop the run.
   */
  private async setCover(page: Page, image: PublisherImage, progress: Parameters<BaijiahaoDriver['publish']>[2]): Promise<void> {
    progress({ message: '正在设置百家号封面' })
    const entry = page.getByText('选择封面', { exact: true }).first()
    await entry.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {
      throw new ApiError(502, 'baijiahao_cover_failed', '百家号编辑器没有找到“选择封面”入口，平台页面可能已改版')
    })
    await entry.click().catch(async () => { await entry.click({ force: true }).catch(() => {}) })
    const input = page.locator(COVER_FILE_INPUT).first()
    await input.waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {
      throw new ApiError(502, 'baijiahao_cover_failed', '百家号封面弹窗没有出现上传入口，平台页面可能已改版')
    })
    await input.setInputFiles({ name: image.name, mimeType: image.mimeType, buffer: image.buffer })
    log('cover file selected')
    // The confirm button appears once the platform has processed the upload.
    const confirm = page.locator('.cheetah-modal button').filter({ hasText: /^确定/ }).last()
    await confirm.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {
      throw new ApiError(502, 'baijiahao_cover_failed', '百家号封面上传未完成（未出现确定按钮），已停止发布')
    })
    // Confirming before the preview thumbnail renders leaves the dialog in a
    // half-processed state that later blocks the publish button, so wait for it.
    await page.locator('.cheetah-modal img').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(1_200)
    await confirm.click({ timeout: 10_000 }).catch(async () => { await confirm.click({ force: true }).catch(() => {}) })
    // The dialog closes itself after confirm; large covers may reopen or linger
    // while the platform finishes processing, so poll and confirm again if needed.
    let closed = false
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.waitForTimeout(1_500)
      const modal = page.locator('.cheetah-modal').first()
      if (!await modal.isVisible().catch(() => false)) { closed = true; break }
      const retry = page.locator('.cheetah-modal button').filter({ hasText: /^确定/ }).last()
      if (await retry.isVisible().catch(() => false)) {
        log('cover dialog still open; confirming again')
        await retry.click({ timeout: 10_000 }).catch(async () => { await retry.click({ force: true }).catch(() => {}) })
        continue
      }
      const close = page.locator('.cheetah-modal button[aria-label="关闭"], .cheetah-modal button[aria-label="Close"]').first()
      if (await close.isVisible().catch(() => false)) { await close.click().catch(() => {}); continue }
      break
    }
    if (!closed && await page.locator(`.cheetah-modal ${COVER_FILE_INPUT}`).isVisible().catch(() => false)) {
      throw new ApiError(502, 'baijiahao_cover_failed', '百家号封面弹窗未关闭，封面可能未生效，已停止发布')
    }
    if (!closed) {
      // A lingering modal would block the publish button; close it explicitly.
      const close = page.locator('.cheetah-modal button[aria-label="关闭"], .cheetah-modal button[aria-label="Close"]').first()
      if (await close.isVisible().catch(() => false)) { await close.click().catch(() => {}); await page.waitForTimeout(800) }
    }
    // Wait out the close animation so its mask cannot intercept the next click.
    await page.locator('.cheetah-modal-wrap').first().waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(800)
    log('cover set')
  }

  /** Compact page snapshot written to journald when the editor or publish step fails. */
  private async diagnostics(page: Page): Promise<string> {
    const counts: string[] = []
    for (const selector of [TITLE, BODY_FRAME, 'button', '.cheetah-modal']) {
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

      const prepared = await this.prepareBody(page, article, progress)
      progress({ message: '正在填写百家号正文' })
      await this.fillBody(page, article, prepared.html)
      await this.security(page)
      log('body filled')

      // The editor must show every uploaded image before anything is submitted.
      await this.dismiss(page)
      if (prepared.expected.length) {
        progress({ message: '正在校验编辑器内的百家号图片' })
        await page.waitForTimeout(800)
        verifyEditorImages(await readEditorImageSources(page), prepared.expected)
        log('editor images verified', prepared.expected.length)
      }

      if (article.mode === 'draft') {
        progress({ message: '正在保存百家号草稿' })
        const saveResponse = page.waitForResponse(response => {
          const url = new URL(response.url())
          return url.hostname === 'baijiahao.baidu.com' && /\/pcui\/article\/save\/?$/.test(url.pathname) && response.request().method() === 'POST'
        }, { timeout: 60_000 }).catch(() => null)
        const draftButton = page.locator('button').filter({ hasText: /^\s*存草稿\s*$/ }).first()
        if (!await draftButton.count()) throw new ApiError(502, 'baijiahao_draft_unavailable', '百家号编辑器没有找到存草稿按钮，平台页面可能已改版；请到编辑器手动保存')
        await draftButton.click({ timeout: 20_000 }).catch(async () => { await this.dismiss(page!); await draftButton.click({ timeout: 20_000 }) })
        const saved = await saveResponse
        const data = object(await saved?.json().catch(() => null) ?? null)
        const errno = Number(data.errno ?? data.code ?? NaN)
        log('draft save response', 'errno=' + String(errno))
        if (SESSION_ERRORS.includes(errno)) throw expired()
        const result = errno === 0 ? parseBaijiahaoPublished(data) : null
        if (errno !== 0 || !result) {
          const message = typeof data.errmsg === 'string' ? data.errmsg : ''
          throw new ApiError(errno !== 0 ? 502 : 409, 'baijiahao_draft_unconfirmed', `百家号草稿保存未确认成功${message ? `：${message}` : ''}；请到百家号草稿箱核对`)
        }
        return { state: await context.storageState(), status: 'draft' as const, remoteId: result.remoteId, url: result.url, message: '已保存到百家号草稿箱，正文图片已上传到百家号图床' }
      }

      if (article.cover) await this.setCover(page, article.cover, progress)
      else throw new ApiError(409, 'baijiahao_cover_required', '百家号发布必须设置封面：请先在原文中设置封面，或在正文里插入图片')

      await this.dismiss(page)

      progress({ message: '正在提交百家号发布' })
      const responsePromise = page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.hostname === 'baijiahao.baidu.com' && /\/pcui\/article\/publish\/?$/.test(url.pathname) && response.request().method() === 'POST'
      }, { timeout: 60_000 }).catch(() => null)
      // Never use has-text here: it would also match 定时发布.
      const publishButton = page.locator('button[data-testid="publish-btn"]').first()
      const publishByTestid = await publishButton.count()
      const button = publishByTestid ? publishButton : page.locator('button').filter({ hasText: /^\s*发布\s*$/ }).first()
      await button.waitFor({ state: 'visible', timeout: 20_000 })
      if (!await button.isEnabled()) throw new ApiError(409, 'baijiahao_publish_disabled', '百家号发布按钮不可用，请检查标题、正文和账号状态')
      submitted = true
      // Wait out any lingering modal mask before the decisive click.
      await page.locator('.cheetah-modal-wrap').first().waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {})
      await button.click({ timeout: 20_000 }).catch(async (error) => {
        // A late marketing modal can swallow the click; dismiss and retry once.
        log('publish click intercepted, retrying:', error instanceof Error ? error.message.slice(0, 600) : String(error))
        const covering = await page!.evaluate(`(() => {
          const button = document.querySelector('button[data-testid="publish-btn"]')
          if (!button) return 'no button'
          const rect = button.getBoundingClientRect()
          const el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          if (!el) return 'none'
          const modal = el.closest ? el.closest('.cheetah-modal') : null
          const wrap = el.closest ? el.closest('.cheetah-modal-wrap') : null
          const text = modal ? (modal.textContent || '').replace(/\\s+/g, ' ').slice(0, 200) : ''
          const hasFileInput = modal ? !!modal.querySelector('input[name="media"]') : false
          const html = modal ? modal.outerHTML.slice(0, 600) : wrap ? wrap.outerHTML.slice(0, 600) : ''
          const style = wrap ? getComputedStyle(wrap).cssText.slice(0, 0) || wrap.getAttribute('style') || '' : ''
          return el.tagName + ' cls=' + String(el.className || '').slice(0, 100) + ' modalText=' + JSON.stringify(text) + ' hasFileInput=' + hasFileInput + ' wrapStyle=' + JSON.stringify(style) + ' html=' + JSON.stringify(html)
        })()`).catch(() => 'inspect failed')
        log('covering element:', covering)
        await this.dismiss(page!)
        await button.click({ timeout: 20_000 })
      })
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

      // Read the public page back so image loss is never reported as success.
      // Freshly published articles lag behind while the platform processes the
      // content, so retry over roughly a minute before giving up.
      let message = '百家号文章已发布'
      if (prepared.expected.length) {
        progress({ message: '正在回读百家号公开页确认正文图片' })
        let found = 0, readable = false
        for (const delay of [4_000, 10_000, 16_000, 24_000]) {
          await page.waitForTimeout(delay)
          const publicPage = await context.request.get(result.url, { headers: { Accept: 'text/html' }, timeout: 20_000 }).catch(() => null)
          if (publicPage?.ok()) {
            readable = true
            found = countBaijiahaoFeedImages(await publicPage.text().catch(() => ''))
            if (found) break
          }
        }
        if (readable && !found) {
          throw new ApiError(409, 'baijiahao_result_uncertain', '百家号已受理文章，但公开页未回读到正文图片；请人工核对公开页后再选择核实结果')
        }
        if (found) {
          message = found >= prepared.expected.length
            ? `百家号文章已发布，公开页已确认 ${found} 张正文图片`
            : `百家号文章已发布，公开页回读到 ${found}/${prepared.expected.length} 张正文图片，请人工复核`
        }
      }
      return { state: await context.storageState(), status: 'published' as const, remoteId: result.remoteId, url: result.url, message }
    } catch (error) {
      if (submitted && !(error instanceof ApiError && ['baijiahao_session_expired', 'baijiahao_security_check'].includes(error.code))) {
        if (!(error instanceof ApiError)) log('post-submit failure', error instanceof Error ? error.message.slice(0, 220) : String(error))
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
