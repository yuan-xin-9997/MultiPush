import { createHash } from 'node:crypto'
import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import { load } from 'cheerio'
import type { JianshuPublication } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'

export interface JianshuIdentity { accountId: string; name: string }
export interface JianshuArticle {
  title: string
  markdown: string
  text: string
  mode: 'draft' | 'publish'
  notebookId?: string
}
export interface JianshuDriver {
  connect(cookie: string): Promise<{ state: PublisherStorageState; identity: JianshuIdentity }>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: JianshuIdentity }>
  checkPublication(state: PublisherStorageState, remoteId: string, title: string, slug?: string | null): Promise<{ state: PublisherStorageState; status: 'published' | 'missing' | 'unknown'; url: string | null; message: string }>
  deleteDraft(state: PublisherStorageState, remoteId: string): Promise<{ state: PublisherStorageState; remoteDeleted: boolean; message: string }>
  publish(state: PublisherStorageState, article: JianshuArticle, progress: (value: Partial<Pick<JianshuPublication, 'message' | 'remoteId' | 'url'>>) => void): Promise<{ state: PublisherStorageState; status: 'draft' | 'published'; remoteId: string; url: string; message: string }>
  close(): Promise<void>
}

const HOME = 'https://www.jianshu.com/'
const WRITER = 'https://www.jianshu.com/writer'
const NOTEBOOKS = 'https://www.jianshu.com/author/notebooks'
const NOTES = 'https://www.jianshu.com/author/notes'
const CSRF_HEADERS = { Accept: 'application/json, text/javascript, */*; q=0.01', Referer: WRITER, 'X-Requested-With': 'XMLHttpRequest' }
const expired = () => new ApiError(409, 'jianshu_session_expired', '简书登录状态已失效，请重新复制 Cookie 连接')
const uncertain = (message: string) => new ApiError(502, 'jianshu_result_uncertain', message)
type Data = Record<string, unknown>
function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {} }
function log(...parts: unknown[]): void { console.log('[jianshu]', ...parts) }

/** Parse a Cookie request header into Playwright cookie objects. */
export function parseJianshuCookies(header: string): Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite: 'Lax' }> {
  const cookies: Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite: 'Lax' }> = []
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!name || !value) continue
    cookies.push({ name, value, domain: '.jianshu.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' })
  }
  return cookies
}

export function jianshuArticleUrl(slug: string): string {
  return `https://www.jianshu.com/p/${encodeURIComponent(slug)}`
}

/** The create/update responses include the numeric note id and public slug. */
export function parseJianshuNote(value: unknown): { id: string; slug: string } | null {
  const visit = (raw: unknown, depth: number): { id: string; slug: string } | null => {
    if (depth > 3 || !raw || typeof raw !== 'object') return null
    if (Array.isArray(raw)) {
      for (const item of raw) { const found = visit(item, depth + 1); if (found) return found }
      return null
    }
    const record = raw as Data
    const idRaw = record.id ?? record.note_id ?? record.noteId
    const id = idRaw === undefined || idRaw === null ? '' : String(idRaw)
    const slug = typeof record.slug === 'string' ? record.slug : ''
    if (/^\d{5,30}$/.test(id)) return { id, slug }
    for (const key of ['data', 'note', 'result']) {
      if (record[key] !== undefined) { const found = visit(record[key], depth + 1); if (found) return found }
    }
    return null
  }
  return visit(value, 0)
}

export function parseJianshuNotebooks(value: unknown): Array<{ id: string; name: string }> {
  const list = Array.isArray(value) ? value : Array.isArray(object(value).notebooks) ? object(value).notebooks as unknown[] : []
  return list.map((raw) => {
    const item = object(raw)
    return { id: String(item.id ?? item.notebook_id ?? ''), name: String(item.name ?? item.title ?? '') }
  }).filter((item) => /^\d{5,30}$/.test(item.id))
}

export function parseJianshuCsrf(html: string): string {
  const $ = load(html)
  return $('meta[name="csrf-token"]').attr('content') || $('input[name="authenticity_token"]').attr('value') || ''
}

export class PlaywrightJianshuDriver implements JianshuDriver {
  private browser: Promise<Browser> | null = null

  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = publisherExecutablePath('jianshu')
      if (!executablePath) throw new ApiError(503, 'jianshu_browser_unavailable', '服务器未安装可用的 Chrome / Chromium 浏览器')
      this.browser = chromium.launch({ executablePath, headless: true, chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1', args: ['--disable-dev-shm-usage'] }).then(browser => {
        browser.on('disconnected', () => { this.browser = null })
        return browser
      }).catch(() => { this.browser = null; throw new ApiError(503, 'jianshu_browser_unavailable', '无法启动简书浏览器，请检查服务器浏览器配置') })
    }
    const context = await (await this.browser).newContext({ storageState: state, locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(20_000)
    return context
  }

  private async profile(context: BrowserContext, cookies: string): Promise<JianshuIdentity> {
    const token = parseJianshuCookies(cookies).find(item => item.name === 'remember_user_token')?.value || cookies
  const accountId = createHash('sha256').update(token).digest('hex').slice(0, 16)
    let name = '简书用户'
    try {
      const response = await context.request.get(WRITER, { timeout: 20_000, headers: { Accept: 'text/html' } })
      if (response.ok()) {
        const $ = load(await response.text())
        const candidate = $('.user-name, .name, .dropdown-toggle .name, #user-menu .name').first().text().trim() || $('title').text().replace(/\s*[-–—|]\s*简书.*$/i, '').trim()
        if (candidate && !/简书|登录|注册/.test(candidate)) name = candidate
      }
    } catch { /* cookie identity is enough */ }
    return { accountId, name }
  }

  private async notebooks(context: BrowserContext): Promise<Array<{ id: string; name: string }>> {
    const response = await context.request.get(NOTEBOOKS, { timeout: 20_000, headers: { ...CSRF_HEADERS, Accept: 'application/json' } })
    if (response.status() === 401 || response.status() === 403) throw expired()
    if (!response.ok()) throw new ApiError(502, 'jianshu_session_check', `简书文集读取失败（HTTP ${response.status()}），请检查登录状态`)
    return parseJianshuNotebooks(await response.json().catch(() => null))
  }

  private async csrf(context: BrowserContext): Promise<string> {
    const response = await context.request.get(WRITER, { timeout: 20_000, headers: { Accept: 'text/html' } }).catch(() => null)
    if (response?.status() === 401 || response?.status() === 403) throw expired()
    return response?.ok() ? parseJianshuCsrf(await response.text()) : ''
  }

  async connect(cookie: string) {
    const parsed = parseJianshuCookies(cookie)
    if (!parsed.some(item => item.name === 'remember_user_token')) throw new ApiError(400, 'jianshu_cookie_invalid', 'Cookie 中缺少 remember_user_token，请从已登录简书的浏览器重新复制')
    const context = await this.context()
    try {
      await context.addCookies(parsed)
      await this.notebooks(context)
      const identity = await this.profile(context, cookie)
      return { state: await context.storageState(), identity }
    } finally { await context.close().catch(() => {}) }
  }

  async checkSession(state: PublisherStorageState) {
    const context = await this.context(state)
    try {
      await this.notebooks(context)
      const cookies = (await context.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
      return { state: await context.storageState(), identity: await this.profile(context, cookies) }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'jianshu_check_failed', '简书连接检查未完成，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async checkPublication(state: PublisherStorageState, remoteId: string, title: string, slug?: string | null) {
    const context = await this.context(state)
    try {
      if (!slug) return { state: await context.storageState(), status: 'unknown' as const, url: null, message: '缺少简书文章公开地址，请到简书后台核实' }
      const url = jianshuArticleUrl(slug)
      const response = await context.request.get(url, { timeout: 20_000, headers: { Accept: 'text/html' } })
      if (response.status() === 404) return { state: await context.storageState(), status: 'missing' as const, url: null, message: '简书文章不存在，可能已删除或未发布成功' }
      const html = await response.text().catch(() => '')
      const $ = load(html)
      const found = $('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text()
      if (response.status() === 200 && found && (!title || found.includes(title.slice(0, 10)))) {
        return { state: await context.storageState(), status: 'published' as const, url, message: '已重新核实：简书文章已发布' }
      }
      return { state: await context.storageState(), status: 'unknown' as const, url: null, message: '简书暂未返回可确认的发布结果，请到简书后台核实' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'jianshu_check_failed', '简书发布结果核实未完成，请稍后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async deleteDraft(state: PublisherStorageState, remoteId: string) {
    const context = await this.context(state)
    try {
      const token = await this.csrf(context)
      const headers = { ...CSRF_HEADERS, 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}) }
      const response = await context.request.post(`${NOTES}/${encodeURIComponent(remoteId)}/soft_destroy`, { data: {}, headers, timeout: 30_000 })
      if (response.status() === 401 || response.status() === 403 || /\/(?:sign_in|login)(?:[/?#]|$)/i.test(response.url())) throw expired()
      if (response.status() === 404 || response.status() === 410) return { state: await context.storageState(), remoteDeleted: false, message: '简书草稿已不存在，已清理本系统记录' }
      if (!response.ok()) {
        const body = await response.text().catch(() => '')
        throw new ApiError(502, 'jianshu_delete_failed', `简书删除草稿失败（HTTP ${response.status()}）${body ? `：${body.slice(0, 120)}` : ''}`)
      }
      return { state: await context.storageState(), remoteDeleted: true, message: '简书草稿已移至回收站' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'jianshu_delete_failed', '简书删除草稿未完成，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async publish(state: PublisherStorageState, article: JianshuArticle, progress: (value: Partial<Pick<JianshuPublication, 'message' | 'remoteId' | 'url'>>) => void) {
    const context = await this.context(state)
    try {
      const notebooks = await this.notebooks(context)
      const notebookId = article.notebookId && notebooks.some(item => item.id === article.notebookId) ? article.notebookId : notebooks[0]?.id
      if (!notebookId) throw new ApiError(400, 'jianshu_notebook_missing', '简书账号下没有可用文集，请先在简书创建一个文集')
      const token = await this.csrf(context)
      const headers = { ...CSRF_HEADERS, 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}) }
      progress({ message: '正在创建简书草稿' })
      const createdResponse = await context.request.post(NOTES, { data: { at_bottom: true, notebook_id: String(notebookId), title: article.title }, headers, timeout: 30_000 })
      if (createdResponse.status() === 401 || createdResponse.status() === 403) throw expired()
      if (!createdResponse.ok()) throw new ApiError(502, 'jianshu_draft_failed', `简书创建草稿失败（HTTP ${createdResponse.status()}），请稍后重试`)
      const created = parseJianshuNote(await createdResponse.json().catch(() => null))
      if (!created?.id) throw uncertain('简书已接收创建草稿请求，但未返回文章编号；请到简书草稿箱核实')
      progress({ message: '正在保存简书正文', remoteId: created.id })
      const savedResponse = await context.request.put(`${NOTES}/${encodeURIComponent(created.id)}`, { data: { autosave_control: 3, content: article.markdown, id: String(created.id), title: article.title }, headers, timeout: 30_000 })
      if (savedResponse.status() === 401 || savedResponse.status() === 403) throw expired()
      if (!savedResponse.ok()) throw uncertain(`简书草稿 ${created.id} 已创建，但正文保存未确认成功（HTTP ${savedResponse.status()}）；请到简书草稿箱核实`)
      const savedBody = await savedResponse.json().catch(() => null)
      const saved = parseJianshuNote(savedBody)
      let slug = saved?.slug || created.slug
      const savedRecord = object(savedBody)
      const lastCompiled = Number(savedRecord.content_updated_at ?? object(savedRecord.data).content_updated_at)
        || Math.floor(Date.now() / 1000)
      const draftUrl = `https://www.jianshu.com/writer#/notebooks/${notebookId}/notes/${created.id}`
      if (article.mode === 'draft') {
        progress({ message: '简书草稿已保存', remoteId: created.id, url: draftUrl })
        return { state: await context.storageState(), status: 'draft' as const, remoteId: created.id, url: draftUrl, message: '已保存到简书草稿箱' }
      }
      progress({ message: '正在发布简书文章', remoteId: created.id })
      const publishedResponse = await context.request.post(`${NOTES}/${encodeURIComponent(created.id)}/publicize`, { data: { last_compiled_at: lastCompiled }, headers, timeout: 30_000 })
      const publishedBody = await publishedResponse.json().catch(() => null)
      const publishedNote = parseJianshuNote(publishedBody)
      if (publishedNote?.slug) slug = publishedNote.slug
      if (publishedResponse.status() === 401 || publishedResponse.status() === 403) {
        const message = String(object(publishedBody).error ?? object(publishedBody).message ?? '')
        if (/每天只能发布|发布失败/.test(message)) throw new ApiError(409, 'jianshu_publish_rejected', message)
        throw expired()
      }
      if (!publishedResponse.ok()) {
        const message = String(object(publishedBody).error ?? object(publishedBody).message ?? `HTTP ${publishedResponse.status()}`)
        throw new ApiError(502, 'jianshu_publish_failed', `简书发布失败：${message}`)
      }
      if (!slug) throw uncertain(`简书文章 ${created.id} 已提交发布，但未返回公开地址；请到简书后台核实`)
      const url = jianshuArticleUrl(slug)
      progress({ message: '简书文章已发布', remoteId: created.id, url })
      return { state: await context.storageState(), status: 'published' as const, remoteId: created.id, url, message: `已发布到简书：${url}` }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw uncertain('简书发布过程中网络或页面异常，结果未确认；请先到简书草稿箱核实，避免重复发布')
    } finally { await context.close().catch(() => {}) }
  }

  async close(): Promise<void> {
    const pending = this.browser
    this.browser = null
    if (pending) await (await pending).close().catch(() => {})
  }
}
