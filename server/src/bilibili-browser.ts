import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from 'playwright-core'
import type { PublisherStorageState } from './publisher-session'
import { publisherExecutablePath } from './wechat-browser'
import { PublisherContextCache } from './publisher-context-cache'
import { qrReady } from './qr-capture'
import { ApiError } from './errors'
import { wbiSign } from './bilibili-api'
import { pasteHtml, writeClipboardImage } from './browser-clipboard'
import { replaceBilibiliImageMarkers, stripBilibiliImageMarkers } from './bilibili-image-markers'

export interface BilibiliIdentity { accountId: string; name: string }
export interface BilibiliArticleImage { name: string; mime: string; buffer: Buffer }
export interface BilibiliArticleInput {
  title: string
  /** HTML with <img> removed; images are pasted separately as native editor images. */
  html: string
  plain: string
  images: BilibiliArticleImage[]
}
export interface BilibiliLoginAttempt {
  poll(): Promise<{ status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'; qrCode: string | null; message: string; state?: PublisherStorageState; identity?: BilibiliIdentity }>
  close(): Promise<void>
}
export interface BilibiliArticleResult {
  status: 'draft' | 'published' | 'uncertain'
  remoteId: string | null
  url: string | null
  message: string
}

export interface BilibiliDriver {
  beginLogin(): Promise<BilibiliLoginAttempt>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: BilibiliIdentity }>
  publishArticle(state: PublisherStorageState, article: BilibiliArticleInput, mode: 'draft' | 'publish', progress: (message: string) => void): Promise<{ state: PublisherStorageState; result: BilibiliArticleResult }>
  close(): Promise<void>
}

const LOGIN = 'https://passport.bilibili.com/login'
const NAV = 'https://api.bilibili.com/x/web-interface/nav'
const TEXT_UPLOAD = 'https://member.bilibili.com/platform/upload/text'
const DRAFT_LIST = 'https://api.bilibili.com/x/article/creative/draft/list'
const QR_SELECTORS = [
  '.login-scan-code img',
  '.qrcode-img img',
  '.login-qrcode img',
  '.login-scan-code img',
  'img[src^="data:image"]',
  'img[src*="qrcode"]',
  'img[src*="qr"]',
  'canvas[class*="qr"]',
]
const EXPIRED_TEXT = /二维码已过期|二维码失效|请重新登录|登录已过期/
const SECURITY_TEXT = /安全验证|风险验证|请完成验证|验证码/
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+A' : 'Control+A'
const PASTE = process.platform === 'darwin' ? 'Meta+V' : 'Control+V'
const IMAGE_UPLOAD = 'https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs'
const IMAGE_NODE_SELECTOR = 'img'


function stateCookie(state: PublisherStorageState, name: string): string {
  return state.cookies.find((cookie) => cookie.name === name)?.value ?? ''
}

async function wbiKeys(context: BrowserContext): Promise<{ imgKey: string; subKey: string }> {
  const response = await context.request.get(NAV, { timeout: 15_000 })
  const body = object(await response.json().catch(() => null))
  const wbi = object(object(body.data).wbi_img)
  const imgKey = typeof wbi.img_url === 'string' ? wbi.img_url.split('/').pop()?.split('.')[0] ?? '' : ''
  const subKey = typeof wbi.sub_url === 'string' ? wbi.sub_url.split('/').pop()?.split('.')[0] ?? '' : ''
  if (!imgKey || !subKey) throw new ApiError(502, 'bilibili_image_upload', 'B 站没有返回图片上传所需的 WBI 密钥，请重新登录')
  return { imgKey, subKey }
}

async function waitForImageUrl(context: BrowserContext, url: string, timeout = 15_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const response = await context.request.get(url, { timeout: 5_000 })
      if (response.status() === 200 && (response.headers()['content-type'] ?? '').startsWith('image/')) return true
    } catch {
      // The BFS CDN may need a moment to expose a newly uploaded object.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function waitForImageCount(editor: Locator, expected: number, timeout = 20_000): Promise<number> {
  const start = Date.now()
  let count = 0
  while (Date.now() - start < timeout) {
    count = await editor.locator(IMAGE_NODE_SELECTOR).count()
    if (count >= expected) return count
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return count
}

async function editorDiagnostics(editor: Locator, page: Page): Promise<string> {
  const stats = await editor.evaluate((element) => ({
    imgs: element.querySelectorAll('img').length,
    figures: element.querySelectorAll('figure').length,
    imageWrappers: element.querySelectorAll('[class*="image"]').length,
    placeholders: element.querySelectorAll('[class*="placeholder"], [class*="loading"], [class*="upload"]').length,
  })).catch(() => null)
  const bodyText = await page.locator('body').innerText().catch(() => '')
  const security = SECURITY_TEXT.test(bodyText) ? '检测到安全验证' : '未检测到安全验证'
  return `${JSON.stringify(stats ?? {})}；${security}`
}

type Json = Record<string, unknown>
function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}
const expired = () => new ApiError(409, 'bilibili_session_expired', 'B 站登录状态已失效，请重新扫码连接')

async function findEditorFrame(page: Page): Promise<Frame> {
  for (const frame of page.frames()) {
    if (!frame.url().includes('read-editor')) continue
    try {
      if (await frame.locator('.tiptap.ProseMirror, textarea.title-input__inner').count()) return frame
    } catch {
      // Try the next frame.
    }
  }
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue
    try {
      if (await frame.locator('.tiptap.ProseMirror, textarea.title-input__inner').count()) return frame
    } catch {
      // Try the next frame.
    }
  }
  return page.mainFrame()
}

async function enterEditor(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    try {
      const button = frame.getByRole('button', { name: /新的创作/ })
      if (await button.count()) {
        await button.first().click()
        await page.waitForTimeout(4500)
        return
      }
    } catch {
      // Try the next frame.
    }
  }
}

async function readNav(context: BrowserContext): Promise<{ login: boolean; name: string; mid: string }> {
  try {
    const response = await context.request.get(NAV, { timeout: 15_000 })
    const body = object(await response.json())
    const data = object(body.data)
    return {
      login: Boolean(data.isLogin),
      name: typeof data.uname === 'string' ? data.uname : '',
      mid: typeof data.mid === 'number' ? String(data.mid) : '',
    }
  } catch {
    return { login: false, name: '', mid: '' }
  }
}

async function captureQr(page: Page): Promise<string | null> {
  for (const selector of QR_SELECTORS) {
    const locator = page.locator(selector).first()
    try {
      if (!(await locator.count()) || !(await locator.isVisible())) continue
      await qrReady(locator)
      const buffer = await locator.screenshot({ type: 'png' })
      return `data:image/png;base64,${buffer.toString('base64')}`
    } catch {
      // Try the next selector.
    }
  }
  return null
}

export class PlaywrightBilibiliDriver implements BilibiliDriver {
  private browser: Browser | null = null
  private readonly contexts = new PublisherContextCache()

  private async launch(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser
    const executablePath = publisherExecutablePath('bilibili')
    this.browser = await chromium.launch({
      executablePath,
      headless: process.env.BILIBILI_HEADLESS !== '0',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    return this.browser
  }

  private async sessionContext(state: PublisherStorageState, options: { viewport?: { width: number; height: number }; userAgent?: string } = {}): Promise<BrowserContext> {
    const key = this.contexts.key(state)
    const cached = this.contexts.get(key)
    if (cached) return cached
    const browser = await this.launch()
    const context = await browser.newContext({ storageState: state, ...options })
    this.contexts.set(key, context)
    return context
  }

  private async releaseContext(context: BrowserContext): Promise<void> {
    await this.contexts.release(context)
  }

  async beginLogin(): Promise<BilibiliLoginAttempt> {
    const browser = await this.launch()
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForSelector('img[src^="data:image"], .login-scan-code img, canvas', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1200)
    const expiresAt = Date.now() + 3 * 60_000
    let lastQr: string | null = null
    let closed = false
    let scanned = false

    return {
      poll: async () => {
        if (closed) return { status: 'expired', qrCode: null, message: '登录已关闭' }
        const nav = await readNav(context)
        if (nav.login) {
          const state = await context.storageState()
          const identity = { accountId: nav.mid || 'bilibili', name: nav.name || 'B 站账号' }
          return { status: 'connected', qrCode: null, message: `已连接 ${identity.name}`, state, identity }
        }
        if (Date.now() > expiresAt) return { status: 'expired', qrCode: null, message: '二维码已过期，请重新获取' }
        const text = await page.locator('body').innerText().catch(() => '')
        if (EXPIRED_TEXT.test(text)) return { status: 'expired', qrCode: null, message: '二维码已过期，请重新获取' }
        if (SECURITY_TEXT.test(text)) scanned = true
        if (!scanned) {
          const qr = await captureQr(page)
          if (qr) lastQr = qr
        }
        return {
          status: scanned ? 'scanned' : 'waiting',
          qrCode: scanned ? null : lastQr,
          message: scanned ? '已扫码，请在手机上确认登录' : '请使用哔哩哔哩 App 扫码登录',
        }
      },
      close: async () => {
        closed = true
        await context.close().catch(() => {})
      },
    }
  }

  async checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: BilibiliIdentity }> {
    const context = await this.sessionContext(state)
    try {
      const nav = await readNav(context)
      if (!nav.login) throw expired()
      return {
        state: await context.storageState(),
        identity: { accountId: nav.mid || 'bilibili', name: nav.name || 'B 站账号' },
      }
    } finally {
      await this.releaseContext(context)
    }
  }

  /** Upload one article image through Bilibili's editor image endpoint. */
  private async uploadImage(
    context: BrowserContext,
    state: PublisherStorageState,
    image: BilibiliArticleImage,
    keys: { imgKey: string; subKey: string },
    index: number,
    total: number,
  ): Promise<{ url: string; width: number; height: number; size: number }> {
    const csrf = stateCookie(state, 'bili_jct')
    if (!csrf) throw new ApiError(409, 'bilibili_session_expired', 'B 站登录状态缺少 CSRF 凭据，请重新扫码连接')
    const signed = wbiSign({}, keys.imgKey, keys.subKey)
    const query = new URLSearchParams(Object.fromEntries(Object.entries(signed).map(([key, value]) => [key, String(value)]))).toString()
    const response = await context.request.post(`${IMAGE_UPLOAD}?${query}`, {
      multipart: {
        file_up: { name: image.name, mimeType: image.mime, buffer: image.buffer },
        biz: 'new_dyn',
        category: 'daily',
        csrf,
      },
      headers: { Referer: 'https://member.bilibili.com/', Origin: 'https://member.bilibili.com' },
      timeout: 30_000,
    }).catch((error) => {
      throw new ApiError(502, 'bilibili_image_upload', `B 站图片上传请求失败（第 ${index + 1}/${total} 张）：${error instanceof Error ? error.message : String(error)}`)
    })
    const body = object(await response.json().catch(() => null))
    const message = typeof body.message === 'string' ? body.message : ''
    if (response.status() !== 200 || Number(body.code) !== 0) {
      throw new ApiError(502, 'bilibili_image_upload', `B 站图片上传失败（第 ${index + 1}/${total} 张，HTTP ${response.status()}，code ${String(body.code ?? 'unknown')}${message ? `：${message}` : ''}）`)
    }
    const data = object(body.data)
    const raw = typeof data.image_url === 'string' ? data.image_url : ''
    if (!raw) throw new ApiError(502, 'bilibili_image_upload', `B 站图片上传成功但没有返回地址（第 ${index + 1}/${total} 张）`)
    const url = raw.startsWith('//') ? `https:${raw}` : raw.replace(/^http:\/\//, 'https://')
    return {
      url,
      width: typeof data.image_width === 'number' ? data.image_width : 0,
      height: typeof data.image_height === 'number' ? data.image_height : 0,
      size: typeof data.img_size === 'number' ? data.img_size : 0,
    }
  }

  /** Official editor clipboard fallback, with focus and a real DOM completion check. */
  private async pasteClipboardImages(
    page: Page,
    frame: Frame,
    editor: Locator,
    images: BilibiliArticleImage[],
    progress: (message: string) => void,
    imageNotes: string[],
  ): Promise<number> {
    let inserted = 0
    for (const [index, image] of images.entries()) {
      await page.bringToFront()
      await editor.click()
      await page.waitForTimeout(120)
      const before = await editor.locator(IMAGE_NODE_SELECTOR).count()
      try {
        await frame.evaluate(writeClipboardImage, { b64: image.buffer.toString('base64'), mime: image.mime })
      } catch (error) {
        throw new ApiError(502, 'bilibili_image_upload', `第 ${index + 1}/${images.length} 张图片写入剪贴板失败：${error instanceof Error ? error.message : String(error)}`)
      }
      await page.keyboard.press(PASTE)
      const count = await waitForImageCount(editor, before + 1, 15_000)
      if (count <= before) {
        throw new ApiError(502, 'bilibili_article_editor', `第 ${index + 1}/${images.length} 张图片粘贴后未出现在编辑器；${await editorDiagnostics(editor, page)}；${imageNotes.join('；')}`)
      }
      inserted += 1
      progress(`正在写入 B 站正文图片 ${inserted}/${images.length}`)
    }
    return inserted
  }

  async publishArticle(state: PublisherStorageState, article: BilibiliArticleInput, mode: 'draft' | 'publish', progress: (message: string) => void): Promise<{ state: PublisherStorageState; result: BilibiliArticleResult }> {
    const context = await this.sessionContext(state, {
      viewport: { width: 1440, height: 920 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const page = await context.newPage()
    const responses: Array<{ url: string; body: Json | null }> = []
    page.on('response', (response) => {
      const url = response.url()
      if (!/create\/opus|article\/draft|article\/publish|\/publish|\/submit/i.test(url)) return
      response.json().then((body) => responses.push({ url, body: object(body) })).catch(() => {})
    })

    try {
      const images = article.images.slice(0, 20)
      const imageNotes: string[] = []
      let imageCount = 0
      let uploadFailure = ''
      let bodyHtml = article.html
      if (images.length) {
        const uploaded: string[] = []
        try {
          const keys = await wbiKeys(context)
          for (const [index, image] of images.entries()) {
            progress(`正在上传 B 站正文图片 ${index + 1}/${images.length}`)
            const result = await this.uploadImage(context, state, image, keys, index, images.length)
            const ready = await waitForImageUrl(context, result.url)
            if (!ready) throw new ApiError(502, 'bilibili_image_upload', `B 站图片 CDN 暂未就绪（第 ${index + 1}/${images.length} 张），已改用剪贴板兜底`)
            uploaded.push(result.url)
            imageNotes.push(`第 ${index + 1} 张 HTTP 200 code 0（${result.width}×${result.height}，CDN 已就绪）`)
          }
        } catch (error) {
          uploadFailure = error instanceof Error ? error.message : String(error)
          imageNotes.push(uploadFailure)
        }
        if (uploaded.length === images.length) {
          const replaced = replaceBilibiliImageMarkers(article.html, uploaded.map((url, index) => ({ url, name: images[index]?.name })))
          bodyHtml = replaced.html
          if (replaced.replaced !== images.length) {
            throw new ApiError(502, 'bilibili_article_editor', `正文图片占位符不完整：期望 ${images.length} 个，实际替换 ${replaced.replaced} 个`)
          }
        } else {
          bodyHtml = stripBilibiliImageMarkers(article.html)
        }
      }

      progress('正在打开 B 站图文编辑器')
      await page.goto(TEXT_UPLOAD, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3500)
      await enterEditor(page)
      const frame = await findEditorFrame(page)
      await frame.waitForSelector('.tiptap.ProseMirror[contenteditable="true"]', { timeout: 20_000 })
      const titleInput = frame.locator('textarea.title-input__inner').first()
      if (!(await titleInput.count())) throw new ApiError(502, 'bilibili_article_editor', '未找到 B 站图文标题输入框，已停止发布')
      await titleInput.fill(article.title)
      const editor = frame.locator('.tiptap.ProseMirror[contenteditable="true"]').first()
      progress('正在写入 B 站图文正文')
      await editor.click()
      const pasted = await frame.evaluate(pasteHtml, { html: bodyHtml, plain: article.plain, replace: true })
      if (!pasted?.ok) throw new ApiError(502, 'bilibili_article_editor', '未找到 B 站正文编辑区，无法写入正文')
      await page.waitForTimeout(2500)
      if (!(await editor.innerText()).includes(article.plain.slice(0, 18))) {
        await editor.click()
        await page.keyboard.press(SELECT_ALL)
        await page.keyboard.insertText(article.plain)
        await page.waitForTimeout(1200)
      }

      if (images.length) {
        if (!uploadFailure) {
          imageCount = await waitForImageCount(editor, images.length, 20_000)
          if (imageCount < images.length) {
            throw new ApiError(502, 'bilibili_article_editor', `正文图片写入不完整：期望 ${images.length} 张，实际 ${imageCount} 张；${await editorDiagnostics(editor, page)}；${imageNotes.join('；')}`)
          }
        } else {
          // Official editor paste fallback: focus is mandatory before clipboard.write.
          try {
            imageCount = await this.pasteClipboardImages(page, frame, editor, images, progress, imageNotes)
          } catch (error) {
            throw new ApiError(502, 'bilibili_article_editor', `${uploadFailure ? `${uploadFailure}；` : ''}剪贴板兜底也失败：${error instanceof Error ? error.message : String(error)}；${await editorDiagnostics(editor, page)}`)
          }
        }
      }

      const textLength = Array.from(await editor.innerText()).length
      progress('正在保存 B 站图文草稿')
      let draftClicked = false
      for (const candidate of [frame, page.mainFrame()]) {
        const button = candidate.getByRole('button', { name: /保存为草稿|保存草稿/ })
        if (await button.count()) {
          await button.first().click()
          draftClicked = true
          break
        }
      }
      if (!draftClicked) throw new ApiError(502, 'bilibili_article_editor', '未找到「保存为草稿」按钮，已停止 B 站图文发布')
      await page.waitForTimeout(5000)

      let draftId: string | null = null
      try {
        const listResponse = await context.request.get(`${DRAFT_LIST}?pn=1&ps=5`, { timeout: 15_000 })
        const listBody = object(await listResponse.json())
        const artlist = object(listBody.artlist ?? object(listBody.data).artlist)
        const drafts = artlist.drafts
        if (Array.isArray(drafts)) {
          const matched = drafts.find((draft) => object(draft).title === article.title) ?? drafts[0]
          const first = object(matched)
          if (typeof first.id === 'number') draftId = String(first.id)
        }
      } catch {
        // Draft id is best effort; the publication is still useful.
      }

      let status: BilibiliArticleResult['status'] = 'draft'
      let url: string | null = null
      let remoteId = draftId
      let message = `已保存为 B 站图文草稿（正文 ${textLength} 字，配图 ${imageCount} 张）`

      if (mode === 'publish') {
        progress('正在提交 B 站图文公开发布')
        let publishClicked = false
        for (const candidate of [frame, page.mainFrame()]) {
          const button = candidate.getByRole('button', { name: '发布', exact: true })
          if (await button.count()) {
            await button.first().click()
            publishClicked = true
            break
          }
        }
        if (!publishClicked) {
          status = 'uncertain'
          message = '草稿已保存，但没有找到「发布」按钮；请到 B 站创作中心手动发布'
        } else {
          await page.waitForTimeout(4500)
          for (const keyword of ['确认发布', '立即发布', '确定发布']) {
            let confirmed = false
            for (const candidate of page.frames()) {
              const button = candidate.getByRole('button', { name: new RegExp(`^${keyword}$`) })
              if (await button.count().catch(() => 0)) {
                await button.first().click().catch(() => {})
                confirmed = true
                break
              }
            }
            if (confirmed) {
              await page.waitForTimeout(5000)
              break
            }
          }
          await page.waitForTimeout(3000)
          const signal = responses
            .map((record) => object(record.body))
            .find((body) => body.code === 0 && object(body.data).dyn_id_str)
          const dynId = signal ? String(object(object(signal).data).dyn_id_str) : ''
          if (dynId) {
            status = 'published'
            remoteId = dynId
            url = `https://www.bilibili.com/opus/${dynId}`
            message = `已发布为 B 站图文（opus ${dynId}）`
          } else {
            status = 'uncertain'
            message = '已点击发布，但没有捕获到明确成功信号；请到 B 站创作中心确认，不要重复发布'
          }
        }
      }

      return {
        state: await context.storageState(),
        result: { status, remoteId, url, message },
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new Error(`B 站图文发布失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await this.releaseContext(context)
    }
  }

  async close(): Promise<void> {
    await this.contexts.close()
    await this.browser?.close().catch(() => {})
    this.browser = null
  }
}
