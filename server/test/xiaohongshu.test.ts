import { prepareXhsCaption } from '../../shared/render-workbench'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Database } from '../src/db'
import { loadConfig } from '../src/config'
import { XhsService } from '../src/xiaohongshu'
import type { XhsDriver, XhsLoginAttempt } from '../src/xiaohongshu-browser'
import { xhsPublishedResult } from '../src/xiaohongshu-browser'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey } from '../src/publisher-session'
import { ApiError } from '../src/errors'
import type { PlatformRender } from '../../shared/types'

const cleanups: Array<() => Promise<void>> = []
const state = { cookies: [], origins: [] }, identity = { accountId: 'xhs-account', name: '作者' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-xhs-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' })
  let database: Database = openDatabase(path.join(directory, 'test.sqlite'))
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const attempt = { poll: vi.fn<XhsLoginAttempt['poll']>().mockResolvedValue({ status: 'waiting', qrCode: null, message: '请扫码' }), close: vi.fn(async () => {}) }
  const driver = {
    beginLogin: vi.fn<XhsDriver['beginLogin']>().mockResolvedValue(attempt),
    checkSession: vi.fn<XhsDriver['checkSession']>().mockResolvedValue({ state, identity }),
    checkPublication: vi.fn<XhsDriver['checkPublication']>().mockResolvedValue({ state, status: 'unknown', url: null, message: '请人工核实' }),
    publish: vi.fn<XhsDriver['publish']>().mockResolvedValue({ state, status: 'published', remoteId: '1234567890abcdef12345678', url: 'https://www.xiaohongshu.com/explore/1234567890abcdef12345678', message: '成功' }),
    close: vi.fn(async () => {}),
  }
  const service = new XhsService(database, config, driver)
  const key = loadPublisherKey(directory, 'xiaohongshu')
  database.saveXhsAccount(alice.id, { ...identity, encryptedSession: encryptPublisherSession(state, key, alice.id), status: 'connected', checkedAt: new Date().toISOString() })
  const image = (userId = alice.id) => {
    const filename = `${randomUUID()}.png`
    writeFileSync(path.join(config.uploadsDir, filename), png)
    return database.createMedia(userId, { filename, originalName: filename, kind: 'image', mimeType: 'image/png', size: png.length })
  }
  const article = () => {
    const content = database.createContent(alice.id, { title: '测试笔记', contentHtml: '<p>正文</p>', contentJson: {}, excerpt: '', bookId: null, coverImage: null, tags: [], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const result: PlatformRender = { platform: 'xiaohongshu', title: content.title, html: '', markdown: null, text: '正文', previewMode: 'cards', themeColor: '#ff2442', meta: { wordCount: 4, imageCount: 1, videoCount: 0, readMinutes: 1, tags: ['测试'], titleLength: 4, summary: '' }, cards: [], assets: [], videos: [], warnings: [], downloads: [], generatedAt: content.updatedAt, sourceUpdatedAt: content.updatedAt }
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['xiaohongshu'], results: [result], options: {} })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { database, service, alice, bob, driver, attempt, image, article, key, restart: async () => { await service.close(); database.close(); database = openDatabase(path.join(directory, 'test.sqlite')); return database } }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const finish = async (service: XhsService, owner: string, id: string) => { await vi.waitFor(() => expect(service.get(owner, id).status).not.toBe('running')); return service.get(owner, id) }

describe('Xiaohongshu publishing', () => {
  it('requires explicit success and a valid note ID', () => {
    expect(xhsPublishedResult({ code: 0, success: true, data: { note_id: '1234567890abcdef12345678' } })?.remoteId).toBe('1234567890abcdef12345678')
    for (const value of [null, {}, { code: 0 }, { code: 0, success: false, data: { id: '1234567890abcdef12345678' } }, { code: 0, success: true, data: { id: '../bad' } }]) expect(xhsPublishedResult(value)).toBeNull()
  })
  it('encrypts sessions with owner and platform binding', async () => {
    const { database, alice, bob, key, service } = setup()
    const encrypted = database.getXhsAccount(alice.id)!.encryptedSession
    expect(decryptPublisherSession(encrypted, key, alice.id)).toEqual(state)
    expect(() => decryptPublisherSession(encrypted, key, bob.id)).toThrow()
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
    expect(JSON.stringify(await service.account(alice.id))).not.toContain('encryptedSession')
    await service.disconnect(alice.id)
    expect(database.getXhsAccount(alice.id)).toBeNull()
  })
  it('isolates login attempts and persists only confirmed sessions', async () => {
    const { service, alice, bob, attempt } = setup()
    const login = await service.startLogin(bob.id)
    await expect(service.pollLogin(alice.id, login.id)).rejects.toMatchObject({ status: 404 })
    attempt.poll.mockResolvedValue({ status: 'connected', qrCode: null, message: '完成', state, identity })
    await vi.waitFor(async () => expect(await service.pollLogin(bob.id, login.id)).toMatchObject({ status: 'connected' }))
    expect(await service.account(bob.id)).toMatchObject({ status: 'connected' })
  })
  it('preserves image order and deduplicates identical content across media uploads', async () => {
    const { service, alice, driver, image, article } = setup()
    const render = article(), first = image(), second = image()
    const input = { renderId: render.id, mode: 'publish' as const, imageMediaIds: [first.id] }
    const published = await service.publish(alice.id, input)
    await finish(service, alice.id, published.id)
    const again = await service.publish(alice.id, { ...input, imageMediaIds: [second.id] })
    expect(again.id).toBe(published.id)
    expect(driver.publish).toHaveBeenCalledTimes(1)
    expect(driver.publish.mock.calls[0][1].body).toBe('正文\n\n#测试')
  })
  it('submits the same shortened caption used by the preview, preserving saved prose and cards', async () => {
    const { service, database, alice, driver, image, article } = setup()
    const render = article()
    const saved = { ...render.results[0], captionBody: '正文细节🙂。'.repeat(300), meta: { ...render.results[0].meta, tags: ['发布测试', '小红书'] } }
    database.saveRenderDraft(alice.id, render.id, saved)
    const publication = await service.publish(alice.id, { renderId: render.id, mode: 'publish', imageMediaIds: [image().id] })
    expect((await finish(service, alice.id, publication.id)).status).toBe('published')
    const submitted = driver.publish.mock.calls[0][1].body
    expect(submitted).toBe(prepareXhsCaption(saved).text)
    expect(Array.from(submitted).length).toBeLessThanOrEqual(1000)
    expect(submitted).toContain('#发布测试 #小红书')
    expect(database.getRender(alice.id, render.id)!.results[0].captionBody).toBe(saved.captionBody)
    expect(database.getRender(alice.id, render.id)!.results[0].cards).toEqual(saved.cards)
  })

  it('rejects cross-user renders/images and invalid titles before submission', async () => {
    const { service, database, alice, bob, image, article, driver } = setup()
    const render = article()
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'publish', imageMediaIds: [image(bob.id).id] })).rejects.toMatchObject({ status: 404 })
    await expect(service.publish(bob.id, { renderId: render.id, mode: 'publish', imageMediaIds: [image(bob.id).id] })).rejects.toMatchObject({ status: 409 })
    database.saveRenderDraft(alice.id, render.id, { ...render.results[0], title: '字'.repeat(21) })
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'publish', imageMediaIds: [image().id] })).rejects.toMatchObject({ code: 'xiaohongshu_title_invalid' })
    expect(driver.publish).not.toHaveBeenCalled()
  })
  it('blocks uncertain results until the owner explicitly resolves them', async () => {
    const { service, alice, bob, driver, image, article } = setup()
    const input = { renderId: article().id, mode: 'publish' as const, imageMediaIds: [image().id] }
    driver.publish.mockRejectedValue(new ApiError(409, 'xiaohongshu_result_uncertain', '结果待核实'))
    const publication = await service.publish(alice.id, input)
    expect((await finish(service, alice.id, publication.id)).status).toBe('uncertain')
    await expect(service.publish(alice.id, input)).rejects.toMatchObject({ code: 'xiaohongshu_result_uncertain' })
    await expect(service.resolve(bob.id, publication.id, { action: 'not_published' })).rejects.toMatchObject({ status: 404 })
    await expect(service.resolve(alice.id, publication.id, { action: 'published', articleUrl: 'https://evil.example/explore/1234567890abcdef12345678' })).rejects.toMatchObject({ status: 400 })
    await service.resolve(alice.id, publication.id, { action: 'not_published' })
    driver.publish.mockResolvedValue({ state, status: 'published', remoteId: null, url: null, message: '完成' })
    const retry = await service.publish(alice.id, input)
    expect((await finish(service, alice.id, retry.id)).status).toBe('published')
  })
  it('marks interrupted jobs uncertain across restart and preserves account state', async () => {
    const { database, alice, article, restart } = setup()
    const render = article()
    const job = database.createXhsPublication(alice.id, { renderId: render.id, title: '测试', mode: 'publish', idempotencyKey: 'interrupted' })
    const reopened = await restart()
    expect(reopened.getXhsPublication(alice.id, job.id)?.status).toBe('uncertain')
    expect(reopened.getXhsAccount(alice.id)?.status).toBe('connected')
  })
})
