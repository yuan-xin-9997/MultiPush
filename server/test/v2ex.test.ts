import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { ApiError } from '../src/errors'
import { decryptPublisherSession, loadPublisherKey } from '../src/publisher-session'
import { renderPlatforms } from '../src/renderers'
import { V2exService } from '../src/v2ex'
import { parseV2exCookies, parseV2exNodesFromHtml, parseV2exTopicId, type V2exDriver } from '../src/v2ex-browser'
import type { ContentDetail } from '../../shared/types'

const cleanups: Array<() => Promise<void> | void> = []
const state = { cookies: [{ name: 'PB3_SESSION', value: 'v2ex-session', domain: '.v2ex.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }], origins: [] }
const identity = { accountId: 'v2ex-hash', name: 'V2EX 作者' }
const topic = '123456'

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-v2ex-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' })
  let database: Database = openDatabase(path.join(directory, 'test.sqlite'))
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const driver = {
    connect: vi.fn<V2exDriver['connect']>().mockResolvedValue({ state, identity }),
    checkSession: vi.fn<V2exDriver['checkSession']>().mockResolvedValue({ state, identity }),
    listNodes: vi.fn<V2exDriver['listNodes']>().mockResolvedValue([{ name: 'programming', title: '程序员' }]),
    checkPublication: vi.fn<V2exDriver['checkPublication']>().mockResolvedValue({ state, status: 'published', url: `https://www.v2ex.com/t/${topic}`, message: '已核实' }),
    publish: vi.fn<V2exDriver['publish']>().mockResolvedValue({ state, status: 'published', remoteId: topic, url: `https://www.v2ex.com/t/${topic}`, message: 'V2EX 主题已发布' }),
    close: vi.fn(async () => {}),
  }
  const service = new V2exService(database, config, driver)
  const key = loadPublisherKey(directory, 'v2ex')
  const article = async (html = '<h2>小节</h2><p>正文内容</p>', title = 'V2EX 测试主题') => {
    const content: ContentDetail = database.createContent(alice.id, { title, contentHtml: html, contentJson: {}, excerpt: '', bookId: null, coverImage: null, tags: ['V2EX'], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const [result] = await renderPlatforms({ content, platforms: ['v2ex'], options: {}, authorName: 'Alice', baseUrl: 'http://127.0.0.1:34080' })
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['v2ex'], options: {}, results: [result] })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return {
    directory,
    database,
    service,
    alice,
    bob,
    driver,
    article,
    key,
    restart: async () => {
      await service.close()
      database.close()
      database = openDatabase(path.join(directory, 'test.sqlite'))
      return database
    },
  }
}

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

describe('V2EX publishing', () => {
  it('connects with a cookie and encrypts the browser session for its owner', async () => {
    const { database, service, alice, bob, driver, key } = setup()
    const account = await service.connect(alice.id, { cookie: 'PB3_SESSION=v2ex-session; A2=remember' })
    expect(account).toMatchObject({ status: 'connected', name: 'V2EX 作者' })
    expect(driver.connect).toHaveBeenCalledWith('PB3_SESSION=v2ex-session; A2=remember')
    expect(decryptPublisherSession(database.getV2exAccount(alice.id)!.encryptedSession, key, alice.id)).toEqual(state)
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
    await service.disconnect(alice.id)
    expect(database.getV2exAccount(alice.id)).toBeNull()
  })

  it('publishes a markdown topic with the selected node and stores the topic id', async () => {
    const { service, alice, driver, article } = setup()
    await service.connect(alice.id, { cookie: 'PB3_SESSION=v2ex-session' })
    const render = await article()
    const publication = await service.publish(alice.id, { renderId: render.id, nodeName: 'programming' })
    expect(publication).toMatchObject({ status: 'published', nodeName: 'programming', remoteId: topic, url: `https://www.v2ex.com/t/${topic}` })
    expect(driver.publish.mock.calls[0][1]).toMatchObject({ title: 'V2EX 测试主题', nodeName: 'programming' })
    expect(driver.publish.mock.calls[0][1].markdown).not.toContain('# V2EX 测试主题')
    expect(driver.publish.mock.calls[0][1].markdown).toContain('正文内容')
    expect((await service.publish(alice.id, { renderId: render.id, nodeName: 'programming' })).id).toBe(publication.id)
  })

  it('marks a post-submit failure uncertain, blocks retries and resolves it', async () => {
    const { service, alice, bob, driver, article } = setup()
    await service.connect(alice.id, { cookie: 'PB3_SESSION=v2ex-session' })
    const render = await article()
    await expect(service.publish(bob.id, { renderId: render.id, nodeName: 'programming' })).rejects.toMatchObject({ status: 409 })
    driver.publish.mockRejectedValueOnce(new ApiError(502, 'v2ex_result_uncertain', 'V2EX 已提交但未确认'))
    const publication = await service.publish(alice.id, { renderId: render.id, nodeName: 'programming' })
    expect(publication.status).toBe('uncertain')
    await expect(service.publish(alice.id, { renderId: render.id, nodeName: 'programming' })).rejects.toMatchObject({ code: 'v2ex_result_uncertain' })
    const resolved = await service.resolve(alice.id, publication.id, { action: 'published', topicUrl: `https://www.v2ex.com/t/${topic}` })
    expect(resolved).toMatchObject({ status: 'published', remoteId: topic })
  })

  it('rejects invalid nodes and never deletes published records', async () => {
    const { service, alice, driver, article } = setup()
    await service.connect(alice.id, { cookie: 'PB3_SESSION=v2ex-session' })
    const render = await article()
    await expect(service.publish(alice.id, { renderId: render.id, nodeName: '../bad' })).rejects.toMatchObject({ code: 'v2ex_node_invalid' })
    const publication = await service.publish(alice.id, { renderId: render.id, nodeName: 'programming' })
    await expect(service.remove(alice.id, publication.id)).rejects.toMatchObject({ code: 'v2ex_delete_published' })
    expect(driver.publish).toHaveBeenCalledTimes(1)
  })

  it('marks interrupted publishes uncertain after restart', async () => {
    const { database, alice, article, restart } = setup()
    const render = await article()
    const publication = database.createV2exPublication(alice.id, { renderId: render.id, title: '测试', nodeName: 'programming', idempotencyKey: 'interrupted' })
    const reopened = await restart()
    expect(reopened.getV2exPublication(alice.id, publication.id)?.status).toBe('uncertain')
  })
})

describe('V2EX rendering and parsing', () => {
  it('renders v2ex markdown, rejects videos with a warning and exports downloads', async () => {
    const { article } = setup()
    const render = await article('<h2>小节</h2><p>正文</p><figure><video src="/uploads/demo.mp4"></video></figure>')
    const result = render.results[0]
    expect(result.platform).toBe('v2ex')
    expect(result.markdown).toContain('# V2EX 测试主题')
    expect(result.markdown).toContain('正文')
    expect(result.warnings.join('\n')).toContain('不支持视频')
    expect(result.downloads.map(item => item.kind)).toEqual(['html', 'markdown', 'json'])
    expect(result.previewMode).toBe('article')
  })

  it('parses cookies, topic ids and node options', () => {
    expect(parseV2exCookies('PB3_SESSION=abc%3D; V2EX_LANG=enus')).toEqual([
      expect.objectContaining({ name: 'PB3_SESSION', value: 'abc%3D', domain: '.v2ex.com' }),
      expect.objectContaining({ name: 'V2EX_LANG', value: 'enus', domain: '.v2ex.com' }),
    ])
    expect(parseV2exTopicId(`https://www.v2ex.com/t/${topic}#reply1`)).toBe(topic)
    expect(parseV2exTopicId('https://evil.example/t/123')).toBeNull()
    expect(parseV2exNodesFromHtml('<select id="nodes"><option value="programming">程序员</option><option value="create">分享创造</option></select>')).toEqual([
      { name: 'programming', title: '程序员' },
      { name: 'create', title: '分享创造' },
    ])
  })
})
