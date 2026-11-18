import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { load } from 'cheerio'
import type { ContentDetail, PlatformRender } from '../../shared/types'
import { renderPlatforms } from '../src/renderers'
import { adjustPlatformRender } from '../src/render-adjustment'
import { ApiError } from '../src/errors'
import { WechatpicService } from '../src/wechatpic'
import { WechatStickerApiDriver, type WechatStickerDriver } from '../src/wechatpic-api'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { decryptPublisherSecret, encryptPublisherSecret, loadPublisherKey } from '../src/publisher-session'
import { wechatpicConnectSchema, wechatpicPublishSchema } from '../src/validation'
import { publishChecks } from '../../shared/render-workbench'

const credentials = { appId: 'wx1234567890abcdef', appSecret: 'a'.repeat(32) }
const identity = { accountId: credentials.appId, name: '迷茫的旅行商' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')

function content(overrides: Partial<ContentDetail> = {}): ContentDetail {
  return {
    id: 'content-1',
    bookId: null,
    bookName: null,
    title: '一次创作，多平台发布',
    excerpt: '摘要',
    coverImage: null,
    tags: ['内容创作', '效率'],
    status: 'ready',
    favorite: false,
    wordCount: 20,
    imageCount: 1,
    videoCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    contentJson: { type: 'doc', content: [] },
    contentHtml: '<h1>一次创作，多平台发布</h1><p>这是 MultiPush 的示例内容。</p><p><img src="/uploads/cover.png" alt="cover"></p><p>配文结尾。</p>',
    ...overrides,
  }
}

function renderInput(platforms: 'wechatpic'[], overrides: Partial<ContentDetail> = {}) {
  return {
    content: content(overrides),
    platforms,
    options: { cardStyle: 'clean' as const, includeTags: true },
    authorName: 'MultiPush 编辑部',
    baseUrl: 'http://192.168.0.111:34080',
  }
}

const cleanups: Array<() => Promise<void>> = []

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-wechatpic-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' })
  const database = openDatabase(path.join(directory, 'test.sqlite'))
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const driver = {
    checkSession: vi.fn<WechatStickerDriver['checkSession']>().mockResolvedValue({ identity }),
    publish: vi.fn<WechatStickerDriver['publish']>().mockResolvedValue({ status: 'draft' as const, remoteId: 'draft-media-1', message: '已创建公众号贴图草稿，请在公众号后台手动发表' }),
    deleteDraft: vi.fn<WechatStickerDriver['deleteDraft']>().mockResolvedValue({ message: '已删除公众号贴图草稿', remoteDeleted: true }),
  }
  const service = new WechatpicService(database, config, driver)
  const key = loadPublisherKey(directory, 'wechatpic')
  database.saveWechatpicAccount(alice.id, {
    encryptedCredentials: encryptPublisherSecret(credentials, key, alice.id),
    appId: credentials.appId,
    name: identity.name,
    status: 'connected',
    checkedAt: new Date().toISOString(),
  })
  const image = (userId = alice.id) => {
    const filename = `${randomUUID()}.png`
    writeFileSync(path.join(config.uploadsDir, filename), png)
    return database.createMedia(userId, { filename, originalName: filename, kind: 'image', mimeType: 'image/png', size: png.length })
  }
  /** Save a real content + fake wechatpic render whose asset points at a freshly uploaded image. */
  const sticker = (html = '<p>正文内容</p><p><img src="__IMG__"></p>', detailOverrides: Partial<ContentDetail> = {}, recordOverrides: Partial<PlatformRender> = {}) => {
    const media = image()
    const resolvedHtml = html.split('__IMG__').join(`/uploads/${media.filename}`)
    const created = database.createContent(alice.id, {
      title: detailOverrides.title ?? '一次创作，多平台发布',
      contentHtml: resolvedHtml,
      contentJson: {},
      excerpt: '',
      bookId: null,
      coverImage: null,
      tags: detailOverrides.tags ?? ['内容创作', '效率'],
      status: 'ready',
      favorite: false,
      wordCount: 20,
      imageCount: 1,
      videoCount: 0,
    })
    const record: PlatformRender = {
      platform: 'wechatpic',
      title: created.title,
      html: `<div data-mp-wechatpic="1"><img src="/uploads/${media.filename}" alt="" /></div>`,
      markdown: null,
      text: `${created.title}\n\n正文内容`,
      previewMode: 'vertical',
      themeColor: '#07c160',
      meta: { wordCount: 4, imageCount: 1, videoCount: 0, readMinutes: 1, tags: created.tags, titleLength: Array.from(created.title).length, summary: '正文内容' },
      cards: [],
      assets: [{ filename: media.filename, url: `/uploads/${media.filename}`, kind: 'image' }],
      videos: [],
      warnings: [],
      downloads: [],
      generatedAt: created.updatedAt,
      sourceUpdatedAt: created.updatedAt,
      captionBody: '正文内容',
      ...recordOverrides,
    }
    return database.createRender(alice.id, { contentId: created.id, contentTitle: created.title, platforms: ['wechatpic'], results: [record], options: {} })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, config, database, service, alice, bob, driver, image, sticker, key }
}

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const finish = async (service: WechatpicService, owner: string, id: string) => {
  await vi.waitFor(() => expect(service.get(owner, id).status).not.toBe('running'))
  return service.get(owner, id)
}

describe('wechatpic renderer', () => {
  it('extracts images in document order, caps at 20 and builds caption text', async () => {
    const html = ['<p>第一段</p>', ...Array.from({ length: 21 }, (_, index) => `<p><img src="/uploads/p${index}.png"></p>`), '<p>结尾</p>'].join('')
    const [result] = await renderPlatforms(renderInput(['wechatpic'], { contentHtml: html }))
    expect(result.platform).toBe('wechatpic')
    expect(result.assets.filter((asset) => asset.kind === 'image')).toHaveLength(20)
    expect(result.captionBody).toContain('第一段')
    expect(result.text).toContain('第一段')
    expect(result.text).toContain('#内容创作')
    expect(result.downloads.some((item) => item.kind === 'text')).toBe(true)
    expect(result.downloads.some((item) => item.filename.endsWith('贴图.json'))).toBe(true)
    const $ = load(result.html)
    expect($('img')).toHaveLength(20)
  })

  it('truncates the title to 32 chars, warns about missing images and passes videos through', async () => {
    const [result] = await renderPlatforms(renderInput(['wechatpic'], { contentHtml: '<p>只有文字没有图片</p><video src="/uploads/demo.mp4"></video>', title: '字'.repeat(40) }))
    expect(Array.from(result.title)).toHaveLength(32)
    expect(result.warnings.some((warning) => warning.includes('至少需要 1 张图片'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('超过公众号贴图建议的 32 字'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('不支持视频'))).toBe(true)
    expect(result.videos).toHaveLength(1)
  })
})

describe('wechatpic workbench', () => {
  it('rebuilds caption text when the sticker body is adjusted', async () => {
    const [base] = await renderPlatforms(renderInput(['wechatpic']))
    const adjusted = await adjustPlatformRender(base, { title: base.title, body: '新的配文', tags: ['旅行'] }, { cardStyle: 'clean' }, 'http://192.168.0.111:34080')
    expect(adjusted.captionBody).toBe('新的配文')
    expect(adjusted.text).toBe(`${base.title}\n\n新的配文\n\n#旅行`)
    expect(adjusted.downloads.some((item) => item.filename.endsWith('贴图.json'))).toBe(true)
  })

  it('requires a non-empty caption in publish checks', async () => {
    const [base] = await renderPlatforms(renderInput(['wechatpic']))
    expect(publishChecks(base).find((check) => check.label.includes('文案'))?.ok).toBe(true)
    const [empty] = await renderPlatforms(renderInput(['wechatpic'], { contentHtml: '<p><img src="/uploads/p0.png"></p>' }))
    expect(publishChecks(empty).find((check) => check.label.includes('文案'))?.ok).toBe(false)
  })
})

describe('wechatpic validation', () => {
  it('accepts a valid appid/secret pair and rejects malformed values', () => {
    expect(wechatpicConnectSchema.parse({ appId: 'wx1234567890abcdef', appSecret: 'a'.repeat(32) })).toBeTruthy()
    expect(() => wechatpicConnectSchema.parse({ appId: 'gh_1234', appSecret: 'a'.repeat(32) })).toThrow()
    expect(() => wechatpicConnectSchema.parse({ appId: 'wx1234567890abcdef', appSecret: 'short' })).toThrow()
    expect(wechatpicPublishSchema.parse({ renderId: randomUUID() })).toBeTruthy()
  })
})

describe('WechatStickerApiDriver', () => {
  it('fails the connection when the token endpoint rejects the credentials', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      assert.ok(String(url).includes('/token?'), 'the driver must fetch a token before anything else')
      return new Response(JSON.stringify({ errcode: 40001, errmsg: 'invalid credential' }), { headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const driver = new WechatStickerApiDriver()
      await expect(driver.checkSession(credentials)).rejects.toMatchObject({ code: 'wechatpic_auth_failed' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('verifies the token first and then reads the account nickname', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url)
      if (target.includes('/token?')) {
        calls.push('token')
        return new Response(JSON.stringify({ access_token: 'TOKEN', expires_in: 7200 }), { headers: { 'Content-Type': 'application/json' } })
      }
      calls.push(target)
      return new Response(JSON.stringify({ errcode: 0, nickname: '迷茫的旅行商' }), { headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const driver = new WechatStickerApiDriver()
      const result = await driver.checkSession(credentials)
      expect(result).toEqual({ identity: { accountId: credentials.appId, name: '迷茫的旅行商' } })
      expect(calls[0]).toBe('token')
      expect(calls[1]).toContain('/account/getaccountbasicinfo')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('WechatpicService', () => {
  it('encrypts credentials with owner binding and reports account states', async () => {
    const { database, alice, bob, key, service } = setup()
    const encrypted = database.getWechatpicAccount(alice.id)!.encryptedCredentials
    expect(decryptPublisherSecret(encrypted, key, alice.id)).toEqual(credentials)
    expect(() => decryptPublisherSecret(encrypted, key, bob.id)).toThrow()
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
    const account = await service.account(alice.id)
    expect(account).toMatchObject({ status: 'connected', name: '迷茫的旅行商' })
    expect(JSON.stringify(account)).not.toContain(credentials.appSecret)
    await service.disconnect(alice.id)
    expect(database.getWechatpicAccount(alice.id)).toBeNull()
  })

  it('connects with AppID/AppSecret and surfaces credential failures', async () => {
    const { service, bob, driver } = setup()
    const account = await service.connect(bob.id, credentials)
    expect(account).toMatchObject({ status: 'connected', name: '迷茫的旅行商', appId: credentials.appId })
    expect(driver.checkSession).toHaveBeenCalledWith(credentials)
    driver.checkSession.mockRejectedValue(new ApiError(409, 'wechatpic_auth_failed', 'AppID 或 AppSecret 无效'))
    await expect(service.connect(bob.id, { appId: 'wx1234567890abcdef', appSecret: 'b'.repeat(32) })).rejects.toMatchObject({ code: 'wechatpic_auth_failed' })
  })

  it('creates a draft from the saved render and reuses it on repeated submissions', async () => {
    const { service, alice, driver, sticker } = setup()
    const render = sticker()
    const publication = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    const done = await finish(service, alice.id, publication.id)
    expect(done).toMatchObject({ status: 'draft', remoteId: 'draft-media-1', mode: 'draft' })
    expect(done.message).toContain('手动发表')
    const draft = driver.publish.mock.calls[0][1]
    expect(draft.title).toBe('一次创作，多平台发布')
    expect(draft.body).toContain('正文内容')
    expect(draft.images).toHaveLength(1)
    expect(draft.images[0].mimeType).toBe('image/png')
    const again = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    expect(again.id).toBe(publication.id)
    expect(driver.publish).toHaveBeenCalledTimes(1)
  })

  it('rejects cross-user renders, missing images, videos and oversized titles before submission', async () => {
    const { service, database, alice, bob, sticker } = setup()
    const render = sticker()
    // Credentials are checked before render ownership, so a cross-user submit
    // surfaces as a connection error for an unconnected user (no existence leak).
    await expect(service.publish(bob.id, { renderId: render.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ status: 409 })
    const noImages = sticker('<p>没有图片的贴图</p>', {}, { assets: [] })
    await expect(service.publish(alice.id, { renderId: noImages.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'wechatpic_image_required' })
    const video = sticker('<p>视频</p>', {}, { videos: ['/uploads/demo.mp4'] })
    await expect(service.publish(alice.id, { renderId: video.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'wechatpic_media_unsupported' })
    database.saveRenderDraft(alice.id, render.id, { ...render.results[0], title: '字'.repeat(33) })
    await expect(service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'wechatpic_title_invalid' })
  })

  it('rejects stale renders when the source has changed', async () => {
    const { service, database, alice, sticker } = setup()
    const render = sticker()
    database.saveRenderDraft(alice.id, render.id, { ...render.results[0], sourceUpdatedAt: '2000-01-01T00:00:00.000Z' })
    await expect(service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'wechatpic_render_stale' })
  })

  it('stays uncertain when the draft state is unknown and blocks further submissions', async () => {
    const { service, alice, driver, sticker } = setup()
    driver.publish.mockRejectedValue(new Error('boom'))
    const render = sticker()
    const publication = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    await finish(service, alice.id, publication.id)
    expect(service.get(alice.id, publication.id).status).toBe('uncertain')
    await expect(service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'wechatpic_result_uncertain' })
  })

  it('keeps the draft status with a warning when only verification failed', async () => {
    const { service, alice, driver, sticker } = setup()
    driver.publish.mockImplementation(async (_credentials, _draft, progress) => {
      progress({ remoteId: 'draft-media-9', message: '正在核对贴图草稿' })
      throw new Error('verify failed')
    })
    const render = sticker()
    const publication = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    await finish(service, alice.id, publication.id)
    const done = service.get(alice.id, publication.id)
    expect(done.status).toBe('draft')
    expect(done.remoteId).toBe('draft-media-9')
    expect(done.message).toContain('核对')
  })

  it('deletes the remote draft with the record and tolerates a missing draft', async () => {
    const { service, alice, driver, sticker } = setup()
    const render = sticker()
    const publication = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    await finish(service, alice.id, publication.id)
    expect(await service.remove(alice.id, publication.id)).toEqual({ ok: true, remoteDeleted: true })
    expect(driver.deleteDraft).toHaveBeenCalledWith(credentials, 'draft-media-1')
    expect(service.list(alice.id)).toHaveLength(0)
    driver.deleteDraft.mockResolvedValue({ message: '草稿已不存在（可能已发表或已删除），已清理本地发布记录', remoteDeleted: false })
    const second = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    await finish(service, alice.id, second.id)
    expect(await service.remove(alice.id, second.id)).toEqual({ ok: true, remoteDeleted: false })
  })

  it('marks known WeChat rejections as failed and expires the connection on auth errors', async () => {
    const { service, database, alice, driver, sticker } = setup()
    driver.publish.mockRejectedValue(new ApiError(502, 'wechatpic_upload_failed', '上传贴图图片到微信失败'))
    const render = sticker()
    const publication = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    await finish(service, alice.id, publication.id)
    expect(service.get(alice.id, publication.id).status).toBe('failed')
    expect(database.getWechatpicAccount(alice.id)?.status).toBe('connected')
    driver.publish.mockRejectedValue(new ApiError(409, 'wechatpic_auth_failed', 'AppID 或 AppSecret 无效'))
    const next = await service.publish(alice.id, { renderId: render.id }, 'http://127.0.0.1:34080')
    await finish(service, alice.id, next.id)
    expect(service.get(alice.id, next.id).status).toBe('failed')
    expect(database.getWechatpicAccount(alice.id)?.status).toBe('expired')
  })
})
