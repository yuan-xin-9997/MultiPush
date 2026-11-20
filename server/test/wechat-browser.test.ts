import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { ApiError } from '../src/errors'
import { load } from 'cheerio'
import { applyWechatImage, assertWechatResponse, classifyWechatFailure, findPublishedArticle, isWechatLoginScanned, parseWechatPage, parseWechatUpload, prepareWechatLinks, wechatSwitchState, PlaywrightWechatDriver, type WechatStorageState } from '../src/wechat-browser'

describe('WeChat browser responses', () => {
  it('preserves external addresses as text when the account cannot save clickable links', () => {
    const $ = load('<ul><li><a href="https://github.com/org/repo?a=1&amp;b=2"><strong>项目源码</strong></a></li><li><a href="https://example.com/">https://example.com/</a></li><li><a href="https://example.com/image"><img src="image.png" data-imgfileid="123"></a></li></ul><a href="https://mp.weixin.qq.com/s/article">微信文章</a><a href="#heading">目录</a>', null, false)
    const editor = 'wx.cgiData.can_use_hyperlink = 0;\n//wx.cgiData.can_use_hyperlink = 1;\nwx.cgiData.can_use_appmsg_outer_url = 1;'
    expect(prepareWechatLinks($, editor)).toBe(3)
    expect($('li').length).toBe(3)
    expect($('li').first().text()).toBe('项目源码（https://github.com/org/repo?a=1&b=2）')
    expect($('li').eq(1).text()).toBe('https://example.com/')
    expect($('strong').text()).toBe('项目源码')
    expect($('img').attr('data-imgfileid')).toBe('123')
    expect($('a').map((_, n) => $(n).attr('href')).get()).toEqual(['https://mp.weixin.qq.com/s/article', '#heading'])
    const once = $.html()
    expect(prepareWechatLinks($, editor)).toBe(0)
    expect($.html()).toBe(once)
  })

  it('keeps clickable links when both permissions are present, and retains addresses for unknown permissions', () => {
    const $ = load('<a href="https://github.com/org/repo">项目</a>', null, false)
    const before = $.html()
    expect(prepareWechatLinks($, 'wx.cgiData.can_use_hyperlink = 1;\nwx.cgiData.can_use_appmsg_outer_url = "1" * 1;')).toBe(0)
    expect($.html()).toBe(before)
    expect(prepareWechatLinks($, '')).toBe(1)
    expect($.text()).toContain('https://github.com/org/repo')
  })

  it.each(['png', 'jpeg', 'gif'])('writes mobile editor material metadata for uploaded %s images', (format) => {
    const $ = load('<section><p>正文</p><img src="/uploads/body.png" alt="图一" style="max-width:100%"><img src="/uploads/body.png" srcset="https://external.test/image.png 2x"><img src="https://mmbiz.qpic.cn/other"></section>', null, false)
    const uploaded = { id: '100000843', url: 'https://mmbiz.qpic.cn/image/0?wx_fmt=png&from=appmsg' }
    applyWechatImage($, '/uploads/body.png', uploaded, `image/${format}`)
    for (const node of $('img').slice(0, 2).toArray()) {
      expect($(node).attr()).toMatchObject({ src: uploaded.url, 'data-src': uploaded.url, 'data-imgfileid': uploaded.id, 'data-type': format, type: 'block' })
      expect($(node).hasClass('js_insertlocalimg')).toBe(true)
      expect($(node).attr('data-s')).toBe(format === 'gif' ? undefined : '300,640')
      expect($(node).attr('srcset')).toBeUndefined()
    }
    expect($('img').first().attr('alt')).toBe('图一')
    expect($('img').first().attr('style')).toBe('max-width:100%')
    expect($('img').last().attr('src')).toBe('https://mmbiz.qpic.cn/other')
    expect($('p').text()).toBe('正文')
  })

  it('requires an explicit successful remote result and maps expired sessions', () => {
    expect(assertWechatResponse({ base_resp: { ret: '0' } }, '保存')).toEqual({ base_resp: { ret: '0' } })
    expect(() => assertWechatResponse({ base_resp: { ret: 200003 } }, '保存')).toThrow('登录已过期')
    expect(() => assertWechatResponse({}, '保存')).toThrow('无法识别')
    expect(() => assertWechatResponse({ ret: '' }, '保存')).toThrow('无法识别')
    expect(() => assertWechatResponse({ ret: 64703, secret: 'credential' }, '保存')).toThrow('64703')
    expect(() => assertWechatResponse({ ret: 64703, secret: 'credential' }, '保存')).not.toThrow('credential')
  })

  it('decodes nested record JSON and matches the remote article ID', () => {
    const records = { base_resp: { ret: 0 }, publish_page: JSON.stringify({ publish_list: [
      { publish_info: JSON.stringify({ appmsg_info: [{ appmsgid: 123, title: '同名文章', content_url: 'https://mp.weixin.qq.com/s/example' }] }) },
    ] }) }
    expect(findPublishedArticle(records, '123')).toEqual({ url: 'https://mp.weixin.qq.com/s/example' })
    expect(findPublishedArticle(records, '456')).toBeNull()
  })

  it('does not confirm missing, deleted, or unsafe article links', () => {
    for (const article of [
      { appmsgid: '123', title: '文章' },
      { appmsgid: '123', is_deleted: 1, content_url: 'https://mp.weixin.qq.com/s/deleted' },
      { appmsgid: '123', content_url: 'https://evil.example/s/article' },
      { appmsgid: '123', content_url: 'https://mp.weixin.qq.com/cgi-bin/home?token=secret' },
    ]) {
      expect(findPublishedArticle({ ret: 0, publish_list: [{ publish_info: { appmsg_info: [article] } }] }, '123')).toBeNull()
    }
  })

  it('links the published ID to its original draft and waits for completed review', () => {
    const make = (status: number) => ({ base_resp: { ret: 0 }, publish_page: JSON.stringify({ publish_list: [
      { publish_info: JSON.stringify({
        copy_appmsg_id: 123,
        publish_info: { draft_msgid: 123, publish_status: status },
        appmsg_info: [{ appmsgid: 2247485000, content_url: 'https:\\/\\/mp.weixin.qq.com\\/s\\/published' }],
      }) },
    ] }) })
    expect(findPublishedArticle(make(200), '123')).toEqual({ url: 'https://mp.weixin.qq.com/s/published' })
    expect(findPublishedArticle(make(100), '123')).toBeNull()
    expect(findPublishedArticle(make(200), '456')).toBeNull()
  })

  it('extracts account metadata without executing scripts', () => {
    const html = '<script>window.wx={commonData:{data:{t:"123",user_name:"gh_account",ticket:"ticket",nick_name:"%E5%85%AC%E4%BC%97%E5%8F%B7"}}}; throw Error("must not execute")</script>'
    expect(parseWechatPage(html, 'https://mp.weixin.qq.com/cgi-bin/home?token=123')).toEqual({ token: '123', userName: 'gh_account', ticket: 'ticket', name: '公众号' })
    expect(parseWechatPage('<html>请扫码登录</html>', 'https://mp.weixin.qq.com/')).toBeNull()
    expect(parseWechatPage(html.replace('gh_account', ''), 'https://mp.weixin.qq.com/')).toBeNull()
    expect(parseWechatPage(html, 'https://evil.example/?token=123')).toBeNull()
  })

  it('treats a URL token on an mp origin as logged in even when identity fields move to XHR templates', () => {
    // Redesigned home pages may not embed user_name/nick_name in the initial HTML.
    expect(parseWechatPage('<html>后台</html>', 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=123')).toEqual({ token: '123', userName: '', ticket: '', name: '微信公众号' })
    // An HTML-embedded token without user_name and without a URL token still
    // means "not a logged-in page".
    expect(parseWechatPage('token=123', 'https://mp.weixin.qq.com/')).toBeNull()
  })

  it('accepts material objects and serialized material objects and upgrades trusted CDN URLs', () => {
    for (const content of [{ media_id: 'id', cdn_url: 'http://mmbiz.qpic.cn/picture' }, JSON.stringify({ media_id: 'id', cdn_url: 'http://mmbiz.qpic.cn/picture' })]) {
      expect(parseWechatUpload({ ret: 0, content })).toEqual({ id: 'id', url: 'https://mmbiz.qpic.cn/picture' })
    }
    expect(parseWechatUpload({ base_resp: { ret: 0 }, content: 'numeric-id', cdn_url: 'https://mmbiz.qlogo.cn/image' })).toEqual({ id: 'numeric-id', url: 'https://mmbiz.qlogo.cn/image' })
    expect(() => parseWechatUpload({ ret: 0, content: 'id', cdn_url: 'http://evil.example/image' })).toThrow('有效素材')
    expect(() => parseWechatUpload({ ret: 0, content: '{"unrecognized":"id"}', cdn_url: 'https://mmbiz.qpic.cn/image' })).toThrow('有效素材')
  })

  it('requires explicit switch state before allowing submission', () => {
    expect(wechatSwitchState({ checked: false })).toBe(false)
    expect(wechatSwitchState({ checked: true, className: 'switch_off' })).toBe(true)
    expect(wechatSwitchState({ ariaChecked: 'false' })).toBe(false)
    expect(wechatSwitchState({ className: 'weui-desktop-switch switch_on' })).toBe(true)
    expect(wechatSwitchState({ className: 'weui-desktop-switch_off' })).toBe(false)
    expect(wechatSwitchState({ className: 'weui-desktop-switch weui-desktop-switch_loading' })).toBeNull()
  })

  it('does not treat the initial account-selection instructions as a completed scan', () => {
    expect(isWechatLoginScanned('微信扫一扫，选择该微信下的公众平台账号登录')).toBe(false)
    expect(isWechatLoginScanned('扫码成功，请选择公众号')).toBe(true)
    expect(isWechatLoginScanned('请在手机微信上确认登录')).toBe(true)
  })

  it('distinguishes safe preparation failures from unknown remote writes', () => {
    const networkError = new Error('request failed cookie=must-never-leak')
    expect(classifyWechatFailure(networkError, { draftRequested: false, submitted: false, remoteId: '' })).toMatchObject({ code: 'wechat_preparation_failed' })
    expect(classifyWechatFailure(networkError, { draftRequested: true, submitted: false, remoteId: '' })).not.toBeInstanceOf(ApiError)
    expect(classifyWechatFailure(networkError, { draftRequested: true, submitted: false, remoteId: '123' })).toMatchObject({ code: 'wechat_publish_not_submitted', message: expect.stringContaining('草稿箱') })
    expect(classifyWechatFailure(networkError, { draftRequested: true, submitted: true, remoteId: '123' })).not.toBeInstanceOf(ApiError)
    for (const phase of [
      { draftRequested: false, submitted: false, remoteId: '' },
      { draftRequested: true, submitted: false, remoteId: '' },
      { draftRequested: true, submitted: false, remoteId: '123' },
      { draftRequested: true, submitted: true, remoteId: '123' },
    ]) expect(classifyWechatFailure(networkError, phase).message).not.toContain('must-never-leak')
  })

  it('preserves explicit rejections and session expiry without classifying them as unknown writes', () => {
    let rejection: unknown
    try { assertWechatResponse({ ret: 64703 }, '保存', 'wechat_rejected') } catch (error) { rejection = error }
    expect(classifyWechatFailure(rejection, { draftRequested: true, submitted: false, remoteId: '' })).toMatchObject({ code: 'wechat_rejected' })
    const sessionExpired = new ApiError(409, 'wechat_session_expired', '登录已过期')
    expect(classifyWechatFailure(sessionExpired, { draftRequested: false, submitted: false, remoteId: '' })).toBe(sessionExpired)
    const cannotVerify = new ApiError(409, 'wechat_notification_unverified', '无法确认群发通知')
    expect(classifyWechatFailure(cannotVerify, { draftRequested: true, submitted: false, remoteId: '123' })).toMatchObject({ code: 'wechat_notification_unverified' })
  })
})


const deleteSession: WechatStorageState = {
  cookies: [{ name: 'bizuin', value: 'private', domain: 'mp.weixin.qq.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [],
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('WeChat browser draft deletion', () => {
  it('calls the admin delete endpoint with the draft appmsgid and rejects unsupported responses', async () => {
    const post = vi.fn(async (_url: string, _options: { form: Record<string, string> }) => ({
      status: () => 200, ok: () => true, json: async () => ({ base_resp: { ret: 0 } }),
    }))
    const page = {
      goto: vi.fn(),
      content: async () => '<script>var data={t:"123",user_name:"gh_test",ticket:"ticket",nick_name:"测试公众号"};</script>',
      url: () => 'https://mp.weixin.qq.com/?token=123',
    }
    const context = {
      newPage: async () => page,
      setDefaultTimeout: vi.fn(),
      storageState: async () => deleteSession,
      close: vi.fn(async () => {}),
      request: { post },
    }
    vi.stubEnv('WECHAT_BROWSER_PATH', process.execPath)
    vi.spyOn(chromium, 'launch').mockResolvedValue({ newContext: async () => context, on: vi.fn(), close: async () => {} } as unknown as Browser)
    const driver = new PlaywrightWechatDriver()
    try {
      await expect(driver.deleteDraft(deleteSession, '345')).resolves.toMatchObject({ message: '已删除公众号草稿' })
      const [url, options] = post.mock.calls[0]
      expect(url).toContain('/cgi-bin/operate_appmsg?sub=del')
      expect(options.form).toMatchObject({ AppMsgId: '345', token: '123', lang: 'zh_CN' })
      await expect(driver.deleteDraft(deleteSession, '../bad')).rejects.toMatchObject({ code: 'wechat_draft_invalid' })
    } finally { await driver.close() }
  })
})
