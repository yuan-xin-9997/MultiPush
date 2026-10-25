import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Database } from '../src/db'
import { loadConfig } from '../src/config'
import { DouyinService } from '../src/douyin'
import type { DouyinDriver, DouyinLoginAttempt } from '../src/douyin-browser'
import { douyinPublishedResult } from '../src/douyin-browser'
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
  const attempt = { poll: vi.fn<DouyinLoginAttempt['poll']>().mockResolvedValue({ status: 'waiting', qrCode: null, message: '请扫码' }), close: vi.fn(async () => {}) }
  const driver = {
    beginLogin: vi.fn<DouyinDriver['beginLogin']>().mockResolvedValue(attempt),
    checkSession: vi.fn<DouyinDriver['checkSession']>().mockResolvedValue({ state, identity }),
    checkPublication: vi.fn<DouyinDriver['checkPublication']>().mockResolvedValue({ state, status: 'unknown', url: null, message: '请人工核实' }),
    publish: vi.fn<DouyinDriver['publish']>().mockResolvedValue({ state, status: 'published', remoteId: '1234567890123456789', url: 'https://www.douyin.com/video/1234567890123456789', message: '成功' }),
    close: vi.fn(async () => {}),
  }
  const service = new DouyinService(database, config, driver)
  const key = loadPublisherKey(directory, 'douyin')
  database.saveDouyinAccount(alice.id, { ...identity, encryptedSession: encryptPublisherSession(state, key, alice.id), status: 'connected', checkedAt: new Date().toISOString() })
  const image = (userId = alice.id) => {
    const filename = `${randomUUID()}.png`
    writeFileSync(path.join(config.uploadsDir, filename), png)
    return database.createMedia(userId, { filename, originalName: filename, kind: 'image', mimeType: 'image/png', size: png.length })
  }
  const article = () => {
    const content = database.createContent(alice.id, { title: '测试笔记', contentHtml: '<p>正文</p>', contentJson: {}, excerpt: '', bookId: null, coverImage: null, tags: [], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const result: PlatformRender = { platform: 'douyin', title: content.title, html: '', markdown: null, text: '正文', previewMode: 'cards', themeColor: '#ff2442', meta: { wordCount: 4, imageCount: 1, videoCount: 0, readMinutes: 1, tags: ['测试'], titleLength: 4, summary: '' }, cards: [], assets: [], videos: [], warnings: [], downloads: [], generatedAt: content.updatedAt, sourceUpdatedAt: content.updatedAt }
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['douyin'], results: [result], options: {} })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, config, database, service, alice, bob, driver, attempt, image, article, key, restart: async () => { await service.close(); database.close(); database = openDatabase(path.join(directory, 'test.sqlite')); return database } }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const finish = async (service: DouyinService, owner: string, id: string) => { await vi.waitFor(() => expect(service.get(owner, id).status).not.toBe('running')); return service.get(owner, id) }

describe('Douyin publishing', () => {
  it('requires explicit success and an exact string ID', () => {
    expect(douyinPublishedResult({ status_code: 0, aweme: { aweme_id: '1234567890123456789' } })?.remoteId).toBe('1234567890123456789')
    for (const value of [null, {}, { status_code: 0 }, { status_code: 1, aweme_id: '1234567890123456789' }, { status_code: 0, aweme_id: 1234567890123456789 }, { status_code: 0, aweme_id: '../bad' }]) expect(douyinPublishedResult(value)).toBeNull()
  })
  it('encrypts sessions with owner and platform binding', async () => {
    const { database, alice, bob, key, service } = setup()
    const encrypted = database.getDouyinAccount(alice.id)!.encryptedSession
    expect(decryptPublisherSession(encrypted, key, alice.id)).toEqual(state)
    expect(() => decryptPublisherSession(encrypted, key, bob.id)).toThrow()
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
    expect(JSON.stringify(await service.account(alice.id))).not.toContain('encryptedSession')
    await service.disconnect(alice.id)
    expect(database.getDouyinAccount(alice.id)).toBeNull()
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
    expect(driver.publish.mock.calls[0][1].body).toBe('正文')
  })
  it('rejects cross-user renders/images and invalid titles before submission', async () => {
    const { service, database, alice, bob, image, article, driver } = setup()
    const render = article()
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'publish', imageMediaIds: [image(bob.id).id] })).rejects.toMatchObject({ status: 404 })
    await expect(service.publish(bob.id, { renderId: render.id, mode: 'publish', imageMediaIds: [image(bob.id).id] })).rejects.toMatchObject({ status: 409 })
    database.saveRenderDraft(alice.id, render.id, { ...render.results[0], title: '字'.repeat(31) })
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'publish', imageMediaIds: [image().id] })).rejects.toMatchObject({ code: 'douyin_title_invalid' })
    expect(driver.publish).not.toHaveBeenCalled()
  })
  it('blocks uncertain results until the owner explicitly resolves them', async () => {
    const { service, alice, bob, driver, image, article } = setup()
    const input = { renderId: article().id, mode: 'publish' as const, imageMediaIds: [image().id] }
    driver.publish.mockRejectedValue(new ApiError(409, 'douyin_result_uncertain', '结果待核实'))
    const publication = await service.publish(alice.id, input)
    expect((await finish(service, alice.id, publication.id)).status).toBe('uncertain')
    await expect(service.publish(alice.id, input)).rejects.toMatchObject({ code: 'douyin_result_uncertain' })
    await expect(service.resolve(bob.id, publication.id, { action: 'not_published' })).rejects.toMatchObject({ status: 404 })
    await expect(service.resolve(alice.id, publication.id, { action: 'published', articleUrl: 'https://evil.example/video/1234567890123456789' })).rejects.toMatchObject({ status: 400 })
    await service.resolve(alice.id, publication.id, { action: 'not_published' })
    driver.publish.mockResolvedValue({ state, status: 'published', remoteId: null, url: null, message: '完成' })
    const retry = await service.publish(alice.id, input)
    expect((await finish(service, alice.id, retry.id)).status).toBe('published')
  })
  it('checks video ownership, excludes mixed media, and deduplicates video bytes', async () => {
    const { config, database, service, alice, bob, driver, article, image } = setup()
    const buffer = Buffer.from('0000ftypisom0000')
    const video = (userId: string) => {
      const filename = `${randomUUID()}.mp4`
      writeFileSync(path.join(config.uploadsDir, filename), buffer)
      return database.createMedia(userId, { filename, originalName: filename, kind: 'video', mimeType: 'video/mp4', size: buffer.length })
    }
    const render = article()
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'publish', videoMediaId: image(bob.id).id })).rejects.toMatchObject({ code: 'douyin_video_invalid' })
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'publish', videoMediaId: image().id, imageMediaIds: [image().id] })).rejects.toMatchObject({ code: 'douyin_media_invalid' })
    expect(driver.publish).not.toHaveBeenCalled()
    const input = { renderId: render.id, mode: 'publish' as const, videoMediaId: video(alice.id).id }
    const first = await service.publish(alice.id, input)
    await finish(service, alice.id, first.id)
    expect((await service.publish(alice.id, { ...input, videoMediaId: video(alice.id).id })).id).toBe(first.id)
    expect(driver.publish.mock.calls[0][1].video?.buffer).toEqual(buffer)
  })
  it('marks interrupted jobs uncertain across restart and preserves account state', async () => {
    const { database, alice, article, restart } = setup()
    const render = article()
    const job = database.createDouyinPublication(alice.id, { renderId: render.id, title: '测试', mode: 'publish', idempotencyKey: 'interrupted' })
    const reopened = await restart()
    expect(reopened.getDouyinPublication(alice.id, job.id)?.status).toBe('uncertain')
    expect(reopened.getDouyinAccount(alice.id)?.status).toBe('connected')
  })
})
