import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { ApiError } from '../src/errors'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey } from '../src/publisher-session'
import { renderPlatforms } from '../src/renderers'
import * as publisherImageModule from '../src/publisher-image'
import { BaijiahaoService, parseBaijiahaoPublishedId } from '../src/baijiahao'
import { parseBaijiahaoProfile, parseBaijiahaoProfileIssue, parseBaijiahaoPublished, type BaijiahaoDriver, type BaijiahaoLoginAttempt } from '../src/baijiahao-browser'
import type { ContentDetail } from '../../shared/types'

const cleanups: Array<() => Promise<void> | void> = []
const state = { cookies: [{ name: 'BDUSS', value: 'baijiahao-session', domain: '.baidu.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] }
const identity = { accountId: '1234567890123', name: '头条作者' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-toutiao-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' })
  let database: Database = openDatabase(path.join(directory, 'test.sqlite'))
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const attempt = { poll: vi.fn<BaijiahaoLoginAttempt['poll']>().mockResolvedValue({ status: 'waiting', qrCode: null, message: '请扫码' }), close: vi.fn(async () => {}) }
  const driver = {
    beginLogin: vi.fn<BaijiahaoDriver['beginLogin']>().mockResolvedValue(attempt),
    checkSession: vi.fn<BaijiahaoDriver['checkSession']>().mockResolvedValue({ state, identity }),
    checkPublication: vi.fn<BaijiahaoDriver['checkPublication']>().mockResolvedValue({ state, status: 'published', url: 'https://baijiahao.baidu.com/s?id=5000000000000001', message: '已发布' }),
    publish: vi.fn<BaijiahaoDriver['publish']>().mockImplementation(async (_state, article) => article.mode === 'draft'
      ? { state, status: 'draft' as const, remoteId: '', url: 'https://baijiahao.baidu.com/builder/rc/edit?type=news', message: '草稿已保存' }
      : { state, status: 'published' as const, remoteId: '5000000000000001', url: 'https://baijiahao.baidu.com/s?id=5000000000000001', message: '百家号文章已发布' }),
    close: vi.fn(async () => {}),
  }
  const service = new BaijiahaoService(database, config, driver)
  const key = loadPublisherKey(directory, 'baijiahao')
  database.saveBaijiahaoAccount(alice.id, { ...identity, encryptedSession: encryptPublisherSession(state, key, alice.id), status: 'connected', checkedAt: new Date().toISOString() })
  const media = (filename: string, user = alice.id, mimeType = 'image/png', buffer = png) => {
    writeFileSync(path.join(config.uploadsDir, filename), buffer)
    return database.createMedia(user, { filename, originalName: filename, kind: 'image', mimeType, size: buffer.length })
  }
  const article = async (html = '<h2>标题</h2><p>正文内容</p>', title = '百家号测试文章', coverImage: string | null = null) => {
    const content: ContentDetail = database.createContent(alice.id, { title, contentHtml: html, contentJson: {}, excerpt: '', bookId: null, coverImage, tags: ['效率', '工具'], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const [result] = await renderPlatforms({ content, platforms: ['baijiahao'], options: {}, authorName: 'Alice', baseUrl: 'http://127.0.0.1:34080' })
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['baijiahao'], options: {}, results: [result] })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, config, database, service, alice, bob, driver, attempt, article, media, key, restart: async () => { await service.close(); database.close(); database = openDatabase(path.join(directory, 'test.sqlite')); return database } }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const finish = async (service: BaijiahaoService, owner: string, id: string) => {
  await vi.waitFor(() => expect(service.get(owner, id).status).not.toBe('running'))
  return service.get(owner, id)
}

describe('Baijiahao publishing', () => {
  it('encrypts the session and binds it to the owner', async () => {
    const { database, alice, bob, key, service } = setup()
    const encrypted = database.getBaijiahaoAccount(alice.id)!.encryptedSession
    expect(decryptPublisherSession(encrypted, key, alice.id)).toEqual(state)
    expect(() => decryptPublisherSession(encrypted, key, bob.id)).toThrow()
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
    expect(JSON.stringify(await service.account(alice.id))).not.toContain('baijiahao-session')
  })

  it('publishes a saved Toutiao render and suppresses duplicate submissions', async () => {
    const { service, alice, driver, article, media } = setup()
    media('cover.png')
    const render = await article('<h2>标题</h2><p>正文内容</p>', '百家号测试文章', '/uploads/cover.png')
    const input = { renderId: render.id }
    const publication = await service.publish(alice.id, input, 'http://127.0.0.1:34080')
    const done = await finish(service, alice.id, publication.id)
    expect(done).toMatchObject({ status: 'published', remoteId: '5000000000000001', url: 'https://baijiahao.baidu.com/s?id=5000000000000001' })
    expect(driver.publish.mock.calls[0][1]).toMatchObject({ title: '百家号测试文章' })
    expect(driver.publish.mock.calls[0][1].html).toContain('正文内容')
    expect(driver.publish.mock.calls[0][1].cover?.buffer).toEqual(png)
    expect(driver.publish.mock.calls[0][1].images.size).toBe(0)
    expect((await service.publish(alice.id, input, 'http://127.0.0.1:34080')).id).toBe(publication.id)
    expect(driver.publish).toHaveBeenCalledTimes(1)
  })

  it('creates a baijiahao draft without publishing and without a cover', async () => {
    const { service, alice, driver, article } = setup()
    const render = await article()
    const publication = await service.publish(alice.id, { renderId: render.id, mode: 'draft' }, 'http://127.0.0.1:34080')
    expect(await finish(service, alice.id, publication.id)).toMatchObject({ status: 'draft', url: 'https://baijiahao.baidu.com/builder/rc/edit?type=news' })
    expect(driver.publish.mock.calls[0][1]).toMatchObject({ mode: 'draft' })
    expect(driver.publish.mock.calls[0][1].cover).toBeNull()
  })

  it('collects body images in document order, deduplicates and downloads external ones', async () => {
    const { service, alice, driver, article, media } = setup()
    media('body.png')
    const download = vi.spyOn(publisherImageModule, 'downloadPublisherImage').mockResolvedValue({ name: 'remote.png', mimeType: 'image/png', buffer: png })
    const render = await article('<p>开头</p><figure><img src="https://publish.yuan-xin.top/uploads/a.jpg" alt="一"></figure><p><img src="/uploads/body.png" alt="二"></p><figure><img src="https://publish.yuan-xin.top/uploads/a.jpg"></figure><p><img src="data:image/png;base64,AAAABBBB" alt="三"></p>')
    // publish mode exercises the cover fallback too: no content cover, so the
    // first body image becomes the cover file.
    const publication = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    expect(await finish(service, alice.id, publication.id)).toMatchObject({ status: 'published' })
    const submitted = driver.publish.mock.calls[0][1]
    expect(submitted.images.size).toBe(3)
    const keys = [...submitted.images.keys()]
    expect(keys[0]).toBe('https://publish.yuan-xin.top/uploads/a.jpg')
    expect(keys[1]).toBe('http://127.0.0.1:34080/uploads/body.png')
    expect(keys[2]).toMatch(/^data:image\/png;base64,/)
    expect(submitted.images.get('http://127.0.0.1:34080/uploads/body.png')?.buffer).toEqual(png)
    // cover falls back to the first body image, which downloads before the upload
    expect(download).toHaveBeenCalledTimes(2)
    expect(submitted.cover?.buffer).toEqual(png)
    // the same render again reuses the record without a second driver call
    expect((await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')).id).toBe(publication.id)
    expect(driver.publish).toHaveBeenCalledTimes(1)
  })

  it('rejects publishing without any usable cover', async () => {
    const { service, alice, article, driver } = setup()
    const render = await article('<h2>标题</h2><p>正文内容</p>')
    await expect(service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'baijiahao_cover_required' })
    expect(driver.publish).not.toHaveBeenCalled()
  })

  it('rejects oversized covers and unsupported image types', async () => {
    const { service, alice, article, media } = setup()
    // Valid PNG magic bytes followed by 6 MB of filler: passes the type check,
    // then fails the 5 MB cover limit enforced by the Baijiahao cover dialog.
    const oversized = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(6 * 1024 * 1024)])
    const big = media('big.png', alice.id, 'image/png', oversized)
    const render = await article('<h2>标题</h2><p>正文内容</p>', '百家号测试文章', `/uploads/${big.filename}`)
    await expect(service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'baijiahao_cover_size' })
    media('cover.png')
    const webp = media('photo.webp', alice.id, 'image/webp', png)
    const body = await article('<p>正文文字</p><p><img src="/uploads/photo.webp"></p>', '百家号测试文章', '/uploads/cover.png')
    await expect(service.publish(alice.id, { renderId: body.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'baijiahao_image_invalid' })
    expect(webp.filename).toBe('photo.webp')
  })

  it('rejects cross-user renders and blocks new publishes while a result is uncertain', async () => {
    const { service, alice, bob, driver, article, media } = setup()
    media('cover.png')
    const render = await article('<h2>标题</h2><p>正文内容</p>', '百家号测试文章', '/uploads/cover.png')
    await expect(service.publish(bob.id, { renderId: render.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ status: 409 })
    driver.publish.mockRejectedValueOnce(new ApiError(409, 'baijiahao_result_uncertain', '结果待核实'))
    const publication = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    expect((await finish(service, alice.id, publication.id)).status).toBe('uncertain')
    await expect(service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'baijiahao_result_uncertain' })
    await expect(service.resolve(bob.id, publication.id, { action: 'not_published' })).rejects.toMatchObject({ status: 404 })
    await service.resolve(alice.id, publication.id, { action: 'not_published' })
    expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'failed' })
  })

  it('rejects videos, short titles and stale renders before submitting', async () => {
    const { service, database, alice, article, media } = setup()
    media('cover.png')
    const video = await article('<p>正文</p><video src="/uploads/demo.mp4"></video>', '百家号测试文章', '/uploads/cover.png')
    await expect(service.publish(alice.id, { renderId: video.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'baijiahao_media_unsupported' })
    const short = await article('<p>正文</p>', '短', '/uploads/cover.png')
    await expect(service.publish(alice.id, { renderId: short.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'baijiahao_title_invalid' })
    const clean = await article('<h2>标题</h2><p>正文内容</p>', '百家号测试文章', '/uploads/cover.png')
    const original = database.getRender(alice.id, clean.id)!.results[0]
    database.saveRenderDraft(alice.id, clean.id, { ...original, sourceUpdatedAt: 'old' })
    await expect(service.publish(alice.id, { renderId: clean.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'baijiahao_render_stale' })
  })

  it('marks interrupted jobs uncertain after restart', async () => {
    const { database, alice, article, restart } = setup()
    const render = await article()
    const job = database.createBaijiahaoPublication(alice.id, { renderId: render.id, title: '测试', mode: 'publish', idempotencyKey: 'interrupted' })
    const reopened = await restart()
    expect(reopened.getBaijiahaoPublication(alice.id, job.id)?.status).toBe('uncertain')
  })
})

describe('Baijiahao parsing', () => {
  it('parses the account, article ids and public links', () => {
    expect(parseBaijiahaoProfile({ errno: 0, data: { userid: '123', uname: '作者' } })).toEqual({ accountId: '123', name: '作者' })
    expect(parseBaijiahaoProfile({ errno: 0, data: { user_id: 42, name: '作者' } })).toEqual({ accountId: '42', name: '作者' })
    expect(parseBaijiahaoProfile({ errno: 217100002, data: null })).toBeNull()
    expect(parseBaijiahaoProfile({ errno: 0, data: {} })).toBeNull()
    expect(parseBaijiahaoProfile({ errno: 0, data: { uk: '123', name: '作者' } })).toEqual({ accountId: '123', name: '作者' })
    expect(parseBaijiahaoProfileIssue({ errno: 20040000, errmsg: '当前用户未绑定百家号', data: { name: '百度用户', have_account: 0 } })).toContain('尚未开通百家号')
    expect(parseBaijiahaoProfileIssue({ errno: 0, data: { uk: '123' } })).toBeNull()
    expect(parseBaijiahaoPublished({ errno: 0, data: { id: '5000000000000001' } })).toEqual({ remoteId: '5000000000000001', url: 'https://baijiahao.baidu.com/s?id=5000000000000001' })
    expect(parseBaijiahaoPublished({ errno: 0, data: { url: 'https://baijiahao.baidu.com/s?id=5000000000000001&wfr=x' } })).toEqual({ remoteId: '5000000000000001', url: 'https://baijiahao.baidu.com/s?id=5000000000000001' })
    expect(parseBaijiahaoPublished({ errno: 20040001 })).toBeNull()
    expect(parseBaijiahaoPublishedId('https://baijiahao.baidu.com/s?id=5000000000000001')).toBe('5000000000000001')
    expect(parseBaijiahaoPublishedId('https://baijiahao.baidu.com/s?id=5000000000000001&wfr=spider')).toBe('5000000000000001')
    expect(parseBaijiahaoPublishedId('https://evil.example/s?id=5000000000000001')).toBeNull()
  })
})
