import { createHmac, randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright-core'
import { load } from 'cheerio'
import type { CsdnPublication } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import { publisherExecutablePath } from './wechat-browser'
import { PublisherContextCache } from './publisher-context-cache'
import { ApiError } from './errors'

export interface CsdnIdentity { accountId: string; name: string }

export interface CsdnArticle {
  title: string
  markdown: string
  text: string
  mode: 'draft' | 'publish'
  tags: string[]
}

export interface CsdnLoginAttempt {
  poll(): Promise<{ status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'; qrCode: string | null; message: string; state?: PublisherStorageState; identity?: CsdnIdentity }>
  close(): Promise<void>
}

export interface CsdnDriver {
  beginLogin(): Promise<CsdnLoginAttempt>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: CsdnIdentity }>
  checkPublication(state: PublisherStorageState, remoteId: string, title: string, url?: string | null): Promise<{ state: PublisherStorageState; status: 'published' | 'missing' | 'unknown'; url: string | null; message: string }>
  deleteDraft(state: PublisherStorageState, remoteId: string): Promise<{ state: PublisherStorageState; remoteDeleted: boolean; message: string }>
  publish(state: PublisherStorageState, article: CsdnArticle, progress: (value: Partial<Pick<CsdnPublication, 'message' | 'remoteId' | 'url'>>) => void): Promise<{ state: PublisherStorageState; status: 'draft' | 'published'; remoteId: string; url: string; message: string }>
  close(): Promise<void>
}

const LOGIN = 'https://passport.csdn.net/login'
const EDITOR = 'https://editor.csdn.net/md/?not_checkout=1'
const SAVE_API = '/blog-console-api/v3/mdeditor/saveArticle'
const DELETE_API = 'https://bizapi.csdn.net/blog/phoenix/console/v1/article/del'
const APP_KEY = '203803574'
const APP_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba'
const TITLE_INPUT = 'input.article-bar__title--input'
const TITLE_DISPLAY = '.article-bar__title-display'
const EDITOR_BODY = 'pre.editor__inner'
const PUBLISH_MODAL = '.modal__publish-article'
/** CSDN's console API signs requests with the public web app key. */
function signedHeaders(contentType: string): Record<string, string> {
  const nonce = randomUUID()
  const signed: Record<string, string> = { 'x-ca-key': APP_KEY, 'x-ca-nonce': nonce }
  const names = Object.keys(signed).sort()
  let text = `POST\n*/*\n\n${contentType}\n\n`
  for (const name of names) text += `${name}:${signed[name]}\n`
  text += '/blog/phoenix/console/v1/article/del'
  return {
    Accept: '*/*',
    'Content-Type': contentType,
    'X-Ca-Stage': '',
    'X-Ca-Key': APP_KEY,
    'X-Ca-Nonce': nonce,
    'X-Ca-Signature': createHmac('sha256', APP_SECRET).update(text).digest('base64'),
    'X-Ca-Signature-Headers': names.join(','),
  }
}

const expired = () => new ApiError(409, 'csdn_session_expired', 'CSDN 登录状态已失效，请重新扫码连接')
const uncertain = (message: string) => new ApiError(502, 'csdn_result_uncertain', message)
type Data = Record<string, unknown>
function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {} }
function textOf(value: unknown): string { return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '' }
function log(...parts: unknown[]): void { console.log('[csdn]', ...parts) }
function decode(value: string | undefined): string {
  if (!value) return ''
  const unicode = value.replace(/%u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  try { return decodeURIComponent(unicode) } catch { return unicode }
}
function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'CSDN 文章'
}

/**
 * Compare what the editor shows against the article without letting Markdown
 * syntax decide the result. The editor keeps `#`, `|`, `**` and friends, while
 * the imported Markdown is full of them; comparing raw strings made every
 * import look like it failed.
 */
function editorProbe(value: string): string {
  return value
    .replace(/[\u200b\ufeff]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function csdnEditorContainsArticle(markdown: string, text: string, editorText: string): boolean {
  const haystack = editorProbe(editorText)
  if (!haystack) return false
  const markdownProbe = editorProbe(markdown)
  const probe = markdownProbe.length >= 6 ? markdownProbe : editorProbe(text)
  if (probe.length < 6) return false
  if (probe.length <= 120) return haystack.includes(probe)
  // Require the head, middle and tail: a partial import, a leftover title or a
  // dropped middle section must not pass.
  const middleStart = Math.floor((probe.length - 40) / 2)
  return haystack.includes(probe.slice(0, 40))
    && haystack.includes(probe.slice(middleStart, middleStart + 40))
    && haystack.includes(probe.slice(-40))
}

function titleText(value: string): string {
  return value.replace(/[\s\u200b\ufeff]+/g, '').replace(/[.…]+$/u, '')
}

/** The CSDN title bar may truncate long titles; accept a whitespace-free prefix. */
export function csdnTitleMatches(shown: string, title: string): boolean {
  const expected = titleText(title)
  const actual = titleText(shown)
  if (!expected || !actual) return false
  if (actual === expected) return true
  return expected.startsWith(actual) && actual.length >= Math.min(20, expected.length)
}

/**
 * If the editor autosaved while importing or filling the title, a later failure
 * may still leave a draft behind. Such a result must be verified by the user,
 * not retried as if nothing had been submitted.
 */
export function csdnEarlySaveNeedsCheck(stage: string, saveRequested: boolean): boolean {
  return saveRequested && stage !== '保存 CSDN 草稿' && stage !== '发布 CSDN 文章'
}

/** Read the signed-in identity from CSDN cookies. UserToken alone is not enough. */
export function parseCsdnIdentity(cookies: Array<{ name: string; value: string }>): CsdnIdentity | null {
  const map = new Map(cookies.map(cookie => [cookie.name, cookie.value]))
  if (!map.get('UserToken')) return null
  const accountId = decode(map.get('UserName')).trim()
  const name = decode(map.get('UserNick')).trim() || accountId
  return accountId ? { accountId, name: name || 'CSDN 用户' } : null
}

/** Parse the CSDN markdown editor save response (`saveArticle`). */
export function parseCsdnSaveResponse(value: unknown): { code: number; message: string; id: string; url: string; originalRejected: boolean } | null {
  const root = object(value)
  if (root.code === undefined && root.message === undefined) return null
  const code = Number(root.code)
  const data = object(root.data)
  const id = /^\d{5,20}$/.test(textOf(data.id)) ? textOf(data.id) : ''
  const url = /^https?:\/\//.test(textOf(data.url)) ? textOf(data.url) : ''
  const original = textOf(data.check_original_status)
  return {
    code: Number.isFinite(code) ? code : 0,
    message: textOf(root.message) || textOf(root.msg) || (Number.isFinite(code) ? `HTTP ${code}` : '未知错误'),
    id,
    url,
    originalRejected: original === 'false' || data.check_original_status === false,
  }
}

/** Extract the numeric article id from a public/blog editor URL. */
export function parseCsdnArticleId(value: string | null | undefined): string | null {
  const raw = typeof value === 'string' ? value : ''
  const match = raw.match(/(?:article\/details\/|articleId=)(\d{5,20})/i)
  return match?.[1] ?? null
}

export function csdnArticleUrl(accountId: string, articleId: string): string {
  return `https://blog.csdn.net/${encodeURIComponent(accountId)}/article/details/${encodeURIComponent(articleId)}`
}

export class PlaywrightCsdnDriver implements CsdnDriver {
  private browser: Promise<Browser> | null = null
  private readonly contexts = new PublisherContextCache()

  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    const key = state ? this.contexts.key(state) : null
    if (key) { const cached = this.contexts.get(key); if (cached) return cached }
    if (!this.browser) {
      const executablePath = publisherExecutablePath('csdn')
      if (!executablePath) throw new ApiError(503, 'csdn_browser_unavailable', '服务器未安装可用的 Chrome / Chromium 浏览器')
      this.browser = chromium.launch({ executablePath, headless: true, chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1', args: ['--disable-dev-shm-usage'] }).then(browser => {
        browser.on('disconnected', () => { this.browser = null })
        return browser
      }).catch(() => { this.browser = null; throw new ApiError(503, 'csdn_browser_unavailable', '无法启动 CSDN 浏览器，请检查服务器浏览器配置') })
    }
    const context = await (await this.browser).newContext({ storageState: state, locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(20_000)
    if (key) this.contexts.set(key, context)
    return context
  }

  private async releaseContext(context: BrowserContext): Promise<void> {
    await this.contexts.release(context)
  }

  private async identity(context: BrowserContext): Promise<CsdnIdentity | null> {
    return parseCsdnIdentity(await context.cookies().catch(() => []))
  }

  private async readQr(page: Page): Promise<string | null> {
    const found = await page.evaluate(`(() => {
      const scoped = document.querySelector('.login-code-wechat img, .login-box-code img, .login-code img')
      if (scoped) {
        const src = scoped.getAttribute('src') || ''
        if (src.startsWith('data:image/')) return src
      }
      const images = Array.from(document.querySelectorAll('img[src^="data:image/"]'))
        .map((image) => {
          const rect = image.getBoundingClientRect()
          return { src: image.getAttribute('src') || '', area: rect.width * rect.height }
        })
        .filter((image) => image.src.startsWith('data:image/'))
        .sort((left, right) => right.area - left.area)
      return images[0] ? images[0].src : null
    })()`).catch(() => null)
    return typeof found === 'string' ? found : null
  }

  async beginLogin(): Promise<CsdnLoginAttempt> {
    const context = await this.context(), page = await context.newPage()
    let closed = false, qrCode: string | null = null
    const close = async () => { if (!closed) { closed = true; await this.releaseContext(context) } }
    const deadline = Date.now() + 5 * 60_000
    try {
      await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      for (let attempt = 0; attempt < 8 && !qrCode; attempt += 1) {
        await page.waitForTimeout(attempt === 0 ? 2_000 : 1_500)
        qrCode = await this.readQr(page)
      }
      if (!qrCode) throw new ApiError(502, 'csdn_login_unavailable', 'CSDN 登录页没有返回可识别的二维码，请稍后重试')
      log('login QR ready')
    } catch (error) {
      await close()
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'csdn_login_unavailable', '无法取得 CSDN 官方登录二维码，请检查服务器网络或稍后重试')
    }
    return {
      close,
      poll: async () => {
        if (closed || Date.now() > deadline) return { status: 'expired', qrCode: null, message: 'CSDN 登录二维码已过期，请重新获取' }
        const body = await page.locator('body').innerText().catch(() => '')
        if (/二维码已过期|二维码失效|重新获取二维码/.test(body)) return { status: 'expired', qrCode: null, message: 'CSDN 登录二维码已失效，请重新获取' }
        if (/安全验证|风险验证|环境异常|请完成验证|滑动验证/.test(body)) throw new ApiError(409, 'csdn_security_check', 'CSDN 要求安全验证，请到官方页面完成验证后重新连接')
        const identity = await this.identity(context)
        if (identity) {
          log('login completed', identity.accountId)
          return { status: 'connected', qrCode: null, message: 'CSDN 已登录，登录状态已保存', state: await context.storageState(), identity }
        }
        const next = await this.readQr(page).catch(() => null)
        if (next) qrCode = next
        return { status: /扫描成功|扫码成功|已扫描|请在手机|确认登录/.test(body) ? 'scanned' : 'waiting', qrCode, message: '请使用微信扫描二维码登录 CSDN' }
      },
    }
  }

  private async openEditor(context: BrowserContext): Promise<Page> {
    const page = await context.newPage()
    try {
      // The editor always calls its signed getBaseInfo endpoint on boot. A 401
      // there means the stored cookies are no longer valid even if the SPA shell
      // still renders.
      const baseInfo = page.waitForResponse(response => response.url().includes('/v3/editor/getBaseInfo'), { timeout: 30_000 }).catch(() => null)
      await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (/passport\.csdn\.net/i.test(page.url())) throw expired()
      await page.locator(EDITOR_BODY).first().waitFor({ state: 'visible', timeout: 30_000 })
      if (/passport\.csdn\.net/i.test(page.url())) throw expired()
      const session = await Promise.race([
        baseInfo,
        new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), 3_000); timer.unref() }),
      ])
      if (session && [401, 403].includes(session.status())) throw expired()
      return page
    } catch (error) {
      await page.close().catch(() => {})
      if (error instanceof ApiError) throw error
      if (!await this.identity(context)) throw expired()
      throw new ApiError(502, 'csdn_editor_unavailable', 'CSDN 编辑器加载失败，请检查服务器网络或稍后重试')
    }
  }

  async checkSession(state: PublisherStorageState) {
    const context = await this.context(state)
    try {
      const identity = await this.identity(context)
      if (!identity) throw expired()
      const page = await this.openEditor(context)
      await page.close().catch(() => {})
      return { state: await context.storageState(), identity }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'csdn_check_failed', 'CSDN 连接检查未完成，请检查网络后重试')
    } finally { await this.releaseContext(context) }
  }

  async checkPublication(state: PublisherStorageState, remoteId: string, title: string, url?: string | null) {
    const context = await this.context(state)
    try {
      const identity = await this.identity(context)
      const target = url && /^https:\/\/blog\.csdn\.net\//i.test(url) ? url : identity ? csdnArticleUrl(identity.accountId, remoteId) : null
      if (!target) return { state: await context.storageState(), status: 'unknown' as const, url: null, message: '缺少 CSDN 账号信息，请到 CSDN 后台核实' }
      const response = await context.request.get(target, { timeout: 20_000, headers: { Accept: 'text/html' } })
      if (response.status() === 404) return { state: await context.storageState(), status: 'missing' as const, url: null, message: 'CSDN 文章不存在，可能已删除或未发布成功' }
      const html = await response.text().catch(() => '')
      const $ = load(html)
      const found = $('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text()
      const missing = /页面不存在|您访问的页面不存在|你访问的页面不存在|404 Not Found/i.test(found + (await $('body').text()).slice(0, 400))
      if (response.status() === 200 && !missing && found && (!title || found.includes(title.slice(0, 10)))) {
        return { state: await context.storageState(), status: 'published' as const, url: target, message: '已重新核实：CSDN 文章已发布' }
      }
      return { state: await context.storageState(), status: 'unknown' as const, url: null, message: 'CSDN 暂未返回可确认的发布结果，请到 CSDN 后台核实' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'csdn_check_failed', 'CSDN 发布结果核实未完成，请稍后重试')
    } finally { await this.releaseContext(context) }
  }

  async deleteDraft(state: PublisherStorageState, remoteId: string) {
    const context = await this.context(state)
    try {
      const identity = await this.identity(context)
      if (!identity) throw expired()
      const contentType = 'application/json;charset=UTF-8'
      const response = await context.request.post(DELETE_API, {
        data: { articleId: remoteId, deep: true },
        headers: { ...signedHeaders(contentType), Origin: 'https://mp.csdn.net', Referer: 'https://mp.csdn.net/mp_blog/manage/article' },
        timeout: 30_000,
      })
      const body = object(await response.json().catch(() => null))
      const code = Number(body.code)
      const message = textOf(body.message) || textOf(body.msg)
      if (response.status() === 401 || response.status() === 403 || code === 401 || code === 403) throw expired()
      if (response.ok() && code === 200) return { state: await context.storageState(), remoteDeleted: true, message: 'CSDN 草稿已删除' }
      if (/不存在|已删除|找不到|not\s*found/i.test(message)) return { state: await context.storageState(), remoteDeleted: false, message: 'CSDN 草稿已不存在，已清理本系统记录' }
      throw new ApiError(502, 'csdn_delete_failed', `CSDN 删除草稿失败：${message || `HTTP ${response.status()}${Number.isFinite(code) ? ` / 错误码 ${code}` : ''}`}`)
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'csdn_delete_failed', 'CSDN 删除草稿未完成，请检查网络后重试')
    } finally { await this.releaseContext(context) }
  }

  /**
   * CSDN opens a template-library modal and a coach-mark guide on some editor
   * boots. Both overlay the title bar and the editor, so pointer actions time
   * out even though the import itself succeeded. Dismiss only known onboarding
   * overlays; the publish dialog is opened later and never touched here.
   */
  private async dismissEditorHints(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let dismissed = false
      const modal = page.locator('.modal:visible').first()
      if (await modal.count()) {
        const close = modal.locator('.modal__close-button[title="关闭"]').first()
        if (await close.count() && await close.isVisible().catch(() => false)) {
          await close.click({ timeout: 3_000 }).catch(() => {})
          dismissed = true
        } else {
          await page.keyboard.press('Escape').catch(() => {})
          dismissed = true
        }
      }
      const guide = page.locator('.beginnerGuide-box:visible').first()
      if (await guide.count()) {
        const button = guide.getByRole('button', { name: /^(?:我知道了|知道了|跳过)$/ }).first()
        if (await button.count()) await button.click({ timeout: 3_000 }).catch(() => {})
        else await page.keyboard.press('Escape').catch(() => {})
        dismissed = true
      }
      if (!dismissed) return
      log('dismissed CSDN onboarding overlay')
      await page.waitForTimeout(300)
    }
  }

  private async fillTitle(page: Page, title: string): Promise<void> {
    const display = page.locator(TITLE_DISPLAY).first()
    if (await display.count()) {
      await display.click({ timeout: 5_000 }).catch(async () => { await display.dispatchEvent('click').catch(() => {}) })
    }
    const input = page.locator(`${TITLE_INPUT}:visible`).first()
    if (!await input.count()) throw new ApiError(502, 'csdn_editor_unavailable', 'CSDN 编辑器没有找到标题输入框，页面可能已改版')
    await input.fill(title)
    await input.press('Enter')
    await page.waitForTimeout(300)
    const value = (await input.inputValue().catch(() => '')).trim()
    const shown = (await display.innerText().catch(() => '')).trim()
    if (value !== title && !csdnTitleMatches(shown, title)) {
      throw new ApiError(502, 'csdn_title_failed', `CSDN 标题没有正确写入（当前为“${(value || shown).slice(0, 40)}”），请稍后重试`)
    }
  }

  private async importMarkdown(page: Page, article: CsdnArticle): Promise<void> {
    const editor = page.locator(EDITOR_BODY).first()
    const readEditor = async (): Promise<string> => editor.innerText().catch(() => '')
    const imported = async (): Promise<boolean> => csdnEditorContainsArticle(article.markdown, article.text, await readEditor())
    const importer = page.locator('#import-markdown-file-input').first()
    if (await importer.count()) {
      try {
        await importer.setInputFiles({ name: `${safeFilename(article.title)}.md`, mimeType: 'text/markdown', buffer: Buffer.from(article.markdown, 'utf8') })
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await page.waitForTimeout(500)
          if (await imported()) { log('markdown import verified'); return }
        }
      } catch (error) {
        log('markdown import failed', error instanceof Error ? error.message : String(error))
      }
      log('markdown import did not take effect, falling back to paste')
    }
    // Fallback for editor revisions that hide the importer: focus the Markdown
    // surface directly (avoid pointer events blocked by overlays), replace its
    // contents, then verify the article text before any save request is made.
    try {
      await this.dismissEditorHints(page)
      await editor.focus({ timeout: 5_000 }).catch(async () => { await editor.click({ timeout: 5_000 }) })
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      await page.keyboard.insertText(article.markdown)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await page.waitForTimeout(500)
        if (!await imported()) continue
        const shown = await readEditor()
        const welcome = /欢迎使用\s*Markdown\s*编辑器|这里写自定义目录标题/
        if (welcome.test(shown) && !welcome.test(article.markdown)) throw new ApiError(502, 'csdn_body_failed', 'CSDN 正文粘贴时没有替换编辑器中的旧内容，未提交保存；请稍后重试')
        log('markdown paste verified')
        return
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'csdn_body_failed', `CSDN 正文导入失败，未提交保存：${error instanceof Error ? error.message : '页面操作异常'}`)
    }
    throw new ApiError(502, 'csdn_body_failed', 'CSDN 正文导入未生效（导入和粘贴都没有写入正文），未提交保存；请稍后重试或先保存草稿再粘贴')
  }

  private async addTags(page: Page, tags: string[]): Promise<void> {
    if (!tags.length) return
    const modal = page.locator(PUBLISH_MODAL).first()
    const trigger = modal.locator('button.tag__btn-tag').first()
    if (!await trigger.count()) return
    await trigger.click().catch(() => {})
    const box = page.locator('.mark_selection_box').first()
    if (!await box.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) return
    const input = box.locator('input.el-input__inner').first()
    for (const tag of tags.slice(0, 5)) {
      if (!tag.trim()) continue
      if (await input.count()) {
        await input.fill(tag).catch(() => {})
        await input.press('Enter').catch(() => {})
        await page.waitForTimeout(400)
      }
    }
    await box.locator('button.modal__close-button').first().click().catch(() => {})
    await page.waitForTimeout(300)
  }

  private async notice(page: Page): Promise<string> {
    const toasts = await page.locator('.el-message, .el-notification, .notice, .toast').allInnerTexts().catch(() => [] as string[])
    const joined = toasts.join(' ').replace(/\s+/g, ' ').trim()
    if (joined) return joined.slice(0, 160)
    const body = await page.locator('body').innerText().catch(() => '')
    return body.match(/(标题长度[^\n]{0,40}|请设置文章标签|文章内容不能为空|文章类型[^\n]{0,30}|请先登录[^\n]{0,20}|登录已失效|原创[^\n]{0,40})/)?.[0] ?? ''
  }

  private async saveResponse(page: Page, pubStatus: 'draft' | 'publish'): Promise<Response> {
    return page.waitForResponse((response) => {
      if (response.request().method() !== 'POST' || !response.url().includes(SAVE_API)) return false
      const body = response.request().postData() ?? ''
      return body.includes(`"pubStatus":"${pubStatus}"`)
    }, { timeout: 120_000 })
  }

  private async saveResult(response: Response): Promise<{ id: string; url: string; message: string }> {
    let body: unknown = null
    try { body = await response.json() } catch { body = null }
    const parsed = parseCsdnSaveResponse(body)
    const status = response.status()
    if (status === 401 || status === 403 || parsed?.code === 401 || parsed?.code === 403) throw expired()
    if (status >= 500) throw uncertain(`CSDN 保存接口返回 HTTP ${status}，结果未确认；请先到 CSDN 草稿箱和文章列表核实`)
    if (!response.ok()) throw new ApiError(502, 'csdn_save_failed', `CSDN 保存失败：${parsed?.message || `HTTP ${status}`}`)
    if (!parsed) throw uncertain('CSDN 返回了无法解析的保存结果，结果未确认；请先到 CSDN 草稿箱核实')
    if (parsed.code !== 200) {
      if (parsed.code >= 500) throw uncertain(`CSDN 保存接口返回错误码 ${parsed.code}（${parsed.message}），结果未确认；请先到 CSDN 草稿箱核实`)
      throw new ApiError(502, 'csdn_save_failed', `CSDN 保存失败：${parsed.message}`)
    }
    if (!parsed.id) throw uncertain('CSDN 已接收保存请求，但没有返回文章编号；请到 CSDN 草稿箱核实，避免重复创建')
    if (parsed.originalRejected) throw new ApiError(409, 'csdn_original_rejected', 'CSDN 原创校验未通过：该文章可能被判定为非原创，请到 CSDN 后台查看审核原因')
    return { id: parsed.id, url: parsed.url, message: parsed.message }
  }

  async publish(state: PublisherStorageState, article: CsdnArticle, progress: (value: Partial<Pick<CsdnPublication, 'message' | 'remoteId' | 'url'>>) => void) {
    const context = await this.context(state)
    let stage = '准备 CSDN 编辑器', saveRequested = false
    try {
      const page = await this.openEditor(context)
      try {
        // CSDN may autosave while the article is being imported or titled.
        // Track every write from the moment the editor exists so a later
        // failure is never mistaken for "nothing was submitted".
        page.on('request', request => {
          if (request.method() === 'POST' && request.url().includes(SAVE_API)) saveRequested = true
        })
        await page.waitForTimeout(800)
        await this.dismissEditorHints(page)
        progress({ message: '正在导入 CSDN 正文' })
        stage = '导入 CSDN 正文'
        await this.importMarkdown(page, article)
        await this.dismissEditorHints(page)
        await this.fillTitle(page, article.title)
        if (article.mode === 'draft') {
          progress({ message: '正在保存 CSDN 草稿' })
          stage = '保存 CSDN 草稿'
          const pending = this.saveResponse(page, 'draft')
          await page.locator('button.btn-save').first().click()
          let response: Response
          try { response = await pending }
          catch {
            if (!saveRequested) throw new ApiError(502, 'csdn_save_blocked', `CSDN 没有提交保存请求：${await this.notice(page) || '请检查编辑器状态后重试'}`)
            throw uncertain('CSDN 草稿保存请求已发出，但结果未确认；请先到 CSDN 草稿箱核实，避免重复创建')
          }
          const result = await this.saveResult(response)
          const url = `https://editor.csdn.net/md/?articleId=${encodeURIComponent(result.id)}`
          progress({ message: 'CSDN 草稿已保存', remoteId: result.id, url })
          return { state: await context.storageState(), status: 'draft' as const, remoteId: result.id, url, message: '已保存到 CSDN 草稿箱' }
        }
        progress({ message: '正在打开发布设置' })
        stage = '打开发布设置'
        await page.locator('button.btn-publish').first().click()
        const modal = page.locator(PUBLISH_MODAL).first()
        try { await modal.waitFor({ state: 'visible', timeout: 30_000 }) }
        catch { throw new ApiError(502, 'csdn_publish_dialog', `CSDN 发布设置没有打开：${await this.notice(page) || '页面可能已改版或登录状态失效，请重试'}`) }
        await this.addTags(page, article.tags)
        progress({ message: '正在发布 CSDN 文章' })
        stage = '发布 CSDN 文章'
        const pending = this.saveResponse(page, 'publish')
        await modal.locator('.publish-article-modal__footer button.btn-b-red').first().click()
        let response: Response
        try { response = await pending }
        catch {
          if (!saveRequested) throw new ApiError(400, 'csdn_publish_blocked', `CSDN 发布设置校验未通过，未提交发布：${await this.notice(page) || '请检查标签、标题和可见范围后重试'}`)
          throw uncertain('CSDN 发布请求已发出，但结果未确认；请先到 CSDN 草稿箱和文章列表核实，避免重复发布')
        }
        const result = await this.saveResult(response)
        const identity = await this.identity(context)
        const url = result.url || (identity ? csdnArticleUrl(identity.accountId, result.id) : '')
        if (!url) throw uncertain(`CSDN 文章 ${result.id} 已提交发布，但没有返回公开地址；请到 CSDN 后台核实`)
        progress({ message: 'CSDN 文章已发布', remoteId: result.id, url })
        return { state: await context.storageState(), status: 'published' as const, remoteId: result.id, url, message: `已发布到 CSDN：${url}` }
      } finally { await page.close().catch(() => {}) }
    } catch (error) {
      if (csdnEarlySaveNeedsCheck(stage, saveRequested)) {
        throw uncertain(`CSDN ${stage}时编辑器已自动提交过保存请求，后续操作失败${error instanceof ApiError ? `（${error.message}）` : ''}；结果未确认，请先到 CSDN 草稿箱核实，避免重复创建`)
      }
      if (error instanceof ApiError) throw error
      if (saveRequested) throw uncertain(`CSDN ${stage}时页面或网络异常，结果未确认；请先到 CSDN 草稿箱和文章列表核实，避免重复发布`)
      throw new ApiError(502, 'csdn_publish_failed', `CSDN ${stage}时页面异常，尚未提交保存，请稍后重试`)
    } finally { await this.releaseContext(context) }
  }

  async close(): Promise<void> {
    await this.contexts.close()
    const pending = this.browser
    this.browser = null
    if (pending) await (await pending).close().catch(() => {})
  }
}
