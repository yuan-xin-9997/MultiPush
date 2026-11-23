import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import type { CsdnService } from '../src/csdn'
import type { SspaiService } from '../src/sspai'
import type { WechatService } from '../src/wechat'
import type { ZhihuService } from '../src/zhihu'
import { AiService } from '../src/ai'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { decryptPublisherSecret, loadPublisherKey } from '../src/publisher-session'
import { VideoService } from '../src/video'
import { parseAiProvidersConfig, type AiProvidersConfig } from '../src/ai-provider-config'
import type { PlatformRender } from '../../shared/types'

const cleanups: Array<() => Promise<void> | void> = []

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function setup(
  defaults?: { apiKey: string; baseUrl: string; model: string; label: string },
  aiProviders?: AiProvidersConfig,
  options?: { writePoolFile?: unknown; nodeEnv?: string; settingsAdmins?: string[]; aiPoolDailyLimit?: number; aiPoolDailyTokens?: number; aiPoolAccess?: 'admin' | 'all'; aiPoolUsers?: string[] },
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-ai-'))
  if (options?.writePoolFile) {
    writeFileSync(path.join(directory, 'ai-providers.json'), JSON.stringify(options.writePoolFile), { mode: 0o600 })
  }
  const config = loadConfig({
    dataDir: directory,
    nodeEnv: options?.nodeEnv ?? 'test',
    jwtSecret: 'ai-test-secret',
    ...(defaults ? { aiDefaults: defaults } : {}),
    ...(aiProviders ? { aiProviders } : {}),
    ...(options?.settingsAdmins ? { settingsAdmins: options.settingsAdmins } : {}),
    ...(options?.aiPoolDailyLimit !== undefined ? { aiPoolDailyLimit: options.aiPoolDailyLimit } : {}),
    ...(options?.aiPoolDailyTokens !== undefined ? { aiPoolDailyTokens: options.aiPoolDailyTokens } : {}),
    ...(options?.aiPoolAccess ? { aiPoolAccess: options.aiPoolAccess } : {}),
    ...(options?.aiPoolUsers ? { aiPoolUsers: options.aiPoolUsers } : {}),
  })
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
  const csdn = { publish: vi.fn() } as unknown as CsdnService
  const batch = {} as BatchService
  const video = new VideoService(database, config)
  const service = new AiService(database, config, wechat, zhihu, sspai, blog, douyin, weibo, toutiao, douban, juejin, jianshu, csdn, batch, video)
  const session = service.createSession(user.id)
  cleanups.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, config, database, user, service, session, wechat, zhihu, sspai, blog, douyin, weibo, toutiao, douban, juejin, jianshu, csdn, video }
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
    const result = await service.chat(user.id, session.id, { message: '看看我的内容库' })
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
    const result = await service.chat(user.id, session.id, { message: '写一篇关于 AI 的文章并生成知乎排版' })
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
    const result = await service.chat(user.id, session.id, { message: '把这篇保存为公众号草稿' })
    expect(wechat.publish).toHaveBeenCalledWith(user.id, { renderId: record.id, mode: 'draft', coverMediaId: 'cover-1' }, expect.any(String))
    expect(result.reply.content).toContain('草稿')
  })

  it('edits a video timeline and starts an export through tools', async () => {
    const { database, user, service, session } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    const videoContent = database.createContent(user.id, {
      title: 'AI 剪辑测试', kind: 'video', bookId: null, contentJson: {}, contentHtml: '<p>正文</p>', excerpt: '',
      coverImage: null, tags: [], status: 'draft', favorite: false, wordCount: 2, imageCount: 0, videoCount: 0,
    })
    const media = database.createMedia(user.id, {
      kind: 'video', filename: 'ai-clip.mp4', originalName: 'ai-clip.mp4', mimeType: 'video/mp4', size: 1024,
      meta: { duration: 8, width: 1280, height: 720, hasAudio: true },
    })
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return response(toolCall('update_video_timeline', {
          contentId: videoContent.id,
          clips: [{ mediaId: media.id, trimStart: 2 }],
        }))
      }
      if (calls === 2) return response(toolCall('export_video', { contentId: videoContent.id }))
      return response({ choices: [{ message: { role: 'assistant', content: '已修剪开头并开始导出。' } }] })
    }))
    const result = await service.chat(user.id, session.id, { message: '把开头 2 秒剪掉然后导出' })
    const row = database.getVideoProjectRow(user.id, videoContent.id)
    expect(row.clips).toHaveLength(1)
    expect(row.clips[0]).toMatchObject({ mediaId: media.id, trimStart: 2, trimEnd: null, duration: 8 })
    const exportsList = database.listVideoExports(user.id, videoContent.id)
    expect(exportsList).toHaveLength(1)
    // The media file does not exist in this test, so the queued job fails
    // asynchronously with a clear message — that is the expected path.
    let status = exportsList[0]?.status
    for (let i = 0; i < 20 && (status === 'queued' || status === 'running'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      status = database.listVideoExports(user.id, videoContent.id)[0]?.status
    }
    expect(status).toBe('failed')
    expect(database.listVideoExports(user.id, videoContent.id)[0]?.message).toContain('素材文件已丢失')
    expect(database.getContentSummary(user.id, videoContent.id)?.videoCount).toBe(1)
    // export_video waits for the terminal state instead of returning "queued",
    // so the model sees the failure in the same round.
    const exportTool = result.session.messages.find(message => message.role === 'tool' && message.toolName === 'export_video')
    expect(exportTool).toBeTruthy()
    const exportResult = JSON.stringify(exportTool?.toolResult)
    expect(exportResult).toContain('"status":"failed"')
    expect(exportResult).toContain('素材文件已丢失')
    expect(result.reply.content).toContain('导出')
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
    const result = await service.chat(user.id, session.id, { message: '只回复正常' })
    expect(result.reply.content).toBe('正常')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lets a user save only the model and reuse the server key', () => {
    const { user, service, database, directory } = setup({
      apiKey: 'sk-server-default', baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'deepseek-v4.1-flash', label: 'OpenCode Go',
    })
    const settings = service.saveSettings(user.id, { baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'custom-model' })
    expect(settings).toMatchObject({ configured: true, source: 'user', baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'custom-model' })
    const record = database.getAiSettings(user.id)!
    expect(decryptPublisherSecret<string>(record.encryptedApiKey, loadPublisherKey(directory, 'ai'), user.id)).toBe('sk-server-default')
  })

  it('does not send a server key to a different endpoint when the user leaves the key blank', () => {
    const { user, service } = setup({
      apiKey: 'sk-server-default', baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'deepseek-v4.1-flash', label: 'OpenCode Go',
    })
    expect(() => service.saveSettings(user.id, { baseUrl: 'https://evil.example/v1', model: 'custom-model' }))
      .toThrowError(/留空仅可在接口地址与服务器默认地址一致/)
  })
})

describe('AI attachments', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
  const jpg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD//gA7Q1JFQVRPUgo=', 'base64')

  function image(config: ReturnType<typeof loadConfig>, database: Database, userId: string, name = 'photo.png') {
    const filename = `${randomUUID()}.png`
    writeFileSync(path.join(config.uploadsDir, filename), png)
    return database.createMedia(userId, { kind: 'image', filename, originalName: name, mimeType: 'image/png', size: png.length, meta: { width: 32, height: 32, hasAudio: false } })
  }

  function videoMedia(config: ReturnType<typeof loadConfig>, database: Database, userId: string, name = 'clip.mp4') {
    const filename = `${randomUUID()}.mp4`
    writeFileSync(path.join(config.uploadsDir, filename), Buffer.from('fake-video'))
    return database.createMedia(userId, { kind: 'video', filename, originalName: name, mimeType: 'video/mp4', size: 1024, meta: { duration: 30, width: 1280, height: 720, hasAudio: true } })
  }

  it('stores attachments, sends vision parts for the current turn and references later', async () => {
    const { config, database, user, service, session } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    const media = image(config, database, user.id)
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1
      bodies.push(JSON.parse(String(init?.body)))
      if (calls === 1) return response({ choices: [{ message: { role: 'assistant', content: '这是一张测试图片。' } }] })
      return response({ choices: [{ message: { role: 'assistant', content: '已根据图片继续处理。' } }] })
    }))
    const first = await service.chat(user.id, session.id, { message: '看看这张图', mediaIds: [media.id] })
    expect(first.session.messages[0]).toMatchObject({ role: 'user', content: '看看这张图' })
    expect(first.session.messages[0].attachments).toEqual([expect.objectContaining({ kind: 'image', mediaId: media.id, url: media.url })])
    // Current turn: vision part with a data URL plus attachment metadata text.
    const firstContent = bodies[0].messages.find(message => message.role === 'user')?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(firstContent).toBeInstanceOf(Array)
    const imagePart = firstContent.find(part => part.type === 'image_url')
    expect(imagePart?.image_url?.url).toContain('data:image/png;base64,')
    const textPart = firstContent.find(part => part.type === 'text')
    expect(textPart?.text).toContain('素材 ID')
    expect(textPart?.text).toContain('32×32')
    // Next turn: the older message keeps only a compact reference.
    const second = await service.chat(user.id, session.id, { message: '再帮我写一段说明' })
    const historyUser = bodies[1].messages.filter(message => message.role === 'user')[0]
    expect(typeof historyUser.content).toBe('string')
    expect(String(historyUser.content)).toContain('[图片附件]')
    expect(String(historyUser.content)).toContain(media.id)
    expect(String(historyUser.content)).not.toContain('data:image')
    expect(second.reply.content).toContain('继续处理')
  })

  it('inlines document text on the current turn and omits it from later turns', async () => {
    const { user, service, session } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    const longText = '字'.repeat(25_000)
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1
      bodies.push(JSON.parse(String(init?.body)))
      return response({ choices: [{ message: { role: 'assistant', content: `收到第 ${calls} 条消息。` } }] })
    }))
    await service.chat(user.id, session.id, { message: '根据这份资料写文章', documents: [{ name: '资料.md', mimeType: 'text/markdown', size: 50_000, text: longText }] })
    const userMessage = bodies[0].messages.find(message => message.role === 'user')?.content as string
    expect(userMessage).toContain('[文档附件] 资料.md')
    expect(userMessage).toContain('已截断')
    const inlineCount = (userMessage.match(/字/g) ?? []).length
    expect(inlineCount).toBeGreaterThanOrEqual(20_000)
    expect(inlineCount).toBeLessThan(25_000)
    await service.chat(user.id, session.id, { message: '换一个角度再写' })
    const olderMessage = bodies[1].messages.filter(message => message.role === 'user')[0]
    expect(String(olderMessage.content)).toContain('正文文本已省略')
    expect(String(olderMessage.content)).not.toContain('字字字')
  })

  it('allows attachments without text and reports them in the stored message', async () => {
    const { config, database, user, service, session } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    const media = videoMedia(config, database, user.id)
    vi.stubGlobal('fetch', vi.fn(async () => response({ choices: [{ message: { role: 'assistant', content: '收到视频，我会用它创建视频内容。' } }] })))
    const result = await service.chat(user.id, session.id, { message: '', mediaIds: [media.id] })
    expect(result.session.messages[0]).toMatchObject({ role: 'user', content: '（消息包含 1 个附件）' })
    expect(result.session.messages[0].attachments?.[0]).toMatchObject({ kind: 'video', duration: 30 })
    expect(result.session.title).toBe(media.originalName)
  })

  it('rejects foreign media and oversized attachment batches', async () => {
    const { config, database, user, service, session } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
    const foreign = image(config, database, bob.id)
    await expect(service.chat(user.id, session.id, { message: '看看', mediaIds: [foreign.id] })).rejects.toMatchObject({ status: 404 })
    const many = Array.from({ length: 11 }, () => image(config, database, user.id).id)
    await expect(service.chat(user.id, session.id, { message: '一次太多', mediaIds: many })).rejects.toMatchObject({ code: 'ai_attachments_too_many' })
  })

  it('creates an article with uploaded images and cover through create_content', async () => {
    const { config, database, user, service, session } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    const first = image(config, database, user.id, 'first.png')
    const second = image(config, database, user.id, 'second.png')
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) return response(toolCall('create_content', { title: '游记', html: '<h1>游记</h1><p>正文</p>', mediaIds: [first.id, second.id], tags: ['旅行'] }))
      return response({ choices: [{ message: { role: 'assistant', content: '文章已创建，图片已插入。' } }] })
    }))
    const result = await service.chat(user.id, session.id, { message: '用这两张图写一篇游记' })
    const toolMessage = result.session.messages.find(message => message.role === 'tool')
    expect(toolMessage?.toolResult).toMatchObject({ ok: true })
    const createdId = (toolMessage?.toolResult as { data: { content: { id: string } } }).data.content.id
    const detail = database.getContentDetail(user.id, createdId)!
    expect(detail.contentHtml).toContain('<h1>游记</h1>')
    expect(detail.contentHtml).toContain(`src="${first.url}"`)
    expect(detail.contentHtml).toContain(`src="${second.url}"`)
    expect(detail.coverImage).toBe(first.url)
    expect(detail.imageCount).toBe(2)
    expect((detail.contentHtml.match(/<img /g) ?? []).length).toBe(2)
  })

  it('creates an image-first gallery through create_content', async () => {
    const { config, database, user, service, session } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    const first = image(config, database, user.id, 'gallery-first.png')
    const second = image(config, database, user.id, 'gallery-second.png')
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) return response(toolCall('create_content', {
        title: '周末散步', kind: 'gallery', html: '<p>三张图的周末。</p>', mediaIds: [first.id, second.id], tags: ['散步'],
      }))
      return response({ choices: [{ message: { role: 'assistant', content: '图文已创建。' } }] })
    }))
    const result = await service.chat(user.id, session.id, { message: '用这两张图做一篇图文' })
    const toolMessage = result.session.messages.find(message => message.role === 'tool')
    expect(toolMessage?.toolResult).toMatchObject({ ok: true })
    const createdId = (toolMessage?.toolResult as { data: { content: { id: string } } }).data.content.id
    const detail = database.getContentDetail(user.id, createdId)!
    expect(detail.kind).toBe('gallery')
    expect(detail.coverImage).toBe(first.url)
    expect(detail.imageCount).toBe(2)
    expect(detail.contentHtml).toContain(first.url)
    expect(detail.contentHtml).toContain(second.url)
    expect(database.listContents(user.id, { favorite: false, trash: false, kind: 'gallery', sort: 'updated_desc', page: 1, pageSize: 20 }).total).toBe(1)
  })

  it('initializes a video timeline when creating video content from uploaded videos', async () => {
    const { config, database, user, service, session, video } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    const clipA = videoMedia(config, database, user.id, 'a.mp4')
    const clipB = videoMedia(config, database, user.id, 'b.mp4')
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) return response(toolCall('create_content', { title: '旅行 vlog', kind: 'video', html: '<p>行进中的城市记录。</p>', mediaIds: [clipA.id, clipB.id] }))
      return response({ choices: [{ message: { role: 'assistant', content: '视频内容已创建并初始化时间线。' } }] })
    }))
    const result = await service.chat(user.id, session.id, { message: '用这两段视频建一个视频内容' })
    const toolMessage = result.session.messages.find(message => message.role === 'tool')
    expect(toolMessage?.toolResult).toMatchObject({ ok: true, data: { timeline: { clips: 2 } } })
    const createdId = (toolMessage?.toolResult as { data: { content: { id: string } } }).data.content.id
    const project = await video.getProject(user.id, createdId)
    expect(project.clips.map(clip => clip.mediaId)).toEqual([clipA.id, clipB.id])
    expect(project.clips[0]).toMatchObject({ trimStart: 0, duration: 30 })
    expect(database.getContentSummary(user.id, createdId)?.videoCount).toBe(2)
  })

  it('reports kind mismatches and unknown media in the tool result', async () => {
    const { config, database, user, service, session } = setup()
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    const wrongKind = videoMedia(config, database, user.id, 'video-as-image.mp4')
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) return response(toolCall('create_content', { title: '错误用法', html: '<p>正文</p>', mediaIds: [wrongKind.id] }))
      return response({ choices: [{ message: { role: 'assistant', content: '素材类型不对，我已停止。' } }] })
    }))
    const result = await service.chat(user.id, session.id, { message: '把视频插进文章' })
    const toolMessage = result.session.messages.find(message => message.role === 'tool')
    expect(toolMessage?.toolResult).toMatchObject({ ok: false, error: { code: 'ai_media_kind' } })
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})


describe('AI high availability integration', () => {
  function gatewayPool() {
    return parseAiProvidersConfig({
      providers: [
        {
          id: 'alpha',
          label: 'Alpha 云',
          baseUrl: 'https://alpha.example/v1',
          defaultModel: 'alpha-flash',
          models: ['alpha-flash'],
          keys: [
            { id: 'a1', label: '账号1', apiKey: 'sk-alpha-key-111111111111' },
            { id: 'a2', label: '账号2', apiKey: 'sk-alpha-key-222222222222' },
          ],
        },
        {
          id: 'beta',
          label: 'Beta 官方',
          baseUrl: 'https://beta.example/v1',
          defaultModel: 'beta-pro',
          models: ['beta-pro'],
          keys: [{ id: 'b1', label: '官方 Key', apiKey: 'sk-beta-key-111111111111' }],
        },
      ],
      modelMap: { 'alpha/alpha-flash': { beta: 'beta-pro' } },
      cooldowns: { quotaMs: 60_000, authMs: 60_000, rateLimitMs: 30_000, transientMs: 20_000, providerMs: 60_000 },
    })
  }

  it('switches keys inside the chat turn and keeps the session history for the next turn', async () => {
    const { database, user, service, session } = setup(undefined, gatewayPool())
    expect(service.settings(user.id)).toMatchObject({ configured: true, source: 'server', label: 'Alpha 云', providers: 2, keys: 3, fallback: true })
    let calls = 0
    const bodies: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1
      bodies.push(JSON.parse(String(init?.body)))
      if (calls === 1) {
        return response({ type: 'error', error: { type: 'GoUsageLimitError', message: 'usage limit reached' } }, 429)
      }
      return response({ choices: [{ message: { role: 'assistant', content: calls === 2 ? '第一次回答' : '第二次回答' } }] })
    }))
    const first = await service.chat(user.id, session.id, { message: '第一句话' })
    expect(first.routing).toMatchObject({ providerId: 'alpha', model: 'alpha-flash', keyId: 'a2', fallback: true, reason: 'quota_exhausted' })
    expect(first.reply.content).toBe('第一次回答')
    expect(first.session.messages.map(message => message.role)).toEqual(['user', 'assistant'])

    const second = await service.chat(user.id, session.id, { message: '第二句话' })
    expect(second.reply.content).toBe('第二次回答')
    expect(second.session.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(second.session.messages[0].content).toBe('第一句话')
    // The second provider call carries the full prior history.
    const secondBody = bodies[bodies.length - 1]
    expect(secondBody.model).toBe('alpha-flash')
    expect(secondBody.messages.some(message => message.role === 'assistant' && message.content === '第一次回答')).toBe(true)
    expect(secondBody.messages.some(message => message.role === 'user' && message.content === '第一句话')).toBe(true)

    const events = database.listAiFailoverEvents(user.id, 20)
    expect(events.some(event => event.kind === 'key_switch' && event.sessionId === session.id)).toBe(true)
    const requests = database.listAiProviderRequests(user.id, 20)
    expect(requests.some(request => request.status === 'failed' && request.keyId === 'a1')).toBe(true)
    expect(JSON.stringify(requests)).not.toContain('sk-alpha-key-111111111111')
  })

  it('falls back to the next provider with a mapped model and keeps the tool trace', async () => {
    const { user, service, session } = setup(undefined, gatewayPool())
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls <= 2) return response({ type: 'error', error: { type: 'GoUsageLimitError', message: 'usage limit reached' } }, 429)
      if (calls === 3) return response(toolCall('list_contents', { pageSize: 1 }))
      return response({ choices: [{ message: { role: 'assistant', content: '备用提供商已完成查询。' } }] })
    }))
    const result = await service.chat(user.id, session.id, { message: '看看我的内容库' })
    expect(result.routing).toMatchObject({ providerId: 'beta', model: 'beta-pro', requestedModel: 'alpha-flash', fallback: true })
    expect(result.session.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(result.reply.content).toContain('备用提供商')
  })
})


describe('provider pool settings integration', () => {
  const poolFile = {
    providers: [
      {
        id: 'opencode-go',
        label: 'OpenCode Go',
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        defaultModel: 'deepseek-v4.1-flash',
        models: ['deepseek-v4.1-flash'],
        highAvailability: true,
        keys: [
          { id: 'account-1', label: '账号1', apiKey: 'sk-pool-account-1-111111', enabled: true },
          { id: 'account-2', label: '账号2', apiKey: 'sk-pool-account-2-222222', enabled: true },
        ],
      },
    ],
    modelMap: {},
    probeIntervalMs: 300_000,
    maxProviderFailures: 3,
  }

  it('returns a masked editable pool and persists changes without restarting', () => {
    const { user, service, config } = setup(undefined, undefined, { writePoolFile: poolFile })
    const before = service.providerPool(user.id)
    expect(before).toMatchObject({ editable: true, source: 'file', editableReason: null })
    expect(before.providers[0].highAvailability).toBe(true)
    expect(before.providers[0].keys.map(key => key.maskedKey)).toEqual(['sk-p…1111', 'sk-p…2222'])
    expect(JSON.stringify(before)).not.toContain('sk-pool-account-1-111111')

    const saved = service.saveProviderPool(user.id, {
      providers: [{
        id: 'opencode-go',
        label: 'OpenCode Go',
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        defaultModel: 'deepseek-v4.1-flash',
        models: ['deepseek-v4.1-flash'],
        highAvailability: false,
        keys: [
          { id: 'account-1', label: '账号1', enabled: true },
          { id: 'account-2', label: '账号2', enabled: false },
          { id: 'account-3', label: '账号3', apiKey: 'sk-pool-account-3-333333', enabled: true },
        ],
      }],
      probeIntervalMs: 120_000,
    })
    expect(saved.editable).toBe(true)
    expect(saved.providers[0].highAvailability).toBe(false)
    expect(saved.providers[0].keys).toHaveLength(3)
    expect(saved.providers[0].keys[0].maskedKey).toBe('sk-p…1111')
    expect(saved.providers[0].keys[1].enabled).toBe(false)
    expect(saved.providers[0].keys[2].maskedKey).toBe('sk-p…3333')
    expect(service.settings(user.id)).toMatchObject({ configured: true, source: 'server', providers: 1, keys: 1 })
    expect(config.aiProvidersSource).toBe('file')
    expect(service.gateway.keyCount).toBe(1)
    expect(service.gateway.status(user.id).source).toBe('file')
  })

  it('only lets configured admins edit the server pool in production', () => {
    const { database, user, service } = setup(undefined, undefined, {
      writePoolFile: poolFile,
      nodeEnv: 'production',
      settingsAdmins: ['alice'],
    })
    const bob = database.createUser({ username: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: 'hash' })
    expect(service.providerPool(user.id).editable).toBe(true)
    expect(service.providerPool(bob.id)).toMatchObject({ editable: false, editableReason: expect.stringContaining('仅管理员') })
    expect(() => service.saveProviderPool(bob.id, { providers: [{ id: 'x', label: 'X', baseUrl: 'https://x.example/v1', defaultModel: 'm', keys: [{ label: 'k', apiKey: 'sk-x-12345678' }] }] }))
      .toThrowError(/仅管理员/)
  })

  it('keeps the pool read-only when it comes from AI_PROVIDERS_JSON-like overrides', () => {
    const pool = parseAiProvidersConfig(poolFile)
    const { user, service } = setup(undefined, pool)
    expect(service.providerPool(user.id)).toMatchObject({ editable: false, source: 'override' })
  })
})


describe('AI server pool access', () => {
  const pool = () => parseAiProvidersConfig({
    providers: [{
      id: 'pool', label: 'Pool', baseUrl: 'https://pool.example/v1', defaultModel: 'pool-model', models: ['pool-model'],
      keys: [{ id: 'k1', label: 'K1', apiKey: 'sk-pool-key-12345678' }],
    }],
  })

  it('blocks non-admin accounts from the server pool in production', async () => {
    const { user, service, session } = setup(undefined, pool(), { nodeEnv: 'production' })
    expect(service.settings(user.id)).toMatchObject({ configured: false, serverPoolAvailable: false })
    await expect(service.chat(user.id, session.id, { message: 'hi' })).rejects.toMatchObject({ code: 'ai_pool_forbidden' })
  })

  it('allows configured admins and reports server-pool usage', async () => {
    const { database, user, service, session } = setup(undefined, pool(), { nodeEnv: 'production', settingsAdmins: ['alice'] })
    expect(service.settings(user.id)).toMatchObject({ configured: true, source: 'server', serverPoolAvailable: true })
    vi.stubGlobal('fetch', vi.fn(async () => response({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })))
    const result = await service.chat(user.id, session.id, { message: 'hi' })
    expect(result.reply.content).toBe('OK')
    const usage = database.listAiUsageByUser(new Date(Date.now() - 60_000).toISOString())
    expect(usage[0]).toMatchObject({ username: 'alice', requests: 1 })
  })

  it('lets a named non-admin account use the server pool without granting admin', async () => {
    const { user, service, session } = setup(undefined, pool(), { nodeEnv: 'production', aiPoolUsers: ['alice'] })
    expect(user.isAdmin).toBe(false)
    expect(service.settings(user.id)).toMatchObject({ configured: true, source: 'server', serverPoolAvailable: true })
    vi.stubGlobal('fetch', vi.fn(async () => response({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })))
    const result = await service.chat(user.id, session.id, { message: 'hi' })
    expect(result.reply.content).toBe('OK')
  })

  it('enforces the daily server-pool token quota and ignores personal-key usage', async () => {
    const { database, user, service, session } = setup(undefined, pool(), { nodeEnv: 'production', aiPoolAccess: 'all', aiPoolDailyTokens: 100 })
    database.createAiProviderRequest({
      userId: user.id, providerId: 'user:' + user.id, providerLabel: '用户 Key', model: 'user-model', keyId: 'user-key', keyLabel: '账号 Key',
      keyMasked: 'sk-u…0000', status: 'success', durationMs: 10, tokensIn: 900, tokensOut: 900,
    })
    expect(database.sumAiPoolTokensSince(user.id, new Date(Date.now() - 60_000).toISOString())).toBe(0)
    database.createAiProviderRequest({
      userId: user.id, providerId: 'pool', providerLabel: 'Pool', model: 'pool-model', keyId: 'k1', keyLabel: 'K1',
      keyMasked: 'sk-p…5678', status: 'success', durationMs: 10, tokensIn: 60, tokensOut: 50,
    })
    expect(database.sumAiPoolTokensSince(user.id, new Date(Date.now() - 60_000).toISOString())).toBe(110)
    await expect(service.chat(user.id, session.id, { message: 'hi' })).rejects.toMatchObject({ code: 'ai_pool_quota' })
  })

  it('blocks a personal-key fallback when the pool token quota is exhausted', async () => {
    const { database, user, service, session } = setup(undefined, pool(), { nodeEnv: 'production', aiPoolAccess: 'all', aiPoolDailyTokens: 100 })
    service.saveSettings(user.id, { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    database.createAiProviderRequest({
      userId: user.id, providerId: 'pool', providerLabel: 'Pool', model: 'pool-model', keyId: 'k1', keyLabel: 'K1',
      keyMasked: 'sk-p…5678', status: 'success', durationMs: 10, tokensIn: 60, tokensOut: 50,
    })
    const fetchMock = vi.fn(async () => response({ error: { message: 'personal key failed' } }, 500))
    vi.stubGlobal('fetch', fetchMock)
    await expect(service.chat(user.id, session.id, { message: 'hi' })).rejects.toMatchObject({ code: 'ai_pool_quota' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('enforces the daily server-pool quota', async () => {
    const { database, user, service, session } = setup(undefined, pool(), { nodeEnv: 'production', aiPoolAccess: 'all', aiPoolDailyLimit: 1 })
    database.createAiProviderRequest({
      userId: user.id, providerId: 'pool', providerLabel: 'Pool', model: 'pool-model', keyId: 'k1', keyLabel: 'K1',
      keyMasked: 'sk-p…5678', status: 'success', durationMs: 10,
    })
    await expect(service.chat(user.id, session.id, { message: 'hi' })).rejects.toMatchObject({ code: 'ai_pool_quota' })
  })
})
