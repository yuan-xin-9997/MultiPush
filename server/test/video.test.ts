import { mkdtempSync, copyFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { openDatabase, type Database } from '../src/db'
import { VideoService, buildSegmentArgs, parseProbeOutput } from '../src/video'

const directories: string[] = []
const databases: Database[] = []

interface TestContext {
  database: Database
  config: ReturnType<typeof loadConfig>
  uploadsDir: string
}

function setup(): TestContext {
  const directory = mkdtempSync(path.join(tmpdir(), 'multipush-video-'))
  directories.push(directory)
  const uploadsDir = path.join(directory, 'uploads')
  const config = loadConfig({ dataDir: directory, jwtSecret: 'test-secret' })
  const database = openDatabase(path.join(directory, 'test.sqlite'))
  databases.push(database)
  return { database, config, uploadsDir }
}

function hasBinary(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ['-version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

const ffmpegAvailable = await hasBinary('ffmpeg')
const describeFfmpeg = ffmpegAvailable ? describe : describe.skip

function createVideoUser(context: TestContext, username: string) {
  const user = context.database.createUser({ username, email: `${username}@example.com`, passwordHash: 'hash', displayName: 'Tester' })
  const content = context.database.createContent(user.id, {
    title: '测试视频',
    kind: 'video',
    bookId: null,
    contentJson: {},
    contentHtml: '<p>视频正文</p>',
    excerpt: '视频正文',
    coverImage: null,
    tags: [],
    status: 'draft',
    favorite: false,
    wordCount: 4,
    imageCount: 0,
    videoCount: 0,
  })
  return { user, content }
}

function importFixture(context: TestContext, userId: string, fixture: string, suffix: string) {
  const filename = `media-${suffix}.mp4`
  copyFileSync(path.join(__dirname, 'fixtures', fixture), path.join(context.uploadsDir, filename))
  return context.database.createMedia(userId, {
    kind: 'video',
    filename,
    originalName: fixture,
    mimeType: 'video/mp4',
    size: statSync(path.join(context.uploadsDir, filename)).size,
    meta: null,
  })
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // already closed
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('video timeline persistence', () => {
  it('stores clips, counts them on the content and isolates by user', () => {
    const context = setup()
    const alice = context.database.createUser({ username: 'video_alice', email: 'video-alice@example.com', passwordHash: 'hash', displayName: 'Alice' })
    const bob = context.database.createUser({ username: 'video_bob', email: 'video-bob@example.com', passwordHash: 'hash', displayName: 'Bob' })
    const content = context.database.createContent(alice.id, {
      title: 'Vlog',
      kind: 'video',
      bookId: null,
      contentJson: {},
      contentHtml: '<p>正文</p>',
      excerpt: '',
      coverImage: null,
      tags: [],
      status: 'draft',
      favorite: false,
      wordCount: 2,
      imageCount: 0,
      videoCount: 0,
    })
    const media = context.database.createMedia(alice.id, {
      kind: 'video',
      filename: 'clip-a.mp4',
      originalName: 'clip-a.mp4',
      mimeType: 'video/mp4',
      size: 1024,
      meta: { duration: 12.5, width: 1920, height: 1080, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac' },
    })
    const clips = context.database.saveVideoProject(alice.id, content.id, {
      clips: [
        { id: 'clip-1', mediaId: media.id, trimStart: 1.5, trimEnd: null, duration: 12.5 },
        { id: 'clip-2', mediaId: media.id, trimStart: 0, trimEnd: 3, duration: 12.5 },
      ],
    })
    expect(clips).toHaveLength(2)
    const project = context.database.getVideoProjectRow(alice.id, content.id)
    expect(project.clips[0]?.trimStart).toBe(1.5)
    expect(project.clips[0]?.trimEnd).toBeNull()
    const summary = context.database.getContentSummary(alice.id, content.id)
    expect(summary?.videoCount).toBe(2)
    // Cross-tenant reads stay empty.
    expect(context.database.getVideoProjectRow(bob.id, content.id).clips).toHaveLength(0)
    // Duplicating a video content copies its timeline.
    const copy = context.database.createContent(alice.id, {
      title: 'Vlog（副本）',
      kind: 'video',
      bookId: null,
      contentJson: {},
      contentHtml: '<p>正文</p>',
      excerpt: '',
      coverImage: null,
      tags: [],
      status: 'draft',
      favorite: false,
      wordCount: 2,
      imageCount: 0,
      videoCount: 2,
    })
    context.database.copyVideoProject(alice.id, content.id, copy.id)
    expect(context.database.getVideoProjectRow(alice.id, copy.id).clips).toHaveLength(2)
  })

  it('keeps article contents untouched and defaults missing metadata', () => {
    const context = setup()
    const user = context.database.createUser({ username: 'video_meta', email: 'video-meta@example.com', passwordHash: 'hash', displayName: 'Meta' })
    const content = context.database.createContent(user.id, {
      title: '文章',
      kind: 'article',
      bookId: null,
      contentJson: {},
      contentHtml: '<p>文章</p>',
      excerpt: '',
      coverImage: null,
      tags: [],
      status: 'draft',
      favorite: false,
      wordCount: 2,
      imageCount: 0,
      videoCount: 0,
    })
    expect(context.database.getContentSummary(user.id, content.id)?.kind).toBe('article')
    expect(context.database.getVideoProjectRow(user.id, content.id).clips).toHaveLength(0)
  })
})

describe('video service timeline validation', () => {
  it('clamps trims to the probed duration and rejects foreign media', async () => {
    const context = setup()
    const { user, content } = createVideoUser(context, 'clamp_user')
    const video = new VideoService(context.database, context.config)
    const media = context.database.createMedia(user.id, {
      kind: 'video',
      filename: 'clamp.mp4',
      originalName: 'clamp.mp4',
      mimeType: 'video/mp4',
      size: 2048,
      meta: { duration: 10, width: 1280, height: 720, hasAudio: true },
    })
    const foreign = context.database.createMedia(user.id, {
      kind: 'image',
      filename: 'image.png',
      originalName: 'image.png',
      mimeType: 'image/png',
      size: 128,
      meta: null,
    })

    const project = await video.saveTimeline(user.id, content.id, [
      { mediaId: media.id, trimStart: 9.8, trimEnd: 20 },
    ])
    // 9.8 + 0.05 would exceed 10s → start clamped below the source end and
    // trimEnd collapses to "until the end of the source".
    expect(project.clips).toHaveLength(1)
    const first = project.clips[0]
    expect(first?.trimEnd).toBeNull()
    expect(first?.trimStart).toBeGreaterThan(9)
    expect(first?.media?.width).toBe(1280)
    expect(project.totalDuration).toBeGreaterThan(0)

    await expect(video.saveTimeline(user.id, content.id, [{ mediaId: 'missing' }])).rejects.toMatchObject({ status: 404 })
    await expect(video.saveTimeline(user.id, content.id, [{ mediaId: foreign.id }])).rejects.toMatchObject({ code: 'not_video' })
  })

  it('tracks raw materials and marks only genuinely edited timelines', async () => {
    const context = setup()
    const { user, content } = createVideoUser(context, 'material_user')
    const video = new VideoService(context.database, context.config)
    const first = context.database.createMedia(user.id, { kind: 'video', filename: 'first.mp4', originalName: 'first.mp4', mimeType: 'video/mp4', size: 1024, meta: { duration: 8 } })
    const second = context.database.createMedia(user.id, { kind: 'video', filename: 'second.mp4', originalName: 'second.mp4', mimeType: 'video/mp4', size: 1024, meta: { duration: 5 } })
    const simple = await video.saveTimeline(user.id, content.id, [{ mediaId: first.id }, { mediaId: second.id }])
    expect(simple.materials.map((material) => material.mediaId)).toEqual([first.id, second.id])
    expect(simple.edited).toBe(false)
    const trimmed = await video.saveTimeline(user.id, content.id, [{ mediaId: first.id, trimStart: 1 }, { mediaId: second.id }])
    expect(trimmed.edited).toBe(true)
    const removed = await video.saveTimeline(user.id, content.id, [{ mediaId: first.id }])
    expect(removed.materials).toHaveLength(2)
    expect(removed.edited).toBe(true)
  })

  it('rejects timeline editing for article contents', async () => {
    const context = setup()
    const user = context.database.createUser({ username: 'article_only', email: 'article-only@example.com', passwordHash: 'hash', displayName: 'A' })
    const article = context.database.createContent(user.id, {
      title: '文章',
      kind: 'article',
      bookId: null,
      contentJson: {},
      contentHtml: '<p>文章</p>',
      excerpt: '',
      coverImage: null,
      tags: [],
      status: 'draft',
      favorite: false,
      wordCount: 2,
      imageCount: 0,
      videoCount: 0,
    })
    const video = new VideoService(context.database, context.config)
    await expect(video.saveTimeline(user.id, article.id, [])).rejects.toMatchObject({ code: 'not_video_content' })
  })
})

describe('ffmpeg command builder', () => {
  it('builds a normalized segment command with explicit end', () => {
    const args = buildSegmentArgs({
      ffmpegPath: 'ffmpeg',
      source: '/uploads/a.mp4',
      trimStart: 1.5,
      trimEnd: 4.25,
      fallbackDuration: 10,
      hasAudio: true,
      width: 1920,
      height: 1080,
      output: '/tmp/seg.mp4',
    })
    expect(args[0]).toBe('-y')
    expect(args).toContain('-ss')
    expect(args[args.indexOf('-ss') + 1]).toBe('1.500')
    expect(args).toContain('-to')
    expect(args[args.indexOf('-to') + 1]).toBe('4.250')
    expect(args[args.indexOf('-t') + 1]).toBe('2.750')
    expect(args.join(' ')).toContain('scale=1920:1080:force_original_aspect_ratio=decrease')
    expect(args.join(' ')).toContain('pad=1920:1080')
    expect(args).not.toContain('anullsrc')
    expect(args[args.indexOf('-map') + 1]).toBe('0:v:0')
    expect(args[args.lastIndexOf('-map') + 1]).toBe('0:a:0')
    expect(args.at(-1)).toBe('/tmp/seg.mp4')
  })

  it('fills missing audio with silence and uses the source end when untrimmed', () => {
    const args = buildSegmentArgs({
      ffmpegPath: 'ffmpeg',
      source: '/uploads/b.mp4',
      trimStart: 0,
      trimEnd: null,
      fallbackDuration: 8,
      hasAudio: false,
      width: 1280,
      height: 720,
      output: '/tmp/seg2.mp4',
    })
    expect(args).toContain('anullsrc=r=44100:cl=stereo')
    expect(args[args.indexOf('-t') + 1]).toBe('8.000')
    expect(args[args.lastIndexOf('-map') + 1]).toBe('1:a:0')
  })
})

describe('ffprobe output parsing', () => {
  it('extracts duration, size, fps and audio presence', () => {
    const probe = parseProbeOutput(JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: { duration: '12.345678', format_name: 'mov,mp4,m4a,3gp,mj2' },
    }))
    expect(probe).not.toBeNull()
    expect(probe?.duration).toBeCloseTo(12.346, 3)
    expect(probe?.width).toBe(1920)
    expect(probe?.height).toBe(1080)
    expect(probe?.hasAudio).toBe(true)
    expect(probe?.fps).toBeCloseTo(29.97, 2)
  })

  it('returns null for malformed output and video-less files', () => {
    expect(parseProbeOutput('not json')).toBeNull()
    expect(parseProbeOutput(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: {} }))).toBeNull()
  })
})

describeFfmpeg('video export pipeline', () => {
  it('trims and merges two mixed segments into one mp4 media asset', async () => {
    const context = setup()
    const { user, content } = createVideoUser(context, 'export_user')
    const video = new VideoService(context.database, context.config)
    const capability = await video.capability()
    if (!capability.ffmpeg || !capability.ffprobe) return

    const mediaA = importFixture(context, user.id, 'clip_a.mp4', 'a')
    context.database.updateMediaMeta(user.id, mediaA.id, { duration: 2, width: 320, height: 240 })
    const mediaB = importFixture(context, user.id, 'clip_b.mp4', 'b')
    context.database.updateMediaMeta(user.id, mediaB.id, { duration: 2, width: 640, height: 480 })

    const timeline = await video.saveTimeline(user.id, content.id, [
      { mediaId: mediaA.id, trimStart: 0.5, trimEnd: 1.5 },
      { mediaId: mediaB.id },
    ])
    expect(timeline.totalDuration).toBeCloseTo(3, 5)

    const record = await video.createExport(user.id, content.id)
    expect(record.status).toBe('queued')

    // The queue runs asynchronously; wait for completion.
    let finished = null
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const current = video.getExport(user.id, record.id)
      if (current.status === 'completed' || current.status === 'failed') {
        finished = current
        break
      }
    }
    expect(finished?.status).toBe('completed')
    expect(finished?.outputMedia).not.toBeNull()
    expect(finished?.outputMedia?.mimeType).toBe('video/mp4')
    const outputPath = path.join(context.uploadsDir, finished?.outputMedia?.filename ?? '')
    expect(existsSync(outputPath)).toBe(true)
    expect(statSync(outputPath).size).toBeGreaterThan(10_000)

    const probed = await video.probeFile(outputPath)
    expect(probed?.duration).toBeGreaterThan(2.7)
    expect(probed?.duration).toBeLessThan(3.6)
    expect(probed?.width).toBe(320)
    expect(probed?.height).toBe(240)
    // The audio-less source was normalized to AAC silence, so the merged file has audio.
    expect(probed?.hasAudio).toBe(true)
    expect(probed?.videoCodec).toBe('h264')

    // A deleted media row makes createExport reject synchronously.
    context.database.deleteMedia(user.id, mediaB.id)
    await expect(video.createExport(user.id, content.id)).rejects.toMatchObject({ code: 'clip_media_missing' })

    // A missing file (row intact) fails asynchronously inside the job runner.
    const mediaC = importFixture(context, user.id, 'clip_b.mp4', 'c')
    context.database.updateMediaMeta(user.id, mediaC.id, { duration: 2, width: 640, height: 480 })
    await video.saveTimeline(user.id, content.id, [{ mediaId: mediaA.id, trimStart: 0.5, trimEnd: 1.5 }, { mediaId: mediaC.id }])
    rmSync(path.join(context.uploadsDir, 'media-c.mp4'), { force: true })
    const broken = await video.createExport(user.id, content.id)
    let failed = null
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const current = video.getExport(user.id, broken.id)
      if (current.status === 'completed' || current.status === 'failed') {
        failed = current
        break
      }
    }
    expect(failed?.status).toBe('failed')
    expect(failed?.message).toContain('素材文件已丢失')
  }, 180_000)
})
