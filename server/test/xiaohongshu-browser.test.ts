import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { PlaywrightXhsDriver, xhsUserAgent, clickXhsImageTab, xhsEditorText, normalizeXhsEditorText } from '../src/xiaohongshu-browser'

const drivers: PlaywrightXhsDriver[] = []
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
function fixture(options: { security?: boolean; disabled?: boolean; mismatch?: boolean; timeout?: boolean; response?: unknown; failStage?: 'upload' | 'body' } = {}) {
  let title = '', body = ''
  const click = vi.fn(async () => {})
  const locator = (selector: string): any => ({
    first() { return this }, nth() { return this }, filter() { return this },
    count: async () => 1, isVisible: async () => true, boundingBox: async () => ({ x: 10, y: 10, width: 100, height: 40 }),
    waitFor: async () => {}, click: selector.includes('publish-btn') ? click : async () => {},
    setInputFiles: vi.fn(async () => { if (options.failStage === 'upload') { const error = new Error('secret-cookie'); error.name = 'TimeoutError'; throw error } }),
    fill: async (value: string) => { if (options.failStage === 'body' && selector.includes('tiptap')) throw new Error('secret-cookie'); if (selector.includes('d-input')) title = value; else body = value },
    inputValue: async () => title,
    innerHTML: async () => options.mismatch ? '<p>不一致</p>' : `<p>${body}</p>`,
    innerText: async () => selector === 'body' ? options.security ? '请完成验证' : '小红书创作中心' : options.mismatch ? '不一致' : body,
    getAttribute: async () => options.disabled ? 'true' : null,
    isDisabled: async () => false,
  })
  const page = { viewportSize: () => ({ width: 1280, height: 1000 }), goto: async () => {}, url: () => 'https://creator.xiaohongshu.com/publish/publish', locator,
    waitForResponse: async (predicate: (r: any) => boolean) => {
      const response = { url: () => 'https://edith.xiaohongshu.com/api/sns/web/v1/note', request: () => ({ method: () => 'POST' }), ok: () => true, json: async () => options.response ?? { code: 0, success: true, data: { note_id: '1234567890abcdef12345678' } } }
      expect(predicate(response)).toBe(true)
      if (options.timeout) throw new Error('timeout-secret-cookie')
      return response
    } }
  const context = { newPage: async () => page, setDefaultTimeout: () => {}, close: vi.fn(async () => {}), storageState: async () => ({ cookies: [], origins: [] }) }
  vi.stubEnv('XHS_BROWSER_PATH', process.execPath)
  vi.spyOn(chromium, 'launch').mockResolvedValue({ newContext: async () => context, on: () => {}, close: async () => {}, version: () => '140.0.0.0' } as unknown as Browser)
  const driver = new PlaywrightXhsDriver(); drivers.push(driver)
  const publish = () => driver.publish({ cookies: [], origins: [] }, { title: '标题', body: '正文', images: new Map([['0', { name: 'card.png', mimeType: 'image/png', buffer: Buffer.from('image') }]]) }, () => {})
  return { publish, click, context }
}
describe('Xiaohongshu browser submission boundary', () => {
  it.each([{ failStage: 'upload' as const, expected: '上传图片 1/1超时' }, { failStage: 'body' as const, expected: '填写正文失败' }])('reports the failed preparation step without leaking upstream errors: %s', async options => {
    const { publish, click } = fixture(options)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(publish()).rejects.toMatchObject({ code: 'xiaohongshu_prepare_failed', message: expect.stringContaining(options.expected) })
    expect(click).not.toHaveBeenCalled()
    expect(warning.mock.calls.flat().join(' ')).not.toContain('secret-cookie')
  })
  it('confirms explicit platform success and always closes the context', async () => {
    const { publish, click, context } = fixture()
    expect(await publish()).toMatchObject({ status: 'published', remoteId: '1234567890abcdef12345678' })
    expect(click).toHaveBeenCalledTimes(1)
    expect(context.close).toHaveBeenCalledTimes(1)
  })
  it.each([{ security: true }, { mismatch: true }, { disabled: true }])('does not submit when preparation is blocked: %s', async options => {
    const { publish, click, context } = fixture(options)
    await expect(publish()).rejects.toMatchObject({ status: 409 })
    expect(click).not.toHaveBeenCalled()
    expect(context.close).toHaveBeenCalledTimes(1)
  })
  it.each([{ timeout: true }, { response: { code: 0, success: true } }, { response: { code: -1, success: false } }])('retains uncertainty after a submission without confirmation: %s', async options => {
    const { publish, click } = fixture(options)
    await expect(publish()).rejects.toMatchObject({ code: 'xiaohongshu_result_uncertain' })
    expect(click).toHaveBeenCalledTimes(1)
  })
})
describe('Xiaohongshu login preparation', () => {
  function loginFixture(options: { security?: boolean; qrVisible?: boolean; loginVisible?: boolean; scanVisible?: boolean } = {}) {
    const clicks: string[] = []
    let profileHref: string | null = null
    let snapshot: unknown = { user: { loggedIn: false, userInfo: { guest: true } } }
    vi.stubGlobal('__INITIAL_STATE__', snapshot)
    vi.stubGlobal('document', { querySelector: () => profileHref ? { getAttribute: () => profileHref } : null })
    let qrVisible = options.qrVisible ?? true
    const locator = (selector: string): any => ({
      first() { return this },
      isVisible: async () => selector.includes('qrcode-img') ? qrVisible : selector === '.main-container .user.side-bar-component .link-wrapper' ? false : !!options.loginVisible,
      click: async () => { clicks.push(selector); qrVisible = true },
      waitFor: async () => {},
      screenshot: async () => Buffer.from('qr-image'),
      innerText: async () => options.security ? '安全限制 IP存在风险，请切换可靠网络环境后重试' : '登录后推荐更懂你的笔记',
    })
    const page = {
      goto: async () => {}, url: () => 'https://www.xiaohongshu.com/explore',
      locator,
      getByText: (): any => ({ first() { return this }, isVisible: async () => !!options.scanVisible, click: async () => { clicks.push('scan'); qrVisible = true } }),
      evaluate: async (callback: () => unknown) => callback(),
      waitForFunction: async () => {},
    }
    const newContext = vi.fn(async () => ({ newPage: async () => page, setDefaultTimeout: () => {}, close: vi.fn(async () => {}), storageState: async () => ({ cookies: [], origins: [] }) }))
    vi.stubEnv('XHS_BROWSER_PATH', process.execPath)
    vi.spyOn(chromium, 'launch').mockResolvedValue({ newContext, on: () => {}, close: async () => {}, version: () => '140.0.6533.88' } as unknown as Browser)
    const driver = new PlaywrightXhsDriver(); drivers.push(driver)
    return { driver, newContext, clicks,
      setState: (state: unknown) => { snapshot = state; vi.stubGlobal('__INITIAL_STATE__', snapshot) },
      setProfile: (href: string | null) => { profileHref = href },
      hideQr: () => { qrVisible = false },
      page,
    }
  }
  it.each(['value', '_value'])('detects login with a reactive %s flag and userInfo', async key => {
    const { driver, setState, hideQr } = loginFixture()
    const attempt = await driver.beginLogin()
    expect((await attempt.poll()).status).toBe('waiting')
    hideQr()
    setState({ user: { loggedIn: { [key]: true }, userInfo: { [key]: { userId: '1234567890abcdef12345678', nickname: '扫码作者' } } } })
    expect(await attempt.poll()).toMatchObject({ status: 'connected', identity: { accountId: '1234567890abcdef12345678', name: '扫码作者' }, state: { cookies: [], origins: [] } })
    await attempt.close()
  })
  it('uses the current user profile link when the initial state remains a guest', async () => {
    const { driver, setProfile, hideQr } = loginFixture()
    const attempt = await driver.beginLogin()
    hideQr()
    setProfile('/user/profile/1234567890abcdef12345678')
    expect(await attempt.poll()).toMatchObject({ status: 'connected', identity: { accountId: '1234567890abcdef12345678' } })
    await attempt.close()
  })
  it('refreshes a stale guest snapshot once after QR disappearance without claiming success from disappearance alone', async () => {
    let time = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => time)
    const { driver, hideQr, setState, page } = loginFixture()
    const attempt = await driver.beginLogin()
    await attempt.poll()
    hideQr()
    expect(await attempt.poll()).toMatchObject({ status: 'scanned', qrCode: null })
    page.goto = async () => { setState({ user: { loggedIn: true, userInfo: { userId: '1234567890abcdef12345678', nickname: '已登录' } } }) }
    time += 5001
    expect(await attempt.poll()).toMatchObject({ status: 'connected', identity: { name: '已登录' } })
    await attempt.close()
  })
  it('ends with an actionable failure when QR disappears but no authenticated identity arrives', async () => {
    let time = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => time)
    const { driver, hideQr } = loginFixture()
    const attempt = await driver.beginLogin()
    hideQr()
    expect((await attempt.poll()).status).toBe('scanned')
    time += 60_001
    expect(await attempt.poll()).toMatchObject({ status: 'failed', qrCode: null })
    await attempt.close()
  })
  it('does not accept guest state or untrusted profile URLs as authentication', async () => {
    const { driver, hideQr, setProfile, setState } = loginFixture()
    const attempt = await driver.beginLogin()
    hideQr()
    setState({ user: { loggedIn: false, userInfo: { guest: true, userId: '1234567890abcdef12345678' } } })
    setProfile('https://evil.example/user/profile/1234567890abcdef12345678')
    expect((await attempt.poll()).status).toBe('scanned')
    await attempt.close()
  })
  it('uses a desktop Chrome identity so Xiaohongshu serves the official QR instead of a security page', async () => {
    const { driver, newContext } = loginFixture()
    const attempt = await driver.beginLogin()
    expect(newContext).toHaveBeenCalledWith(expect.objectContaining({ userAgent: xhsUserAgent('140.0.6533.88') }))
    expect(xhsUserAgent('140.0.6533.88')).not.toMatch(/Headless/)
    expect((await attempt.poll()).qrCode).toMatch(/^data:image\/png;base64,/)
    await attempt.close()
  })
  it('opens the login dialog when the QR code is not on screen', async () => {
    const { driver, clicks } = loginFixture({ qrVisible: false, loginVisible: true })
    const attempt = await driver.beginLogin()
    expect(clicks).toEqual(['#login-btn, .side-bar-component .login-btn'])
    await attempt.close()
  })
  it('switches to the QR tab when the login page defaults to another method', async () => {
    const { driver, clicks } = loginFixture({ qrVisible: false, scanVisible: true })
    const attempt = await driver.beginLogin()
    expect(clicks).toEqual(['scan'])
    await attempt.close()
  })
  it('reports network restrictions instead of a generic QR failure', async () => {
    const { driver } = loginFixture({ security: true })
    await expect(driver.beginLogin()).rejects.toMatchObject({ code: 'xiaohongshu_security_check', status: 409 })
  })
})


describe('Xiaohongshu image tab selection', () => {
  it('skips offscreen layout copies and clicks the rendered tab without forcing clicks', async () => {
    const outside = { boundingBox: async () => ({ x: -9999, y: -9999, width: 96, height: 40 }), isVisible: async () => true, click: vi.fn() }
    const actual = { boundingBox: async () => ({ x: 385, y: 81, width: 96, height: 40 }), isVisible: async () => true, click: vi.fn(async () => {}) }
    const tabs = { first: () => ({ waitFor: async () => {} }), filter() { return this }, count: async () => 2, nth: (i: number) => [outside, actual][i] }
    const locator = vi.fn(() => tabs)
    await clickXhsImageTab({ locator, viewportSize: () => ({ width: 1280, height: 1000 }) } as never)
    expect(locator).toHaveBeenCalledWith('div.creator-tab:not([aria-hidden="true"])')
    expect(outside.click).not.toHaveBeenCalled()
    expect(actual.click).toHaveBeenCalledWith()
  })
  it('stops if no image tab is in the viewport', async () => {
    const tabs = { first: () => ({ waitFor: async () => {} }), filter() { return this }, count: async () => 0 }
    await expect(clickXhsImageTab({ locator: () => tabs, viewportSize: () => ({ width: 1280, height: 1000 }) } as never)).rejects.toMatchObject({ code: 'xiaohongshu_image_tab_missing' })
  })
})


describe('Xiaohongshu editor structural readback', () => {
  it('preserves paragraphs, intentional empty lines, emoji, inline markup and hard breaks', () => {
    const html = '<p>第一段🙂。</p><p><br class="ProseMirror-trailingBreak"></p><p>第二段<strong>重点</strong><br>下一行</p><p>#话题</p>'
    expect(xhsEditorText(html)).toBe('第一段🙂。\n\n第二段重点\n下一行\n#话题')
    expect(xhsEditorText('<p><br class="ProseMirror-trailingBreak"></p><p>正文</p><p><br class="ProseMirror-trailingBreak"></p>')).toBe('\n正文\n')
    expect(xhsEditorText('纯文本 &amp; 标点🙂')).toBe('纯文本 & 标点🙂')
    expect(xhsEditorText('<div>第一行</div><div>第二行</div>')).toBe('第一行\n第二行')
  })
  it('normalizes only browser whitespace variants and still detects missing text and changed word boundaries', () => {
    expect(normalizeXhsEditorText(xhsEditorText('<p>a&nbsp;b</p><p>c</p>'))).toBe(normalizeXhsEditorText('a b\r\nc'))
    expect(normalizeXhsEditorText(xhsEditorText('<p>正文</p>'))).not.toBe(normalizeXhsEditorText('正文还有细节'))
    expect(normalizeXhsEditorText(xhsEditorText('<p>ab</p>'))).not.toBe(normalizeXhsEditorText('a b'))
    expect(normalizeXhsEditorText(xhsEditorText('<p>第一段</p><p>第二段</p>'))).not.toBe(normalizeXhsEditorText('第一段\n\n第二段'))
    expect(xhsEditorText('<p>正文</p>多余文字')).not.toBe('正文')
  })
})
