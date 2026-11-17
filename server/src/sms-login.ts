import { createHash, randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core'
import type { SmsLogin, SmsLoginPlatform } from '../../shared/types'
import { ApiError, notFound } from './errors'
import type { PublisherStorageState } from './publisher-session'
import { publisherExecutablePath } from './wechat-browser'

export interface SmsSessionImporter {
  /**
   * Validate an externally-created browser session, derive its platform
   * identity and persist it. Implemented by each publisher service so the SMS
   * flow reuses its encryption key, database table and identity checks.
   */
  importPublisherSession(userId: string, state: PublisherStorageState): Promise<{ name: string }>
}

interface SmsPlatformConfig {
  name: string
  loginUrl: string
  /** URL patterns shown while the login form is still active. */
  loginPage: RegExp
  phoneSelector: string
  codeSelector: string
  send: (page: Page) => Locator
  submit: (page: Page) => Locator
  prepare?: (page: Page) => Promise<void>
  agree?: (page: Page) => Promise<void>
}

const PHONE_PATTERN = /^1[3-9]\d{9}$/
const CODE_PATTERN = /^\d{4,8}$/
const TTL_MS = 5 * 60_000
const VERIFY_TIMEOUT_MS = 45_000
const MAX_ATTEMPTS = 8
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

const SMS_SECURITY = /请完成(?:下方)?验证|拖动滑块|滑块验证|请进行安全验证|操作频繁|访问频繁|请求过于频繁|环境异常|账号存在安全风险/

function clickText(page: Page, value: string): Locator {
  return page.getByText(value, { exact: true }).first()
}

function log(message: string): void {
  console.log(`[multipush] ${message}`)
}

export const SMS_LOGIN_PLATFORMS: SmsLoginPlatform[] = [
  'zhihu',
  'weibo',
  'toutiao',
  'baijiahao',
  'douban',
  'juejin',
  'douyin',
]

export const SMS_PLATFORM_CONFIG: Record<SmsLoginPlatform, SmsPlatformConfig> = {
  zhihu: {
    name: '知乎',
    loginUrl: 'https://www.zhihu.com/signin',
    loginPage: /\/signin/i,
    phoneSelector: 'input[name="username"]',
    codeSelector: 'input[name="digits"]',
    send: (page) => page.getByRole('button', { name: '获取短信验证码' }).first(),
    submit: (page) => page.getByRole('button', { name: '登录/注册' }).first(),
    prepare: async (page) => {
      const tab = clickText(page, '验证码登录')
      if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => {})
    },
  },
  weibo: {
    name: '微博',
    loginUrl: 'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog',
    loginPage: /passport\.weibo\.com\/sso\/signin/i,
    phoneSelector: 'input[placeholder="手机号"]',
    codeSelector: 'input[placeholder="验证码"]',
    send: (page) => clickText(page, '获取验证码'),
    submit: (page) => clickText(page, '登录/注册'),
  },
  toutiao: {
    name: '今日头条',
    loginUrl: 'https://mp.toutiao.com/auth/page/login',
    loginPage: /\/auth\/page\/login/i,
    phoneSelector: 'input[placeholder="手机号"]',
    codeSelector: 'input[placeholder="验证码"]',
    send: (page) => page.locator('span.send-input').first(),
    submit: (page) => page.locator('button.web-login-button').first(),
    prepare: async (page) => {
      const tab = clickText(page, '验证码登录')
      if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => {})
    },
  },
  baijiahao: {
    name: '百家号',
    loginUrl: 'https://baijiahao.baidu.com/builder/theme/bjh/login',
    loginPage: /\/login(?:[?#]|$)/i,
    phoneSelector: '#TANGRAM__PSP_4__smsPhone',
    codeSelector: '#TANGRAM__PSP_4__smsVerifyCode',
    send: (page) => page.locator('#TANGRAM__PSP_4__smsTimer').first(),
    submit: (page) => page.locator('#TANGRAM__PSP_4__smsSubmit').first(),
    prepare: async (page) => {
      const start = clickText(page, '登录/注册百家号')
      if (await start.isVisible().catch(() => false)) {
        await start.click().catch(() => {})
        await page.waitForTimeout(800)
      }
      const tab = page.locator('#TANGRAM__PSP_4__form .login-item.sms-login').first()
      if (await tab.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) {
        await tab.click().catch(() => {})
        await page.waitForTimeout(600)
      }
    },
    agree: async (page) => {
      const checkbox = page.locator('#TANGRAM__PSP_4__smsIsAgree').first()
      if (await checkbox.isVisible().catch(() => false) && !(await checkbox.isChecked().catch(() => true))) {
        await checkbox.check({ force: true }).catch(() => {})
      }
    },
  },
  douban: {
    name: '豆瓣',
    loginUrl: 'https://accounts.douban.com/passport/login',
    loginPage: /accounts\.douban\.com\/passport\/login/i,
    phoneSelector: 'input[placeholder="手机号"]',
    codeSelector: 'input[placeholder="验证码"]',
    send: (page) => clickText(page, '获取验证码'),
    submit: (page) => clickText(page, '登录豆瓣'),
  },
  juejin: {
    name: '掘金',
    loginUrl: 'https://juejin.cn/login',
    loginPage: /juejin\.cn\/login/i,
    phoneSelector: 'input[name="mobile"]',
    codeSelector: 'input[name="registerSmsCode"]',
    send: (page) => page.locator('button.send-vcode-btn').first(),
    submit: (page) => clickText(page, '登录 / 注册'),
  },
  douyin: {
    name: '抖音',
    loginUrl: 'https://creator.douyin.com/',
    loginPage: /^https:\/\/creator\.douyin\.com\/?$/i,
    phoneSelector: 'input[placeholder="请输入手机号"]',
    codeSelector: 'input[placeholder="请输入验证码"]',
    send: (page) => page.locator('#douyin_login_comp_button_input_id span').first(),
    submit: (page) => page.locator('#douyin_login_comp_btn_id').first(),
    prepare: async (page) => {
      const tab = clickText(page, '验证码登录')
      if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => {})
    },
  },
}

function normalizePhone(value: string): string {
  return value.trim().replace(/[\s-]/g, '').replace(/^\+?86/, '')
}

export function maskSmsPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d{4}(\d{3,4})$/, '$1****$2')
}

async function assertNoSecurity(page: Page): Promise<void> {
  const body = await page.locator('body').innerText().catch(() => '')
  if (SMS_SECURITY.test(body)) {
    throw new ApiError(409, 'sms_security_check', '平台要求安全验证，请改用扫码登录')
  }
  for (const selector of [
    '.nc-container',
    '.geetest_panel',
    '.geetest_holder',
    '[class*="slider-verify"]',
    '[class*="captcha-container"]',
  ]) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false)
    if (visible) throw new ApiError(409, 'sms_security_check', '平台要求安全验证，请改用扫码登录')
  }
}

/** Open the official SMS form and fill the phone number without sending a code. */
export async function openSmsForm(page: Page, platform: SmsLoginPlatform, phone: string): Promise<void> {
  const config = SMS_PLATFORM_CONFIG[platform]
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(1500)
  await assertNoSecurity(page)
  await config.prepare?.(page)
  await page.waitForTimeout(600)
  await assertNoSecurity(page)
  const input = page.locator(config.phoneSelector).first()
  await input.waitFor({ state: 'visible', timeout: 20_000 })
  await input.fill(phone)
  await input.press('Tab').catch(() => {})
  await page.waitForTimeout(400)
  await config.agree?.(page)
  await assertNoSecurity(page)
}

async function sendCode(page: Page, platform: SmsLoginPlatform): Promise<void> {
  const config = SMS_PLATFORM_CONFIG[platform]
  const send = config.send(page)
  await send.waitFor({ state: 'visible', timeout: 10_000 })
  for (let index = 0; index < 10; index += 1) {
    const className = (await send.getAttribute('class').catch(() => '')) || ''
    if (!/disabled|not-allowed|is-disabled|text-disabled/i.test(className)) break
    await page.waitForTimeout(300)
  }
  const beforeClass = (await send.getAttribute('class').catch(() => '')) || ''
  const beforeDisabled = await send.isDisabled().catch(() => false)
  await send.click({ timeout: 10_000 })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await assertNoSecurity(page)
    const body = await page.locator('body').innerText().catch(() => '')
    if (/验证码错误|手机号格式|手机号未注册|发送失败|获取验证码失败|请稍后再试|请求过于频繁/.test(body)) {
      throw new ApiError(400, 'sms_send_failed', '平台未能发送短信验证码，请检查手机号或改用扫码登录')
    }
    const label = await send.innerText().catch(() => '')
    if (/重新发送|重新获取|秒|已发送|已获取/.test(label) || /验证码已发送|验证码已下发|请注意查收/.test(body)) {
      return
    }
    const afterClass = (await send.getAttribute('class').catch(() => '')) || ''
    const afterDisabled = await send.isDisabled().catch(() => false)
    if ((afterClass !== beforeClass && /disabled|count|cool|sending|waiting|again/i.test(afterClass)) || (!beforeDisabled && afterDisabled)) {
      return
    }
    await page.waitForTimeout(400)
  }
  throw new ApiError(502, 'sms_send_unconfirmed', '平台没有确认验证码已发送，请稍后重试或改用扫码登录')
}

interface SmsEntry {
  view: SmsLogin
  userId: string
  config: SmsPlatformConfig
  importer: SmsSessionImporter
  browser: Browser
  context: BrowserContext
  page: Page
  timer: ReturnType<typeof setTimeout>
  closed: boolean
  verifying: boolean
}

export class SmsLoginManager {
  private readonly entries = new Map<string, SmsEntry>()
  private readonly lastSent = new Map<string, number>()
  private readonly starting = new Set<string>()
  private closed = false

  constructor(private readonly importers: Partial<Record<SmsLoginPlatform, SmsSessionImporter>>) {}

  private importer(platform: SmsLoginPlatform): SmsSessionImporter {
    const importer = this.importers[platform]
    if (!importer) throw new ApiError(400, 'sms_platform_unsupported', '该平台暂不支持手机验证码登录')
    return importer
  }

  private view(entry: SmsEntry): SmsLogin {
    return { ...entry.view }
  }

  private closeEntry(entry: SmsEntry): void {
    if (entry.closed) return
    entry.closed = true
    clearTimeout(entry.timer)
    this.entries.delete(entry.view.id)
    void entry.context.close().catch(() => {})
    void entry.browser.close().catch(() => {})
  }

  private expire(entry: SmsEntry): void {
    if (entry.closed) return
    entry.view.status = 'expired'
    entry.view.message = '验证码已过期，请重新发送'
    this.closeEntry(entry)
  }

  async start(userId: string, platform: SmsLoginPlatform, rawPhone: string): Promise<SmsLogin> {
    if (this.closed) throw new ApiError(503, 'sms_unavailable', '短信登录服务正在停止，请稍后重试')
    const importer = this.importer(platform)
    const phone = normalizePhone(rawPhone)
    if (!PHONE_PATTERN.test(phone)) throw new ApiError(400, 'sms_phone_invalid', '请输入 11 位中国大陆手机号')
    const rateKey = `${userId}:${platform}:${createHash('sha256').update(phone).digest('hex').slice(0, 24)}`
    const lastSent = this.lastSent.get(rateKey) || 0
    if (Date.now() - lastSent < 20_000) throw new ApiError(429, 'sms_rate_limited', '请等待 20 秒后再发送验证码')
    if (this.entries.size >= MAX_ATTEMPTS) throw new ApiError(503, 'sms_busy', '当前短信登录请求较多，请稍后重试')
    if (this.starting.has(userId)) throw new ApiError(409, 'sms_busy', '正在准备验证码，请稍候')

    const executablePath = publisherExecutablePath(platform)
    if (!executablePath) throw new ApiError(503, 'sms_browser_unavailable', '服务器没有可用的 Chrome / Chromium')
    this.starting.add(userId)

    for (const entry of this.entries.values()) {
      if (entry.userId === userId) this.closeEntry(entry)
    }

    let browser: Browser | null = null
    let context: BrowserContext | null = null
    try {
      browser = await chromium.launch({
        executablePath,
        headless: true,
        chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1',
        args: ['--disable-dev-shm-usage'],
      })
      const chromeMajor = browser.version().split('.')[0] || '137'
      context = await browser.newContext({
        locale: 'zh-CN',
        viewport: { width: 1365, height: 900 },
        userAgent: DESKTOP_USER_AGENT.replace('Chrome/137.0.0.0', `Chrome/${chromeMajor}.0.0.0`),
      })
      const page = await context.newPage()
      page.setDefaultTimeout(20_000)
      const config = SMS_PLATFORM_CONFIG[platform]
      await openSmsForm(page, platform, phone)
      await sendCode(page, platform)
      if (this.closed) throw new ApiError(503, 'sms_unavailable', '短信登录服务正在停止，请稍后重试')
      this.lastSent.set(rateKey, Date.now())
      const id = randomUUID()
      const view: SmsLogin = {
        id,
        platform,
        status: 'waiting',
        message: `验证码已发送至 ${maskSmsPhone(phone)}，请查看手机短信`,
        expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
        phoneMasked: maskSmsPhone(phone),
      }
      const entry: SmsEntry = {
        view,
        userId,
        config,
        importer,
        browser,
        context,
        page,
        timer: setTimeout(() => this.expire(entry), TTL_MS),
        closed: false,
        verifying: false,
      }
      entry.timer.unref()
      this.entries.set(id, entry)
      this.starting.delete(userId)
      log(`sms ${platform} code sent user=${userId}`)
      return this.view(entry)
    } catch (error) {
      this.starting.delete(userId)
      await context?.close().catch(() => {})
      await browser?.close().catch(() => {})
      const detail = error instanceof ApiError ? error.code : error instanceof Error ? error.name : 'unknown'
      console.warn(`[multipush] sms ${platform} start failed (${detail})`)
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'sms_login_failed', '无法打开平台登录页，请检查服务器网络或改用扫码登录')
    }
  }

  async verify(userId: string, platform: SmsLoginPlatform, id: string, rawCode: string): Promise<SmsLogin> {
    const entry = this.entries.get(id)
    if (!entry || entry.userId !== userId || entry.view.platform !== platform) {
      throw notFound('短信登录请求不存在或已过期，请重新发送验证码')
    }
    if (entry.closed) throw new ApiError(410, 'sms_expired', '验证码已过期，请重新发送')
    if (entry.verifying) throw new ApiError(409, 'sms_busy', '正在验证，请稍候')
    const code = rawCode.trim()
    if (!CODE_PATTERN.test(code)) throw new ApiError(400, 'sms_code_invalid', '请输入短信中的数字验证码')

    entry.verifying = true
    entry.view.status = 'verifying'
    entry.view.message = '正在提交验证码…'
    const started = Date.now()
    try {
      const input = entry.page.locator(entry.config.codeSelector).first()
      await input.waitFor({ state: 'visible', timeout: 10_000 })
      await input.fill(code)
      await entry.config.submit(entry.page).first().click({ timeout: 10_000 })
      await assertNoSecurity(entry.page)
      const result = await this.waitForLogin(entry, started)
      entry.view.status = 'connected'
      entry.view.name = result.name
      entry.view.message = `${result.name || entry.config.name}已连接，登录状态已保存`
      this.closeEntry(entry)
      log(`sms ${platform} connected user=${userId}`)
      return this.view(entry)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'sms_code_invalid') {
        entry.view.status = 'waiting'
        entry.view.message = error.message
        return this.view(entry)
      }
      entry.view.status = 'failed'
      entry.view.message = error instanceof ApiError ? error.message : '短信登录未完成，请改用扫码登录'
      const detail = error instanceof ApiError ? error.code : error instanceof Error ? error.name : 'unknown'
      this.closeEntry(entry)
      log(`sms ${platform} ${entry.view.status} user=${userId} (${detail})`)
      return this.view(entry)
    } finally {
      entry.verifying = false
    }
  }

  private async waitForLogin(entry: SmsEntry, started: number): Promise<{ name: string }> {
    let imports = 0
    while (Date.now() - started < VERIFY_TIMEOUT_MS) {
      await assertNoSecurity(entry.page)
      const body = await entry.page.locator('body').innerText().catch(() => '')
      if (/验证码错误|验证码不正确|验证码已失效|验证码过期|请输入正确的验证码|验证码有误/.test(body)) {
        throw new ApiError(400, 'sms_code_invalid', '验证码不正确或已失效，请重新输入或重新获取')
      }
      const leftLogin = !entry.config.loginPage.test(entry.page.url())
      const formGone = !(await entry.page.locator(entry.config.phoneSelector).first().isVisible().catch(() => false))
      if (Date.now() - started > 2000 && (leftLogin || formGone)) {
        imports += 1
        const state = await entry.context.storageState()
        try {
          return await entry.importer.importPublisherSession(entry.userId, state)
        } catch (error) {
          if (imports >= 2) {
            if (error instanceof ApiError) throw error
            break
          }
          await entry.page.waitForTimeout(2500)
          continue
        }
      }
      await entry.page.waitForTimeout(1500)
    }
    throw new ApiError(504, 'sms_login_timeout', '未能确认登录成功；平台可能要求二次验证，请改用扫码登录')
  }

  async cancel(userId: string, platform: SmsLoginPlatform, id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.userId !== userId || entry.view.platform !== platform) return
    this.closeEntry(entry)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const entry of [...this.entries.values()]) this.closeEntry(entry)
  }
}
