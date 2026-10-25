import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { PlaywrightXhsDriver } from '../src/xiaohongshu-browser'

const drivers: PlaywrightXhsDriver[] = []
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
function fixture(options: { security?: boolean; disabled?: boolean; mismatch?: boolean; timeout?: boolean; response?: unknown } = {}) {
  let title = '', body = ''
  const click = vi.fn(async () => {})
  const locator = (selector: string): any => ({
    first() { return this }, nth() { return this }, filter() { return this },
    waitFor: async () => {}, click: selector.includes('publish-btn') ? click : async () => {},
    setInputFiles: vi.fn(async () => {}),
    fill: async (value: string) => { if (selector.includes('d-input')) title = value; else body = value },
    inputValue: async () => title,
    innerText: async () => selector === 'body' ? options.security ? '请完成验证' : '小红书创作中心' : options.mismatch ? '不一致' : body,
    getAttribute: async () => options.disabled ? 'true' : null,
    isDisabled: async () => false,
  })
  const page = { goto: async () => {}, url: () => 'https://creator.xiaohongshu.com/publish/publish', locator,
    waitForResponse: async (predicate: (r: any) => boolean) => {
      const response = { url: () => 'https://edith.xiaohongshu.com/api/sns/web/v1/note', request: () => ({ method: () => 'POST' }), ok: () => true, json: async () => options.response ?? { code: 0, success: true, data: { note_id: '1234567890abcdef12345678' } } }
      expect(predicate(response)).toBe(true)
      if (options.timeout) throw new Error('timeout-secret-cookie')
      return response
    } }
  const context = { newPage: async () => page, setDefaultTimeout: () => {}, close: vi.fn(async () => {}), storageState: async () => ({ cookies: [], origins: [] }) }
  vi.stubEnv('XHS_BROWSER_PATH', process.execPath)
  vi.spyOn(chromium, 'launch').mockResolvedValue({ newContext: async () => context, on: () => {}, close: async () => {} } as unknown as Browser)
  const driver = new PlaywrightXhsDriver(); drivers.push(driver)
  const publish = () => driver.publish({ cookies: [], origins: [] }, { title: '标题', body: '正文', images: new Map([['0', { name: 'card.png', mimeType: 'image/png', buffer: Buffer.from('image') }]]) }, () => {})
  return { publish, click, context }
}
describe('Xiaohongshu browser submission boundary', () => {
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
