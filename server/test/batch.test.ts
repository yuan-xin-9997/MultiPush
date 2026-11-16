import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BatchService } from '../src/batch'
import type { BlogService } from '../src/blog'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import type { SspaiService } from '../src/sspai'
import type { WechatService } from '../src/wechat'
import type { ZhihuService } from '../src/zhihu'

const cleanups: Array<() => Promise<void> | void> = []

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-batch-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test', jwtSecret: 'batch-test-secret' })
  const database = openDatabase(':memory:')
  const user = database.createUser({ username: 'alice', email: 'alice@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const content = database.createContent(user.id, {
    title: '批量文章', bookId: null, contentJson: {}, contentHtml: '<h2>标题</h2><p>正文内容</p>', excerpt: '',
    coverImage: null, tags: ['测试'], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0,
  })
  const wechat = {
    publish: vi.fn(async (userId: string, input: { renderId: string; mode: 'draft' | 'publish'; coverMediaId: string }) => {
      const publication = database.createWechatPublication(userId, {
        renderId: input.renderId, title: '批量文章', mode: input.mode, idempotencyKey: `batch-${Math.random()}`,
      })
      database.updateWechatPublication(userId, publication.id, { status: 'draft', message: '已保存公众号草稿' })
      return database.getWechatPublication(userId, publication.id)!
    }),
    remove: vi.fn(),
  } as unknown as WechatService
  const zhihu = { publish: vi.fn() } as unknown as ZhihuService
  const sspai = { publish: vi.fn() } as unknown as SspaiService
  const blog = { publish: vi.fn() } as unknown as BlogService
  const service = new BatchService(database, config, wechat, zhihu, sspai, blog)
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, config, uploadsDir: config.uploadsDir, database, user, content, service, wechat }
}

afterEach(() => { for (const cleanup of cleanups.splice(0)) void cleanup() })

async function wait(service: BatchService, userId: string, id: string) {
  await vi.waitFor(() => expect(['completed', 'failed']).toContain(service.get(userId, id).status))
  return service.get(userId, id)
}

describe('Batch render and publish', () => {
  it('renders selected contents sequentially and returns render ids', async () => {
    const { database, user, content, service } = setup()
    const job = service.createRenderJob(user.id, { contentIds: [content.id], platforms: ['zhihu'] }, 'http://127.0.0.1:34080')
    const done = await wait(service, user.id, job.id)
    expect(done).toMatchObject({ status: 'completed', total: 1, done: 1 })
    expect(done.items[0]).toMatchObject({ status: 'done', contentId: content.id })
    expect(done.items[0].renderId).toBeTruthy()
    expect(database.listRenders(user.id)).toHaveLength(1)
  })

  it('waits for each publication to finish and records the platform result', async () => {
    const { database, user, content, service, wechat, uploadsDir } = setup()
    const filename = 'cover-batch.png'
    writeFileSync(path.join(uploadsDir, filename), Buffer.from('cover'))
    const media = database.createMedia(user.id, { filename, originalName: filename, kind: 'image', mimeType: 'image/png', size: 5 })
    const job = service.createPublishJob(user.id, { contentIds: [content.id], platform: 'wechat', mode: 'draft', coverMediaId: media.id }, 'http://127.0.0.1:34080')
    const done = await wait(service, user.id, job.id)
    expect(done).toMatchObject({ status: 'completed', total: 1, done: 1 })
    expect(done.items[0]).toMatchObject({ status: 'done', publicationStatus: 'draft' })
    expect(wechat.publish).toHaveBeenCalledWith(user.id, expect.objectContaining({ mode: 'draft', coverMediaId: media.id }), 'http://127.0.0.1:34080')
    expect(database.listWechatPublications(user.id)).toHaveLength(1)
  })
})
