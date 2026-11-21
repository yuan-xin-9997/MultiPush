import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { load } from 'cheerio'
import type { JuejinPublication } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'
import { qrReady } from './qr-capture'

export interface JuejinIdentity { accountId: string; name: string }
export interface JuejinArticle {
  title: string
  markdown: string
  text: string
  mode: 'draft' | 'publish'
  categoryId?: string
  tagNames: string[]
}
export interface JuejinLoginAttempt {
  poll(): Promise<{ status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'; qrCode: string | null; message: string; state?: PublisherStorageState; identity?: JuejinIdentity }>
  close(): Promise<void>
}
export interface JuejinDriver {
  beginLogin(): Promise<JuejinLoginAttempt>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: JuejinIdentity }>
  checkPublication(state: PublisherStorageState, remoteId: string, title: string): Promise<{ state: PublisherStorageState; status: 'published' | 'missing' | 'unknown'; url: string | null; message: string }>
  deleteDraft(state: PublisherStorageState, remoteId: string): Promise<{ state: PublisherStorageState; remoteDeleted: boolean; message: string }>
  publish(state: PublisherStorageState, article: JuejinArticle, progress: (value: Partial<Pick<JuejinPublication, 'message' | 'remoteId' | 'url'>>) => void): Promise<{ state: PublisherStorageState; status: 'draft' | 'published'; remoteId: string; url: string; message: string }>
  close(): Promise<void>
}

const LOGIN = 'https://juejin.cn/login'
const HOME = 'https://juejin.cn/'
const USER_API = 'https://api.juejin.cn/user_api/v1/user/get?aid=2608'
const CATEGORY_API = 'https://api.juejin.cn/tag_api/v1/query_category_briefs'
const TAG_API = 'https://api.juejin.cn/tag_api/v1/query_tag_list'
const DRAFT_API = 'https://api.juejin.cn/content_api/v1/article_draft/create'
const DRAFT_DELETE_API = 'https://api.juejin.cn/content_api/v1/article_draft/delete'
const PUBLISH_API = 'https://api.juejin.cn/content_api/v1/article/publish'
const QR = 'img.qrcode-img, .qrcode-img, img[class*="qrcode"], canvas[class*="qrcode"]'
const DEFAULT_CATEGORY = '6809637769959178254'
const FRONTEND_CATEGORY = '6809637767543259144'
const DEFAULT_TAG = '6809640407484334093'
const FRONTEND_HINTS = /前端|javascript|typescript|react|vue|css|html|node|浏览器|web/i
const expired = () => new ApiError(409, 'juejin_session_expired', '掘金登录状态已失效，请重新扫码连接')
const uncertain = (message: string) => new ApiError(502, 'juejin_result_uncertain', message)
type Data = Record<string, unknown>
function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {} }
function num(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null }
function log(...parts: unknown[]): void { console.log('[juejin]', ...parts) }

export function parseJuejinIdentity(value: unknown): JuejinIdentity | null {
  const root = object(value)
  if (num(root.err_no) !== 0) return null
  const data = object(root.data)
  const user = object(data.user)
  const pick = (keys: string[]): string => {
    for (const bag of [data, user]) for (const key of keys) {
      const raw = bag[key]
      if (typeof raw === 'string' && raw.trim()) return raw.trim()
      if (typeof raw === 'number') return String(raw)
    }
    return ''
  }
  const id = pick(['user_id', 'userId', 'uid', 'id'])
  const name = pick(['user_name', 'userName', 'name', 'nickname'])
  return id || name ? { accountId: id || name, name: name || '掘金用户' } : null
}

export function parseJuejinDraftId(value: unknown): string | null {
  const root = object(value), data = object(root.data)
  for (const key of ['draft_id', 'draftId', 'id']) {
    const raw = data[key]
    if ((typeof raw === 'string' || typeof raw === 'number') && /^\d{6,30}$/.test(String(raw))) return String(raw)
  }
  return null
}

export function parseJuejinPublishedId(value: unknown): string | null {
  const root = object(value), data = object(root.data)
  for (const key of ['article_id', 'articleId', 'id']) {
    const raw = data[key]
    if ((typeof raw === 'string' || typeof raw === 'number') && /^\d{6,30}$/.test(String(raw))) return String(raw)
  }
  return null
}

export function parseJuejinCategoryIds(value: unknown): Array<{ id: string; name: string }> {
  const root = object(value)
  if (num(root.err_no) !== 0 || !Array.isArray(root.data)) return []
  return root.data.map((raw) => {
    const item = object(raw)
    return { id: String(item.category_id ?? ''), name: String(item.category_name ?? '') }
  }).filter((item) => item.id)
}

export function parseJuejinTagIds(value: unknown): string[] {
  const root = object(value)
  if (num(root.err_no) !== 0 || !Array.isArray(root.data)) return []
  return root.data.map((raw) => {
    const item = object(raw), tag = object(item.tag)
    return { id: String(tag.tag_id ?? item.tag_id ?? ''), name: String(tag.tag_name ?? '') }
  }).filter((item) => item.id).map((item) => item.id)
}

export class PlaywrightJuejinDriver implements JuejinDriver {
  private browser: Promise<Browser> | null = null

  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = publisherExecutablePath('juejin')
      if (!executablePath) throw new ApiError(503, 'juejin_browser_unavailable', '服务器未安装可用的 Chrome / Chromium 浏览器')
      this.browser = chromium.launch({ executablePath, headless: true, chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1', args: ['--disable-dev-shm-usage'] }).then(browser => {
        browser.on('disconnected', () => { this.browser = null })
        return browser
      }).catch(() => { this.browser = null; throw new ApiError(503, 'juejin_browser_unavailable', '无法启动掘金浏览器，请检查服务器浏览器配置') })
    }
    const context = await (await this.browser).newContext({ storageState: state, locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(20_000)
    return context
  }

  private async csrf(context: BrowserContext): Promise<string> {
    const cookies = await context.cookies().catch(() => [])
    const cookie = cookies.find(item => item.name === 'passport_csrf_token' || item.name === 'passport_csrf_token_default')?.value ?? ''
    if (cookie) return cookie
    const response = await context.request.fetch(HOME, { method: 'HEAD', timeout: 15_000 }).catch(() => null)
    const header = response?.headers()['x-ware-csrf-token'] ?? ''
    return header.split(',')[1] ?? ''
  }

  private async identity(context: BrowserContext): Promise<JuejinIdentity | null> {
    const response = await context.request.get(USER_API, { timeout: 20_000, headers: { Accept: 'application/json', Referer: HOME } }).catch(() => null)
    if (!response?.ok()) return null
    return parseJuejinIdentity(await response.json().catch(() => null))
  }

  async beginLogin(): Promise<JuejinLoginAttempt> {
    const context = await this.context(), page = await context.newPage()
    let closed = false, qrCode: string | null = null
    const close = async () => { if (!closed) { closed = true; await context.close().catch(() => {}) } }
    const deadline = Date.now() + 5 * 60_000
    const readQr = async (): Promise<string | null> => {
      const qr = page.locator(QR).first()
      if (!await qr.isVisible().catch(() => false)) return null
      const src = await qr.getAttribute('src').catch(() => null)
      if (src?.startsWith('data:image/')) return src
      try {
        await qrReady(qr)
        return `data:image/png;base64,${(await qr.screenshot({ type: 'png', timeout: 5_000 })).toString('base64')}`
      } catch { return null }
    }
    try {
      await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(2_500)
      qrCode = await readQr()
      if (!qrCode) { await page.waitForTimeout(3_000); qrCode = await readQr() }
      if (!qrCode) throw new ApiError(502, 'juejin_login_unavailable', '掘金登录页没有返回可识别的二维码，请稍后重试')
      log('login QR ready')
    } catch (error) {
      await close()
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'juejin_login_unavailable', '无法取得掘金官方登录二维码，请检查服务器网络或稍后重试')
    }
    return {
      close,
      poll: async () => {
        if (closed || Date.now() > deadline) return { status: 'expired', qrCode: null, message: '掘金登录二维码已过期，请重新获取' }
        const text = await page.locator('body').innerText().catch(() => '')
        if (/二维码已过期|二维码失效/.test(text)) return { status: 'expired', qrCode: null, message: '掘金登录二维码已失效，请重新获取' }
        if (/安全验证|风险验证|环境异常|请完成验证/.test(text)) throw new ApiError(409, 'juejin_security_check', '掘金要求安全验证，请到官方页面完成验证后重新连接')
        const cookies = await context.cookies().catch(() => [])
        if (cookies.some(cookie => cookie.name === 'sessionid' && cookie.value && /(^|\.)juejin\.cn$/i.test(cookie.domain))) {
          const identity = await this.identity(context)
          if (identity) {
            log('login completed', identity.accountId)
            return { status: 'connected', qrCode: null, message: '掘金已登录，登录状态已保存', state: await context.storageState(), identity }
          }
        }
        const next = await readQr().catch(() => null)
        if (next) qrCode = next
        return { status: /扫描成功|扫码成功|已扫描|请在手机.{0,8}确认|确认登录/.test(text) ? 'scanned' : 'waiting', qrCode, message: '请使用掘金 App 扫描二维码登录' }
      },
    }
  }

  async checkSession(state: PublisherStorageState) {
    const context = await this.context(state)
    try {
      const identity = await this.identity(context)
      if (!identity) throw expired()
      return { state: await context.storageState(), identity }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'juejin_check_failed', '掘金连接检查未完成，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  private async categoryId(context: BrowserContext, article: JuejinArticle): Promise<string> {
    if (article.categoryId && /^\d{6,30}$/.test(article.categoryId)) return article.categoryId
    if (FRONTEND_HINTS.test(article.title) || article.tagNames.some(tag => FRONTEND_HINTS.test(tag))) return FRONTEND_CATEGORY
    const response = await context.request.get(CATEGORY_API, { timeout: 20_000, headers: { Referer: HOME } }).catch(() => null)
    const categories = response?.ok() ? parseJuejinCategoryIds(await response.json().catch(() => null)) : []
    return categories.find(item => /后端|前端|人工智能/.test(item.name))?.id ?? DEFAULT_CATEGORY
  }

  private async tagIds(context: BrowserContext, names: string[]): Promise<string[]> {
    const ids: string[] = []
    for (const name of names.slice(0, 5)) {
      const response = await context.request.post(TAG_API, { data: { key_word: name, page: 1, page_size: 10 }, headers: { 'Content-Type': 'application/json', Referer: HOME }, timeout: 20_000 }).catch(() => null)
      const found = response?.ok() ? parseJuejinTagIds(await response.json().catch(() => null)) : []
      if (found[0]) ids.push(found[0])
    }
    return Array.from(new Set(ids.length ? ids : [DEFAULT_TAG])).slice(0, 5)
  }

  async checkPublication(state: PublisherStorageState, remoteId: string, title: string) {
    const context = await this.context(state)
    try {
      const url = `https://juejin.cn/post/${encodeURIComponent(remoteId)}`
      const response = await context.request.get(url, { timeout: 20_000, headers: { Accept: 'text/html' } })
      if (response.status() === 404) return { state: await context.storageState(), status: 'missing' as const, url: null, message: '掘金文章不存在，可能已删除或未发布成功' }
      const html = await response.text().catch(() => '')
      const $ = load(html)
      const found = $('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text()
      if (response.status() === 200 && found && (!title || found.includes(title.slice(0, 10)))) {
        return { state: await context.storageState(), status: 'published' as const, url, message: '已重新核实：掘金文章已发布' }
      }
      return { state: await context.storageState(), status: 'unknown' as const, url: null, message: '掘金暂未返回可确认的发布结果，请到掘金后台核实' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'juejin_check_failed', '掘金发布结果核实未完成，请稍后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async deleteDraft(state: PublisherStorageState, remoteId: string) {
    const context = await this.context(state)
    try {
      const identity = await this.identity(context)
      if (!identity) throw expired()
      const token = await this.csrf(context)
      const headers = { 'Content-Type': 'application/json', Origin: 'https://juejin.cn', Referer: `https://juejin.cn/editor/drafts/${encodeURIComponent(remoteId)}`, ...(token ? { 'x-csrf-token': token } : {}) }
      const response = await context.request.post(DRAFT_DELETE_API, { data: { draft_id: remoteId }, headers, timeout: 30_000 })
      const body = await response.json().catch(() => null)
      const errNo = num(object(body).err_no)
      const message = String(object(body).err_msg ?? '')
      if (response.status() === 401 || response.status() === 403 || errNo === 403) throw expired()
      if (!response.ok()) throw new ApiError(502, 'juejin_delete_failed', `掘金删除草稿失败（HTTP ${response.status()}），请稍后重试`)
      if (errNo !== 0) {
        if (/不存在|已删除|找不到|not\s*found/i.test(message)) return { state: await context.storageState(), remoteDeleted: false, message: '掘金草稿已不存在，已清理本系统记录' }
        throw new ApiError(502, 'juejin_delete_failed', `掘金删除草稿失败：${message || `错误码 ${String(errNo)}`}`)
      }
      return { state: await context.storageState(), remoteDeleted: true, message: '掘金草稿已删除' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'juejin_delete_failed', '掘金删除草稿未完成，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async publish(state: PublisherStorageState, article: JuejinArticle, progress: (value: Partial<Pick<JuejinPublication, 'message' | 'remoteId' | 'url'>>) => void) {
    const context = await this.context(state)
    try {
      const identity = await this.identity(context)
      if (!identity) throw expired()
      const token = await this.csrf(context)
      const categoryId = await this.categoryId(context, article)
      const tagIds = await this.tagIds(context, article.tagNames)
      const briefSource = article.text.replace(/\s+/g, ' ').trim() || article.title
      let brief = Array.from(briefSource).slice(0, 100).join('')
      if (Array.from(brief).length < 50) brief = Array.from(`${brief} ${article.title}`).slice(0, 100).join('')
      const headers = { 'Content-Type': 'application/json', Origin: 'https://juejin.cn', Referer: 'https://juejin.cn/editor/drafts/new', ...(token ? { 'x-csrf-token': token } : {}) }
      const create = await context.request.post(DRAFT_API, {
        data: { category_id: categoryId, tag_ids: tagIds, title: article.title, brief_content: brief, edit_type: 10, mark_content: article.markdown, cover_image: '', html_content: '', link_url: '', theme_ids: [] },
        headers,
        timeout: 30_000,
      })
      const createBody = await create.json().catch(() => null)
      if (create.status() === 401 || create.status() === 403 || num(object(createBody).err_no) === 403) throw expired()
      if (!create.ok() || num(object(createBody).err_no) !== 0) throw new ApiError(502, 'juejin_draft_failed', `掘金创建草稿失败：${String(object(createBody).err_msg ?? `HTTP ${create.status()}`)}`)
      const draftId = parseJuejinDraftId(createBody)
      if (!draftId) throw uncertain('掘金已接收草稿请求，但未返回草稿编号；请到掘金草稿箱核实，避免重复创建')
      if (article.mode === 'draft') {
        const url = `https://juejin.cn/editor/drafts/${draftId}`
        progress({ message: '掘金草稿已创建', remoteId: draftId, url })
        return { state: await context.storageState(), status: 'draft' as const, remoteId: draftId, url, message: '已保存到掘金草稿箱' }
      }
      progress({ message: '正在发布掘金文章', remoteId: draftId })
      const publish = await context.request.post(PUBLISH_API, { data: { draft_id: draftId, sync_to_org: false, column_ids: [] }, headers, timeout: 30_000 })
      const publishBody = await publish.json().catch(() => null)
      if (publish.status() === 401 || publish.status() === 403 || num(object(publishBody).err_no) === 403) throw expired()
      if (!publish.ok() || num(object(publishBody).err_no) !== 0) throw uncertain(`掘金草稿已创建（${draftId}），但发布请求未确认成功：${String(object(publishBody).err_msg ?? `HTTP ${publish.status()}`)}；请先到掘金草稿箱核实`)
      const articleId = parseJuejinPublishedId(publishBody)
      if (!articleId) throw uncertain(`掘金草稿 ${draftId} 已创建，但未返回文章编号；请到掘金核实后再决定是否重试`)
      const url = `https://juejin.cn/post/${articleId}`
      progress({ message: '掘金文章已发布', remoteId: articleId, url })
      return { state: await context.storageState(), status: 'published' as const, remoteId: articleId, url, message: `已发布到掘金：${url}` }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw uncertain('掘金发布过程中网络或页面异常，结果未确认；请先到掘金草稿箱核实，避免重复发布')
    } finally { await context.close().catch(() => {}) }
  }

  async close(): Promise<void> {
    const pending = this.browser
    this.browser = null
    if (pending) await (await pending).close().catch(() => {})
  }
}
