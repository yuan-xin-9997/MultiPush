import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type APIResponse } from 'playwright-core'
import { load } from 'cheerio'
import { PlaywrightZhihuDriver, parseZhihuPublishedId, zhihuResponse, type ZhihuArticle } from '../src/zhihu-browser'
import { ApiError } from '../src/errors'

const state = { cookies: [], origins: [] }
const drivers: PlaywrightZhihuDriver[] = []
const response = (data: unknown, status = 200) => ({ status: () => status, ok: () => status >= 200 && status < 300, json: async () => data }) as APIResponse

afterEach(async () => { for (const driver of drivers.splice(0)) await driver.close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

function fixture(options: { mismatch?: boolean; createTimeout?: boolean; publishTimeout?: boolean } = {}) {
  let saved: Record<string, unknown> = { id: '123', state: 'draft' }, publishListener: (value: unknown) => void = () => {}
  const upload = vi.fn(async () => response({ src: 'https://pic4.zhimg.com/uploaded.png' }))
  const post = vi.fn(async (url: string) => {
    if (url.endsWith('/uploaded_images')) return upload()
    if (options.createTimeout) throw Error('timeout with secret-cookie')
    return response({ id: '123' })
  })
  const patch = vi.fn(async (_url: string, value: { data: Record<string, unknown> }) => { saved = { ...saved, ...value.data }; return response({}) })
  const get = vi.fn(async (url: string) => url.endsWith('/me') ? response({ id: 'account', name: '作者' }) : response({ ...saved, ...(options.mismatch ? { content: '<p>丢失的内容</p>' } : {}) }))
  const click = vi.fn(async () => {
    if (options.publishTimeout) throw Error('timeout with secret-cookie')
    saved = { ...saved, id: '456', state: 'published' }
    publishListener({ request: () => ({ method: () => 'POST' }), url: () => 'https://www.zhihu.com/api/v4/content/publish', json: async () => ({ code: 0, data: { result: JSON.stringify({ publish: { id: '456' } }) } }) })
  })
  const page = { goto: vi.fn(), url: () => 'https://zhuanlan.zhihu.com/p/123/edit', on: (_event: string, listener: typeof publishListener) => { publishListener = listener }, getByRole: () => ({ first: () => ({ click }) }), waitForTimeout: vi.fn() }
  const context = { setDefaultTimeout: vi.fn(), storageState: async () => state, cookies: async () => [{ name: '_xsrf', value: 'test-xsrf' }], close: vi.fn(async () => {}), newPage: async () => page, request: { post, patch, get } }
  vi.stubEnv('ZHIHU_BROWSER_PATH', process.execPath)
  vi.spyOn(chromium, 'launch').mockResolvedValue({ newContext: async () => context, on: vi.fn(), close: async () => {} } as unknown as Browser)
  const driver = new PlaywrightZhihuDriver(); drivers.push(driver)
  const article: ZhihuArticle = { title: '测试文章', html: '<h2>标题</h2><p><img src="https://external.test/image.png"></p><p><br></p><p><em>图 1：说明</em></p><ul>\n<li><a href="https://github.com/org/repo">项目源码</a></li>\n<li><br></li>\n<li>第二项</li>\n</ul><pre><code class="language-js">  hello\n    world</code></pre>', images: new Map([['https://external.test/image.png', { name: 'body.png', mimeType: 'image/png', buffer: Buffer.from('image') }]]) }
  return { driver, article, post, patch, get, page, click, context }
}

describe('Zhihu browser publishing', () => {
  it('uploads image bytes, writes native formatting, and reads the stored draft before reporting success', async () => {
    const { driver, article, post, patch, get } = fixture()
    const progress = vi.fn()
    const result = await driver.publish(state, article, 'draft', progress)
    expect(result).toMatchObject({ status: 'draft', remoteId: '123', url: 'https://zhuanlan.zhihu.com/p/123/edit' })
    expect(post.mock.calls[0][0]).toBe('https://zhuanlan.zhihu.com/api/uploaded_images')
    const content = String(patch.mock.calls[1][1].data.content), $ = load(content)
    expect($('img').attr('src')).toBe('https://pic4.zhimg.com/uploaded.png')
    expect($('figure > figcaption em').text()).toBe('图 1：说明')
    expect($('li').length).toBe(2)
    expect($('a').attr('href')).toBe('https://github.com/org/repo')
    expect($('pre').text()).toBe('  hello\n    world')
    expect(get.mock.calls.map(call => call[0])).toContain('https://zhuanlan.zhihu.com/api/articles/123')
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ remoteId: '123' }))
  })

  it('does not click publish if the saved article fails content verification', async () => {
    const { driver, article, click } = fixture({ mismatch: true })
    await expect(driver.publish(state, article, 'publish', vi.fn())).rejects.toMatchObject({ code: 'zhihu_content_mismatch' })
    expect(click).not.toHaveBeenCalled()
  })

  it('requires explicit platform publication identity and reads back the published article', async () => {
    const { driver, article, click, get } = fixture()
    expect(await driver.publish(state, article, 'publish', vi.fn())).toMatchObject({ status: 'published', remoteId: '456', url: 'https://zhuanlan.zhihu.com/p/456' })
    expect(click).toHaveBeenCalledTimes(1)
    expect(get.mock.calls.map(call => call[0])).toContain('https://zhuanlan.zhihu.com/api/articles/456')
  })

  it.each([{ createTimeout: true }, { publishTimeout: true }])('treats timed-out writes as uncertain and never leaks credentials: %j', async options => {
    const { driver, article, click } = fixture(options)
    await expect(driver.publish(state, article, 'publish', vi.fn())).rejects.toMatchObject({ code: 'zhihu_result_uncertain', message: expect.not.stringContaining('secret-cookie') })
    expect(click.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('maps expired auth and security challenges without exposing upstream bodies', async () => {
    await expect(zhihuResponse(response({ secret: 'cookie' }, 401), '检查')).rejects.toMatchObject({ code: 'zhihu_session_expired', status: 409 })
    await expect(zhihuResponse(response({ secret: 'cookie' }, 403), '检查')).rejects.toMatchObject({ code: 'zhihu_security_check', status: 409 })
    await expect(zhihuResponse(response({ error: 'secret-cookie' }), '保存')).rejects.toBeInstanceOf(ApiError)
    await expect(zhihuResponse(response({ error: 'secret-cookie' }), '保存')).rejects.not.toThrow('secret-cookie')
  })

  it('does not infer publication success from an accepted response, missing ID, or malformed data', () => {
    for (const value of [{}, { code: '', data: { result: { publish: { id: '123' } } } }, { code: 0 }, { code: 0, data: { result: 'bad' } }, { code: 1, data: { result: { publish: { id: 123 } } } }]) expect(parseZhihuPublishedId(value)).toBeNull()
    expect(parseZhihuPublishedId({ code: 0, data: { result: '{"publish":{"id":123}}' } })).toBe('123')
  })
})
