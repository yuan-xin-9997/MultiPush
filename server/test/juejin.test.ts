import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { ApiError } from '../src/errors'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey } from '../src/publisher-session'
import { renderPlatforms } from '../src/renderers'
import { JuejinService } from '../src/juejin'
import { parseJuejinCategoryIds, parseJuejinDraftId, parseJuejinIdentity, parseJuejinPublishedId, parseJuejinTagIds, type JuejinDriver, type JuejinLoginAttempt } from '../src/juejin-browser'
import type { ContentDetail } from '../../shared/types'

const cleanups: Array<() => Promise<void> | void> = []
const state = { cookies: [{ name: 'sessionid', value: 'juejin-session', domain: '.juejin.cn', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] }
const identity = { accountId: '123456789', name: '掘金作者' }

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-juejin-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' })
  let database: Database = openDatabase(path.join(directory, 'test.sqlite'))
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const attempt = { poll: vi.fn<JuejinLoginAttempt['poll']>().mockResolvedValue({ status: 'waiting', qrCode: null, message: '请扫码' }), close: vi.fn(async () => {}) }
  const driver = {
    beginLogin: vi.fn<JuejinDriver['beginLogin']>().mockResolvedValue(attempt),
    checkSession: vi.fn<JuejinDriver['checkSession']>().mockResolvedValue({ state, identity }),
    checkPublication: vi.fn<JuejinDriver['checkPublication']>().mockResolvedValue({ state, status: 'published', url: 'https://juejin.cn/post/7000000000000000001', message: '已发布' }),
    deleteDraft: vi.fn<JuejinDriver['deleteDraft']>().mockResolvedValue({ state, remoteDeleted: true, message: '掘金草稿已删除' }),
    publish: vi.fn<JuejinDriver['publish']>().mockImplementation(async (_state, article) => article.mode === 'draft'
      ? { state, status: 'draft' as const, remoteId: '7000000000000000002', url: 'https://juejin.cn/editor/drafts/7000000000000000002', message: '草稿已保存' }
      : { state, status: 'published' as const, remoteId: '7000000000000000001', url: 'https://juejin.cn/post/7000000000000000001', message: '文章已发布' }),
    close: vi.fn(async () => {}),
  }
  const service = new JuejinService(database, config, driver)
  const key = loadPublisherKey(directory, 'juejin')
  database.saveJuejinAccount(alice.id, { ...identity, encryptedSession: encryptPublisherSession(state, key, alice.id), status: 'connected', checkedAt: new Date().toISOString() })
  const article = async (html = '<h2>小节</h2><p>正文内容</p>', title = '掘金测试文章') => {
    const content: ContentDetail = database.createContent(alice.id, { title, contentHtml: html, contentJson: {}, excerpt: '', bookId: null, coverImage: null, tags: ['前端', 'TypeScript'], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const [result] = await renderPlatforms({ content, platforms: ['juejin'], options: {}, authorName: 'Alice', baseUrl: 'http://127.0.0.1:34080' })
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['juejin'], options: {}, results: [result] })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, database, service, alice, bob, driver, attempt, article, key, restart: async () => { await service.close(); database.close(); database = openDatabase(path.join(directory, 'test.sqlite')); return database } }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const finish = async (service: JuejinService, owner: string, id: string) => {
  await vi.waitFor(() => expect(service.get(owner, id).status).not.toBe('running'))
  return service.get(owner, id)
}

describe('Juejin publishing', () => {
  it('encrypts the session and binds it to the owner', async () => {
    const { database, alice, bob, key, service } = setup()
    const encrypted = database.getJuejinAccount(alice.id)!.encryptedSession
    expect(decryptPublisherSession(encrypted, key, alice.id)).toEqual(state)
    expect(() => decryptPublisherSession(encrypted, key, bob.id)).toThrow()
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
  })

  it('creates a draft and publishes it with category and tag names', async () => {
    const { service, alice, driver, article } = setup()
    const render = await article()
    const draft = await service.publish(alice.id, { renderId: render.id, mode: 'draft', tags: ['前端', 'React'] })
    const draftDone = await finish(service, alice.id, draft.id)
    expect(draftDone).toMatchObject({ status: 'draft', mode: 'draft', remoteId: '7000000000000000002' })
    const published = await service.publish(alice.id, { renderId: render.id, mode: 'publish', categoryId: '6809637767543259144', tags: ['前端'] })
    expect(await finish(service, alice.id, published.id)).toMatchObject({ status: 'published', mode: 'publish', url: 'https://juejin.cn/post/7000000000000000001' })
    expect(driver.publish.mock.calls[0][1]).toMatchObject({ title: '掘金测试文章', mode: 'draft', tagNames: ['前端', 'React'] })
    expect(driver.publish.mock.calls[1][1]).toMatchObject({ categoryId: '6809637767543259144', tagNames: ['前端'] })
    expect((await service.publish(alice.id, { renderId: render.id, mode: 'draft', tags: ['前端', 'React'] })).id).toBe(draft.id)
    expect(driver.publish).toHaveBeenCalledTimes(2)
  })

  it('blocks new publishes while a result is uncertain and allows manual resolution', async () => {
    const { service, alice, bob, driver, article } = setup()
    const render = await article()
    await expect(service.publish(bob.id, { renderId: render.id, mode: 'draft' })).rejects.toMatchObject({ status: 409 })
    driver.publish.mockRejectedValueOnce(new ApiError(502, 'juejin_result_uncertain', '结果待核实'))
    const publication = await service.publish(alice.id, { renderId: render.id, mode: 'publish' })
    expect((await finish(service, alice.id, publication.id)).status).toBe('uncertain')
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'draft' })).rejects.toMatchObject({ code: 'juejin_result_uncertain' })
    await expect(service.resolve(bob.id, publication.id, { action: 'not_published' })).rejects.toMatchObject({ status: 404 })
    await service.resolve(alice.id, publication.id, { action: 'published', articleUrl: 'https://juejin.cn/post/7000000000000000001' })
    expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'published', remoteId: '7000000000000000001' })
  })


  it('deletes a draft remotely and never removes published records', async () => {
    const { service, alice, bob, driver, article } = setup()
    const render = await article()
    const draft = await service.publish(alice.id, { renderId: render.id, mode: 'draft' })
    await finish(service, alice.id, draft.id)
    await expect(service.remove(bob.id, draft.id)).rejects.toMatchObject({ status: 404 })
    await expect(service.remove(alice.id, draft.id)).resolves.toEqual({ ok: true, remoteDeleted: true })
    expect(driver.deleteDraft).toHaveBeenCalledWith(state, '7000000000000000002')
    expect(() => service.get(alice.id, draft.id)).toThrow('掘金发布记录不存在')
    const published = await service.publish(alice.id, { renderId: render.id, mode: 'publish' })
    await finish(service, alice.id, published.id)
    await expect(service.remove(alice.id, published.id)).rejects.toMatchObject({ code: 'juejin_delete_published' })
  })

  it('clears failed draft records locally even when remote cleanup fails', async () => {
    const { database, service, alice, driver, article } = setup()
    const render = await article()
    const draft = await service.publish(alice.id, { renderId: render.id, mode: 'draft' })
    await finish(service, alice.id, draft.id)
    database.updateJuejinPublication(alice.id, draft.id, { status: 'failed' })
    driver.deleteDraft.mockRejectedValueOnce(new ApiError(502, 'juejin_delete_failed', '删除失败'))
    await expect(service.remove(alice.id, draft.id)).resolves.toEqual({ ok: true, remoteDeleted: false })
  })

  it('marks interrupted jobs uncertain after restart', async () => {
    const { database, alice, article, restart } = setup()
    const render = await article()
    const job = database.createJuejinPublication(alice.id, { renderId: render.id, title: '测试', mode: 'draft', idempotencyKey: 'interrupted' })
    const reopened = await restart()
    expect(reopened.getJuejinPublication(alice.id, job.id)?.status).toBe('uncertain')
  })
})

describe('Juejin parsing', () => {
  it('parses identity, draft ids, published ids, categories and tags', () => {
    expect(parseJuejinIdentity({ err_no: 0, data: { user_id: 123, user_name: '作者' } })).toEqual({ accountId: '123', name: '作者' })
    expect(parseJuejinIdentity({ err_no: 403, data: null })).toBeNull()
    expect(parseJuejinDraftId({ err_no: 0, data: { draft_id: '7000000000000000002' } })).toBe('7000000000000000002')
    expect(parseJuejinDraftId({ err_no: 1, data: {} })).toBeNull()
    expect(parseJuejinPublishedId({ err_no: 0, data: { article_id: '7000000000000000001' } })).toBe('7000000000000000001')
    expect(parseJuejinCategoryIds({ err_no: 0, data: [{ category_id: '1', category_name: '后端' }] })).toEqual([{ id: '1', name: '后端' }])
    expect(parseJuejinTagIds({ err_no: 0, data: [{ tag: { tag_id: '2', tag_name: '前端' } }] })).toEqual(['2'])
  })
})
