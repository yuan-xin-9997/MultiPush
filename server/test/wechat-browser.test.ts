import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/errors'
import { assertWechatResponse, classifyWechatFailure, findPublishedArticle, isWechatLoginScanned, parseWechatPage, parseWechatUpload, wechatSwitchState } from '../src/wechat-browser'

describe('WeChat browser responses', () => {
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
    expect(parseWechatPage('token=123', 'https://mp.weixin.qq.com/?token=123')).toBeNull()
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
