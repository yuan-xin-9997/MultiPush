import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { ApiError } from '../src/errors'
import { decryptPublisherSession, encryptPublisherSession, loadPublisherKey } from '../src/publisher-session'
import { renderPlatforms } from '../src/renderers'
import { CsdnService } from '../src/csdn'
import { csdnArticleUrl, csdnEarlySaveNeedsCheck, csdnEditorContainsArticle, csdnTitleMatches, parseCsdnArticleId, parseCsdnIdentity, parseCsdnSaveResponse, type CsdnDriver, type CsdnLoginAttempt } from '../src/csdn-browser'
import type { ContentDetail } from '../../shared/types'

const cleanups: Array<() => Promise<void> | void> = []
const state = {
  cookies: [
    { name: 'UserToken', value: 'csdn-token', domain: '.csdn.net', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const },
    { name: 'UserName', value: 'alice_csdn', domain: '.csdn.net', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' as const },
  ],
  origins: [],
}
const identity = { accountId: 'alice_csdn', name: 'Alice 的 CSDN' }

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-csdn-'))
  const config = loadConfig({ dataDir: directory, nodeEnv: 'test' })
  let database: Database = openDatabase(path.join(directory, 'test.sqlite'))
  const alice = database.createUser({ username: 'alice', email: 'a@example.com', displayName: 'Alice', passwordHash: 'hash' })
  const bob = database.createUser({ username: 'bob', email: 'b@example.com', displayName: 'Bob', passwordHash: 'hash' })
  const attempt = { poll: vi.fn<CsdnLoginAttempt['poll']>().mockResolvedValue({ status: 'waiting', qrCode: null, message: '请扫码' }), close: vi.fn(async () => {}) }
  const driver = {
    beginLogin: vi.fn<CsdnDriver['beginLogin']>().mockResolvedValue(attempt),
    checkSession: vi.fn<CsdnDriver['checkSession']>().mockResolvedValue({ state, identity }),
    checkPublication: vi.fn<CsdnDriver['checkPublication']>().mockResolvedValue({ state, status: 'published', url: 'https://blog.csdn.net/alice_csdn/article/details/13000000001', message: '已发布' }),
    deleteDraft: vi.fn<CsdnDriver['deleteDraft']>().mockResolvedValue({ state, remoteDeleted: true, message: 'CSDN 草稿已删除' }),
    publish: vi.fn<CsdnDriver['publish']>().mockImplementation(async (_state, article) => article.mode === 'draft'
      ? { state, status: 'draft' as const, remoteId: '13000000002', url: 'https://editor.csdn.net/md/?articleId=13000000002', message: '草稿已保存' }
      : { state, status: 'published' as const, remoteId: '13000000001', url: 'https://blog.csdn.net/alice_csdn/article/details/13000000001', message: '文章已发布' }),
    close: vi.fn(async () => {}),
  }
  const service = new CsdnService(database, config, driver)
  const key = loadPublisherKey(directory, 'csdn')
  database.saveCsdnAccount(alice.id, { ...identity, encryptedSession: encryptPublisherSession(state, key, alice.id), status: 'connected', checkedAt: new Date().toISOString() })
  const article = async (html = '<h2>小节</h2><p>正文内容</p>', title = 'CSDN 测试文章') => {
    const content: ContentDetail = database.createContent(alice.id, { title, contentHtml: html, contentJson: {}, excerpt: '', bookId: null, coverImage: null, tags: ['前端', 'TypeScript'], status: 'ready', favorite: false, wordCount: 4, imageCount: 0, videoCount: 0 })
    const [result] = await renderPlatforms({ content, platforms: ['csdn'], options: {}, authorName: 'Alice', baseUrl: 'http://127.0.0.1:34080' })
    return database.createRender(alice.id, { contentId: content.id, contentTitle: content.title, platforms: ['csdn'], options: {}, results: [result] })
  }
  cleanups.push(async () => { await service.close(); database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, database, service, alice, bob, driver, attempt, article, key, restart: async () => { await service.close(); database.close(); database = openDatabase(path.join(directory, 'test.sqlite')); return database } }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const finish = async (service: CsdnService, owner: string, id: string) => {
  await vi.waitFor(() => expect(service.get(owner, id).status).not.toBe('running'))
  return service.get(owner, id)
}

describe('CSDN publishing', () => {
  it('encrypts the session and binds it to the owner', async () => {
    const { database, alice, bob, key, service } = setup()
    const encrypted = database.getCsdnAccount(alice.id)!.encryptedSession
    expect(decryptPublisherSession(encrypted, key, alice.id)).toEqual(state)
    expect(() => decryptPublisherSession(encrypted, key, bob.id)).toThrow()
    expect(await service.account(bob.id)).toMatchObject({ status: 'disconnected' })
  })

  it('creates a draft and publishes with tags', async () => {
    const { service, alice, driver, article } = setup()
    const render = await article()
    const draft = await service.publish(alice.id, { renderId: render.id, mode: 'draft' })
    expect(await finish(service, alice.id, draft.id)).toMatchObject({ status: 'draft', mode: 'draft', remoteId: '13000000002' })
    const published = await service.publish(alice.id, { renderId: render.id, mode: 'publish', tags: ['后端', 'Java'] })
    expect(await finish(service, alice.id, published.id)).toMatchObject({ status: 'published', mode: 'publish', url: 'https://blog.csdn.net/alice_csdn/article/details/13000000001' })
    expect(driver.publish.mock.calls[0][1]).toMatchObject({ title: 'CSDN 测试文章', mode: 'draft', tags: ['前端', 'TypeScript'] })
    expect(driver.publish.mock.calls[1][1]).toMatchObject({ tags: ['后端', 'Java'] })
    expect((await service.publish(alice.id, { renderId: render.id, mode: 'draft' })).id).toBe(draft.id)
    expect(driver.publish).toHaveBeenCalledTimes(2)
  })

  it('rejects CSDN titles outside 5–100 characters', async () => {
    const { service, alice, article } = setup()
    const render = await article('<p>正文</p>', '短')
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'draft' })).rejects.toMatchObject({ code: 'csdn_title_invalid' })
  })

  it('blocks new publishes while a result is uncertain and allows manual resolution', async () => {
    const { service, alice, bob, driver, article } = setup()
    const render = await article()
    await expect(service.publish(bob.id, { renderId: render.id, mode: 'draft' })).rejects.toMatchObject({ status: 409 })
    driver.publish.mockRejectedValueOnce(new ApiError(502, 'csdn_result_uncertain', '结果待核实'))
    const publication = await service.publish(alice.id, { renderId: render.id, mode: 'publish' })
    expect((await finish(service, alice.id, publication.id)).status).toBe('uncertain')
    await expect(service.publish(alice.id, { renderId: render.id, mode: 'draft' })).rejects.toMatchObject({ code: 'csdn_result_uncertain' })
    await expect(service.resolve(bob.id, publication.id, { action: 'not_published' })).rejects.toMatchObject({ status: 404 })
    await service.resolve(alice.id, publication.id, { action: 'published', articleUrl: 'https://blog.csdn.net/alice_csdn/article/details/13000000001' })
    expect(service.get(alice.id, publication.id)).toMatchObject({ status: 'published', remoteId: '13000000001', url: 'https://blog.csdn.net/alice_csdn/article/details/13000000001' })
  })

  it('deletes a draft remotely and never removes published records', async () => {
    const { service, alice, bob, driver, article } = setup()
    const render = await article()
    const draft = await service.publish(alice.id, { renderId: render.id, mode: 'draft' })
    await finish(service, alice.id, draft.id)
    await expect(service.remove(bob.id, draft.id)).rejects.toMatchObject({ status: 404 })
    await expect(service.remove(alice.id, draft.id)).resolves.toEqual({ ok: true, remoteDeleted: true })
    expect(driver.deleteDraft).toHaveBeenCalledWith(state, '13000000002')
    const published = await service.publish(alice.id, { renderId: render.id, mode: 'publish' })
    await finish(service, alice.id, published.id)
    await expect(service.remove(alice.id, published.id)).rejects.toMatchObject({ code: 'csdn_delete_published' })
  })

  it('marks interrupted jobs uncertain after restart', async () => {
    const { database, alice, article, restart } = setup()
    const render = await article()
    const job = database.createCsdnPublication(alice.id, { renderId: render.id, title: '测试', mode: 'draft', idempotencyKey: 'interrupted' })
    const reopened = await restart()
    expect(reopened.getCsdnPublication(alice.id, job.id)?.status).toBe('uncertain')
  })
})

describe('CSDN parsing', () => {
  it('reads identity from CSDN cookies', () => {
    expect(parseCsdnIdentity([
      { name: 'UserToken', value: 'token' },
      { name: 'UserName', value: 'alice_csdn' },
      { name: 'UserNick', value: '%41%6c%69%63%65' },
    ])).toEqual({ accountId: 'alice_csdn', name: 'Alice' })
    expect(parseCsdnIdentity([
      { name: 'UserToken', value: 'token' },
      { name: 'UserName', value: 'alice_csdn' },
      { name: 'UserNick', value: '%u5F20%u4E09' },
    ])).toEqual({ accountId: 'alice_csdn', name: '张三' })
    expect(parseCsdnIdentity([{ name: 'UserName', value: 'alice_csdn' }])).toBeNull()
    expect(parseCsdnIdentity([{ name: 'UserToken', value: 'token' }])).toBeNull()
  })

  it('parses saveArticle responses and article URLs', () => {
    expect(parseCsdnSaveResponse({ code: 200, message: 'ok', data: { id: 13000000001, url: 'https://blog.csdn.net/alice_csdn/article/details/13000000001', check_original_status: 'true' } }))
      .toMatchObject({ code: 200, id: '13000000001', url: 'https://blog.csdn.net/alice_csdn/article/details/13000000001', originalRejected: false })
    expect(parseCsdnSaveResponse({ code: 200, data: { id: 13000000001, check_original_status: 'false' } })?.originalRejected).toBe(true)
    expect(parseCsdnSaveResponse({ code: 401, message: '请登录后操作！', data: null })).toMatchObject({ code: 401, id: '', message: '请登录后操作！' })
    expect(parseCsdnSaveResponse(null)).toBeNull()
    expect(parseCsdnArticleId('https://blog.csdn.net/alice_csdn/article/details/13000000001')).toBe('13000000001')
    expect(parseCsdnArticleId('https://editor.csdn.net/md/?articleId=13000000002')).toBe('13000000002')
    expect(parseCsdnArticleId('https://blog.csdn.net/alice_csdn/article/details/abc')).toBeNull()
    expect(csdnArticleUrl('alice_csdn', '13000000001')).toBe('https://blog.csdn.net/alice_csdn/article/details/13000000001')
  })

  it('verifies CSDN import without being confused by Markdown syntax', () => {
    const markdown = [
      '# 优化|MPSolver 和 pywraplp 到底谁是谁？',
      '',
      '前几天，一位做排班的同学问我：',
      '',
      '> “MPSolver 和 pywraplp 到底哪个快？”',
      '',
      '- **pywraplp** 是 Python 模块',
      '- `MPSolver` 是 C++ 接口',
      '',
      '```text',
      'from ortools.linear_solver import pywraplp',
      '```',
      '',
      '最后一段结论：先选对模型，再谈调参。',
    ].join('\n')
    const editorText = markdown.replace(/\n/g, '\n\n')
    expect(csdnEditorContainsArticle(markdown, '正文', editorText)).toBe(true)
    expect(csdnEditorContainsArticle(markdown, '正文', `\u200b${editorText.replace(/调参/g, '调\u200b参')}`)).toBe(true)
    expect(csdnEditorContainsArticle(markdown, '正文', editorText.slice(0, editorText.indexOf('最后一段')))).toBe(false)
    const middle = Math.floor(editorText.length / 2)
    expect(csdnEditorContainsArticle(markdown, '正文', editorText.slice(0, middle - 100) + editorText.slice(middle + 100))).toBe(false)
    expect(csdnEditorContainsArticle(markdown, '正文', [
      '欢迎使用Markdown编辑器',
      '这里写自定义目录标题',
      '# 欢迎使用Markdown编辑器',
    ].join('\n\n'))).toBe(false)
  })

  it('accepts a long CSDN title when the title bar truncates it', () => {
    const title = '一次讲清 OR-Tools 的三层结构：MPSolver、pywraplp 与后端求解器到底谁是谁，如何选型，以及什么时候应该更换求解后端'
    expect(csdnTitleMatches(title, title)).toBe(true)
    expect(csdnTitleMatches(title.slice(0, 40) + '…', title)).toBe(true)
    expect(csdnTitleMatches(title.replace(/\s+/g, ' '), title)).toBe(true)
    expect(csdnTitleMatches('完全不同的标题', title)).toBe(false)
    expect(csdnTitleMatches(title.slice(0, 10), title)).toBe(false)
    expect(csdnTitleMatches('短标', '短标题')).toBe(false)
    expect(csdnTitleMatches('短标题', '短标题')).toBe(true)
  })

  it('treats an auto-save during import as a result that needs checking', () => {
    expect(csdnEarlySaveNeedsCheck('准备 CSDN 编辑器', true)).toBe(true)
    expect(csdnEarlySaveNeedsCheck('导入 CSDN 正文', true)).toBe(true)
    expect(csdnEarlySaveNeedsCheck('打开发布设置', true)).toBe(true)
    expect(csdnEarlySaveNeedsCheck('保存 CSDN 草稿', true)).toBe(false)
    expect(csdnEarlySaveNeedsCheck('发布 CSDN 文章', true)).toBe(false)
    expect(csdnEarlySaveNeedsCheck('导入 CSDN 正文', false)).toBe(false)
  })
})
