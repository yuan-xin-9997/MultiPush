import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AppConfig } from '../src/config'
import { createRequireAuth, signToken } from '../src/auth'
import { openDatabase, type Database } from '../src/db'
import { errorHandler } from '../src/errors'
import { createMediaRouter } from '../src/routes/media'

const directories: string[] = []
const databases: Database[] = []
const servers: Server[] = []

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-media-'))
  directories.push(directory)
  const uploadsDir = path.join(directory, 'uploads')
  rmSync(uploadsDir, { recursive: true, force: true })
  const database = openDatabase(path.join(directory, 'media.sqlite'))
  databases.push(database)
  mkdirSync(uploadsDir, { recursive: true })
  const user = database.createUser({
    username: 'mediauser', email: 'media@example.com', passwordHash: 'unused', displayName: 'Media',
  })
  const app = express()
  app.use(express.json())
  app.use('/api/media', createRequireAuth(database, 'media-secret'), createMediaRouter(database, { uploadsDir } as AppConfig))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  return { database, user, uploadsDir, server, token: signToken(user, 'media-secret') }
}

async function apiBase(server: Server) {
  if (!server.listening) await once(server, 'listening')
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}/api/media`
}

async function upload(server: Server, token: string, name: string, content: string, type: string, folderId?: string) {
  const base = await apiBase(server)
  const form = new FormData()
  form.append('file', new Blob([content], { type }), name)
  if (folderId) form.append('folderId', folderId)
  const response = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  return { status: response.status, data: await response.json() as { media?: Record<string, unknown>; error?: string } }
}

async function request(server: Server, token: string, route = '', init: RequestInit = {}) {
  const base = await apiBase(server)
  const response = await fetch(`${base}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: response.status, data: await response.json() as Record<string, unknown> }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('media library API', () => {
  it('uploads, searches and deletes a document asset', async () => {
    const { database, user, uploadsDir, server, token } = setup()

    const created = await upload(server, token, '素材说明.md', '# 素材说明\n\n这是文档内容。', 'text/markdown')
    expect(created.status).toBe(200)
    expect(created.data.media).toMatchObject({
      kind: 'document',
      originalName: '素材说明.md',
      mimeType: 'text/markdown',
      size: expect.any(Number),
    })
    const media = created.data.media!
    expect(media.id).toBeTruthy()
    expect(database.getMedia(user.id, String(media.id))?.kind).toBe('document')

    const list = await request(server, token, '?kind=document&q=素材')
    expect(list.status).toBe(200)
    expect(list.data).toMatchObject({ total: 1, page: 1, pageSize: 100 })
    expect((list.data.media as Array<Record<string, unknown>>)[0]?.originalName).toBe('素材说明.md')

    const stats = await request(server, token, '/stats')
    expect(stats.status).toBe(200)
    expect(stats.data.stats).toMatchObject({ total: 1, images: 0, videos: 0, documents: 1 })

    const probe = await request(server, token, `/${media.id}/probe`, { method: 'GET', headers: {} })
    expect(probe.status).toBe(400)
    expect(probe.data.error).toBe('not_video')

    const removed = await request(server, token, `/${media.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(existsSync(path.join(uploadsDir, String(media.filename)))).toBe(false)
    expect((await request(server, token, '/stats')).data.stats).toMatchObject({ total: 0, documents: 0 })
  })

  it('rejects unsupported files without writing a media row', async () => {
    const { database, user, server, token } = setup()
    const created = await upload(server, token, 'payload.exe', 'not allowed', 'application/octet-stream')
    expect(created.status).toBe(400)
    expect(created.data.error).toBe('unsupported_media_type')
    expect(database.getMediaStats(user.id).total).toBe(0)
  })

  it('creates folders and moves assets between them', async () => {
    const { database, user, server, token } = setup()

    const createdFolder = await request(server, token, '/folders', {
      method: 'POST', body: JSON.stringify({ name: '产品图' }),
    })
    expect(createdFolder.status).toBe(200)
    const folder = createdFolder.data.folder as Record<string, unknown>
    expect(folder).toMatchObject({ name: '产品图', assetCount: 0 })

    const duplicate = await request(server, token, '/folders', {
      method: 'POST', body: JSON.stringify({ name: '产品图' }),
    })
    expect(duplicate.status).toBe(409)

    const uploaded = await upload(server, token, '产品图.png', 'fake-bytes', 'image/png', String(folder.id))
    expect(uploaded.status).toBe(200)
    expect(uploaded.data.media?.folderId).toBe(folder.id)

    expect((await request(server, token, `?folderId=${folder.id}`)).data.total).toBe(1)
    expect((await request(server, token, '?folderId=unfiled')).data.total).toBe(0)
    expect((await request(server, token, `/stats?folderId=${folder.id}`)).data.stats).toMatchObject({
      total: 1, images: 1, videos: 0, documents: 0,
    })
    expect((await request(server, token, '/stats?folderId=unfiled')).data.stats).toMatchObject({
      total: 0, images: 0, videos: 0, documents: 0,
    })
    expect(((await request(server, token, '/folders')).data.folders as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: folder.id, assetCount: 1,
    })

    const renamed = await request(server, token, `/folders/${folder.id}`, {
      method: 'PATCH', body: JSON.stringify({ name: '品牌图' }),
    })
    expect(renamed.data.folder).toMatchObject({ id: folder.id, name: '品牌图' })

    const media = uploaded.data.media!
    const moved = await request(server, token, `/${media.id}`, {
      method: 'PATCH', body: JSON.stringify({ folderId: null }),
    })
    expect(moved.status).toBe(200)
    expect(moved.data.media).toMatchObject({ id: media.id, folderId: null })
    expect((await request(server, token, '?folderId=unfiled')).data.total).toBe(1)

    await request(server, token, `/${media.id}`, {
      method: 'PATCH', body: JSON.stringify({ folderId: folder.id }),
    })
    const removed = await request(server, token, `/folders/${folder.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(removed.data).toMatchObject({ ok: true, moved: 1 })
    expect(database.getMedia(user.id, String(media.id))?.folderId).toBeNull()
  })

  it('enforces ownership on listing and deletion', async () => {
    const { database, server, token } = setup()
    const created = await upload(server, token, 'photo.png', 'fake-bytes', 'image/png')
    expect(created.status).toBe(200)
    const media = created.data.media!

    const bob = database.createUser({
      username: 'mediabob', email: 'mediabob@example.com', passwordHash: 'unused', displayName: 'Bob',
    })
    const bobToken = signToken(bob, 'media-secret')
    const bobList = await request(server, bobToken)
    expect(bobList.data.total).toBe(0)
    const bobDelete = await request(server, bobToken, `/${media.id}`, { method: 'DELETE' })
    expect(bobDelete.status).toBe(404)
    expect(database.getMedia(bob.id, String(media.id))).toBeNull()
  })
})
