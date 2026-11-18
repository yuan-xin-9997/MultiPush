import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { ApiError } from '../src/errors'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey } from '../src/publisher-session'
import { renderPlatforms } from '../src/renderers'
import { DoubanService } from '../src/douban'
import { parseDoubanNoteId, prepareDoubanContent, verifyDoubanContent } from '../src/douban-content'
import {
  parseDoubanIdentity,
  parseDoubanNoteResult,
  parseDoubanUidFromSession,
  parseDoubanUploadUrl,
  type DoubanDriver,
  type DoubanLoginAttempt,
} from '../src/douban-browser'
import type { ContentDetail } from '../../shared/types'

const cleanups: Array<() => Promise<void> | void> = []
const state = { cookies: [{ name: 'dbcl2', value: '123456789:abc', domain: '.douban.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] }
const identity = { accountId: '123456789', name: '豆瓣用户' }
const noteUrl = 'https://www.douban.com/note/987654321/'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII='

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-douban-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' })
  let database: Database = openDatabase(path.join(directory, 'test.sqlite'))
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const attempt = { poll: vi.fn<DoubanLoginAttempt['poll']>().mockResolvedValue({ status: 'waiting', qrCode: null, message: '请扫码' }), close: vi.fn(async () => {}) }
  const driver = {
    beginLogin: vi.fn<DoubanDriver['beginLogin']>().mockResolvedValue(attempt),
    checkSession: vi.fn<DoubanDriver['checkSession']>().mockResolvedValue({ state, identity }),
    checkPublication: vi.fn<DoubanDriver['checkPublication']>().mockResolvedValue({ state, status: 'published', url: noteUrl, message: '已发布' }),
    publish: vi.fn<DoubanDriver['publish']>().mockResolvedValue({ state, status: 'published', remoteId: '987654321', url: noteUrl, message: '豆瓣日记已发布' }),
    close: vi.fn(async () => {}),
  }
  const service = new DoubanService(database, config, driver)
  const key = loadPublisherKey(directory, 'douban')
  database.saveDoubanAccount(alice.id, { ...identity, encryptedSession: encryptPublisherSession(state, key, alice.id), status: 'connected', checkedAt: new Date().toISOString() })
  const article = async (html = '<h2>标题</h2><p>正文内容</p>', title = '豆瓣日记测试文章') => {
    const content: ContentDetail = database.createContent(alice.id, { title, contentHtml: html, contentJson: {}, excerpt: '', bookId: null, coverImage: null, tags: ['读书', '日记'], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const [result] = await renderPlatforms({ content, platforms: ['douban'], options: {}, authorName: 'Alice', baseUrl: 'http://127.0.0.1:34080' })
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['douban'], options: {}, results: [result] })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, config, database, service, alice, bob, driver, attempt, article, key, restart: async () => { await service.close(); database.close(); database = openDatabase(path.join(directory, 'test.sqlite')); return database } }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const finish = async (service: DoubanService, owner: string, id: string) => {
  await vi.waitFor(() => expect(service.get(owner, id).status).not.toBe('running'))
  return service.get(owner, id)
}

describe('Douban publishing', () => {
  it('encrypts the session and binds it to the owner', async () => {
    const { database, alice, bob, key, service } = setup()
    const encrypted = database.getDoubanAccount(alice.id)!.encryptedSession
    expect(decryptPublisherSession(encrypted, key, alice.id)).toEqual(state)
    expect(() => decryptPublisherSession(encrypted, key, bob.id)).toThrow()
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
    expect(JSON.stringify(await service.account(alice.id))).not.toContain('dbcl2')
  })

  it('publishes a saved Douban render and suppresses duplicate submissions', async () => {
    const { service, alice, driver, article } = setup()
    const render = await article(), input = { renderId: render.id }
    const publication = await service.publish(alice.id, input)
    const done = await finish(service, alice.id, publication.id)
    expect(done).toMatchObject({ status: 'published', remoteId: '987654321', url: noteUrl })
    expect(driver.publish.mock.calls[0][1]).toMatchObject({ title: '豆瓣日记测试文章', privacy: 'public', tags: ['读书', '日记'] })
    expect(driver.publish.mock.calls[0][1].html).toContain('正文内容')
    expect((await service.publish(alice.id, input)).id).toBe(publication.id)
    expect(driver.publish).toHaveBeenCalledTimes(1)
  })

  it('saves a local draft without calling the Douban publish driver', async () => {
    const { service, alice, driver, article } = setup()
    const render = await article()
    const publication = await service.publish(alice.id, { renderId: render.id, mode: 'draft' })
    expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'draft', mode: 'draft' })
    expect(driver.publish).not.toHaveBeenCalled()
  })

  it('downloads inline images and passes them to the driver with privacy and tags', async () => {
    const { service, alice, driver, article } = setup()
    const render = await article(`<p>正文</p><figure><img src="data:image/png;base64,${png}" alt="图"><figcaption>图：说明</figcaption></figure>`, '带图日记')
    const publication = await service.publish(alice.id, { renderId: render.id, privacy: 'private', tags: ['#旅行', '摄影'] })
    const done = await finish(service, alice.id, publication.id)
    expect(done.status).toBe('published')
    const sent = driver.publish.mock.calls[0][1]
    expect(sent.privacy).toBe('private')
    expect(sent.tags).toEqual(['旅行', '摄影'])
    expect(sent.images.size).toBe(1)
    expect([...sent.images.values()][0].buffer.length).toBeGreaterThan(0)
  })

  it('rejects cross-user renders and blocks new publishes while a result is uncertain', async () => {
    const { service, alice, bob, driver, article } = setup()
    const render = await article()
    await expect(service.publish(bob.id, { renderId: render.id })).rejects.toMatchObject({ status: 409 })
    driver.publish.mockRejectedValueOnce(new ApiError(502, 'douban_result_uncertain', '结果待核实'))
    const publication = await service.publish(alice.id, { renderId: render.id })
    expect((await finish(service, alice.id, publication.id)).status).toBe('uncertain')
    await expect(service.publish(alice.id, { renderId: render.id })).rejects.toMatchObject({ code: 'douban_result_uncertain' })
    await expect(service.resolve(bob.id, publication.id, { action: 'not_published' })).rejects.toMatchObject({ status: 404 })
    await service.resolve(alice.id, publication.id, { action: 'not_published' })
    expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'failed' })
  })

  it('rejects videos and stale renders before submitting', async () => {
    const { service, database, alice, article } = setup()
    const video = await article('<p>正文</p><video src="/uploads/demo.mp4"></video>')
    await expect(service.publish(alice.id, { renderId: video.id })).rejects.toMatchObject({ code: 'douban_media_unsupported' })
    const clean = await article()
    const original = database.getRender(alice.id, clean.id)!.results[0]
    database.saveRenderDraft(alice.id, clean.id, { ...original, sourceUpdatedAt: 'old' })
    await expect(service.publish(alice.id, { renderId: clean.id })).rejects.toMatchObject({ code: 'douban_render_stale' })
  })

  it('marks interrupted jobs uncertain after restart', async () => {
    const { database, alice, article, restart } = setup()
    const render = await article()
    const job = database.createDoubanPublication(alice.id, { renderId: render.id, title: '测试', mode: 'publish', idempotencyKey: 'interrupted' })
    const reopened = await restart()
    expect(reopened.getDoubanPublication(alice.id, job.id)?.status).toBe('uncertain')
  })
})

describe('Douban content preparation', () => {
  it('strips editor styles/classes and keeps safe article structure', () => {
    const html = '<h1 style="color:red" class="x">标题</h1><p style="color:red" onclick="bad()">正文</p><figure><img src="/uploads/a.png" data-x="1"><figcaption>图：说明</figcaption></figure><script>bad()</script><a href="javascript:alert(1)">x</a>'
    const prepared = prepareDoubanContent(html)
    expect(prepared).toContain('<h2>标题</h2>')
    expect(prepared).toContain('<p>正文</p>')
    expect(prepared).toContain('<figure><img src="/uploads/a.png" alt=""><figcaption>图：说明</figcaption></figure>')
    expect(prepared).not.toContain('<script')
    expect(prepared).not.toContain('onclick')
    expect(prepared).not.toContain('javascript:')
  })

  it('compares text, images, links and heading structure for readback', () => {
    const html = '<h2>标题</h2><p>正文</p><figure><img src="/uploads/a.png"><figcaption>图：说明</figcaption></figure>'
    expect(() => verifyDoubanContent(html, html)).not.toThrow()
    expect(() => verifyDoubanContent(html, '<h2>标题</h2><p>正文变了</p>')).toThrow('停止发布')
  })
})

describe('Douban parsing', () => {
  it('parses the web session uid, profile name and note links', () => {
    expect(parseDoubanUidFromSession('123456789:abc')).toBe('123456789')
    expect(parseDoubanUidFromSession('"123456789:abc"')).toBe('123456789')
    expect(parseDoubanUidFromSession('abc')).toBeNull()
    expect(parseDoubanIdentity('<meta property="og:title" content="小林 - 豆瓣">', '123')).toEqual({ accountId: '123', name: '小林' })
    expect(parseDoubanIdentity('<title>豆瓣</title>', '123')).toEqual({ accountId: '123', name: '豆瓣用户' })
    expect(parseDoubanNoteResult({ id: '987654321' })).toEqual({ remoteId: '987654321', url: noteUrl })
    expect(parseDoubanNoteResult({ data: { note_id: '987654321' } })).toEqual({ remoteId: '987654321', url: noteUrl })
    expect(parseDoubanNoteResult('https://www.douban.com/note/987654321/')).toEqual({ remoteId: '987654321', url: noteUrl })
    expect(parseDoubanNoteResult({ r: 1 })).toBeNull()
    expect(parseDoubanUploadUrl({ url: 'https://img1.doubanio.com/view/note/large/public/p1.jpg' })).toBe('https://img1.doubanio.com/view/note/large/public/p1.jpg')
    expect(parseDoubanUploadUrl({ data: { src: '/view/note/large/public/p1.jpg' } })).toBeNull()
    expect(parseDoubanNoteId('https://www.douban.com/note/987654321/')).toBe('987654321')
    expect(parseDoubanNoteId('https://evil.example/note/987654321/')).toBeNull()
  })
})
