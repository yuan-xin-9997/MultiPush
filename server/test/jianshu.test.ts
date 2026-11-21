import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { ApiError } from '../src/errors'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey } from '../src/publisher-session'
import { renderPlatforms } from '../src/renderers'
import { JianshuService } from '../src/jianshu'
import { parseJianshuCookies, parseJianshuCsrf, parseJianshuNote, parseJianshuNotebooks, type JianshuDriver } from '../src/jianshu-browser'
import type { ContentDetail } from '../../shared/types'

const cleanups: Array<() => Promise<void> | void> = []
const state = { cookies: [{ name: 'remember_user_token', value: 'jianshu-session', domain: '.jianshu.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] }
const identity = { accountId: 'jianshu-hash', name: '简书作者' }
const slug = 'abcd1234efgh'

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-jianshu-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' })
  let database: Database = openDatabase(path.join(directory, 'test.sqlite'))
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const driver = {
    connect: vi.fn<JianshuDriver['connect']>().mockResolvedValue({ state, identity }),
    checkSession: vi.fn<JianshuDriver['checkSession']>().mockResolvedValue({ state, identity }),
    checkPublication: vi.fn<JianshuDriver['checkPublication']>().mockResolvedValue({ state, status: 'published', url: `https://www.jianshu.com/p/${slug}`, message: '已发布' }),
    deleteDraft: vi.fn<JianshuDriver['deleteDraft']>().mockResolvedValue({ state, remoteDeleted: true, message: '简书草稿已删除' }),
    publish: vi.fn<JianshuDriver['publish']>().mockImplementation(async (_state, article) => article.mode === 'draft'
      ? { state, status: 'draft' as const, remoteId: '53149573', url: 'https://www.jianshu.com/writer#/notebooks/1/notes/53149573', message: '草稿已保存' }
      : { state, status: 'published' as const, remoteId: '53149573', url: `https://www.jianshu.com/p/${slug}`, message: '文章已发布' }),
    close: vi.fn(async () => {}),
  }
  const service = new JianshuService(database, config, driver)
  const key = loadPublisherKey(directory, 'jianshu')
  const article = async (html = '<h2>小节</h2><p>正文内容</p>', title = '简书测试文章') => {
    const content: ContentDetail = database.createContent(alice.id, { title, contentHtml: html, contentJson: {}, excerpt: '', bookId: null, coverImage: null, tags: ['读书'], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const [result] = await renderPlatforms({ content, platforms: ['jianshu'], options: {}, authorName: 'Alice', baseUrl: 'http://127.0.0.1:34080' })
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['jianshu'], options: {}, results: [result] })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, database, service, alice, bob, driver, article, key, restart: async () => { await service.close(); database.close(); database = openDatabase(path.join(directory, 'test.sqlite')); return database } }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const finish = async (service: JianshuService, owner: string, id: string) => {
  await vi.waitFor(() => expect(service.get(owner, id).status).not.toBe('running'))
  return service.get(owner, id)
}

describe('Jianshu publishing', () => {
  it('connects with a cookie, encrypts the session and binds it to the owner', async () => {
    const { database, alice, bob, service, driver, key } = setup()
    const account = await service.connect(alice.id, { cookie: 'remember_user_token=jianshu-session; _m7e_session_core=x' })
    expect(account).toMatchObject({ status: 'connected', name: '简书作者' })
    expect(driver.connect).toHaveBeenCalledWith('remember_user_token=jianshu-session; _m7e_session_core=x')
    expect(decryptPublisherSession(database.getJianshuAccount(alice.id)!.encryptedSession, key, alice.id)).toEqual(state)
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
  })

  it('creates a draft and publishes it into the selected notebook', async () => {
    const { service, alice, driver, article } = setup()
    await service.connect(alice.id, { cookie: 'remember_user_token=jianshu-session' })
    const render = await article()
    const draft = await service.publish(alice.id, { renderId: render.id, mode: 'draft', notebookId: '51802858' })
    expect(await finish(service, alice.id, draft.id)).toMatchObject({ status: 'draft', mode: 'draft', remoteId: '53149573' })
    const published = await service.publish(alice.id, { renderId: render.id, mode: 'publish' })
    expect(await finish(service, alice.id, published.id)).toMatchObject({ status: 'published', mode: 'publish', url: `https://www.jianshu.com/p/${slug}` })
    expect(driver.publish.mock.calls[0][1]).toMatchObject({ title: '简书测试文章', mode: 'draft', notebookId: '51802858' })
    expect(driver.publish.mock.calls[1][1]).toMatchObject({ mode: 'publish' })
    expect((await service.publish(alice.id, { renderId: render.id, mode: 'draft', notebookId: '51802858' })).id).toBe(draft.id)
  })

  it('blocks new publishes while a result is uncertain and resolves it', async () => {
    const { service, alice, bob, driver, article } = setup()
    await service.connect(alice.id, { cookie: 'remember_user_token=jianshu-session' })
    const render = await article()
    await expect(service.publish(bob.id, { renderId: render.id, mode: 'draft' })).rejects.toMatchObject({ status: 409 })
    driver.publish.mockRejectedValueOnce(new ApiError(502, 'jianshu_result_uncertain', '结果待核实'))
    const publication = await service.publish(alice.id, { renderId: render.id, mode: 'publish' })
    expect((await finish(service, alice.id, publication.id)).status).toBe('uncertain')
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'draft' })).rejects.toMatchObject({ code: 'jianshu_result_uncertain' })
    await service.resolve(alice.id, publication.id, { action: 'published', articleUrl: `https://www.jianshu.com/p/${slug}` })
    expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'published' })
  })

  it('deletes a draft remotely and never removes published records', async () => {
    const { service, alice, bob, driver, article } = setup()
    await service.connect(alice.id, { cookie: 'remember_user_token=jianshu-session' })
    const render = await article()
    const draft = await service.publish(alice.id, { renderId: render.id, mode: 'draft' })
    await finish(service, alice.id, draft.id)
    await expect(service.remove(bob.id, draft.id)).rejects.toMatchObject({ status: 404 })
    await expect(service.remove(alice.id, draft.id)).resolves.toEqual({ ok: true, remoteDeleted: true })
    expect(driver.deleteDraft).toHaveBeenCalledWith(state, '53149573')
  })

  it('marks interrupted jobs uncertain after restart', async () => {
    const { database, alice, article, restart } = setup()
    const render = await article()
    const job = database.createJianshuPublication(alice.id, { renderId: render.id, title: '测试', mode: 'draft', idempotencyKey: 'interrupted' })
    const reopened = await restart()
    expect(reopened.getJianshuPublication(alice.id, job.id)?.status).toBe('uncertain')
  })
})

describe('Jianshu parsing', () => {
  it('parses cookies, notes, notebooks and CSRF tokens', () => {
    expect(parseJianshuCookies('remember_user_token=abc%3D; _m7e_session_core=xyz')).toEqual([
      expect.objectContaining({ name: 'remember_user_token', value: 'abc%3D', domain: '.jianshu.com' }),
      expect.objectContaining({ name: '_m7e_session_core', value: 'xyz', domain: '.jianshu.com' }),
    ])
    expect(parseJianshuNote({ id: 53149573, slug })).toEqual({ id: '53149573', slug })
    expect(parseJianshuNote({ data: { note: { note_id: '53149573', slug } } })).toEqual({ id: '53149573', slug })
    expect(parseJianshuNotebooks([{ id: 51802858, name: '技术' }])).toEqual([{ id: '51802858', name: '技术' }])
    expect(parseJianshuCsrf('<meta name="csrf-token" content="token-1">')).toBe('token-1')
  })
})
