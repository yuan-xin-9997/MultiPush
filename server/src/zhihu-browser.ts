import { chromium, type Browser, type BrowserContext, type APIResponse, type Page } from 'playwright-core'
import { load } from 'cheerio'
import type { ZhihuPublication } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import type { PublisherImage } from './publisher-image'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'
import { prepareZhihuContent, zhihuEditorContent, verifyZhihuContent, zhihuImageUrl } from './zhihu-content'

export interface ZhihuIdentity { accountId: string; name: string }
export interface ZhihuArticle { title: string; html: string; images: Map<string, PublisherImage>; cover?: PublisherImage }
export interface ZhihuLoginAttempt {
  poll(): Promise<{ status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'; qrCode: string | null; message: string; state?: PublisherStorageState; identity?: ZhihuIdentity }>
  close(): Promise<void>
}
export interface ZhihuDriver {
  beginLogin(): Promise<ZhihuLoginAttempt>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: ZhihuIdentity }>
  checkPublication(state: PublisherStorageState, remoteId: string, title: string): Promise<{ state: PublisherStorageState; status: 'published' | 'draft' | 'unknown'; url: string | null; message: string }>
  publish(state: PublisherStorageState, article: ZhihuArticle, mode: 'draft' | 'publish', progress: (value: Partial<Pick<ZhihuPublication, 'message' | 'remoteId' | 'url'>>) => void, resumeDraftId?: string): Promise<{ state: PublisherStorageState; status: 'draft' | 'published'; remoteId: string; url: string; message: string }>
  close(): Promise<void>
}

const HOME = 'https://www.zhihu.com/'
const COLUMN = 'https://zhuanlan.zhihu.com/'
const QR = '.Qrcode-img, .SignFlow-qrcode img, img[src*="/qrcode/"], .Qrcode canvas'
type Data = Record<string, unknown>
function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {} }
const expired = () => new ApiError(409, 'zhihu_session_expired', '知乎登录状态已失效，请重新扫码连接')

export async function zhihuResponse(response: APIResponse, action: string): Promise<Data> {
  if (response.status() === 401) throw expired()
  if (response.status() === 403) throw new ApiError(409, 'zhihu_security_check', '知乎要求安全验证或暂时限制了当前请求，请在知乎完成验证后重试')
  const data = object(await response.json().catch(() => null))
  if (!response.ok() || data.error || data.code !== undefined && Number(data.code) !== 0) {
    throw new ApiError(502, 'zhihu_rejected', `${action}失败（HTTP ${response.status()}），请检查知乎账号权限或稍后重试`)
  }
  return data
}

export function parseZhihuPublishedId(value: unknown): string | null {
  const data = object(value)
  if (data.code !== 0 && data.code !== '0') return null
  let result = object(data.data).result
  if (typeof result === 'string') { try { result = JSON.parse(result) } catch { return null } }
  const id = object(object(result).publish).id
  return id !== undefined && /^\d+$/.test(String(id)) ? String(id) : null
}

export class PlaywrightZhihuDriver implements ZhihuDriver {
  private browser: Promise<Browser> | null = null

  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = publisherExecutablePath('zhihu')
      if (!executablePath) throw new ApiError(503, 'zhihu_browser_unavailable', '服务器未安装可用的 Chrome / Chromium 浏览器')
      this.browser = chromium.launch({ executablePath, headless: true, chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1', args: ['--disable-dev-shm-usage'] }).then(browser => {
        browser.on('disconnected', () => { this.browser = null })
        return browser
      }).catch(() => { this.browser = null; throw new ApiError(503, 'zhihu_browser_unavailable', '无法启动知乎浏览器，请检查服务器浏览器配置') })
    }
    const context = await (await this.browser).newContext({ storageState: state, locale: 'zh-CN', viewport: { width: 1280, height: 1000 } })
    context.setDefaultTimeout(15_000)
    return context
  }

  private async identity(context: BrowserContext): Promise<ZhihuIdentity> {
    const response = await context.request.get(`${HOME}api/v4/me`, { headers: { 'x-requested-with': 'fetch', Referer: HOME }, timeout: 20_000 })
    const data = await zhihuResponse(response, '检查知乎登录状态')
    if (!data.id || typeof data.name !== 'string') throw expired()
    return { accountId: String(data.id), name: data.name }
  }

  async beginLogin(): Promise<ZhihuLoginAttempt> {
    const context = await this.context(), page = await context.newPage()
    let closed = false, qrCode: string | null = null
    const close = async () => { if (!closed) { closed = true; await context.close().catch(() => {}) } }
    const deadline = Date.now() + 5 * 60_000
    try {
      const response = await page.goto(`${HOME}signin`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (response?.status() === 403) throw new ApiError(409, 'zhihu_security_check', '知乎登录页要求安全验证，请稍后重试或在知乎解除账号限制')
      if (!await page.locator(QR).first().isVisible().catch(() => false)) {
        const switcher = page.locator('.SignFlow-switch, .SignFlow-qrcodeTab').first()
        if (await switcher.isVisible().catch(() => false)) await switcher.click()
        else {
          const tab = page.getByText('扫码登录', { exact: true }).first()
          if (await tab.isVisible().catch(() => false)) await tab.click()
        }
      }
      await page.locator(QR).first().waitFor({ state: 'visible', timeout: 15_000 })
    } catch (error) {
      await close()
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'zhihu_login_unavailable', '无法取得知乎官方登录二维码，请检查服务器网络或稍后重试')
    }
    return {
      close,
      poll: async () => {
        if (closed || Date.now() > deadline) return { status: 'expired', qrCode: null, message: '知乎登录二维码已过期，请重新获取' }
        if ((await context.cookies(HOME)).some(cookie => cookie.name === 'z_c0' && cookie.value)) {
          try {
            const identity = await this.identity(context)
            return { status: 'connected', qrCode: null, message: '知乎已登录，登录状态已保存', state: await context.storageState(), identity }
          } catch (error) { if (!(error instanceof ApiError && error.code === 'zhihu_session_expired')) throw error }
        }
        const text = await page.locator('body').innerText()
        if (/二维码已失效|二维码已过期/.test(text)) return { status: 'expired', qrCode: null, message: '二维码已失效，请重新获取' }
        const qr = page.locator(QR).first()
        if (await qr.isVisible().catch(() => false)) qrCode = `data:image/png;base64,${(await qr.screenshot({ type: 'png', animations: 'disabled', timeout: 5000 })).toString('base64')}`
        const scanned = /扫码成功|已扫码|在手机上确认/.test(text)
        return { status: scanned ? 'scanned' : 'waiting', qrCode, message: scanned ? '请在知乎 App 中确认登录' : '请使用知乎 App 扫描二维码登录' }
      },
    }
  }

  async checkSession(state: PublisherStorageState) {
    const context = await this.context(state)
    try { const identity = await this.identity(context); return { state: await context.storageState(), identity } }
    catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'zhihu_check_failed', '知乎连接检查未完成，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async checkPublication(state: PublisherStorageState, remoteId: string, title: string) {
    if (!/^\d+$/.test(remoteId)) throw new ApiError(400, 'zhihu_draft_invalid', '远端编号无效，无法自动核实')
    const context = await this.context(state)
    try {
      const identity = await this.identity(context)
      const headers = { 'x-requested-with': 'fetch', Referer: `${COLUMN}p/${remoteId}/edit` }
      const publishedResponse = await context.request.get(`${COLUMN}api/articles/${remoteId}`, { headers, timeout: 15_000 })
      if (publishedResponse.status() !== 404) {
        const published = await zhihuResponse(publishedResponse, '重新核实知乎文章')
        if (String(published.id) === remoteId && published.title === title && String(object(published.author).id) === identity.accountId && (published.state === 'published' || published.is_published === true)) {
          return { state: await context.storageState(), status: 'published' as const, url: `${COLUMN}p/${remoteId}`, message: '已重新核实：知乎确认该文章已发布' }
        }
      }
      const response = await context.request.get(`${COLUMN}api/articles/${remoteId}/draft`, { headers, timeout: 15_000 })
      if (response.status() !== 404) {
        const draft = await zhihuResponse(response, '重新核实知乎草稿')
        if (String(draft.id) === remoteId && draft.title === title && String(object(draft.author).id) === identity.accountId && draft.state === 'draft' && draft.has_publishing_draft === false) {
          return { state: await context.storageState(), status: 'draft' as const, url: `${COLUMN}p/${remoteId}/edit`, message: '知乎仍有这份草稿。请确认未通过其他记录发布，再选择“已核实未发布，允许重试”' }
        }
      }
      return { state: await context.storageState(), status: 'unknown' as const, url: null, message: '知乎暂未给出可确认的发布结果，请核对知乎后台后选择人工核实结果' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'zhihu_check_failed', '重新核实知乎结果未完成，请稍后重试或人工核实')
    } finally { await context.close().catch(() => {}) }
  }

  async publish(state: PublisherStorageState, article: ZhihuArticle, mode: 'draft' | 'publish', progress: Parameters<ZhihuDriver['publish']>[3], resumeDraftId?: string) {
    if (resumeDraftId && !/^\d+$/.test(resumeDraftId)) throw new ApiError(400, 'zhihu_draft_invalid', '知乎草稿编号无效')
    const context = await this.context(state)
    let remoteId = resumeDraftId || '', writeRequested = false, publishSubmitted = false
    try {
      await this.identity(context)
      const cookies = await context.cookies([HOME, COLUMN])
      const headers = { 'x-requested-with': 'fetch', 'x-xsrftoken': cookies.find(cookie => cookie.name === '_xsrf')?.value || '', Referer: `${COLUMN}write`, Origin: COLUMN.slice(0, -1) }
      const read = async (id: string, kind: 'draft' | 'published') => zhihuResponse(await context.request.get(`${COLUMN}api/articles/${id}${kind === 'draft' ? '/draft' : ''}`, { headers, timeout: 30_000 }), kind === 'draft' ? '核对知乎草稿' : '核对知乎文章')
      const upload = async (image: PublisherImage): Promise<string> => {
        const data = await zhihuResponse(await context.request.post(`${COLUMN}api/uploaded_images`, { headers, multipart: { picture: image, source: 'article' }, timeout: 30_000 }), '上传知乎图片')
        const src = zhihuImageUrl(data.src)
        if (!src) throw new ApiError(502, 'zhihu_image_upload', '知乎图片上传未返回有效的知乎素材地址，已停止发布')
        return src
      }
      const $ = load(article.html, null, false)
      let cover: string | undefined
      if (resumeDraftId) {
        progress({ message: '正在恢复已有知乎草稿', remoteId, url: `${COLUMN}p/${remoteId}/edit` })
        const existing = await read(remoteId, 'draft')
        if (existing.state !== 'draft' || existing.title !== article.title || typeof existing.content !== 'string') throw new ApiError(409, 'zhihu_draft_changed', '已有知乎草稿状态或标题已变更，已停止重试，请到知乎核对')
        verifyZhihuContent(prepareZhihuContent(article.html), existing.content)
        const saved = load(existing.content, null, false), urls = saved('img').toArray().map(n => saved(n).attr('src') || saved(n).attr('data-original-src'))
        $('img').each((index, node) => { $(node).attr('src', urls[index]!) })
      } else {
        progress({ message: '正在上传知乎正文图片与封面' })
        for (const [src, image] of article.images) {
          const uploaded = await upload(image)
          $('img').filter((_, node) => $(node).attr('src') === src).attr('src', uploaded).removeAttr('srcset')
        }
        cover = article.cover ? await upload(article.cover) : undefined
      }
      const content = zhihuEditorContent($.html())
      const ready = load(content, null, false)
      if (ready('img').toArray().some(n => !zhihuImageUrl(ready(n).attr('src')))) throw new ApiError(400, 'zhihu_external_image', '正文仍含未上传到知乎的图片，已停止发布')
      if (!resumeDraftId) {
        progress({ message: '正在创建知乎草稿' })
        writeRequested = true
        const created = await zhihuResponse(await context.request.post(`${COLUMN}api/articles/drafts`, { headers, data: { title: article.title, content: '', delta_time: 0, can_reward: false }, timeout: 30_000 }), '创建知乎草稿')
        remoteId = String(created.id || '')
        if (!/^\d+$/.test(remoteId)) throw new ApiError(502, 'zhihu_draft_unverified', '知乎未返回有效草稿编号，请检查草稿箱，避免重复创建')
      }
      const url = `${COLUMN}p/${remoteId}/edit`
      progress({ message: '正在保存并核对知乎正文', remoteId, url })
      await zhihuResponse(await context.request.patch(`${COLUMN}api/articles/${remoteId}/draft`, { headers, data: { title: article.title, ...(cover ? { title_image: cover } : {}), delta_time: 0, can_reward: false }, timeout: 30_000 }), '保存知乎标题')
      await zhihuResponse(await context.request.patch(`${COLUMN}api/articles/${remoteId}/draft`, { headers, data: { content, table_of_contents: false, delta_time: 0, can_reward: false }, timeout: 30_000 }), '保存知乎正文')
      const stored = await read(remoteId, 'draft')
      if (stored.title !== article.title || typeof stored.content !== 'string') throw new ApiError(502, 'zhihu_content_mismatch', '知乎保存后的标题或正文无法核对，已停止发布')
      verifyZhihuContent(content, stored.content)
      if (mode === 'draft') return { state: await context.storageState(), status: 'draft' as const, remoteId, url, message: '已保存知乎草稿，并核对图片、列表、图注与链接' }
      progress({ message: '正文核对通过，正在提交知乎发布' })
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (/signin/.test(page.url())) throw expired()
      let publishedId: string | null = null, rejected = false
      page.on('response', response => {
        if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/v4/content/publish') return
        void response.json().then(data => { publishedId = parseZhihuPublishedId(data); rejected = !publishedId }, () => {})
      })
      // Once any publish action may have been submitted, never replay it after a timeout.
      publishSubmitted = true
      await page.getByRole('button', { name: /^发布(?:文章)?$/ }).first().click({ timeout: 20_000 })
      const deadline = Date.now() + 45_000
      let confirmed = false
      while (Date.now() < deadline && !publishedId && !rejected) {
        if (!confirmed) {
          const panel = page.locator('[role="dialog"], .PublishPanel').last()
          const button = panel.getByRole('button', { name: /^(?:确认发布|发布|确定)$/ }).last()
          if (await button.isVisible().catch(() => false)) { confirmed = true; await button.click() }
        }
        await page.waitForTimeout(500)
      }
      if (rejected) throw new ApiError(502, 'zhihu_publish_rejected', '知乎未确认发布成功，请打开草稿检查账号权限及发布设置')
      if (!publishedId) throw new ApiError(502, 'zhihu_publish_unverified', '知乎发布结果未能确认，请核对知乎后台，避免重复发布')
      const published = await read(publishedId, 'published')
      if (String(published.id) !== publishedId || published.title !== article.title || !['published', 'PUBLISHED'].includes(String(published.state)) && published.is_published !== true) throw new ApiError(502, 'zhihu_publish_unverified', '知乎尚未确认文章公开状态，请到知乎后台核实')
      verifyZhihuContent(content, String(published.content || ''))
      return { state: await context.storageState(), status: 'published' as const, remoteId: publishedId, url: `${COLUMN}p/${publishedId}`, message: '已发布到知乎，并核对文章内容与发布状态' }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : ''
      if (publishSubmitted || writeRequested && !remoteId && !['zhihu_rejected', 'zhihu_session_expired', 'zhihu_security_check'].includes(code)) {
        throw new ApiError(502, 'zhihu_result_uncertain', '知乎请求已提交，但最终结果未能核实；请先查看知乎草稿和文章，避免重复发布')
      }
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'zhihu_preparation_failed', remoteId ? '知乎操作中断，已保留草稿，请在知乎后台检查' : '知乎准备步骤失败，尚未提交文章，请检查网络后重试')
    } finally { await context.close().catch(() => {}) }
  }

  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null
    if (browser) await browser.then(value => value.close()).catch(() => {})
  }
}
