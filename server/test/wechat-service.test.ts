import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlatformRender, WechatLogin, WechatPublication, WechatPublishInput } from '../../shared/types'
import { createApp } from '../src/app'
import { signToken } from '../src/auth'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { ApiError } from '../src/errors'
import { decryptWechatSession, encryptWechatSession, loadWechatKey, WechatService } from '../src/wechat'
import type { WechatBrowserDriver, WechatLoginAttempt, WechatStorageState } from '../src/wechat-browser'
import * as remoteImages from '../src/wechat-image'
import { load } from 'cheerio'
import { chromium, type Browser } from 'playwright-core'
import { PlaywrightWechatDriver } from '../src/wechat-browser'

const directories: string[] = []
const databases: Database[] = []
const services: WechatService[] = []
const servers: Server[] = []
const session: WechatStorageState = {
  cookies: [{ name: 'bizuin', value: 'private-wechat-account', domain: 'mp.weixin.qq.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fakeDriver() {
  const poll = vi.fn<WechatLoginAttempt['poll']>().mockResolvedValue({ status: 'waiting', qrCode: 'data:image/png;base64,bG9naW4=', message: '等待扫码' })
  const attempt = { poll, close: vi.fn(async () => {}) }
  const driver = {
    beginLogin: vi.fn<WechatBrowserDriver['beginLogin']>().mockResolvedValue(attempt),
    checkSession: vi.fn<WechatBrowserDriver['checkSession']>().mockResolvedValue({ state: session, name: '测试公众号' }),
    publish: vi.fn<WechatBrowserDriver['publish']>().mockImplementation(async (_state, _article, mode) => ({
      state: session, status: mode === 'draft' ? 'draft' : 'published', message: mode === 'draft' ? '草稿已保存' : '已发表',
      remoteId: 'wechat-draft-id', url: mode === 'publish' ? 'https://mp.weixin.qq.com/s/published' : null,
    })),
    close: vi.fn(async () => {}),
  }
  return { driver, attempt }
}

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-wechat-service-'))
  directories.push(directory)
  const config = loadConfig({ dataDir: directory, jwtSecret: 'wechat-test-jwt', nodeEnv: 'test' })
  // Disk persistence has separate coverage; service tests should not depend on CI fsync latency.
  const database = openDatabase(':memory:')
  databases.push(database)
  const alice = database.createUser({ username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: 'unused' })
  const bob = database.createUser({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: 'unused' })
  const { driver, attempt } = fakeDriver()
  const service = new WechatService(database, config, driver)
  services.push(service)
  const seedAccount = (userId = alice.id, checkedAt = new Date().toISOString()) => database.saveWechatAccount(userId, {
    encryptedSession: encryptWechatSession(session, loadWechatKey(directory), userId), name: '测试公众号', status: 'connected', checkedAt,
  })
  const image = (userId: string, filename: string) => {
    const buffer = Buffer.from(`image-bytes-for-${filename}`)
    writeFileSync(path.join(config.uploadsDir, filename), buffer)
    return database.createMedia(userId, { filename, originalName: filename, kind: 'image', mimeType: 'image/png', size: buffer.length })
  }
  const article = (html = '<p>原始正文</p>') => {
    const content = database.createContent(alice.id, { title: '原始标题', contentHtml: html, contentJson: {}, excerpt: '', bookId: null,
      coverImage: null, tags: [], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const result: PlatformRender = { platform: 'wechat', title: content.title, html, markdown: null, text: '原始正文', previewMode: 'article', themeColor: '#07c160',
      meta: { wordCount: 4, imageCount: 0, videoCount: 0, readMinutes: 1, tags: [], titleLength: 4, summary: '摘要' },
      cards: [], assets: [], videos: [], warnings: [], downloads: [], generatedAt: content.updatedAt, sourceUpdatedAt: content.updatedAt }
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['wechat'], options: {}, results: [result] })
  }
  return { directory, config, database, alice, bob, driver, attempt, service, seedAccount, image, article }
}

async function finished(service: WechatService, userId: string, id: string): Promise<WechatPublication> {
  await vi.waitFor(() => expect(['running', 'awaiting_confirmation']).not.toContain(service.get(userId, id).status))
  return service.get(userId, id)
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const service of services.splice(0)) await service.close()
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WeChat session security', () => {
  it('encrypts browser state with a persistent separate key and binds ciphertext to its owner', () => {
    const { directory } = setup()
    const key = loadWechatKey(directory)
    expect(loadWechatKey(directory)).toEqual(key)
    const encrypted = encryptWechatSession(session, key, 'alice')
    expect(Buffer.from(encrypted, 'base64').includes(Buffer.from('private-wechat-account'))).toBe(false)
    expect(encryptWechatSession(session, key, 'alice')).not.toBe(encrypted)
    expect(decryptWechatSession(encrypted, key, 'alice')).toEqual(session)
    expect(() => decryptWechatSession(encrypted, key, 'bob')).toThrow()
    expect(() => decryptWechatSession(encrypted, randomBytes(32), 'alice')).toThrow()
    expect(() => decryptWechatSession('invalid-state', key, 'alice')).toThrow()
  })

  it('isolates login attempts and does not restore credentials after disconnect cancels a pending poll', async () => {
    const { service, alice, bob, driver, attempt, database } = setup()
    let login = await service.startLogin(alice.id)
    expect(login).toMatchObject({ status: 'waiting', qrCode: 'data:image/png;base64,bG9naW4=' })
    await expect(service.pollLogin(bob.id, login.id)).rejects.toMatchObject({ status: 404 })
    const refreshed = await service.startLogin(alice.id)
    expect(refreshed.id).not.toBe(login.id)
    await expect(service.pollLogin(alice.id, login.id)).rejects.toMatchObject({ status: 404 })
    expect(driver.beginLogin).toHaveBeenCalledTimes(2)
    expect(attempt.close).toHaveBeenCalledTimes(1)
    login = refreshed

    const pending = deferred<Awaited<ReturnType<WechatLoginAttempt['poll']>>>()
    attempt.poll.mockReturnValueOnce(pending.promise)
    const poll = service.pollLogin(alice.id, login.id)
    await service.disconnect(alice.id)
    pending.resolve({ status: 'connected', qrCode: null, message: '已登录', state: session, name: '测试公众号' })
    expect((await poll).status).toBe('failed')
    expect(database.getWechatAccount(alice.id)).toBeNull()
    await expect(service.pollLogin(alice.id, login.id)).rejects.toMatchObject({ status: 404 })
    expect(attempt.close).toHaveBeenCalled()
  })

  it('persists a successful login and restores it with a new service instance', async () => {
    const { service, config, alice, driver, attempt, database } = setup()
    attempt.poll.mockResolvedValue({ status: 'connected', qrCode: null, message: '已登录', state: session, name: '测试公众号' })
    expect((await service.startLogin(alice.id)).status).toBe('connected')
    expect(database.getWechatAccount(alice.id)?.encryptedSession).not.toContain('private-wechat-account')
    await service.close()
    const restored = new WechatService(database, { ...config, jwtSecret: 'rotated-jwt-key' }, driver)
    services.push(restored)
    expect(await restored.account(alice.id)).toMatchObject({ status: 'connected', name: '测试公众号' })
    const account = database.getWechatAccount(alice.id)!
    database.saveWechatAccount(alice.id, { ...account, checkedAt: '2020-01-01T00:00:00.000Z' })
    expect(await restored.account(alice.id)).toMatchObject({ status: 'connected' })
    expect(driver.checkSession).toHaveBeenCalledWith(session)
  })

  it('reserves the global login limit before concurrent browser creation completes', async () => {
    const { service, database, driver, attempt } = setup()
    const users = Array.from({ length: 9 }, (_, index) => database.createUser({
      username: `login${index}`, email: `login${index}@example.com`, displayName: `User ${index}`, passwordHash: 'unused',
    }))
    const gate = deferred<WechatLoginAttempt>()
    driver.beginLogin.mockReturnValue(gate.promise)
    const pending = users.slice(0, 8).map((user) => service.startLogin(user.id))
    try {
      await expect(service.startLogin(users[8].id)).rejects.toMatchObject({ status: 503, code: 'wechat_busy' })
      expect(driver.beginLogin).toHaveBeenCalledTimes(8)
    } finally {
      gate.resolve(attempt)
      await Promise.allSettled(pending)
    }
  })

  it('marks unrestorable credentials expired without exposing ciphertext or returning an application 401', async () => {
    const { service, database, alice, bob, seedAccount } = setup()
    seedAccount(alice.id, '2020-01-01T00:00:00.000Z')
    database.saveWechatAccount(bob.id, database.getWechatAccount(alice.id)!)
    expect(await service.account(bob.id)).toMatchObject({ status: 'expired' })
    expect(database.getWechatAccount(bob.id)?.status).toBe('expired')
  })
})

describe('WeChat article submission', () => {
  it('runs legacy content through the real service and driver before submitting a new WeChat draft', async () => {
    const { database, config, alice, seedAccount, image, article } = setup()
    seedAccount()
    const cover = image(alice.id, 'cover.png')
    const render = article('<p><img src="https://example.com/body.png" style="margin:20px auto;margin-bottom:0"></p><p><br></p><p style="margin:0 0 16px;margin-top:8px"><em>图 1：说明</em></p><ul>\n<li><a href="https://github.com/org/repo">项目源码</a></li>\n<li><p><br></p></li>\n<li>另一项</li>\n</ul>')
    vi.spyOn(remoteImages, 'downloadWechatImage').mockResolvedValue({ name: 'body.png', mimeType: 'image/png', buffer: Buffer.from('downloaded-image') })
    const editor = '<script>var data={t:"123",user_name:"gh_test",ticket:"test-ticket",nick_name:"测试公众号"};\nwx.cgiData.can_use_hyperlink = 0;\n</script>'
    let uploaded = 0
    const upload = vi.fn(async () => ({ json: async () => ({ ret: 0, content: { media_id: String(++uploaded), cdn_url: `https://mmbiz.qpic.cn/image/${uploaded}` } }) }))
    const create = vi.fn(async (_url: string, _options: { form: Record<string, string> }) => ({ json: async () => ({ base_resp: { ret: 0 }, appMsgId: '345' }) }))
    const page = { goto: vi.fn(), content: async () => editor, url: () => 'https://mp.weixin.qq.com/?token=123', request: { post: upload } }
    const context = { newPage: async () => page, setDefaultTimeout: vi.fn(), storageState: async () => session, close: vi.fn(async () => {}), request: { get: async () => ({ text: async () => editor }), post: create } }
    vi.stubEnv('WECHAT_BROWSER_PATH', process.execPath)
    vi.spyOn(chromium, 'launch').mockResolvedValue({ newContext: async () => context, on: vi.fn(), close: async () => {} } as unknown as Browser)
    const service = new WechatService(database, config, new PlaywrightWechatDriver())
    services.push(service)
    const publication = await service.publish(alice.id, { renderId: render.id, mode: 'draft', coverMediaId: cover.id, sourceUrl: 'https://github.com/org/repo' })
    expect(await finished(service, alice.id, publication.id)).toMatchObject({ status: 'draft', remoteId: '345', message: expect.stringContaining('1 个正文外链已保留为可复制地址') })
    expect(upload).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledTimes(1)
    const [url, options] = create.mock.calls[0]
    expect(new URL(url).searchParams.get('sub')).toBe('create')
    expect(options.form.sourceurl0).toBe('https://github.com/org/repo')
    const $ = load(options.form.content0)
    expect($('img').attr()).toMatchObject({ src: 'https://mmbiz.qpic.cn/image/2', 'data-src': 'https://mmbiz.qpic.cn/image/2', 'data-imgfileid': '2', 'data-type': 'png' })
    expect($('img').css('margin')).toBe('20px auto 0 auto')
    expect($('img').parent().next().text()).toBe('图 1：说明')
    expect($('img').parent().next().css('margin')).toBe('8px 0 16px 0')
    expect($('li').length).toBe(2)
    expect($('li').first().text()).toBe('项目源码（https://github.com/org/repo）')
    expect($('ul').contents().toArray().every(n => n.type === 'tag' && n.name === 'li')).toBe(true)
    expect($('a[href="https://github.com/org/repo"]').length).toBe(0)
  })

  it('passes the read-original address to the driver and includes it in submission identity', async () => {
    const { service, driver, alice, seedAccount, image, article } = setup()
    seedAccount()
    const cover = image(alice.id, 'cover.png'), render = article()
    const input = { renderId: render.id, mode: 'draft' as const, coverMediaId: cover.id, sourceUrl: 'https://github.com/org/repo' }
    const first = await service.publish(alice.id, input)
    await finished(service, alice.id, first.id)
    expect(driver.publish.mock.calls[0][1].sourceUrl).toBe(input.sourceUrl)
    expect((await service.publish(alice.id, input)).id).toBe(first.id)
    const second = await service.publish(alice.id, { ...input, sourceUrl: 'https://github.com/org/repo/releases' })
    expect(second.id).not.toBe(first.id)
    await finished(service, alice.id, second.id)
    expect(driver.publish.mock.calls[1][1].sourceUrl).toBe('https://github.com/org/repo/releases')
  })

  it('publishes the saved platform adjustment and reads only the owner’s uploaded image files', async () => {
    const { service, database, driver, alice, seedAccount, image, article } = setup()
    seedAccount()
    const cover = image(alice.id, 'cover.png')
    image(alice.id, 'body.png')
    const render = article()
    database.saveRenderDraft(alice.id, render.id, { ...render.results[0], title: '调整后标题', html: '<p>调整后正文</p><p><img src="/uploads/body.png" style="margin:20px auto;"></p><p><br></p><p><em>图 1：说明</em></p><ul>\n<li>列表一</li>\n<li><section><span><br></span></section></li>\n<li>列表二</li>\n</ul>', authorName: '作者' })
    const publication = await service.publish(alice.id, { renderId: render.id, mode: 'draft', coverMediaId: cover.id })
    expect((await finished(service, alice.id, publication.id)).status).toBe('draft')
    const submitted = driver.publish.mock.calls[0][1]
    expect(submitted).toMatchObject({ title: '调整后标题', author: '作者', cover: { name: 'cover.png' } })
    expect(submitted.html).toContain('调整后正文')
    expect(submitted.html).not.toContain('原始正文')
    expect(submitted.html).toContain('<ul><li>列表一</li><li>列表二</li></ul>')
    const $ = load(submitted.html)
    expect($('img').parent().next().text()).toBe('图 1：说明')
    expect($('img').parent().next().css('margin')).toBe('8px 0 0 0')
    expect(submitted.images.get('/uploads/body.png')?.buffer.toString()).toBe('image-bytes-for-body.png')
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'draft', coverMediaId: cover.id })).resolves.toMatchObject({ id: publication.id })
    expect(driver.publish).toHaveBeenCalledTimes(1)
  })

  it('loads external images once per URL and includes their bytes for upload to WeChat', async () => {
    const { service, driver, alice, seedAccount, image, article } = setup()
    seedAccount()
    const cover = image(alice.id, 'cover.png')
    const download = vi.spyOn(remoteImages, 'downloadWechatImage').mockResolvedValue({ name: 'body.png', mimeType: 'image/png', buffer: Buffer.from('remote-image') })
    const render = article('<p>正文</p><img src="https://example.com/a.png" srcset="https://example.com/b.png 2x"><img src="https://example.com/a.png">')
    const publication = await service.publish(alice.id, { renderId: render.id, mode: 'publish', coverMediaId: cover.id })
    expect((await finished(service, alice.id, publication.id)).status).toBe('published')
    expect(download).toHaveBeenCalledExactlyOnceWith('https://example.com/a.png')
    const submitted = driver.publish.mock.calls[0][1]
    expect(submitted.images.get('https://example.com/a.png')?.buffer.toString()).toBe('remote-image')
    expect(submitted.html).not.toContain('srcset')
  })

  it('records image download failures before sending anything to WeChat and permits retry', async () => {
    const { service, driver, alice, seedAccount, image, article } = setup()
    seedAccount()
    const cover = image(alice.id, 'cover.png')
    const render = article('<p>正文</p><img src="https://example.com/a.png">')
    const download = vi.spyOn(remoteImages, 'downloadWechatImage').mockRejectedValueOnce(new ApiError(400, 'wechat_image_download', '图片读取失败'))
    const input: WechatPublishInput = { renderId: render.id, mode: 'draft', coverMediaId: cover.id }
    const failed = await service.publish(alice.id, input)
    expect(await finished(service, alice.id, failed.id)).toMatchObject({ status: 'failed', message: '图片读取失败' })
    expect(driver.publish).not.toHaveBeenCalled()
    download.mockResolvedValueOnce({ name: 'body.png', mimeType: 'image/png', buffer: Buffer.from('remote-image') })
    const publication = await service.publish(alice.id, input)
    expect((await finished(service, alice.id, publication.id)).status).toBe('draft')
  })

  it('rejects another user’s cover and body images and unsupported embedded video before publication', async () => {
    const { service, driver, alice, bob, seedAccount, image, article } = setup()
    const remoteFetch = vi.spyOn(globalThis, 'fetch')
    seedAccount()
    const cover = image(alice.id, 'cover.png')
    const other = image(bob.id, 'other.png')
    const clean = article()
    await expect(service.publish(alice.id, { renderId: clean.id, mode: 'draft', coverMediaId: other.id })).rejects.toMatchObject({ status: 404 })
    for (const [html, code] of [
      ['<p>正文</p><img src="/uploads/other.png">', 'not_found'],
      ['<p>正文</p><video src="/uploads/video.mp4"></video>', 'wechat_video_unsupported'],
    ]) {
      const render = article(html)
      await expect(service.publish(alice.id, { renderId: render.id, mode: 'publish', coverMediaId: cover.id })).rejects.toMatchObject({ code })
    }
    expect(driver.publish).not.toHaveBeenCalled()
    expect(remoteFetch).not.toHaveBeenCalled()
    expect(service.list(alice.id)).toEqual([])
  })

  it('deduplicates repeated official publication and retains verified article URLs', async () => {
    const { service, driver, database, alice, seedAccount, image, article } = setup()
    seedAccount()
    const cover = image(alice.id, 'cover.png')
    const render = article()
    const input: WechatPublishInput = { renderId: render.id, mode: 'publish', coverMediaId: cover.id }
    const first = await service.publish(alice.id, input)
    expect(await finished(service, alice.id, first.id)).toMatchObject({ status: 'published', url: 'https://mp.weixin.qq.com/s/published' })
    expect((await service.publish(alice.id, input)).id).toBe(first.id)
    const regenerated = database.createRender(alice.id, { contentId: render.contentId, contentTitle: render.contentTitle, platforms: render.platforms, options: render.options, results: render.results })
    expect((await service.publish(alice.id, { ...input, renderId: regenerated.id })).id).toBe(first.id)
    expect(driver.publish).toHaveBeenCalledTimes(1)
  })

  it('allows a manual retry after a definite preparation failure without retrying automatically', async () => {
    const { service, driver, alice, seedAccount, image, article } = setup()
    seedAccount()
    const cover = image(alice.id, 'cover.png')
    const render = article()
    const input: WechatPublishInput = { renderId: render.id, mode: 'publish', coverMediaId: cover.id }
    driver.publish.mockRejectedValueOnce(new ApiError(502, 'wechat_preparation_failed', '上传准备失败，尚未创建草稿'))
    const first = await service.publish(alice.id, input)
    expect(await finished(service, alice.id, first.id)).toMatchObject({ status: 'failed', remoteId: null, url: null })
    expect(driver.publish).toHaveBeenCalledTimes(1)

    const retry = await service.publish(alice.id, input)
    expect(retry.id).toBe(first.id)
    expect(await finished(service, alice.id, retry.id)).toMatchObject({ status: 'published', url: 'https://mp.weixin.qq.com/s/published' })
    expect(driver.publish).toHaveBeenCalledTimes(2)
    expect(service.list(alice.id)).toHaveLength(1)
  })

  it('exposes the security QR while publication is pending and blocks competing account mutations', async () => {
    const { service, driver, alice, bob, seedAccount, image, article } = setup()
    seedAccount()
    const gate = deferred<Awaited<ReturnType<WechatBrowserDriver['publish']>>>()
    driver.publish.mockImplementationOnce(async (_state, _article, _mode, update) => {
      update({ status: 'awaiting_confirmation', message: '请扫码确认发表', qrCode: 'data:image/png;base64,c2FmZQ==' })
      return gate.promise
    })
    const cover = image(alice.id, 'cover.png')
    const render = article()
    try {
      const publication = await service.publish(alice.id, { renderId: render.id, mode: 'publish', coverMediaId: cover.id })
      expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'awaiting_confirmation', qrCode: 'data:image/png;base64,c2FmZQ==' })
      expect(service.list(bob.id)).toEqual([])
      expect(() => service.get(bob.id, publication.id)).toThrow('发布记录不存在')
      await expect(service.disconnect(alice.id)).rejects.toMatchObject({ code: 'wechat_busy' })
      await expect(service.startLogin(alice.id)).rejects.toMatchObject({ code: 'wechat_busy' })
      gate.resolve({ state: session, status: 'published', message: '已发表', remoteId: '123', url: 'https://mp.weixin.qq.com/s/article' })
      expect(await finished(service, alice.id, publication.id)).toMatchObject({ status: 'published', qrCode: null })
    } finally {
      gate.resolve({ state: session, status: 'published', message: '已发表', remoteId: '123', url: 'https://mp.weixin.qq.com/s/article' })
    }
  })

  it.each([
    [new ApiError(502, 'wechat_rejected', '微信拒绝发表'), 'failed'],
    [new Error('socket lost after publish'), 'uncertain'],
  ] as const)('never reports success after a rejected or interrupted publication (%s)', async (error, expectedStatus) => {
    const { service, driver, alice, seedAccount, image, article } = setup()
    seedAccount()
    driver.publish.mockRejectedValueOnce(error)
    const cover = image(alice.id, 'cover.png')
    const render = article()
    const input: WechatPublishInput = { renderId: render.id, mode: 'publish', coverMediaId: cover.id }
    const publication = await service.publish(alice.id, input)
    expect(await finished(service, alice.id, publication.id)).toMatchObject({ status: expectedStatus, url: null })
    if (expectedStatus === 'uncertain') {
      expect((await service.publish(alice.id, input)).id).toBe(publication.id)
      expect(driver.publish).toHaveBeenCalledTimes(1)
    }
  })
})

describe('WeChat API authentication', () => {
  it('requires application authentication and reports an expired WeChat session without logging out the app user', async () => {
    const { config, database, driver, alice, bob, seedAccount } = setup()
    const app = createApp(config, database, driver)
    const apiService = app.locals.wechat as WechatService
    if (apiService) services.push(apiService)
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing port')
    const base = `http://127.0.0.1:${address.port}`
    const headers = { Authorization: `Bearer ${signToken(alice, config.jwtSecret)}` }
    expect((await fetch(`${base}/api/wechat/account`)).status).toBe(401)
    expect((await fetch(`${base}/api/wechat/login`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`${base}/api/wechat/publications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401)
    seedAccount(alice.id, '2020-01-01T00:00:00.000Z')
    driver.checkSession.mockRejectedValueOnce(new ApiError(409, 'wechat_session_expired', '微信登录失效'))
    const status = await fetch(`${base}/api/wechat/account`, { headers })
    expect(status.status).toBe(200)
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect(await status.json()).toEqual({ account: { status: 'expired', name: '测试公众号', checkedAt: expect.any(String) } })
    expect((await fetch(`${base}/api/auth/me`, { headers })).status).toBe(200)
    const loginResponse = await fetch(`${base}/api/wechat/login`, { method: 'POST', headers })
    const login = (await loginResponse.json() as { login: WechatLogin }).login
    const otherHeaders = { Authorization: `Bearer ${signToken(bob, config.jwtSecret)}` }
    expect((await fetch(`${base}/api/wechat/login/${login.id}`, { headers: otherHeaders })).status).toBe(404)
    const invalid = await fetch(`${base}/api/wechat/publications`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ renderId: 'bad-id', coverMediaId: 'bad-id', mode: 'publish' }) })
    expect(invalid.status).toBe(400)
    for (const sourceUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'not a URL']) {
      const rejected = await fetch(`${base}/api/wechat/publications`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ renderId: alice.id, coverMediaId: alice.id, mode: 'draft', sourceUrl }) })
      expect(rejected.status).toBe(400)
    }
  })
})
