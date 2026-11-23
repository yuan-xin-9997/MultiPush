import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentDetail } from '../../shared/types'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { BilibiliService } from '../src/bilibili'
import { PlaywrightBilibiliDriver, type BilibiliArticleInput, type BilibiliDriver } from '../src/bilibili-browser'
import type { PublisherStorageState } from '../src/publisher-session'
import { renderPlatforms } from '../src/renderers'
import { publishBilibiliVideo, wbiMixinKey, wbiSign } from '../src/bilibili-api'
import { bilibiliCookies } from '../src/bilibili-cookies'

const directories: string[] = []
const databases: Database[] = []

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-bilibili-'))
  directories.push(directory)
  const database = openDatabase(path.join(directory, 'test.sqlite'))
  databases.push(database)
  return { directory, database, config: loadConfig({ dataDir: directory, jwtSecret: 'test-secret' }) }
}

function content(): ContentDetail {
  return {
    id: 'content-1',
    bookId: null,
    bookName: null,
    title: 'B 站发布测试',
    excerpt: '',
    coverImage: null,
    tags: ['测试'],
    status: 'ready',
    favorite: false,
    wordCount: 20,
    imageCount: 1,
    videoCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    kind: 'article',
    contentJson: {},
    contentHtml: '<h2>小节</h2><p>这是 B 站图文正文。</p><p><img src="/uploads/a.png"></p>',
  }
}

function state(): PublisherStorageState {
  return {
    cookies: [{
      name: 'SESSDATA', value: 'session', domain: '.bilibili.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax',
    }, {
      name: 'bili_jct', value: 'csrf', domain: '.bilibili.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax',
    }],
    origins: [],
  } as PublisherStorageState
}

class FakeBilibiliDriver implements BilibiliDriver {
  articleCalls: BilibiliArticleInput[] = []
  async beginLogin() {
    return {
      poll: async () => ({ status: 'connected' as const, qrCode: null, message: 'ok', state: state(), identity: { accountId: '42', name: '测试 UP 主' } }),
      close: async () => {},
    }
  }
  async checkSession() { return { state: state(), identity: { accountId: '42', name: '测试 UP 主' } } }
  async publishArticle(_state: PublisherStorageState, article: BilibiliArticleInput, mode: 'draft' | 'publish') {
    this.articleCalls.push(article)
    return {
      state: state(),
      result: mode === 'draft'
        ? { status: 'draft' as const, remoteId: '123', url: 'https://member.bilibili.com/platform/upload/text?aid=123', message: '已保存草稿' }
        : { status: 'published' as const, remoteId: '456', url: 'https://www.bilibili.com/opus/456', message: '已发布' },
    }
  }
  async close() {}
}

async function waitFor(database: Database, userId: string, id: string, timeout = 5_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const publication = database.getBilibiliPublication(userId, id)
    if (publication && publication.status !== 'running') return publication
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('publication did not settle')
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    try { database.close() } catch {}
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Bilibili credentials', () => {
  it('extracts cookies and builds a WBI signature', () => {
    expect(bilibiliCookies(state())).toEqual({
      cookie: 'SESSDATA=session; bili_jct=csrf',
      csrf: 'csrf',
    })
    const key = wbiMixinKey('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_')
    expect(key).toHaveLength(32)
    const signed = wbiSign({ foo: "a'b", bar: 1 }, 'img-key', 'sub-key')
    expect(signed.wts).toBeTypeOf('number')
    expect(signed.w_rid).toMatch(/^[a-f0-9]{32}$/)
  })
})

describe('Bilibili article image upload', () => {
  it('uses the editor BFS endpoint with WBI, CSRF and the expected multipart fields', async () => {
    const post = vi.fn(async (url: string, options: { multipart: Record<string, unknown> }) => {
      expect(url).toContain('/x/dynamic/feed/draw/upload_bfs?')
      expect(url).toContain('w_rid=')
      expect(url).toContain('wts=')
      expect(options.multipart).toMatchObject({ biz: 'new_dyn', category: 'daily', csrf: 'csrf' })
      expect(options.multipart.file_up).toMatchObject({ name: 'image-1', mimeType: 'image/png' })
      return {
        status: () => 200,
        json: async () => ({ code: 0, data: { image_url: 'http://i0.hdslb.com/bfs/new_dyn/test.png', image_width: 800, image_height: 500, img_size: 3.7 } }),
      }
    })
    const driver = new PlaywrightBilibiliDriver()
    const uploadImage = (driver as unknown as {
      uploadImage: (context: unknown, state: PublisherStorageState, image: { name: string; mime: string; buffer: Buffer }, keys: { imgKey: string; subKey: string }, index: number, total: number) => Promise<{ url: string; width: number; height: number; size: number }>
    }).uploadImage.bind(driver)
    const result = await uploadImage({ request: { post } }, state(), { name: 'image-1', mime: 'image/png', buffer: Buffer.from('image') }, { imgKey: 'img', subKey: 'sub' }, 0, 1)
    expect(result).toEqual({ url: 'https://i0.hdslb.com/bfs/new_dyn/test.png', width: 800, height: 500, size: 3.7 })
    expect(post).toHaveBeenCalledTimes(1)
  })
})

describe('Bilibili service', () => {
  it('logs in through the QR driver, encrypts the session and lists the account', async () => {
    const { database, config } = setup()
    const user = database.createUser({ username: 'bili_login', email: 'bili-login@example.com', passwordHash: 'hash', displayName: 'UP' })
    const driver = new FakeBilibiliDriver()
    const service = new BilibiliService(database, config, driver)
    const login = await service.beginLogin(user.id)
    const connected = login.status === 'connected' ? login : await service.loginStatus(user.id, login.id)
    expect(connected.status).toBe('connected')
    expect((await service.account(user.id)).status).toBe('connected')
    expect(database.getBilibiliAccount(user.id)?.name).toBe('测试 UP 主')
    service.close()
  })

  it('uploads cover and video parts then submits an add/v3 payload', async () => {
    const { directory } = setup()
    const videoPath = path.join(directory, 'demo.mp4')
    writeFileSync(videoPath, Buffer.from('0123456789'))
    const originalFetch = globalThis.fetch
    let submitBody: Record<string, unknown> | null = null
    let submitUrl = ''
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/x/vu/web/cover/up')) return new Response(JSON.stringify({ code: 0, data: { url: 'https://i0.hdslb.com/cover.jpg' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/preupload')) return new Response(JSON.stringify({ OK: 1, endpoint: '//upos.example.com', upos_uri: 'upos://bucket/demo.mp4', auth: 'auth-token', biz_id: 123, chunk_size: 4 }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.startsWith('https://upos.example.com/bucket/demo.mp4')) {
        if (method === 'PUT') return new Response('', { status: 200, headers: { etag: `"etag-${new URL(url).searchParams.get('partNumber')}"` } })
        if (url.includes('name=')) return new Response(JSON.stringify({ OK: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
        return new Response(JSON.stringify({ OK: 1, upload_id: 'upload-1' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/types/predict')) return new Response(JSON.stringify({ code: 0, data: [{ id: 231, name: '计算机技术', human_type: { id: 188 } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { isLogin: true, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/img.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/sub.png' } } }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/x/geetest/pre/add')) return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/x/vu/web/add/v3')) {
        submitUrl = url
        submitBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return new Response(JSON.stringify({ code: 0, data: { bvid: 'BV1test', aid: 9 } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected fetch ${method} ${url}`)
    }) as typeof fetch
    try {
      const result = await publishBilibiliVideo({ cookie: 'SESSDATA=x; bili_jct=csrf', csrf: 'csrf' }, {
        videoPath,
        videoName: 'demo.mp4',
        coverBuffer: Buffer.from('cover'),
        coverMime: 'image/png',
        title: '测试投稿',
        desc: '简介',
        tags: '测试,技术',
      }, () => {})
      expect(result).toEqual({ bvid: 'BV1test', aid: 9, url: 'https://www.bilibili.com/video/BV1test' })
      expect(submitUrl).toMatch(/w_rid=[a-f0-9]{32}/)
      expect(submitBody).toMatchObject({
        cover: 'https://i0.hdslb.com/cover.jpg',
        title: '测试投稿',
        tid: 231,
        tag: '测试,技术',
        desc: '简介',
        videos: [{ filename: 'demo', cid: 123 }],
        human_type2: 188,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('publishes an article through the driver and persists the publication', async () => {
    const { database, config } = setup()
    const user = database.createUser({ username: 'bili_article', email: 'bili-article@example.com', passwordHash: 'hash', displayName: 'UP' })
    writeFileSync(path.join(config.uploadsDir, 'a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64'))
    const created = database.createContent(user.id, { ...content(), bookId: null })
    const detail = { ...content(), id: created.id }
    const [result] = await renderPlatforms({ content: detail, platforms: ['bilibili'], options: { includeTags: true }, authorName: 'UP', baseUrl: 'http://localhost' })
    const render = database.createRender(user.id, { contentId: detail.id, contentTitle: detail.title, platforms: ['bilibili'], options: {}, results: [result] })
    const driver = new FakeBilibiliDriver()
    const service = new BilibiliService(database, config, driver)
    const login = await service.beginLogin(user.id)
    await service.loginStatus(user.id, login.id)
    const publication = await service.publish(user.id, { renderId: render.id, type: 'article', mode: 'draft' })
    const settled = await waitFor(database, user.id, publication.id)
    expect(settled.status).toBe('draft')
    expect(settled.remoteId).toBe('123')
    expect(driver.articleCalls).toHaveLength(1)
    expect(driver.articleCalls[0].title.length).toBeLessThanOrEqual(40)
    expect(driver.articleCalls[0].html).toContain('data-multipush-image="0"')
    expect(driver.articleCalls[0].html.indexOf('小节')).toBeLessThan(driver.articleCalls[0].html.indexOf('data-multipush-image'))
    service.close()
  })
})
