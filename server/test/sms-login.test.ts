import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { SmsLoginManager, maskSmsPhone } from '../src/sms-login'

const managers: SmsLoginManager[] = []

function fakeLocator(overrides: Record<string, unknown> = {}): any {
  const locator: any = {
    first: () => locator,
    waitFor: async () => {},
    fill: async () => {},
    press: async () => {},
    click: async () => {},
    check: async () => {},
    isVisible: async () => false,
    isEnabled: async () => true,
    isDisabled: async () => false,
    isChecked: async () => true,
    inputValue: async () => '',
    innerText: async () => '',
    getAttribute: async () => '',
    ...overrides,
  }
  return locator
}

function fixture(options: { body?: string; url?: string; sendText?: string; phoneVisible?: boolean } = {}) {
  const state = { body: options.body ?? '今日头条创作者中心', url: options.url ?? 'https://mp.toutiao.com/profile_v4/index', sendText: options.sendText ?? '重新获取' }
  const body = fakeLocator({ innerText: async () => state.body })
  const phone = fakeLocator({ isVisible: async () => options.phoneVisible ?? true, fill: async () => {} })
  const code = fakeLocator({ isVisible: async () => true, fill: async () => {} })
  const send = fakeLocator({ innerText: async () => state.sendText, getAttribute: async () => '', click: async () => {} })
  const submit = fakeLocator({ click: async () => {} })
  const page: any = {
    setDefaultTimeout: () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    url: () => state.url,
    locator: (selector: string) => {
      if (selector === 'body') return body
      if (selector === 'input[placeholder="手机号"]') return phone
      if (selector === 'input[placeholder="验证码"]') return code
      if (selector === 'span.send-input') return send
      if (selector === 'button.web-login-button') return submit
      return fakeLocator()
    },
    getByText: () => fakeLocator(),
    getByRole: () => fakeLocator(),
  }
  const context: any = {
    newPage: async () => page,
    storageState: async () => ({ cookies: [], origins: [] }),
    close: vi.fn(async () => {}),
  }
  const browser: any = {
    version: () => '137.0.0.0',
    newContext: async () => context,
    close: vi.fn(async () => {}),
  }
  vi.stubEnv('TOUTIAO_BROWSER_PATH', process.execPath)
  vi.spyOn(chromium, 'launch').mockResolvedValue(browser as unknown as Browser)
  return { page, context, browser, state }
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('SMS login manager', () => {
  it('masks a mainland phone number without exposing the middle digits', () => {
    expect(maskSmsPhone('13800138000')).toBe('138****8000')
    expect(maskSmsPhone('19912345678')).toBe('199****5678')
  })

  it('rejects malformed phones before opening a browser', async () => {
    const manager = new SmsLoginManager({ toutiao: { importPublisherSession: async () => ({ name: '作者' }) } })
    managers.push(manager)
    await expect(manager.start('user', 'toutiao', '12345')).rejects.toMatchObject({ code: 'sms_phone_invalid' })
    await expect(manager.start('user', 'zhihu', '13800138000')).rejects.toMatchObject({ code: 'sms_platform_unsupported' })
  })

  it('sends a code, verifies it and imports the resulting browser session', async () => {
    const { state } = fixture()
    const importer = vi.fn(async () => ({ name: '测试作者' }))
    const manager = new SmsLoginManager({ toutiao: { importPublisherSession: importer } })
    managers.push(manager)

    const started = await manager.start('user', 'toutiao', '13800138000')
    expect(started).toMatchObject({ status: 'waiting', phoneMasked: '138****8000', platform: 'toutiao' })
    expect(started.message).toContain('138****8000')
    expect(JSON.stringify(started)).not.toContain('13800138000')

    state.body = '今日头条创作者中心'
    const verified = await manager.verify('user', 'toutiao', started.id, '123456')
    expect(verified).toMatchObject({ status: 'connected', name: '测试作者' })
    expect(importer).toHaveBeenCalledWith('user', { cookies: [], origins: [] })
  })

  it('keeps the attempt alive for a retry when the code is wrong', async () => {
    const { state } = fixture()
    const manager = new SmsLoginManager({ toutiao: { importPublisherSession: async () => ({ name: '作者' }) } })
    managers.push(manager)
    const started = await manager.start('user', 'toutiao', '13800138000')

    state.body = '验证码错误，请重新输入'
    const failed = await manager.verify('user', 'toutiao', started.id, '000000')
    expect(failed.status).toBe('waiting')
    expect(failed.message).toContain('验证码不正确')

    state.body = '今日头条创作者中心'
    const retried = await manager.verify('user', 'toutiao', started.id, '123456')
    expect(retried.status).toBe('connected')
  })

  it('stops and reports a security check instead of bypassing it', async () => {
    const { state } = fixture()
    const manager = new SmsLoginManager({ toutiao: { importPublisherSession: async () => ({ name: '作者' }) } })
    managers.push(manager)
    const started = await manager.start('user', 'toutiao', '13800138000')

    state.body = '请完成验证后继续'
    const failed = await manager.verify('user', 'toutiao', started.id, '123456')
    expect(failed.status).toBe('failed')
    expect(failed.message).toContain('安全验证')
  })
})
