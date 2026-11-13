import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { ApiError } from '../src/errors'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey } from '../src/publisher-session'
import { SspaiService } from '../src/sspai'
import { parseSspaiPublishedId, sspaiTokenFromState, type SspaiDriver, type SspaiLoginAttempt } from '../src/sspai-browser'
import { prepareSspaiContent, sspaiEditorContent, verifySspaiContent } from '../src/sspai-content'
import type { PlatformRender } from '../../shared/types'

const cleanups: Array<() => Promise<void>> = []
const state = { cookies: [], origins: [{ origin: 'https://sspai.com', localStorage: [{ name: 'ssToken', value: 'test-token' }] }] }
const identity = { accountId: '482910', name: '测试作者' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-sspai-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' })
  let database: Database = openDatabase(path.join(directory, 'test.sqlite'))
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const attempt = { poll: vi.fn<SspaiLoginAttempt['poll']>().mockResolvedValue({ status: 'waiting', qrCode: null, message: '请扫码' }), close: vi.fn(async () => {}) }
  const driver = {
    beginLogin: vi.fn<SspaiDriver['beginLogin']>().mockResolvedValue(attempt),
    checkSession: vi.fn<SspaiDriver['checkSession']>().mockResolvedValue({ state, identity }),
    checkPublication: vi.fn<SspaiDriver['checkPublication']>().mockResolvedValue({ state, status: 'unknown', url: null, message: '请人工核实' }),
    publish: vi.fn<SspaiDriver['publish']>().mockResolvedValue({ state, status: 'published', remoteId: '118886', url: 'https://sspai.com/post/118886', message: '成功' }),
    close: vi.fn(async () => {}),
  }
  const service = new SspaiService(database, config, driver)
  const key = loadPublisherKey(directory, 'sspai')
  database.saveSspaiAccount(alice.id, { ...identity, encryptedSession: encryptPublisherSession(state, key, alice.id), status: 'connected', checkedAt: new Date().toISOString() })
  const image = (userId = alice.id) => {
    const filename = `${randomUUID()}.png`
    writeFileSync(path.join(config.uploadsDir, filename), png)
    return database.createMedia(userId, { filename, originalName: filename, kind: 'image', mimeType: 'image/png', size: png.length })
  }
  const article = (html = '<p>正文内容</p>', tags = ['效率', '工具']) => {
    const content = database.createContent(alice.id, { title: '测试少数派文章', contentHtml: html, contentJson: {}, excerpt: '', bookId: null, coverImage: null, tags, status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const result: PlatformRender = {
      platform: 'sspai', title: content.title, html, markdown: null, text: '正文内容', previewMode: 'article', themeColor: '#d71a1b',
      meta: { wordCount: 4, imageCount: 0, videoCount: 0, readMinutes: 1, tags, titleLength: Array.from(content.title).length, summary: '' },
      cards: [], assets: [], videos: [], warnings: [], downloads: [], generatedAt: content.updatedAt, sourceUpdatedAt: content.updatedAt,
    }
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['sspai'], results: [result], options: {} })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return {
    directory, config, database, service, alice, bob, driver, attempt, image, article, key,
    restart: async () => { await service.close(); database.close(); database = openDatabase(path.join(directory, 'test.sqlite')); return database },
  }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const finish = async (service: SspaiService, owner: string, id: string) => {
  await vi.waitFor(() => expect(service.get(owner, id).status).not.toBe('running'))
  return service.get(owner, id)
}

describe('Sspai publishing', () => {
  it('reads the Bearer token from storageState and validates published links', () => {
    expect(sspaiTokenFromState(state)).toBe('test-token')
    expect(sspaiTokenFromState({ cookies: [], origins: [] })).toBeNull()
    expect(parseSspaiPublishedId('https://sspai.com/post/118886')).toBe('118886')
    expect(parseSspaiPublishedId('https://sspai.com/post/118886/')).toBe('118886')
    expect(parseSspaiPublishedId('https://sspai.com/post/118886?from=matrix')).toBe('118886')
    for (const value of ['', 'https://sspai.com/write/118886', 'https://evil.example/post/118886', 'https://sspai.com/post/abc', 118886]) expect(parseSspaiPublishedId(value)).toBeNull()
  })

  it('encrypts sessions with owner and platform binding', async () => {
    const { database, alice, bob, key, service } = setup()
    const encrypted = database.getSspaiAccount(alice.id)!.encryptedSession
    expect(decryptPublisherSession(encrypted, key, alice.id)).toEqual(state)
    expect(() => decryptPublisherSession(encrypted, key, bob.id)).toThrow()
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
    expect(JSON.stringify(await service.account(alice.id))).not.toContain('encryptedSession')
    await service.disconnect(alice.id)
    expect(database.getSspaiAccount(alice.id)).toBeNull()
  })

  it('isolates login attempts and persists only confirmed sessions', async () => {
    const { service, alice, bob, attempt } = setup()
    const login = await service.startLogin(bob.id)
    await expect(service.pollLogin(alice.id, login.id)).rejects.toMatchObject({ status: 404 })
    attempt.poll.mockResolvedValue({ status: 'connected', qrCode: null, message: '完成', state, identity })
    await vi.waitFor(async () => expect(await service.pollLogin(bob.id, login.id)).toMatchObject({ status: 'connected' }))
    expect(await service.account(bob.id)).toMatchObject({ status: 'connected' })
  })

  it('publishes saved render with tags and suppresses duplicate submissions', async () => {
    const { service, alice, driver, image, article } = setup()
    const media = image()
    const render = article(`<p>正文内容</p><p><img src="/uploads/${media.filename}"></p>`)
    const input = { renderId: render.id, mode: 'publish' as const }
    const published = await service.publish(alice.id, input)
    const done = await finish(service, alice.id, published.id)
    expect(done).toMatchObject({ status: 'published', remoteId: '118886', url: 'https://sspai.com/post/118886' })
    expect(driver.publish.mock.calls[0][1].tags).toEqual(['效率', '工具'])
    expect(driver.publish.mock.calls[0][1].images.size).toBe(1)
    const again = await service.publish(alice.id, input)
    expect(again.id).toBe(published.id)
    expect(driver.publish).toHaveBeenCalledTimes(1)
  })

  it('rejects cross-user renders, videos and invalid titles before submission', async () => {
    const { service, database, alice, bob, article, driver } = setup()
    const render = article()
    await expect(service.publish(bob.id, { renderId: render.id, mode: 'publish' })).rejects.toMatchObject({ status: 409 })
    database.saveRenderDraft(alice.id, render.id, { ...render.results[0], title: '字'.repeat(33) })
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'publish' })).rejects.toMatchObject({ code: 'sspai_title_invalid' })
    const video = article('<p>视频</p><video src="/uploads/demo.mp4"></video>')
    await expect(service.publish(alice.id, { renderId: video.id, mode: 'publish' })).rejects.toMatchObject({ code: 'sspai_media_unsupported' })
    expect(driver.publish).not.toHaveBeenCalled()
  })

  it('blocks uncertain results until the owner explicitly resolves them', async () => {
    const { service, alice, bob, driver, article } = setup()
    const input = { renderId: article().id, mode: 'publish' as const }
    driver.publish.mockRejectedValue(new ApiError(409, 'sspai_result_uncertain', '结果待核实'))
    const publication = await service.publish(alice.id, input)
    expect((await finish(service, alice.id, publication.id)).status).toBe('uncertain')
    await expect(service.publish(alice.id, input)).rejects.toMatchObject({ code: 'sspai_result_uncertain' })
    await expect(service.resolve(bob.id, publication.id, { action: 'not_published' })).rejects.toMatchObject({ status: 404 })
    await expect(service.resolve(alice.id, publication.id, { action: 'published', articleUrl: 'https://evil.example/post/118886' })).rejects.toMatchObject({ status: 400 })
    await service.resolve(alice.id, publication.id, { action: 'published', articleUrl: 'https://sspai.com/post/118886' })
    expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'published', url: 'https://sspai.com/post/118886' })
  })

  it('marks interrupted jobs uncertain across restart and preserves account state', async () => {
    const { database, alice, article, restart } = setup()
    const render = article()
    const job = database.createSspaiPublication(alice.id, { renderId: render.id, title: '测试', mode: 'publish', idempotencyKey: 'interrupted' })
    const reopened = await restart()
    expect(reopened.getSspaiPublication(alice.id, job.id)?.status).toBe('uncertain')
    expect(reopened.getSspaiAccount(alice.id)?.status).toBe('connected')
  })
})

describe('Sspai content preparation', () => {
  it('demotes duplicate titles, strips styles and flattens captions', () => {
    const html = '<h1 style="color:red">标题</h1><p style="color:red">正文<script>alert(1)</script></p><figure><img src="/uploads/a.png" style="width:10px"><figcaption>图注</figcaption></figure>'
    const prepared = prepareSspaiContent(html)
    expect(prepared).toContain('<h2>标题</h2>')
    expect(prepared).not.toContain('style=')
    expect(prepared).not.toContain('<script')
    expect(prepared).toContain('figure')
    const editor = sspaiEditorContent(html)
    expect(editor).toContain('<em>图注</em>')
    expect(editor).not.toContain('figcaption')
  })

  it('compares text, image keys and structure after read-back', () => {
    const expected = '<h2>标题</h2><p>正文</p><figure><img src="https://cdnfile.sspai.com/a.png"></figure>'
    const stored = '<h2>标题</h2><p>正文</p><figure class="image"><img src="https://cdnfile.sspai.com/a.png?imageView2/2/w/1120"></figure>'
    expect(() => verifySspaiContent(expected, stored)).not.toThrow()
    expect(() => verifySspaiContent(expected, '<h2>标题</h2><p>正文变了</p><figure><img src="https://cdnfile.sspai.com/a.png"></figure>')).toThrow()
  })
})
