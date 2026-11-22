import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright-core'
import type { PublisherStorageState } from './publisher-session'
import { publisherExecutablePath } from './wechat-browser'
import { qrReady } from './qr-capture'
import { ApiError } from './errors'

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

const CLIPBOARD_HTML_JS = `async ({html, plain}) => {
  const item = new ClipboardItem({
    'text/html': new Blob([html], {type: 'text/html'}),
    'text/plain': new Blob([plain], {type: 'text/plain'})
  });
  await navigator.clipboard.write([item]);
  return true;
}`

const CLIPBOARD_IMAGE_JS = `async ({b64, mime}) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await navigator.clipboard.write([new ClipboardItem({[mime]: new Blob([bytes], {type: mime})})]);
  return true;
}`

export class PlaywrightBilibiliDriver implements BilibiliDriver {
  private browser: Browser | null = null

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
    const browser = await this.launch()
    const context = await browser.newContext({ storageState: state })
    try {
      const nav = await readNav(context)
      if (!nav.login) throw expired()
      return {
        state: await context.storageState(),
        identity: { accountId: nav.mid || 'bilibili', name: nav.name || 'B 站账号' },
      }
    } finally {
      await context.close().catch(() => {})
    }
  }

  async publishArticle(state: PublisherStorageState, article: BilibiliArticleInput, mode: 'draft' | 'publish', progress: (message: string) => void): Promise<{ state: PublisherStorageState; result: BilibiliArticleResult }> {
    const browser = await this.launch()
    const context = await browser.newContext({
      storageState: state,
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
      progress('正在打开 B 站图文编辑器')
      await page.goto(TEXT_UPLOAD, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3500)
      await enterEditor(page)
      const frame = await findEditorFrame(page)
      await frame.waitForSelector('.tiptap.ProseMirror[contenteditable="true"]', { timeout: 20_000 })
      const titleInput = frame.locator('textarea.title-input__inner').first()
      if (!(await titleInput.count())) throw new ApiError(502, 'bilibili_article_editor', '未找到 B 站图文标题输入框，已停止发布')
      await titleInput.fill(article.title)
      progress('正在写入 B 站图文正文')
      const editor = frame.locator('.tiptap.ProseMirror[contenteditable="true"]').first()
      await editor.click()
      await page.keyboard.press(SELECT_ALL)
      await frame.evaluate(CLIPBOARD_HTML_JS, { html: article.html, plain: article.plain })
      await editor.click()
      await page.keyboard.press(PASTE)
      await page.waitForTimeout(2500)
      if (!(await editor.innerText()).includes(article.plain.slice(0, 18))) {
        await editor.click()
        await page.keyboard.press(SELECT_ALL)
        await page.keyboard.insertText(article.plain)
        await page.waitForTimeout(1200)
      }

      let pastedImages = 0
      for (const image of article.images.slice(0, 20)) {
        try {
          await frame.evaluate(CLIPBOARD_IMAGE_JS, { b64: image.buffer.toString('base64'), mime: image.mime })
          await editor.click()
          await page.keyboard.press(PASTE)
          await page.waitForTimeout(3500)
          pastedImages += 1
          progress(`正在上传 B 站正文图片 ${pastedImages}/${Math.min(article.images.length, 20)}`)
        } catch {
          // An image that cannot be pasted is reported by the verification step.
        }
      }
      if (article.images.length) await page.waitForTimeout(6000)

      const imageCount = await editor.locator('img').count()
      const textLength = Array.from(await editor.innerText()).length
      if (article.images.length > 0 && imageCount === 0) throw new ApiError(502, 'bilibili_article_editor', '正文图片未能写入 B 站编辑器，已停止发布')
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
        const drafts = object(object(listBody.data).artlist).drafts
        const first = object(Array.isArray(drafts) ? drafts[0] : null)
        if (typeof first.id === 'number') draftId = String(first.id)
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
      await context.close().catch(() => {})
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {})
    this.browser = null
  }
}
