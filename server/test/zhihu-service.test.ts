import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { load } from 'cheerio'
import { openDatabase, type Database } from '../src/db'
import { loadConfig } from '../src/config'
import { ZhihuService } from '../src/zhihu'
import type { ZhihuDriver, ZhihuLoginAttempt } from '../src/zhihu-browser'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey } from '../src/publisher-session'
import * as images from '../src/publisher-image'
import { ApiError } from '../src/errors'
import { createApp } from '../src/app'
import { signToken } from '../src/auth'
import type { PlatformRender } from '../../shared/types'

const directories: string[] = [], databases: Database[] = [], services: ZhihuService[] = [], servers: Server[] = []
const session = { cookies: [{ name: 'z_c0', value: 'secret-zhihu-cookie', domain: '.zhihu.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] }
const identity = { accountId: 'zhihu-account', name: '知乎作者' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')

function setup(persistent = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-zhihu-')); directories.push(directory)
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test', jwtSecret: 'zhihu-test-secret' })
  const database = openDatabase(persistent ? path.join(directory, 'test.sqlite') : ':memory:'); databases.push(database)
  const alice = database.createUser({ username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const poll = vi.fn<ZhihuLoginAttempt['poll']>().mockResolvedValue({ status: 'waiting', qrCode: 'data:image/png;base64,dGVzdA==', message: '请扫码' })
  const attempt = { poll, close: vi.fn(async () => {}) }
  const driver = {
    beginLogin: vi.fn<ZhihuDriver['beginLogin']>().mockResolvedValue(attempt),
    checkSession: vi.fn<ZhihuDriver['checkSession']>().mockResolvedValue({ state: session, identity }),
    publish: vi.fn<ZhihuDriver['publish']>().mockImplementation(async (_state, _article, mode) => ({ state: session, status: mode === 'draft' ? 'draft' : 'published', remoteId: '123', url: `https://zhuanlan.zhihu.com/p/123${mode === 'draft' ? '/edit' : ''}`, message: '完成' })),
    close: vi.fn(async () => {}),
  }
  const service = new ZhihuService(database, config, driver); services.push(service)
  const seed = (userId = alice.id, checkedAt = new Date().toISOString()) => database.saveZhihuAccount(userId, { ...identity, encryptedSession: encryptPublisherSession(session, loadPublisherKey(directory, 'zhihu'), userId), status: 'connected', checkedAt })
  const image = (userId = alice.id, filename = 'body.png') => {
    writeFileSync(path.join(config.uploadsDir, filename), png)
    return database.createMedia(userId, { filename, originalName: filename, kind: 'image', mimeType: 'image/png', size: png.length })
  }
  const article = (html = '<h2>标题</h2><p>正文</p>') => {
    const content = database.createContent(alice.id, { title: '原文标题', contentHtml: html, contentJson: {}, excerpt: '', bookId: null, coverImage: null, tags: [], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const result: PlatformRender = { platform: 'zhihu', title: content.title, html, markdown: null, text: '正文', previewMode: 'article', themeColor: '#1772f6', meta: { wordCount: 4, imageCount: 0, videoCount: 0, readMinutes: 1, tags: [], titleLength: 4, summary: '' }, cards: [], assets: [], videos: [], warnings: [], downloads: [], generatedAt: content.updatedAt, sourceUpdatedAt: content.updatedAt }
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['zhihu'], results: [result], options: {} })
  }
  return { directory, config, database, alice, bob, service, driver, attempt, seed, image, article }
}

async function finished(service: ZhihuService, userId: string, id: string) { await vi.waitFor(() => expect(service.get(userId, id).status).not.toBe('running')); return service.get(userId, id) }
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const service of services.splice(0)) await service.close()
  for (const database of databases.splice(0)) { try { database.close() } catch { /* already reopened */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Zhihu account lifecycle and publishing', () => {
  it('binds encrypted sessions to owner and platform, and persists them across restarts', async () => {
    const { directory, config, database, alice, service, driver, seed } = setup(true)
    seed()
    const encrypted = database.getZhihuAccount(alice.id)!.encryptedSession
    expect(Buffer.from(encrypted, 'base64').toString()).not.toContain('secret-zhihu-cookie')
    const key = loadPublisherKey(directory, 'zhihu')
    expect(() => decryptPublisherSession(encrypted, key, 'another-user')).toThrow()
    expect(() => decryptPublisherSession(encrypted, loadPublisherKey(directory, 'wechat'), alice.id)).toThrow()
    expect(() => decryptPublisherSession(encrypted, randomBytes(32), alice.id)).toThrow()
    await service.close(); database.close()
    const reopened = openDatabase(path.join(directory, 'test.sqlite')); databases.push(reopened)
    const restored = new ZhihuService(reopened, config, driver); services.push(restored)
    expect(await restored.account(alice.id)).toMatchObject({ status: 'connected', name: identity.name })
    expect(decryptPublisherSession(reopened.getZhihuAccount(alice.id)!.encryptedSession, loadPublisherKey(directory, 'zhihu'), alice.id)).toEqual(session)
  })

  it('isolates login polling and only saves confirmed identities', async () => {
    const { service, database, alice, bob, attempt } = setup()
    const login = await service.startLogin(alice.id)
    expect(database.getZhihuAccount(alice.id)).toBeNull()
    await expect(service.pollLogin(bob.id, login.id)).rejects.toMatchObject({ status: 404 })
    attempt.poll.mockResolvedValue({ status: 'connected', qrCode: null, message: '完成', state: session, identity })
    await vi.waitFor(async () => { expect(await service.pollLogin(alice.id, login.id)).toMatchObject({ status: 'connected', qrCode: null }) })
    expect(JSON.stringify(await service.account(alice.id))).not.toContain('secret-zhihu-cookie')
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
    await service.disconnect(alice.id)
    expect(database.getZhihuAccount(alice.id)).toBeNull()
  })

  it('handles expired credentials as a platform 409 without logging the user out of MultiPush', async () => {
    const { service, driver, alice, seed, article } = setup()
    seed(); const render = article()
    driver.checkSession.mockRejectedValue(new ApiError(409, 'zhihu_session_expired', '请重新登录知乎'))
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'draft' })).rejects.toMatchObject({ status: 409 })
    expect(await service.account(alice.id)).toMatchObject({ status: 'expired' })
  })

  it('returns immediately while QR preparation and browser polling run in the background', async () => {
    const { service, driver, attempt, alice } = setup()
    let open!: (value: ZhihuLoginAttempt) => void
    let scan!: (value: Awaited<ReturnType<ZhihuLoginAttempt['poll']>>) => void
    driver.beginLogin.mockReturnValueOnce(new Promise(resolve => { open = resolve }))
    attempt.poll.mockReturnValueOnce(new Promise(resolve => { scan = resolve }))
    try {
      const login = await service.startLogin(alice.id)
      expect(login).toMatchObject({ status: 'waiting', qrCode: null })
      expect((await service.startLogin(alice.id)).id).toBe(login.id)
      expect(driver.beginLogin).toHaveBeenCalledTimes(1)
      open(attempt)
      await vi.waitFor(() => expect(attempt.poll).toHaveBeenCalledTimes(1))
      expect(await service.pollLogin(alice.id, login.id)).toMatchObject({ status: 'waiting', qrCode: null })
      scan({ status: 'waiting', qrCode: 'data:image/png;base64,dGVzdA==', message: '请扫码' })
      await vi.waitFor(async () => { expect((await service.pollLogin(alice.id, login.id)).qrCode).toBe('data:image/png;base64,dGVzdA==') })
    } finally { open(attempt); scan({ status: 'expired', qrCode: null, message: '测试结束' }) }
  })

  it('closes a late login attempt after cancellation without restoring credentials', async () => {
    const { service, database, driver, attempt, alice } = setup()
    let open!: (value: ZhihuLoginAttempt) => void
    driver.beginLogin.mockReturnValueOnce(new Promise(resolve => { open = resolve }))
    try {
      const login = await service.startLogin(alice.id)
      await service.disconnect(alice.id)
      open(attempt)
      await vi.waitFor(() => expect(attempt.close).toHaveBeenCalled())
      expect(attempt.poll).not.toHaveBeenCalled()
      expect(database.getZhihuAccount(alice.id)).toBeNull()
      await expect(service.pollLogin(alice.id, login.id)).rejects.toMatchObject({ status: 404 })
    } finally { open(attempt) }
  })

  it('reports background initialization errors without exposing raw browser errors', async () => {
    const { service, driver, alice } = setup()
    driver.beginLogin.mockRejectedValueOnce(new Error('secret-cookie in browser failure'))
    const login = await service.startLogin(alice.id)
    await vi.waitFor(async () => {
      expect(await service.pollLogin(alice.id, login.id)).toMatchObject({ status: 'failed', qrCode: null, message: expect.not.stringContaining('secret-cookie') })
    })
  })

  it('prepares saved adjustments, native captions and lists, owner images and deduplicated external images', async () => {
    const { service, database, driver, alice, seed, image, article } = setup()
    seed(); image()
    const download = vi.spyOn(images, 'downloadPublisherImage').mockResolvedValue({ name: 'remote.png', mimeType: 'image/png', buffer: png })
    const render = article()
    database.saveRenderDraft(alice.id, render.id, { ...render.results[0], title: '调整后标题', html: '<p><img src="/uploads/body.png"></p><p><br></p><p>图 1：说明</p><ul>\n<li><a href="https://github.com/org/repo">源码</a></li>\n<li><br></li>\n</ul><p><img src="https://external.test/a.png"></p><p><img src="https://external.test/a.png"></p>' })
    const input = { renderId: render.id, mode: 'draft' as const }
    const publication = await service.publish(alice.id, input)
    expect(await finished(service, alice.id, publication.id)).toMatchObject({ status: 'draft' })
    const submitted = driver.publish.mock.calls[0][1], $ = load(submitted.html)
    expect(submitted.title).toBe('调整后标题')
    expect($('figure > figcaption').text()).toBe('图 1：说明')
    expect($('li').length).toBe(1)
    expect(submitted.images.get('/uploads/body.png')?.buffer).toEqual(png)
    expect(download).toHaveBeenCalledExactlyOnceWith('https://external.test/a.png', 'zhihu')
    expect((await service.publish(alice.id, input)).id).toBe(publication.id)
    expect(driver.publish).toHaveBeenCalledTimes(1)
    const formal = await service.publish(alice.id, { ...input, mode: 'publish' })
    expect(formal.id).not.toBe(publication.id)
    await finished(service, alice.id, formal.id)
  })

  it('does not access another user’s media or obsolete/deleted content', async () => {
    const { service, database, driver, alice, bob, seed, image, article } = setup()
    seed(); const foreign = image(bob.id, 'foreign.png'), render = article()
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'draft', coverMediaId: foreign.id })).rejects.toMatchObject({ status: 404 })
    database.saveRenderDraft(alice.id, render.id, { ...render.results[0], sourceUpdatedAt: 'old' })
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'draft' })).rejects.toMatchObject({ code: 'zhihu_render_stale' })
    expect(driver.publish).not.toHaveBeenCalled()
  })

  it('never retries uncertain writes or known remote drafts automatically', async () => {
    const { service, driver, alice, seed, article } = setup()
    seed(); const render = article(), input = { renderId: render.id, mode: 'publish' as const }
    driver.publish.mockImplementationOnce(async (_state, _article, _mode, progress) => { progress({ remoteId: '123', url: 'https://zhuanlan.zhihu.com/p/123/edit' }); throw new ApiError(502, 'zhihu_result_uncertain', '请核对知乎后台') })
    const publication = await service.publish(alice.id, input)
    expect(await finished(service, alice.id, publication.id)).toMatchObject({ status: 'uncertain', remoteId: '123' })
    expect((await service.publish(alice.id, input)).id).toBe(publication.id)
    expect(driver.publish).toHaveBeenCalledTimes(1)
  })

  it('reuses a failed pre-publication draft when the user explicitly retries', async () => {
    const { service, driver, alice, seed, article } = setup()
    seed(); const render = article(), input = { renderId: render.id, mode: 'publish' as const }
    driver.publish.mockImplementationOnce(async (_state, _article, _mode, progress) => { progress({ remoteId: '123', url: 'https://zhuanlan.zhihu.com/p/123/edit' }); throw new ApiError(502, 'zhihu_rejected', '核对草稿失败') })
    const first = await service.publish(alice.id, input)
    expect(await finished(service, alice.id, first.id)).toMatchObject({ status: 'failed', remoteId: '123' })
    expect(driver.publish).toHaveBeenCalledTimes(1)
    const retry = await service.publish(alice.id, input)
    expect(retry.id).toBe(first.id)
    expect(await finished(service, alice.id, retry.id)).toMatchObject({ status: 'published' })
    expect(driver.publish.mock.calls[1][4]).toBe('123')
  })

  it('marks interrupted jobs uncertain after restart without replaying them', () => {
    const { database, directory, alice } = setup(true)
    const publication = database.createZhihuPublication(alice.id, { renderId: 'render-id', title: '标题', mode: 'publish', idempotencyKey: 'key' })
    database.close()
    const reopened = openDatabase(path.join(directory, 'test.sqlite')); databases.push(reopened)
    expect(reopened.getZhihuPublication(alice.id, publication.id)).toMatchObject({ status: 'uncertain' })
  })

  it('authenticates API access, validates inputs, isolates records and keeps responses credential-free', async () => {
    const { database, config, driver, alice, bob } = setup()
    const app = createApp(config, database, undefined, driver); services.push(app.locals.zhihu)
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, headers = { Authorization: `Bearer ${signToken(alice, config.jwtSecret)}` }
    expect((await fetch(`${base}/api/zhihu/account`)).status).toBe(401)
    const account = await fetch(`${base}/api/zhihu/account`, { headers })
    expect(account.headers.get('cache-control')).toBe('no-store')
    expect(await account.json()).toEqual({ account: { status: 'disconnected', name: null, checkedAt: null } })
    expect((await fetch(`${base}/api/zhihu/publications`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ renderId: alice.id, mode: 'wrong' }) })).status).toBe(400)
    const publication = database.createZhihuPublication(alice.id, { renderId: 'render', title: '标题', mode: 'draft', idempotencyKey: 'key' })
    expect((await fetch(`${base}/api/zhihu/publications/${publication.id}`, { headers: { Authorization: `Bearer ${signToken(bob, config.jwtSecret)}` } })).status).toBe(404)
  })
})
