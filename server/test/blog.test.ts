import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlogService } from '../src/blog'
import { blogAbsoluteUrl, blogSlug, prepareBlogContent, verifyBlogContent } from '../src/blog-content'
import { HaloBlogDriver, canonicalBlogBaseUrl, normalizeBlogBaseUrl, type BlogDriver } from '../src/blog-halo'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { ApiError } from '../src/errors'
import { decryptPublisherSecret, encryptPublisherSecret, loadPublisherKey } from '../src/publisher-session'
import type { PlatformRender } from '../../shared/types'

const cleanups: Array<() => Promise<void>> = []
const credentials = { baseUrl: 'https://blog.example.com', token: 'pat_test_token' }
const identity = { accountId: 'yuanxin', name: '管理员' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-blog-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' })
  let database: Database = openDatabase(path.join(directory, 'test.sqlite'))
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const driver = {
    checkSession: vi.fn<BlogDriver['checkSession']>().mockResolvedValue({ identity }),
    checkPublication: vi.fn<BlogDriver['checkPublication']>().mockResolvedValue({ status: 'unknown', url: null, message: '请人工核实' }),
    publish: vi.fn<BlogDriver['publish']>().mockResolvedValue({ status: 'published', remoteId: 'post-1', url: 'https://blog.example.com/archives/test', message: '成功' }),
    deleteDraft: vi.fn<BlogDriver['deleteDraft']>().mockResolvedValue({ message: '已删除个人博客草稿' }),
  }
  const service = new BlogService(database, config, driver, async (value) => normalizeBlogBaseUrl(value))
  const key = loadPublisherKey(directory, 'blog')
  database.saveBlogAccount(alice.id, {
    encryptedCredentials: encryptPublisherSecret(credentials, key, alice.id),
    accountId: identity.accountId,
    baseUrl: credentials.baseUrl,
    name: identity.name,
    status: 'connected',
    checkedAt: new Date().toISOString(),
  })
  const image = (userId = alice.id) => {
    const filename = `${randomUUID()}.png`
    writeFileSync(path.join(config.uploadsDir, filename), png)
    return database.createMedia(userId, { filename, originalName: filename, kind: 'image', mimeType: 'image/png', size: png.length })
  }
  const article = (html = '<p>正文内容</p>', tags = ['效率', '工具']) => {
    const content = database.createContent(alice.id, { title: '测试个人博客文章', contentHtml: html, contentJson: {}, excerpt: '', bookId: null, coverImage: null, tags, status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const result: PlatformRender = {
      platform: 'blog', title: content.title, html, markdown: null, text: '正文内容', previewMode: 'article', themeColor: '#0f172a',
      meta: { wordCount: 4, imageCount: 0, videoCount: 0, readMinutes: 1, tags, titleLength: Array.from(content.title).length, summary: '' },
      cards: [], assets: [], videos: [], warnings: [], downloads: [], generatedAt: content.updatedAt, sourceUpdatedAt: content.updatedAt,
    }
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['blog'], results: [result], options: {} })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return {
    directory, config, database, service, alice, bob, driver, image, article, key,
    restart: async () => { await service.close(); database.close(); database = openDatabase(path.join(directory, 'test.sqlite')); return database },
  }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const finish = async (service: BlogService, owner: string, id: string) => {
  await vi.waitFor(() => expect(service.get(owner, id).status).not.toBe('running'))
  return service.get(owner, id)
}

describe('Blog publishing', () => {
  it('normalizes blog URLs, reads credentials and makes slugs', () => {
    expect(normalizeBlogBaseUrl('https://blog.example.com/')).toBe('https://blog.example.com')
    expect(normalizeBlogBaseUrl('https://blog.example.com/prefix/')).toBe('https://blog.example.com/prefix')
    expect(() => normalizeBlogBaseUrl('ftp://blog.example.com')).toThrow()
    expect(() => normalizeBlogBaseUrl('https://user:pass@blog.example.com')).toThrow()
    expect(blogSlug('Hello World', 'seed')).toMatch(/^hello-world-\d{8}-[a-f0-9]{6}$/)
    expect(blogSlug('中文标题', 'seed')).toMatch(/^multipush-\d{8}-[a-f0-9]{6}$/)
    expect(blogAbsoluteUrl('https://blog.example.com/', '/upload/a.png')).toBe('https://blog.example.com/upload/a.png')
  })

  it('encrypts credentials with owner binding', async () => {
    const { database, alice, bob, key, service } = setup()
    const encrypted = database.getBlogAccount(alice.id)!.encryptedCredentials
    expect(decryptPublisherSecret(encrypted, key, alice.id)).toEqual(credentials)
    expect(() => decryptPublisherSecret(encrypted, key, bob.id)).toThrow()
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
    expect(JSON.stringify(await service.account(alice.id))).not.toContain('pat_test_token')
    await service.disconnect(alice.id)
    expect(database.getBlogAccount(alice.id)).toBeNull()
  })

  it('connects with a validated Halo token and stores the account', async () => {
    const { service, bob, driver } = setup()
    const account = await service.connect(bob.id, { baseUrl: 'https://blog.example.com/', token: ' pat_new ' })
    expect(account).toMatchObject({ status: 'connected', name: '管理员', baseUrl: 'https://blog.example.com' })
    expect(driver.checkSession).toHaveBeenCalledWith({ baseUrl: 'https://blog.example.com', token: 'pat_new' })
    await expect(service.connect(bob.id, { baseUrl: 'https://blog.example.com', token: '' })).rejects.toMatchObject({ code: 'blog_token_invalid' })
  })

  it('publishes saved render with tags and suppresses duplicate submissions', async () => {
    const { service, alice, driver, image, article } = setup()
    const media = image()
    const render = article(`<p>正文内容</p><p><img src="/uploads/${media.filename}"></p>`)
    const input = { renderId: render.id, mode: 'publish' as const }
    const published = await service.publish(alice.id, input, 'http://127.0.0.1:34080')
    const done = await finish(service, alice.id, published.id)
    expect(done).toMatchObject({ status: 'published', remoteId: 'post-1', url: 'https://blog.example.com/archives/test' })
    expect(driver.publish.mock.calls[0][1].tags).toEqual(['效率', '工具'])
    expect(driver.publish.mock.calls[0][1].images.size).toBe(1)
    const again = await service.publish(alice.id, input, 'http://127.0.0.1:34080')
    expect(again.id).toBe(published.id)
    expect(driver.publish).toHaveBeenCalledTimes(1)
  })

  it('rejects cross-user renders, videos and invalid titles before submission', async () => {
    const { service, database, alice, bob, article, driver } = setup()
    const render = article()
    await expect(service.publish(bob.id, { renderId: render.id, mode: 'publish' }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ status: 409 })
    database.saveRenderDraft(alice.id, render.id, { ...render.results[0], title: '字'.repeat(121) })
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'publish' }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'blog_title_invalid' })
    const video = article('<p>视频</p><video src="/uploads/demo.mp4"></video>')
    await expect(service.publish(alice.id, { renderId: video.id, mode: 'publish' }, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'blog_media_unsupported' })
    expect(driver.publish).not.toHaveBeenCalled()
  })

  it('blocks uncertain results until the owner explicitly resolves them', async () => {
    const { service, alice, bob, driver, article } = setup()
    const input = { renderId: article().id, mode: 'publish' as const }
    driver.publish.mockRejectedValue(new ApiError(409, 'blog_result_uncertain', '结果待核实'))
    const publication = await service.publish(alice.id, input, 'http://127.0.0.1:34080')
    expect((await finish(service, alice.id, publication.id)).status).toBe('uncertain')
    await expect(service.publish(alice.id, input, 'http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'blog_result_uncertain' })
    await expect(service.resolve(bob.id, publication.id, { action: 'not_published' })).rejects.toMatchObject({ status: 404 })
    await expect(service.resolve(alice.id, publication.id, { action: 'published', articleUrl: 'https://evil.example/archives/x' })).rejects.toMatchObject({ status: 400 })
    await service.resolve(alice.id, publication.id, { action: 'published', articleUrl: 'https://blog.example.com/archives/x' })
    expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'published', url: 'https://blog.example.com/archives/x' })
  })

  it('marks interrupted jobs uncertain across restart and preserves account state', async () => {
    const { database, alice, article, restart } = setup()
    const render = article()
    const job = database.createBlogPublication(alice.id, { renderId: render.id, title: '测试', mode: 'draft', idempotencyKey: 'interrupted' })
    const reopened = await restart()
    expect(reopened.getBlogPublication(alice.id, job.id)?.status).toBe('uncertain')
    expect(reopened.getBlogAccount(alice.id)?.status).toBe('connected')
  })
})

describe('Blog content preparation', () => {
  it('demotes duplicate titles, strips styles and wraps images', () => {
    const html = '<h1 style="color:red">标题</h1><p style="color:red">正文<script>alert(1)</script></p><p><img src="/upload/a.png" style="width:10px"></p>'
    const prepared = prepareBlogContent(html)
    expect(prepared).toContain('<h2>标题</h2>')
    expect(prepared).not.toContain('style=')
    expect(prepared).not.toContain('<script')
    expect(prepared).toContain('<figure')
    expect(prepared).toContain('/upload/a.png')
  })

  it('compares text, image paths and structure after read-back', () => {
    const expected = '<h2>标题</h2><p>正文</p><figure><img src="/upload/a.png"></figure>'
    const stored = '<h2>标题</h2><p>正文</p><figure class="image"><img src="/upload/a.png?width=800"></figure>'
    expect(() => verifyBlogContent(expected, stored)).not.toThrow()
    expect(() => verifyBlogContent(expected, '<h2>标题</h2><p>正文变了</p><figure><img src="/upload/a.png"></figure>')).toThrow()
  })
})


describe('Blog draft deletion', () => {
  it('deletes the remote Halo draft and local record for the owner only', async () => {
    const { service, database, driver, alice, bob } = setup()
    const draft = database.createBlogPublication(alice.id, { renderId: 'render-id', title: '待删草稿', mode: 'draft', idempotencyKey: 'draft-key' })
    database.updateBlogPublication(alice.id, draft.id, { status: 'draft', remoteId: 'post-2' })
    await expect(service.remove(bob.id, draft.id)).rejects.toMatchObject({ status: 404 })
    await expect(service.remove(alice.id, draft.id)).resolves.toEqual({ ok: true, remoteDeleted: true })
    expect(driver.deleteDraft).toHaveBeenCalledWith(credentials, 'post-2')
    expect(database.getBlogPublication(alice.id, draft.id)).toBeNull()
  })

  it('rejects published records and keeps the local record when remote deletion fails', async () => {
    const { service, database, driver, alice } = setup()
    const published = database.createBlogPublication(alice.id, { renderId: 'render-id', title: '已发布', mode: 'publish', idempotencyKey: 'publish-key' })
    database.updateBlogPublication(alice.id, published.id, { status: 'published' })
    await expect(service.remove(alice.id, published.id)).rejects.toMatchObject({ code: 'blog_delete_published' })

    const draft = database.createBlogPublication(alice.id, { renderId: 'render-id', title: '远端草稿', mode: 'draft', idempotencyKey: 'draft-key' })
    database.updateBlogPublication(alice.id, draft.id, { status: 'draft', remoteId: 'post-3' })
    driver.deleteDraft.mockRejectedValueOnce(new ApiError(502, 'blog_draft_delete_failed', '删除失败'))
    await expect(service.remove(alice.id, draft.id)).rejects.toMatchObject({ code: 'blog_draft_delete_failed' })
    expect(database.getBlogPublication(alice.id, draft.id)).not.toBeNull()
  })
})


describe('Halo browserless draft deletion', () => {
  it('deletes only an unpublished Halo post and verifies the post is gone', async () => {
    let deleted = false
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE' && url.endsWith('/apis/api.console.halo.run/v1alpha1/posts/post-2')) {
        deleted = true
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/apis/content.halo.run/v1alpha1/posts/post-2')) {
        if (deleted) return new Response(JSON.stringify({ title: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } })
        return new Response(JSON.stringify({ metadata: { name: 'post-2' }, spec: { publish: false, title: '草稿' }, status: { phase: 'DRAFT' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/apis/content.halo.run/v1alpha1/posts/post-3')) {
        return new Response(JSON.stringify({ metadata: { name: 'post-3' }, spec: { publish: true, title: '已发布' }, status: { phase: 'PUBLISHED' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ title: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(new HaloBlogDriver().deleteDraft(credentials, 'post-2')).resolves.toEqual({ message: '已删除个人博客草稿' })
      await expect(new HaloBlogDriver().deleteDraft(credentials, 'post-3')).rejects.toMatchObject({ code: 'blog_delete_published' })
      await expect(new HaloBlogDriver().deleteDraft(credentials, 'missing')).resolves.toMatchObject({ message: expect.stringContaining('已不存在') })
    } finally { vi.unstubAllGlobals() }
  })
})


describe('Halo SSRF guard', () => {
  it('rejects loopback and private blog addresses', async () => {
    await expect(canonicalBlogBaseUrl('http://127.0.0.1:34080')).rejects.toMatchObject({ code: 'blog_url_blocked' })
    await expect(new HaloBlogDriver().checkSession({ baseUrl: 'http://127.0.0.1:1', token: 'token' }))
      .rejects.toMatchObject({ code: 'blog_url_blocked' })
    await expect(new HaloBlogDriver().checkSession({ baseUrl: 'http://192.168.0.111:34080', token: 'token' }))
      .rejects.toMatchObject({ code: 'blog_url_blocked' })
  })

  it('allows private addresses only with the explicit local override', async () => {
    await expect(new HaloBlogDriver(true).checkSession({ baseUrl: 'http://127.0.0.1:1', token: 'token' }))
      .rejects.not.toMatchObject({ code: 'blog_url_blocked' })
  })
})
