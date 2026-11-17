import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BatchService } from '../src/batch'
import type { BlogService } from '../src/blog'
import type { DouyinService } from '../src/douyin'
import type { WeiboService } from '../src/weibo'
import type { ToutiaoService } from '../src/toutiao'
import type { DoubanService } from '../src/douban'
import type { JuejinService } from '../src/juejin'
import type { JianshuService } from '../src/jianshu'
import type { SspaiService } from '../src/sspai'
import type { WechatService } from '../src/wechat'
import type { ZhihuService } from '../src/zhihu'
import { AiService } from '../src/ai'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { decryptPublisherSecret, loadPublisherKey } from '../src/publisher-session'
import type { PlatformRender } from '../../shared/types'

const cleanups: Array<() => Promise<void> | void> = []

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function setup(defaults?: { apiKey: string; baseUrl: string; model: string; label: string }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-ai-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test', jwtSecret: 'ai-test-secret', ...(defaults ? { aiDefaults: defaults } : {}) })
  const database = openDatabase(':memory:')
  const user = database.createUser({ username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const wechat = { publish: vi.fn(), remove: vi.fn() } as unknown as WechatService
  const zhihu = { publish: vi.fn() } as unknown as ZhihuService
  const sspai = { publish: vi.fn() } as unknown as SspaiService
  const blog = { publish: vi.fn() } as unknown as BlogService
  const douyin = { publish: vi.fn() } as unknown as DouyinService
  const weibo = { publish: vi.fn() } as unknown as WeiboService
  const toutiao = { publish: vi.fn() } as unknown as ToutiaoService
  const douban = { publish: vi.fn() } as unknown as DoubanService
  const juejin = { publish: vi.fn() } as unknown as JuejinService
  const jianshu = { publish: vi.fn() } as unknown as JianshuService
  const batch = {} as BatchService
  const service = new AiService(database, config, wechat, zhihu, sspai, blog, douyin, weibo, toutiao, douban, juejin, jianshu, batch)
  const session = service.createSession(user.id)
  cleanups.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, config, database, user, service, session, wechat, zhihu, sspai, blog, douyin, weibo, toutiao, douban, juejin, jianshu }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const content = (database: Database, userId: string, title = '测试文章') => database.createContent(userId, {
  title, bookId: null, contentJson: {}, contentHtml: '<p>正文内容</p>', excerpt: '', coverImage: null,
  tags: [], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0,
})

function toolCall(name: string, args: Record<string, unknown>, id = `call-${name}`) {
  return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }
}

describe('AI settings and chat', () => {
  it('encrypts the API key and never returns it in settings', () => {
    const { directory, database, user, service } = setup()
    const settings = service.saveSettings(user.id, { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-secret', temperature: 0.3 })
    expect(settings).toMatchObject({ configured: true, model: 'deepseek-chat', hasApiKey: true, temperature: 0.3 })
    expect(JSON.stringify(settings)).not.toContain('sk-secret')
    const record = database.getAiSettings(user.id)!
    expect(record.encryptedApiKey).not.toContain('sk-secret')
    expect(decryptPublisherSecret<string>(record.encryptedApiKey, loadPublisherKey(directory, 'ai'), user.id)).toBe('sk-secret')
  })

  it('runs a read tool and stores the tool trace before the final answer', async () => {
    const { user, service, session } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    let calls = 0
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1
      if (calls === 1) return response(toolCall('list_contents', { pageSize: 1 }))
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
      expect(body.messages.some(message => message.role === 'tool' && message.content.includes('"ok":true'))).toBe(true)
      return response({ choices: [{ message: { role: 'assistant', content: '你的内容库目前有 0 篇内容。' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await service.chat(user.id, session.id, '看看我的内容库')
    expect(result.reply.content).toContain('0 篇')
    expect(result.session.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(result.session.messages[2]).toMatchObject({ toolName: 'list_contents', toolCallId: 'call-list_contents' })
    expect(result.session.title).toBe('看看我的内容库')
  })

  it('creates and renders an article through tools', async () => {
    const { database, user, service, session } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) return response(toolCall('create_content', { title: 'AI 生成文章', html: '<h2>开头</h2><p>正文</p>', tags: ['AI'] }))
      if (calls === 2) {
        const created = database.listContents(user.id, { favorite: false, trash: false, sort: 'updated_desc', page: 1, pageSize: 1 }).items[0]
        return response(toolCall('render_content', { contentId: created.id, platforms: ['zhihu'] }))
      }
      return response({ choices: [{ message: { role: 'assistant', content: '文章已创建并生成知乎排版。' } }] })
    }))
    const result = await service.chat(user.id, session.id, '写一篇关于 AI 的文章并生成知乎排版')
    const contents = database.listContents(user.id, { favorite: false, trash: false, sort: 'updated_desc', page: 1, pageSize: 10 })
    expect(contents.total).toBe(1)
    expect(contents.items[0]).toMatchObject({ title: 'AI 生成文章', tags: ['AI'] })
    expect(database.listRenders(user.id)).toHaveLength(1)
    expect(result.reply.content).toContain('知乎')
  })

  it('publishes a render through the platform service only when the tool is called', async () => {
    const { database, user, service, session, wechat } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    const article = content(database, user.id, '待发布文章')
    const record = database.createRender(user.id, {
      contentId: article.id, contentTitle: article.title, platforms: ['wechat'], options: {},
      results: [{
        platform: 'wechat', title: article.title, html: '<p>正文</p>', markdown: null, text: '正文', previewMode: 'article', themeColor: '#07c160',
        meta: { wordCount: 2, imageCount: 0, videoCount: 0, readMinutes: 1, tags: [], titleLength: 5, summary: '' },
        cards: [], assets: [], videos: [], warnings: [], downloads: [], generatedAt: new Date().toISOString(),
      }],
    })
    ;(wechat.publish as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'pub-1', status: 'draft', mode: 'draft', title: article.title, message: '已保存', url: null, remoteId: 'draft-1', renderId: record.id, qrCode: null, createdAt: '', updatedAt: '' })
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) return response(toolCall('publish_article', { renderId: record.id, platform: 'wechat', mode: 'draft', coverMediaId: 'cover-1' }))
      return response({ choices: [{ message: { role: 'assistant', content: '已保存为公众号草稿。' } }] })
    }))
    const result = await service.chat(user.id, session.id, '把这篇保存为公众号草稿')
    expect(wechat.publish).toHaveBeenCalledWith(user.id, { renderId: record.id, mode: 'draft', coverMediaId: 'cover-1' }, expect.any(String))
    expect(result.reply.content).toContain('草稿')
  })
})


describe('Server default AI provider', () => {
  it('uses the server OpenCode Go default and sends the required session header', async () => {
    const { user, service, session } = setup({
      apiKey: 'sk-server-default', baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'deepseek-v4.1-flash', label: 'OpenCode Go',
    })
    expect(service.settings(user.id)).toMatchObject({ configured: true, source: 'server', label: 'OpenCode Go', model: 'deepseek-v4.1-flash' })
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer sk-server-default')
      expect(headers['x-opencode-session']).toBe(`multipush-${session.id}`)
      return response({ choices: [{ message: { role: 'assistant', content: '正常' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await service.chat(user.id, session.id, '只回复正常')
    expect(result.reply.content).toBe('正常')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lets a user save only the model and reuse the server key', () => {
    const { user, service, database, directory } = setup({
      apiKey: 'sk-server-default', baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'deepseek-v4.1-flash', label: 'OpenCode Go',
    })
    const settings = service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'custom-model' })
    expect(settings).toMatchObject({ configured: true, source: 'user', baseUrl: 'https://api.example.com/v1', model: 'custom-model' })
    const record = database.getAiSettings(user.id)!
    expect(decryptPublisherSecret<string>(record.encryptedApiKey, loadPublisherKey(directory, 'ai'), user.id)).toBe('sk-server-default')
  })
})
