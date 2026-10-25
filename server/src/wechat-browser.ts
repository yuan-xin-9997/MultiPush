import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { load, type CheerioAPI } from 'cheerio'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core'
import { ApiError } from './errors'

export type WechatStorageState = Awaited<ReturnType<BrowserContext['storageState']>>
export interface WechatLoginAttempt {
  poll(): Promise<{
    status: 'waiting' | 'scanned' | 'connected' | 'expired' | 'failed'
    qrCode: string | null
    message: string
    state?: WechatStorageState
    name?: string
  }>
  close(): Promise<void>
}
export interface WechatArticle {
  title: string
  html: string
  author: string
  digest: string
  sourceUrl?: string
  cover: WechatImage
  images: Map<string, WechatImage>
}
export interface WechatImage { name: string; mimeType: string; buffer: Buffer }
export interface WechatProgress {
  status?: 'running' | 'draft' | 'awaiting_confirmation' | 'published' | 'failed' | 'uncertain'
  message: string
  qrCode?: string | null
  url?: string | null
  remoteId?: string | null
}
export interface WechatBrowserDriver {
  beginLogin(): Promise<WechatLoginAttempt>
  checkSession(state: WechatStorageState): Promise<{ state: WechatStorageState; name: string }>
  publish(state: WechatStorageState, article: WechatArticle, mode: 'draft' | 'publish', onProgress: (update: WechatProgress) => void): Promise<{
    state: WechatStorageState
    status: 'draft' | 'published' | 'uncertain'
    message: string
    url: string | null
    remoteId: string
  }>
  close(): Promise<void>
}

const HOME = 'https://mp.weixin.qq.com/'
const LOGIN_QR = 'img.js_login_qrcode:visible, .js_login_qrcode img:visible, img[src*="scanloginqrcode"]:visible, img[src*="loginqrcode"]:visible, .login__type__container img[src*="qrcode"]:visible'
const CONFIRM_QR = '.safe_check img.qrcode:visible, .qrcode_scan img:visible, img.js_qrcode:visible, img[src*="safeqrcode"]:visible'
const DIALOG = '[role="dialog"]:visible, .weui-desktop-dialog:visible, .mass-send:visible'
const FIVE_MINUTES = 5 * 60_000
type JsonObject = Record<string, unknown>

export function prepareWechatLinks($: CheerioAPI, editorHtml: string): number {
  const enabled = (flag: string) => new RegExp(`(?:^|\\n)\\s*wx\\.cgiData\\.${flag}\\s*=\\s*["']?1(?:["']|\\s*;)`).test(editorHtml)
  if (enabled('can_use_hyperlink') && enabled('can_use_appmsg_outer_url')) return 0
  let converted = 0
  $('a[href]').each((_, node) => {
    const link = $(node)
    let url: URL
    try { url = new URL(link.attr('href')!) } catch { return }
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname === 'mp.weixin.qq.com') return
    // Accounts without external-link permission lose href on save; retain the address as text.
    const replacement = $('<span>').attr('style', 'word-break:break-all;').append(link.contents())
    if (replacement.text().trim() !== url.href && replacement.text().trim() !== link.attr('href')) {
      replacement.append($('<span>').text(`（${url.href}）`))
    }
    link.replaceWith(replacement)
    converted++
  })
  return converted
}

function object(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) } catch { return {} }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function expired(): ApiError {
  return new ApiError(409, 'wechat_session_expired', '微信公众号登录已过期，请重新扫码登录')
}

/** Do not include upstream bodies: they can contain account tokens and cookies. */
export function assertWechatResponse(value: unknown, action: string, rejectionCode = 'wechat_upstream_error'): JsonObject {
  const data = object(value)
  const rawCode = object(data.base_resp).ret ?? data.ret ?? data.errcode
  const code = typeof rawCode === 'number' || typeof rawCode === 'string' && /^-?\d+$/.test(rawCode) ? Number(rawCode) : NaN
  if ([-6, -8, 200003].includes(code)) throw expired()
  if (code !== 0) throw new ApiError(502, Number.isFinite(code) ? rejectionCode : 'wechat_upstream_error', `${action}失败${Number.isFinite(code) ? `（微信错误码 ${code}）` : '，微信返回了无法识别的响应'}`)
  return data
}

export function isWechatLoginScanned(text: string): boolean {
  return /扫码成功|已扫码|扫描成功|请在手机(?:微信)?(?:上)?(?:确认|点击确认)|请在微信中确认/.test(text)
}

export function classifyWechatFailure(error: unknown, phase: { draftRequested: boolean; remoteId: string; submitted: boolean }): ApiError | { message: string } {
  if (phase.submitted) return { message: '发表已提交，但未能核实最终结果，请先查看微信后台，避免重复发表' }
  if (phase.remoteId) {
    const message = `${error instanceof ApiError ? error.message : '微信发表步骤未完成'}；文章已保留在草稿箱，请在微信后台处理`
    return new ApiError(error instanceof ApiError ? error.status : 502, error instanceof ApiError ? error.code : 'wechat_publish_not_submitted', message)
  }
  if (error instanceof ApiError && ['wechat_session_expired', 'wechat_rejected'].includes(error.code)) return error
  if (phase.draftRequested) return { message: '草稿保存请求已发出，但未能确认结果；请先查看微信草稿箱，避免重复创建' }
  return new ApiError(error instanceof ApiError ? error.status : 502, 'wechat_preparation_failed', error instanceof ApiError ? error.message : '公众号准备步骤未完成，尚未提交文章，请检查网络后重试')
}

function publicArticleUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value.replace(/\\\//g, '/'))
    return url.protocol === 'https:' && url.hostname === 'mp.weixin.qq.com' && (url.pathname === '/s' || url.pathname.startsWith('/s/'))
      ? url.href : null
  } catch { return null }
}

/** Titles are not identities: a previous article with the same title must never count. */
export function findPublishedArticle(value: unknown, remoteId: string): { url: string } | null {
  const data = assertWechatResponse(value, '读取发表记录')
  const page = object(data.publish_page ?? data)
  if (!Array.isArray(page.publish_list)) return null
  for (const raw of page.publish_list) {
    const record = object(raw)
    const info = object(record.publish_info ?? record)
    const publication = object(info.publish_info)
    if (publication.publish_status !== undefined && Number(publication.publish_status) !== 200) continue
    const articles = info.appmsg_info ?? info.appmsgex
    if (!Array.isArray(articles)) continue
    for (const rawArticle of articles) {
      const article = object(rawArticle)
      const ids = [article.appmsgid, article.appmsg_id, article.app_id, info.appmsgid, record.appmsgid, record.app_id, info.copy_appmsg_id, publication.draft_msgid]
      const deleted = article.is_deleted === true || article.is_deleted === 1 || article.is_deleted === '1'
      const url = publicArticleUrl(article.content_url ?? article.link)
      if (!deleted && ids.some(id => id !== undefined && String(id) === remoteId) && url) return { url }
    }
  }
  return null
}

export function parseWechatPage(html: string, pageUrl: string): { token: string; name: string; ticket: string; userName: string } | null {
  if (new URL(pageUrl, HOME).origin !== new URL(HOME).origin) return null
  const token = new URL(pageUrl, HOME).searchParams.get('token')
    ?? html.match(/[?&]token=(\d+)/)?.[1]
    ?? html.match(/\bt\s*:\s*["'](\d+)["']/)?.[1]
  const pick = (key: string) => html.match(new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']([^"']+)["']`))?.[1] ?? ''
  const userName = pick('user_name')
  if (!token || !/^\d+$/.test(token) || !userName) return null
  let name = pick('nick_name') || '微信公众号'
  try { name = decodeURIComponent(name) } catch { /* Some accounts return an unencoded nickname. */ }
  name = load(`<span>${name}</span>`).text()
  return { token, name, userName, ticket: pick('ticket') }
}

export function parseWechatUpload(value: unknown): { id: string; url: string } {
  const data = assertWechatResponse(value, '上传公众号图片')
  const content = object(data.content)
  const id = content.media_id ?? data.media_id ?? (typeof data.content === 'string' && !data.content.trim().startsWith('{') ? data.content : undefined)
  const cdnUrl = data.cdn_url ?? content.cdn_url
  try {
    const url = new URL(String(cdnUrl))
    if (id && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port && /\.(?:qpic|qlogo)\.cn$/.test(url.hostname)) {
      url.protocol = 'https:'
      return { id: String(id), url: url.href }
    }
  } catch { /* An invalid URL is an incomplete upload, never a usable image. */ }
  throw new ApiError(502, 'wechat_image_upload_failed', '微信图片上传未返回有效素材，请重试')
}

export function applyWechatImage($: ReturnType<typeof load>, src: string, uploaded: { id: string; url: string }, mimeType: string): void {
  // The mobile draft editor needs material identity and format, not just a CDN URL.
  $('img').each((_, node) => {
    const image = $(node)
    if (image.attr('src') !== src) return
    image.attr({
      src: uploaded.url, 'data-src': uploaded.url, 'data-imgfileid': uploaded.id,
      'data-type': mimeType.slice('image/'.length), type: 'block',
    }).addClass('rich_pages wxw-img js_insertlocalimg').removeAttr('srcset')
    if (mimeType === 'image/gif') image.removeAttr('data-s')
    else image.attr('data-s', '300,640')
  })
}

export function wechatSwitchState(value: { checked?: boolean; ariaChecked?: string | null; className?: string | null }): boolean | null {
  if (typeof value.checked === 'boolean') return value.checked
  if (value.ariaChecked === 'true') return true
  if (value.ariaChecked === 'false') return false
  if (/(?:^|\s)(?:weui-desktop-)?switch[_-]on(?:\s|$)/.test(value.className ?? '')) return true
  if (/(?:^|\s)(?:weui-desktop-)?switch[_-]off(?:\s|$)/.test(value.className ?? '')) return false
  return null
}

async function qrImage(page: Page, selector: string): Promise<{ image: string; key: string } | null> {
  const qr = page.locator(selector).first()
  if (!await qr.count()) return null
  if (!await qr.evaluate((el: any) => el.complete && el.naturalWidth > 10).catch(() => false)) return null
  const bytes = await qr.screenshot({ type: 'png', timeout: 2500 }).catch(() => null)
  return bytes ? { image: `data:image/png;base64,${bytes.toString('base64')}`, key: await qr.getAttribute('src') ?? '' } : null
}

async function sessionInfo(page: Page) {
  await page.goto(HOME, { waitUntil: 'commit', timeout: 30_000 })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const info = parseWechatPage(await page.content(), page.url())
    if (info) return info
    if (await page.locator(LOGIN_QR).count() || /loginpage|scanlogin/.test(page.url())) throw expired()
    await page.waitForTimeout(250)
  }
  throw expired()
}

export function publisherExecutablePath(platform: 'wechat' | 'zhihu' | 'xiaohongshu' | 'douyin' = 'wechat'): string | undefined {
  const configured = (platform === 'douyin' ? process.env.DOUYIN_BROWSER_PATH : platform === 'xiaohongshu' ? process.env.XHS_BROWSER_PATH : platform === 'zhihu' ? process.env.ZHIHU_BROWSER_PATH : '') || process.env.WECHAT_BROWSER_PATH || process.env.CHROME_BIN
  if (configured) {
    if (!existsSync(configured)) throw new ApiError(503, `${platform}_browser_unavailable`, '配置的浏览器不存在，请设置有效的 Chrome 或 Chromium 可执行文件路径')
    return configured
  }
  const candidates = [
    chromium.executablePath(),
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap(key => process.env[key] ? [
      join(process.env[key]!, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env[key]!, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : []),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  return candidates.find(path => existsSync(path))
}

async function turnSwitchOff(dialog: Locator, label: string, required: boolean): Promise<void> {
  const caption = dialog.getByText(label, { exact: true }).first()
  const row = caption.locator('xpath=ancestor-or-self::*[.//input[@type="checkbox"] or .//*[@role="switch"] or .//*[contains(@class,"switch")]][1]')
  if (await caption.count() && await row.count()) {
    const input = row.locator('input[type="checkbox"]').first()
    const control = await input.count() ? input : row.locator('[role="switch"], .weui-desktop-switch, [class*="switch_on"], [class*="switch_off"], [class*="switch__box"]').first()
    if (!await control.count()) throw new ApiError(409, 'wechat_notification_unverified', `未找到可识别的${label}开关，文章已保留在草稿箱`)
    const read = async (): Promise<boolean | null> => {
      if (await input.count()) return input.isChecked()
      return wechatSwitchState({ ariaChecked: await control.getAttribute('aria-checked'), className: await control.getAttribute('class') })
    }
    const current = await read()
    if (current === null) throw new ApiError(409, 'wechat_notification_unverified', `无法确认${label}开关的状态，文章已保留在草稿箱`)
    if (current) {
      if (!await control.isEnabled()) throw new ApiError(409, 'wechat_notification_unverified', `微信后台的${label}无法关闭，草稿已保留，请在微信后台处理`)
      if (await control.isVisible()) {
        if (await input.count()) await input.uncheck()
        else await control.click()
      } else {
        const wrapper = input.locator('xpath=ancestor::*[contains(@class,"weui-desktop-switch")][1]')
        if (!await wrapper.count()) throw new ApiError(409, 'wechat_notification_unverified', `无法操作${label}开关，草稿已保留`)
        await wrapper.click()
      }
    }
    if (await read() === false) return
    throw new ApiError(409, 'wechat_notification_unverified', `无法确认${label}已关闭，文章已保留在草稿箱`)
  }
  if (await caption.count()) throw new ApiError(409, 'wechat_notification_unverified', `无法确认${label}的状态，文章已保留在草稿箱`)
  const text = (await dialog.innerText()).replace(/\s+/g, '')
  if (required && !text.includes(`未开启${label}`) && !text.includes(`不发送${label}`)) {
    throw new ApiError(409, 'wechat_notification_unverified', '无法确认群发通知已关闭，已停止发表；文章已保存到草稿箱')
  }
}

export class PlaywrightWechatDriver implements WechatBrowserDriver {
  private browser: Promise<Browser> | null = null
  constructor(_config?: { dataDir: string }) {}

  private async context(state?: WechatStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const path = publisherExecutablePath()
      if (!path) throw new ApiError(503, 'wechat_browser_unavailable', '服务器未安装 Chrome / Chromium。请安装浏览器并设置 WECHAT_BROWSER_PATH，或执行 npx playwright-core install chromium')
      this.browser = chromium.launch({
        executablePath: path,
        headless: true,
        chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1',
        args: ['--disable-dev-shm-usage'],
      }).then(browser => {
        browser.on('disconnected', () => { this.browser = null })
        return browser
      }).catch(() => {
        this.browser = null
        throw new ApiError(503, 'wechat_browser_unavailable', '无法启动微信公众号浏览器，请检查 WECHAT_BROWSER_PATH 和服务器 Chromium 运行依赖')
      })
    }
    const context = await (await this.browser).newContext({ storageState: state, locale: 'zh-CN', viewport: { width: 1440, height: 1100 } })
    context.setDefaultTimeout(10_000)
    return context
  }

  async beginLogin(): Promise<WechatLoginAttempt> {
    const context = await this.context()
    const page = await context.newPage()
    const deadline = Date.now() + FIVE_MINUTES
    let qrCode: string | null = null
    let closed = false
    const close = async () => { if (!closed) { closed = true; await context.close().catch(() => {}) } }
    try {
      await page.goto(HOME, { waitUntil: 'commit', timeout: 30_000 })
      await page.locator(LOGIN_QR).first().waitFor({ state: 'visible', timeout: 20_000 })
      await page.waitForFunction('(() => { const img = document.querySelector("img.js_login_qrcode, .js_login_qrcode img, img[src*=scanloginqrcode], img[src*=loginqrcode], .login__type__container img[src*=qrcode]"); return img && img.complete && img.naturalWidth > 10 })()', undefined, { timeout: 15_000 })
      qrCode = (await qrImage(page, LOGIN_QR))?.image ?? null
      if (!qrCode) throw new ApiError(502, 'wechat_qrcode_unavailable', '微信登录二维码未能加载，请稍后重新获取')
    } catch (error) {
      await close()
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'wechat_login_unavailable', '无法加载微信公众平台登录页，请检查服务器网络后重试')
    }
    return {
      close,
      poll: async () => {
        if (closed || page.isClosed() || Date.now() > deadline) return { status: 'expired', qrCode: null, message: '登录二维码已过期，请重新获取' }
        const info = parseWechatPage(await page.content(), page.url())
        if (info) return { status: 'connected', qrCode: null, message: '微信公众号已登录', state: await context.storageState(), name: info.name }
        const text = await page.locator('body').innerText()
        if (/二维码已失效|二维码已过期|二维码过期/.test(text)) return { status: 'expired', qrCode: null, message: '登录二维码已过期，请重新获取' }
        const currentQr = await qrImage(page, LOGIN_QR)
        if (currentQr) qrCode = currentQr.image
        const scanned = isWechatLoginScanned(text)
        return { status: scanned ? 'scanned' : 'waiting', qrCode, message: scanned ? '请在微信中选择公众号并确认登录' : '请使用公众号管理员微信扫码登录' }
      },
    }
  }

  async checkSession(state: WechatStorageState) {
    const context = await this.context(state)
    try {
      const info = await sessionInfo(await context.newPage())
      return { state: await context.storageState(), name: info.name }
    } finally { await context.close() }
  }

  async publish(state: WechatStorageState, article: WechatArticle, mode: 'draft' | 'publish', onProgress: (update: WechatProgress) => void) {
    let context: BrowserContext | undefined
    let remoteId = ''
    let draftRequested = false
    let submitted = false
    const snapshot = async () => context ? context.storageState().catch(() => state) : state
    try {
      context = await this.context(state)
      const page = await context.newPage()
      const info = await sessionInfo(page)
      const editor = new URL('/cgi-bin/appmsg', HOME)
      editor.search = new URLSearchParams({ t: 'media/appmsg_edit_v2', action: 'edit', isNew: '1', type: '77', createType: '0', token: info.token, lang: 'zh_CN' }).toString()
      const editorResponse = await context.request.get(editor.href)
      const editorHtml = await editorResponse.text()
      const metadata = parseWechatPage(editorHtml, editor.href)
      if (!metadata?.ticket) throw new ApiError(502, 'wechat_editor_unavailable', '无法取得微信编辑器上传凭据，请重新登录后重试')
      const upload = async (image: WechatImage) => {
        const url = new URL('/cgi-bin/filetransfer', HOME)
        url.search = new URLSearchParams({ action: 'upload_material', f: 'json', scene: '8', writetype: 'doublewrite', groupid: '1', ticket_id: metadata.userName, ticket: metadata.ticket, svr_time: String(Date.now()), token: info.token, lang: 'zh_CN' }).toString()
        const response = await page.request.post(url.href, { multipart: { file: image }, headers: { Referer: editor.href }, timeout: 30_000 })
        return parseWechatUpload(await response.json().catch(() => null))
      }
      onProgress({ status: 'running', message: '正在上传公众号封面和正文图片' })
      const cover = await upload(article.cover)
      const html = load(article.html, null, false)
      const convertedLinks = prepareWechatLinks(html, editorHtml)
      const linkNotice = convertedLinks ? `；${convertedLinks} 个正文外链已保留为可复制地址（当前公众号未开通外链权限）` : ''
      for (const [src, image] of article.images) {
        const uploaded = await upload(image)
        applyWechatImage(html, src, uploaded, image.mimeType)
      }
      const create = new URL('/cgi-bin/operate_appmsg', HOME)
      create.search = new URLSearchParams({ t: 'ajax-response', sub: 'create', type: '77', token: info.token, lang: 'zh_CN' }).toString()
      draftRequested = true
      const response = await context.request.post(create.href, {
        headers: { Referer: editor.href, 'X-Requested-With': 'XMLHttpRequest' },
        form: {
          token: info.token, lang: 'zh_CN', f: 'json', ajax: '1', random: String(Math.random()), AppMsgId: '', count: '1', data_seq: '0', operate_from: 'Chrome', isnew: '1', articlenum: '1',
          title0: article.title, author0: article.author, digest0: article.digest, content0: html.html(), sourceurl0: article.sourceUrl || '', show_cover_pic0: '0', thumb_media_id0: cover.id,
          cdn_url0: cover.url, cdn_235_1_url0: cover.url, cdn_1_1_url0: cover.url, cdn_16_9_url0: cover.url,
          shortvideofileid0: '', copyright_type0: '0', fileid0: '', need_open_comment0: '0', only_fans_can_comment0: '0', can_reward0: '0',
        },
        timeout: 30_000,
      })
      const saved = assertWechatResponse(await response.json().catch(() => null), '保存公众号草稿', 'wechat_rejected')
      remoteId = String(saved.appMsgId ?? saved.appmsgid ?? saved.app_id ?? '')
      if (!remoteId || !/^\d+$/.test(remoteId)) throw new ApiError(502, 'wechat_draft_unverified', '微信未返回草稿编号，暂时无法确认保存结果，请查看微信草稿箱')
      onProgress({ status: 'running', message: '文章已保存到公众号草稿箱', remoteId })
      if (mode === 'draft') return { state: await snapshot(), status: 'draft' as const, message: `已保存到公众号草稿箱${linkNotice}`, url: null, remoteId }

      const publishUrl = new URL('/cgi-bin/appmsg', HOME)
      publishUrl.search = new URLSearchParams({ t: 'media/appmsg_edit', action: 'edit', type: '77', appmsgid: remoteId, isMul: '1', replaceScene: '0', isSend: '1', isFreePublish: '0', token: info.token, lang: 'zh_CN' }).toString()
      await page.goto(publishUrl.href, { waitUntil: 'commit', timeout: 30_000 })
      if (/loginpage|scanlogin/.test(page.url())) throw expired()
      await page.locator('button.mass_send:visible').first().click({ timeout: 25_000 })
      const dialog = page.locator(DIALOG).filter({ hasText: '群发通知' }).last()
      await dialog.waitFor({ state: 'visible', timeout: 15_000 })
      await turnSwitchOff(dialog, '群发通知', true)
      await turnSwitchOff(dialog, '定时发表', false)
      const finalButton = dialog.getByRole('button', { name: '发表', exact: true }).last()
      // A click timeout may happen after the request was sent; never replay this action.
      submitted = true
      await finalButton.click()
      onProgress({ status: 'running', message: '已提交发表，正在等待微信确认', qrCode: null })
      const deadline = Date.now() + FIVE_MINUTES
      let continued = false
      let lastQr: string | null = null
      let lastCheck = 0
      while (Date.now() < deadline) {
        const continuation = page.locator(DIALOG).getByRole('button', { name: '继续发表', exact: true }).last()
        if (!continued && await continuation.isVisible().catch(() => false)) {
          continued = true
          await continuation.click()
        }
        const qr = await qrImage(page, CONFIRM_QR)
        if (qr && qr.key !== lastQr) {
          lastQr = qr.key
          onProgress({ status: 'awaiting_confirmation', message: '微信要求管理员扫码确认发表，请扫描此二维码', qrCode: qr.image })
        }
        if (Date.now() - lastCheck > 5000) {
          lastCheck = Date.now()
          const records = new URL('/cgi-bin/appmsgpublish', HOME)
          records.search = new URLSearchParams({ sub: 'list', free_publish_type: '1', begin: '0', count: '20', token: info.token, lang: 'zh_CN', f: 'json', ajax: '1' }).toString()
          const result = await context.request.get(records.href, { timeout: 15_000 })
          const match = findPublishedArticle(await result.json().catch(() => null), remoteId)
          if (match) {
            onProgress({ status: 'published', message: '文章已发表，已核对微信发表记录', qrCode: null, url: match.url, remoteId })
            return { state: await snapshot(), status: 'published' as const, message: `文章已发表${linkNotice}`, url: match.url, remoteId }
          }
        }
        await page.waitForTimeout(1500)
      }
      return { state: await snapshot(), status: 'uncertain' as const, message: '尚未在微信发表记录中确认结果，请查看微信后台后再决定是否重试，避免重复发表', url: null, remoteId }
    } catch (error) {
      const failure = classifyWechatFailure(error, { draftRequested, remoteId, submitted })
      if (failure instanceof ApiError) throw failure
      return { state: await snapshot(), status: 'uncertain' as const, message: failure.message, url: null, remoteId }
    } finally { await context?.close().catch(() => {}) }
  }

  async close(): Promise<void> {
    const pending = this.browser
    this.browser = null
    if (pending) await (await pending).close().catch(() => {})
  }
}
