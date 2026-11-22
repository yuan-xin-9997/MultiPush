import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { ApiError } from '../src/errors'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey } from '../src/publisher-session'
import { renderPlatforms } from '../src/renderers'
import { WeiboService, parseWeiboPublishedId } from '../src/weibo'
import { parseWeiboProfile, parseWeiboPublished, parseWeiboStatus, type WeiboDriver, type WeiboLoginAttempt } from '../src/weibo-browser'
import type { ContentDetail, PlatformRender } from '../../shared/types'

const cleanups: Array<() => Promise<void> | void> = []
const state = { cookies: [{ name: 'SUB', value: 'weibo-session', domain: '.weibo.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] }
const identity = { accountId: '1234567890', name: '微博作者' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-weibo-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' })
  let database: Database = openDatabase(path.join(directory, 'test.sqlite'))
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const attempt = { poll: vi.fn<WeiboLoginAttempt['poll']>().mockResolvedValue({ status: 'waiting', qrCode: null, message: '请扫码' }), close: vi.fn(async () => {}) }
  const driver = {
    beginLogin: vi.fn<WeiboDriver['beginLogin']>().mockResolvedValue(attempt),
    checkSession: vi.fn<WeiboDriver['checkSession']>().mockResolvedValue({ state, identity }),
    checkPublication: vi.fn<WeiboDriver['checkPublication']>().mockResolvedValue({ state, status: 'published', url: 'https://m.weibo.cn/detail/5000000000000001', message: '已发布' }),
    publish: vi.fn<WeiboDriver['publish']>().mockResolvedValue({ state, status: 'published', remoteId: '5000000000000001', url: 'https://weibo.com/1234567890/5000000000000001', message: '微博已发布' }),
    close: vi.fn(async () => {}),
  }
  const service = new WeiboService(database, config, driver)
  const key = loadPublisherKey(directory, 'weibo')
  database.saveWeiboAccount(alice.id, { ...identity, encryptedSession: encryptPublisherSession(state, key, alice.id), status: 'connected', checkedAt: new Date().toISOString() })
  const image = (userId = alice.id) => {
    writeFileSync(path.join(config.uploadsDir, 'body.png'), png)
    return database.createMedia(userId, { filename: 'body.png', originalName: 'body.png', kind: 'image', mimeType: 'image/png', size: png.length })
  }
  const article = async (html = '<p>正文内容</p><p><img src="/uploads/body.png"></p>') => {
    const content: ContentDetail = database.createContent(alice.id, { title: '微博测试文章', contentHtml: html, contentJson: {}, excerpt: '', bookId: null, coverImage: null, tags: ['效率', '工具'], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const [result] = await renderPlatforms({ content, platforms: ['weibo'], options: {}, authorName: 'Alice', baseUrl: 'http://127.0.0.1:34080' })
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['weibo'], options: {}, results: [result] })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, config, database, service, alice, bob, driver, attempt, image, article, key, restart: async () => { await service.close(); database.close(); database = openDatabase(path.join(directory, 'test.sqlite')); return database } }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const finish = async (service: WeiboService, owner: string, id: string) => {
  await vi.waitFor(() => expect(service.get(owner, id).status).not.toBe('running'))
  return service.get(owner, id)
}

describe('Weibo rendering', () => {
  it('renders a caption with title, body, #topic# tags and 9-image warning', async () => {
    const { database, alice, article } = setup()
    const render = await article('<p>第一段</p><p><img src="/uploads/body.png"></p>')
    const result = database.getRender(alice.id, render.id)!.results[0]
    expect(result.platform).toBe('weibo')
    expect(result.previewMode).toBe('vertical')
    expect(result.captionBody).toBe('第一段')
    expect(result.text).toContain('#效率#')
    expect(result.text).toContain('#工具#')
    expect(result.downloads.map(item => item.kind)).toEqual(['text', 'html', 'json'])
    expect(result.assets).toHaveLength(1)
  })
})

describe('Weibo publishing', () => {
  it('encrypts the session and binds it to the owner', async () => {
    const { database, alice, bob, key, service } = setup()
    const encrypted = database.getWeiboAccount(alice.id)!.encryptedSession
    expect(decryptPublisherSession(encrypted, key, alice.id)).toEqual(state)
    expect(() => decryptPublisherSession(encrypted, key, bob.id)).toThrow()
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
    expect(JSON.stringify(await service.account(alice.id))).not.toContain('weibo-session')
  })

  it('publishes a saved Weibo render and suppresses duplicate submissions', async () => {
    const { service, alice, driver, image, article } = setup()
    image()
    const render = await article(), input = { renderId: render.id }
    const publication = await service.publish(alice.id, input, 'http://127.0.0.1:34080')
    const done = await finish(service, alice.id, publication.id)
    expect(done).toMatchObject({ status: 'published', remoteId: '5000000000000001', url: 'https://weibo.com/1234567890/5000000000000001' })
    expect(driver.publish.mock.calls[0][1].text).toContain('#效率#')
    expect(driver.publish.mock.calls[0][1].images).toHaveLength(1)
    expect((await service.publish(alice.id, input, 'http://127.0.0.1:34080')).id).toBe(publication.id)
    expect(driver.publish).toHaveBeenCalledTimes(1)
  })

  it('publishes long content as a thread and stores per-segment results', async () => {
    const { service, database, alice, driver, article } = setup()
    const paragraphs = Array.from({ length: 40 }, (_, index) => `<p>第 ${index + 1} 段：${'这是一段较长的微博正文内容。'.repeat(8)}</p>`).join('')
    const render = await article(paragraphs)
    const result = database.getRender(alice.id, render.id)!.results[0]
    expect(result.thread!.length).toBeGreaterThan(1)
    const parts = result.thread!.map((_, index) => ({
      index,
      status: 'published' as const,
      remoteId: `5000000000000${String(index).padStart(2, '0')}`,
      url: 'https://weibo.com/1234567890/500000000000001',
      message: '已发布',
    }))
    driver.publish.mockResolvedValueOnce({
      state,
      status: 'published',
      remoteId: '500000000000001',
      url: 'https://weibo.com/1234567890/500000000000001',
      message: `微博串已发布（${parts.length} 条）`,
      thread: parts,
    })
    const publication = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    const done = await finish(service, alice.id, publication.id)
    expect(driver.publish.mock.calls[0][1].thread).toHaveLength(result.thread!.length)
    expect(done.status).toBe('published')
    expect(done.thread).toHaveLength(parts.length)
    expect(done.thread![1]).toMatchObject({ index: 1, status: 'published' })
  })

  it('saves a local draft without calling the Weibo driver', async () => {
    const { service, alice, driver, image, article } = setup()
    image()
    const render = await article()
    const publication = await service.publish(alice.id, { renderId: render.id, mode: 'draft' }, 'http://127.0.0.1:34080')
    expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'draft', mode: 'draft' })
    expect(driver.publish).not.toHaveBeenCalled()
  })

  it('rejects cross-user renders and blocks new publishes while a result is uncertain', async () => {
    const { service, alice, bob, driver, image, article } = setup()
    image()
    const render = await article()
    await expect(service.publish(bob.id, { renderId: render.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ status: 409 })
    driver.publish.mockRejectedValueOnce(new ApiError(409, 'weibo_result_uncertain', '结果待核实'))
    const publication = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    expect((await finish(service, alice.id, publication.id)).status).toBe('uncertain')
    await expect(service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'weibo_result_uncertain' })
    await expect(service.resolve(bob.id, publication.id, { action: 'not_published' })).rejects.toMatchObject({ status: 404 })
    await service.resolve(alice.id, publication.id, { action: 'not_published' })
    expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'failed' })
  })

  it('does not mark a partially published thread as fully published', async () => {
    const { service, database, alice, driver, article } = setup()
    const render = await article('<p>正文</p>')
    const publication = database.createWeiboPublication(alice.id, { renderId: render.id, title: '微博串', mode: 'publish', idempotencyKey: 'partial-thread' })
    database.updateWeiboPublication(alice.id, publication.id, {
      status: 'uncertain',
      message: '微博串第 2/2 条未完成',
      thread: [
        { index: 0, status: 'published', remoteId: '500000000000001', url: 'https://weibo.com/1234567890/500000000000001', message: '已发布' },
        { index: 1, status: 'failed', remoteId: null, url: null, message: '评论失败' },
      ],
    })
    await service.resolve(alice.id, publication.id, { action: 'check' })
    await vi.waitFor(() => expect(service.get(alice.id, publication.id).status).not.toBe('running'))
    expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'uncertain' })
    expect(service.get(alice.id, publication.id).message).toContain('仅完成 1/2 条')
    expect(driver.checkPublication).not.toHaveBeenCalled()
  })

  it('rejects videos and stale renders before submitting', async () => {
    const { service, database, alice, image, article } = setup()
    image()
    const render = await article('<p>正文</p><video src="/uploads/demo.mp4"></video>')
    await expect(service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'weibo_media_unsupported' })
    const clean = await article()
    const original = database.getRender(alice.id, clean.id)!.results[0]
    database.saveRenderDraft(alice.id, clean.id, { ...original, sourceUpdatedAt: 'old' })
    await expect(service.publish(alice.id, { renderId: clean.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'weibo_render_stale' })
  })


  it('removes local drafts and failed records but keeps published posts', async () => {
    const { service, alice, bob, article } = setup()
    const render = await article('<p>正文内容</p>')
    const draft = await service.publish(alice.id, { renderId: render.id, mode: 'draft' })
    expect(draft.status).toBe('draft')
    await expect(service.remove(bob.id, draft.id)).rejects.toMatchObject({ status: 404 })
    await expect(service.remove(alice.id, draft.id)).resolves.toEqual({ ok: true, remoteDeleted: false })
    const published = await service.publish(alice.id, { renderId: render.id, mode: 'publish' })
    await finish(service, alice.id, published.id)
    await expect(service.remove(alice.id, published.id)).rejects.toMatchObject({ code: 'weibo_delete_published' })
  })

  it('marks interrupted jobs uncertain after restart', async () => {
    const { database, alice, article, restart } = setup()
    const render = await article()
    const job = database.createWeiboPublication(alice.id, { renderId: render.id, title: '测试', mode: 'publish', idempotencyKey: 'interrupted' })
    const reopened = await restart()
    expect(reopened.getWeiboPublication(alice.id, job.id)?.status).toBe('uncertain')
  })
})

describe('Weibo parsing', () => {
  it('parses profile, published IDs and status responses', () => {
    expect(parseWeiboProfile({ ok: 1, data: { user: { idstr: '123', screen_name: '作者' } } })).toEqual({ accountId: '123', name: '作者' })
    expect(parseWeiboProfile({ ok: -100 })).toBeNull()
    expect(parseWeiboPublished({ ok: 1, data: { idstr: '5000000000000001' } })).toEqual({ remoteId: '5000000000000001', url: 'https://m.weibo.cn/detail/5000000000000001' })
    expect(parseWeiboStatus({ ok: 1, data: { idstr: '5000000000000001', text: '正文' } }, '5000000000000001')?.text).toBe('正文')
    expect(parseWeiboStatus({ ok: 1, data: { idstr: '1' } }, '2')).toBeNull()
    expect(parseWeiboPublishedId('https://weibo.com/1234567890/5000000000000001')).toBe('5000000000000001')
    expect(parseWeiboPublishedId('https://m.weibo.cn/detail/5000000000000001')).toBe('5000000000000001')
    expect(parseWeiboPublishedId('https://evil.example/5000000000000001')).toBeNull()
  })
})
