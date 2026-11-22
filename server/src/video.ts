import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AppConfig } from './config'
import type { Database, MediaProbeMeta, StoredVideoClip } from './db'
import type { VideoCapability, VideoClipDetail, VideoClipInput, VideoExport, VideoMaterial, VideoProject, VideoStudioProject } from '../../shared/types'
import { ApiError, notFound } from './errors'

const MAX_EXPORT_DURATION_SECONDS = 2 * 60 * 60
const EXPORT_TIMEOUT_MS = 45 * 60 * 1000
const MIN_CLIP_SECONDS = 0.05

function simpleConcat(clips: VideoClipDetail[], materials: VideoMaterial[]): boolean {
  if (clips.length !== materials.length) return false
  return clips.every((clip, index) => {
    const material = materials[index]
    if (!material || clip.mediaId !== material.mediaId || Math.abs(clip.trimStart) > 0.001) return false
    return clip.trimEnd === null || (clip.duration !== null && Math.abs(clip.trimEnd - clip.duration) < 0.01)
  })
}

export interface VideoProbeResult extends MediaProbeMeta {
  hasAudio: boolean
  fps: number | null
  formatName: string | null
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} 超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 200_000) stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} 退出码 ${code}${stderr ? `：${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`))
    })
  })
}

/**
 * ffmpeg is the de-facto mature open-source video engine. Resolve the binaries
 * from env overrides or PATH once per process and remember the result so the
 * UI can explain missing local tooling instead of failing mid-export.
 */
export class VideoService {
  private readonly ffmpegPath: string
  private readonly ffprobePath: string
  private capabilityCache: VideoCapability | null = null
  private capabilityPromise: Promise<VideoCapability> | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly database: Database, private readonly config: AppConfig) {
    const env = (name: string): string | null => {
      const value = process.env[name]
      return value && value.trim() ? value.trim() : null
    }
    this.ffmpegPath = env('FFMPEG_PATH') ?? 'ffmpeg'
    this.ffprobePath = env('FFPROBE_PATH') ?? 'ffprobe'
  }

  async capability(): Promise<VideoCapability> {
    if (this.capabilityCache) return this.capabilityCache
    if (!this.capabilityPromise) {
      this.capabilityPromise = (async () => {
        const result: VideoCapability = { ffmpeg: false, ffprobe: false, version: null }
        try {
          const version = await runCommand(this.ffmpegPath, ['-version'], 10_000)
          result.ffmpeg = true
          result.version = version.stdout.split('\n')[0]?.trim() || null
        } catch {
          result.ffmpeg = false
        }
        try {
          await runCommand(this.ffprobePath, ['-version'], 10_000)
          result.ffprobe = true
        } catch {
          result.ffprobe = false
        }
        this.capabilityCache = result
        return result
      })()
    }
    return this.capabilityPromise
  }

  /** ffprobe a media file; returns null when ffprobe is unavailable or fails. */
  async probeFile(filePath: string): Promise<VideoProbeResult | null> {
    return probeVideoFile(filePath, this.ffprobePath)
  }

  async probeMedia(userId: string, mediaId: string): Promise<VideoProbeResult> {
    const media = this.database.getMedia(userId, mediaId)
    if (!media) throw notFound('素材不存在')
    if (media.kind !== 'video') throw new ApiError(400, 'not_video', '只能探测视频素材')
    const probe = await this.probeFile(this.mediaPath(media.filename))
    if (!probe) throw new ApiError(503, 'ffprobe_missing', '服务器未安装 ffprobe，无法探测视频信息')
    this.database.updateMediaMeta(userId, mediaId, {
      duration: probe.duration ?? null,
      width: probe.width ?? null,
      height: probe.height ?? null,
      hasAudio: probe.hasAudio,
      videoCodec: probe.videoCodec ?? null,
      audioCodec: probe.audioCodec ?? null,
    })
    return probe
  }

  async getProject(userId: string, contentId: string): Promise<VideoProject> {
    const content = this.database.getContentSummary(userId, contentId)
    if (!content) throw notFound('内容不存在')
    const row = this.database.getVideoProjectRow(userId, contentId)
    const clips = this.mapClips(row.clips, userId)
    const materialIds = [...new Set(row.materials ?? clips.map((clip) => clip.mediaId))]
    const materials: VideoMaterial[] = materialIds.map((mediaId) => ({
      mediaId,
      media: this.database.getMedia(userId, mediaId),
    }))
    return {
      contentId,
      materials,
      clips,
      edited: !simpleConcat(clips, materials),
      totalDuration: clips.reduce((sum, clip) => sum + clip.trimDuration, 0),
      updatedAt: row.updatedAt || content.updatedAt,
    }
  }

  /** Validate and clamp client clip ranges against the owned media assets. */
  private buildStoredClips(userId: string, clips: VideoClipInput[]): StoredVideoClip[] {
    const stored: StoredVideoClip[] = []
    for (const clip of clips) {
      const media = this.database.getMedia(userId, clip.mediaId)
      if (!media) throw notFound(`视频素材不存在：${clip.mediaId}`)
      if (media.kind !== 'video') throw new ApiError(400, 'not_video', '时间线片段必须是视频素材')
      const duration = media.duration ?? (typeof clip.duration === 'number' ? clip.duration : null)
      const limit = duration ?? 86_400
      // An omitted trimStart always means "start of the source"; it must not
      // inherit the previous clip's in-point.
      let trimStart = clip.trimStart ?? 0
      trimStart = Math.max(0, Math.min(trimStart, Math.max(0, limit - MIN_CLIP_SECONDS)))
      let trimEnd = clip.trimEnd === undefined ? (duration ?? null) : clip.trimEnd
      if (trimEnd !== null) {
        trimEnd = Math.max(trimStart + MIN_CLIP_SECONDS, Math.min(trimEnd, limit))
        if (duration !== null && trimEnd >= duration - 0.01) trimEnd = null
      }
      stored.push({
        id: randomUUID(),
        mediaId: clip.mediaId,
        trimStart: round2(trimStart),
        trimEnd: trimEnd === null ? null : round2(trimEnd),
        duration: duration === null ? null : round2(duration),
      })
    }
    return stored
  }

  /**
   * Replace the whole timeline. Clips reference media the user owns; trims are
   * clamped to the known source duration so a stale client cannot create an
   * invalid range.
   */
  async saveTimeline(userId: string, contentId: string, clips: VideoClipInput[]): Promise<VideoProject> {
    const content = this.database.getContentSummary(userId, contentId)
    if (!content) throw notFound('内容不存在')
    if (content.kind !== 'video') throw new ApiError(400, 'not_video_content', '只有视频内容支持剪辑时间线')

    const stored = this.buildStoredClips(userId, clips)
    const current = this.database.getVideoProjectRow(userId, contentId)
    const materials = [...(current.materials ?? current.clips.map((clip) => clip.mediaId))]
    for (const clip of stored) {
      if (!materials.includes(clip.mediaId)) materials.push(clip.mediaId)
    }
    this.database.saveVideoProject(userId, contentId, { clips: stored, materials })
    return this.getProject(userId, contentId)
  }

  async getStudioProject(userId: string, contentId: string): Promise<VideoStudioProject> {
    const content = this.database.getContentSummary(userId, contentId)
    if (!content) throw notFound('内容不存在')
    if (content.kind !== 'video') throw new ApiError(400, 'not_video_content', '只有视频内容支持剪辑工作台')
    const row = this.database.getVideoStudioProjectRow(userId, contentId)
    return {
      contentId,
      clips: this.mapClips(row.clips, userId),
      project: row.project,
      updatedAt: row.updatedAt || content.updatedAt,
    }
  }

  async saveStudioProject(
    userId: string,
    contentId: string,
    project: Record<string, unknown>,
    clips: VideoClipInput[],
  ): Promise<VideoStudioProject> {
    const content = this.database.getContentSummary(userId, contentId)
    if (!content) throw notFound('内容不存在')
    if (content.kind !== 'video') throw new ApiError(400, 'not_video_content', '只有视频内容支持剪辑工作台')
    if (clips.length === 0) {
      throw new ApiError(400, 'empty_timeline', '时间线中没有可识别的视频片段，未保存；请从素材库添加视频片段')
    }
    const stored = this.buildStoredClips(userId, clips)
    this.database.saveVideoStudioProject(userId, contentId, { clips: stored, project })
    return this.getStudioProject(userId, contentId)
  }

  listExports(userId: string, contentId?: string): VideoExport[] {
    return this.database.listVideoExports(userId, contentId)
  }

  getExport(userId: string, exportId: string): VideoExport {
    const record = this.database.getVideoExport(userId, exportId)
    if (!record) throw notFound('导出任务不存在')
    return record
  }

  deleteExport(userId: string, exportId: string): void {
    if (!this.database.deleteVideoExport(userId, exportId)) throw notFound('导出任务不存在')
  }

  /** Enqueue an export of the current timeline or a plain concatenation of raw materials. */
  async createExport(userId: string, contentId: string, source: 'timeline' | 'materials' = 'timeline'): Promise<VideoExport> {
    const project = await this.getProject(userId, contentId)
    const clips: VideoClipDetail[] = source === 'materials'
      ? project.materials.map((material) => ({
        id: randomUUID(),
        mediaId: material.mediaId,
        trimStart: 0,
        trimEnd: null,
        duration: material.media?.duration ?? null,
        trimDuration: material.media?.duration ?? 0,
        media: material.media,
      }))
      : project.clips
    if (clips.length === 0) throw new ApiError(400, 'empty_timeline', source === 'materials' ? '素材列表为空，请先上传视频素材' : '时间线还没有片段，请先上传并添加视频')
    const missing = clips.filter((clip) => !clip.media)
    if (missing.length > 0) throw new ApiError(400, 'clip_media_missing', '存在已被删除的素材，请先移除对应片段或重新上传素材')
    const totalDuration = clips.reduce((sum, clip) => sum + clip.trimDuration, 0)
    if (totalDuration > MAX_EXPORT_DURATION_SECONDS) {
      throw new ApiError(400, 'timeline_too_long', `导出总时长不能超过 ${MAX_EXPORT_DURATION_SECONDS / 3600} 小时`)
    }
    const capability = await this.capability()
    if (!capability.ffmpeg) {
      throw new ApiError(503, 'ffmpeg_missing', '服务器未安装 ffmpeg，无法导出视频；剪辑时间线仍可保存。可在服务器安装 ffmpeg 或设置 FFMPEG_PATH')
    }

    const record = this.database.createVideoExport(userId, {
      contentId,
      timeline: clips.map((clip) => ({
        id: clip.id,
        mediaId: clip.mediaId,
        trimStart: clip.trimStart,
        trimEnd: clip.trimEnd,
        duration: clip.duration,
      })),
      totalDuration,
    })
    this.queue = this.queue.then(() => this.runExport(userId, record.id)).catch(() => {
      // runExport records its own failure; keep the queue alive.
    })
    return record
  }

  // ------------------------------------------------------------------ internals

  private mediaPath(filename: string): string {
    // media.filename is generated server-side (uuid.ext); the basename check
    // keeps a corrupted row from escaping the uploads directory.
    const base = path.basename(filename)
    if (base !== filename) throw new ApiError(400, 'invalid_media', '素材文件名无效')
    return path.join(this.config.uploadsDir, base)
  }  private mapClips(clips: StoredVideoClip[], userId: string) {
    if (clips.length === 0) return []
    const mediaIds = [...new Set(clips.map((clip) => clip.mediaId))]
    const media = mediaIds.map((id) => this.database.getMedia(userId, id))
    const byId = new Map(media.map((item) => (item ? [item.id, item] : null)).filter(Boolean) as Array<[string, NonNullable<(typeof media)[number]>]>)
    return clips.map((clip) => ({
      ...clip,
      trimDuration: clip.trimEnd !== null ? Math.max(0, clip.trimEnd - clip.trimStart) : Math.max(0, (clip.duration ?? 0) - clip.trimStart),
      media: byId.get(clip.mediaId) ?? null,
    }))
  }

  private async runExport(userId: string, exportId: string): Promise<void> {
    const record = this.database.getVideoExport(userId, exportId)
    if (!record) return
    const jobDir = path.join(this.config.dataDir, 'video-exports', exportId)
    try {
      this.database.updateVideoExport(userId, exportId, { status: 'running', progress: 0, message: '' })
      mkdirSync(jobDir, { recursive: true })

      const segmentPlan: Array<{
        source: string
        hasAudio: boolean
        /** Clamped trim window within the source. */
        trimStart: number
        trimEnd: number | null
        /** Source duration from probe/media metadata. */
        sourceDuration: number
        /** Seconds the trimmed segment will play. */
        segmentDuration: number
      }> = []
      let targetWidth = 0
      let targetHeight = 0
      for (const clip of record.clips) {
        const media = clip.media
        if (!media) throw new Error(`片段素材不存在：${clip.mediaId}`)
        const source = this.mediaPath(media.filename)
        if (!existsSync(source)) throw new Error(`素材文件已丢失：${media.originalName}`)
        const probe = await this.probeFile(source)
        const sourceDuration = probe?.duration ?? clip.duration ?? clip.trimDuration
        if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error(`无法读取视频时长：${media.originalName}`)
        const hasAudio = probe ? probe.hasAudio : true
        let width = probe?.width ?? media.width ?? 1280
        let height = probe?.height ?? media.height ?? 720
        if (!Number.isFinite(width) || width <= 0) width = 1280
        if (!Number.isFinite(height) || height <= 0) height = 720
        // The first clip decides the canvas; later clips letterbox into it.
        if (targetWidth === 0) {
          targetWidth = Math.max(2, Math.round(width / 2) * 2)
          targetHeight = Math.max(2, Math.round(height / 2) * 2)
        }
        const trimStart = Math.max(0, Math.min(clip.trimStart, sourceDuration - MIN_CLIP_SECONDS))
        const trimEnd = clip.trimEnd === null ? null : Math.min(clip.trimEnd, sourceDuration)
        const segmentDuration = (trimEnd ?? sourceDuration) - trimStart
        if (segmentDuration < MIN_CLIP_SECONDS) throw new Error(`片段有效时长过短：${media.originalName}`)
        segmentPlan.push({ source, hasAudio, trimStart, trimEnd, sourceDuration, segmentDuration })
      }

      const segmentFiles: string[] = []
      for (let index = 0; index < segmentPlan.length; index++) {
        const item = segmentPlan[index]
        const segmentPath = path.join(jobDir, `seg_${String(index).padStart(3, '0')}.mp4`)
        const args = buildSegmentArgs({
          ffmpegPath: this.ffmpegPath,
          source: item.source,
          trimStart: item.trimStart,
          trimEnd: item.trimEnd,
          fallbackDuration: item.sourceDuration,
          hasAudio: item.hasAudio,
          width: targetWidth,
          height: targetHeight,
          output: segmentPath,
        })
        await this.runFfmpegWithProgress(args, item.segmentDuration, index, segmentPlan.length, userId, exportId)
        segmentFiles.push(segmentPath)
      }

      const outputPath = path.join(jobDir, 'output.mp4')
      if (segmentFiles.length === 1) {
        // A single trimmed segment is already normalized; skip the concat pass.
        copyFileSync(segmentFiles[0], outputPath)
      } else {
        const listPath = path.join(jobDir, 'list.txt')
        writeFileSync(listPath, segmentFiles.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
        await runCommand(this.ffmpegPath, [
          '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
          '-c', 'copy', '-movflags', '+faststart', outputPath,
        ], EXPORT_TIMEOUT_MS)
      }

      const size = statSync(outputPath).size
      if (size <= 0) throw new Error('导出结果为空')
      const filename = `${randomUUID()}.mp4`
      copyFileSync(outputPath, path.join(this.config.uploadsDir, filename))
      const safeTitle = record.clips.length > 0
        ? (this.database.getContentSummary(userId, record.contentId)?.title ?? '视频').replace(/[\\/:*?"<>|\n\r]/g, '_').slice(0, 80)
        : '视频'
      const media = this.database.createMedia(userId, {
        kind: 'video',
        filename,
        originalName: `${safeTitle || '视频'}-成片.mp4`,
        mimeType: 'video/mp4',
        size,
        meta: {
          duration: Math.round(record.totalDuration * 100) / 100,
          width: targetWidth,
          height: targetHeight,
          hasAudio: true,
          videoCodec: 'h264',
          audioCodec: 'aac',
        },
      })
      this.database.updateVideoExport(userId, exportId, {
        status: 'completed',
        progress: 100,
        message: '',
        outputMediaId: media.id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出失败'
      this.database.updateVideoExport(userId, exportId, { status: 'failed', message })
    } finally {
      try {
        rmSync(jobDir, { recursive: true, force: true })
      } catch {
        // Best effort cleanup.
      }
    }
  }

  private async runFfmpegWithProgress(
    args: string[],
    segmentDuration: number,
    segmentIndex: number,
    segmentCount: number,
    userId: string,
    exportId: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      let done = false
      const timer = setTimeout(() => {
        if (!done) {
          done = true
          child.kill('SIGKILL')
          reject(new Error(`导出超时（${Math.round(EXPORT_TIMEOUT_MS / 60000)} 分钟）`))
        }
      }, EXPORT_TIMEOUT_MS)
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        const match = /out_time_us=(\d+)/g
        let latest: number | null = null
        let found: RegExpExecArray | null
        while ((found = match.exec(text)) !== null) latest = Number(found[1])
        if (latest !== null && segmentDuration > 0) {
          const fraction = Math.max(0, Math.min(1, latest / 1_000_000 / segmentDuration))
          const overall = ((segmentIndex + fraction) / segmentCount) * 95
          this.database.updateVideoExport(userId, exportId, { progress: overall })
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 100_000) stderr += chunk.toString()
      })
      child.on('error', (error) => {
        if (!done) {
          done = true
          clearTimeout(timer)
          reject(error)
        }
      })
      child.on('close', (code) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg 退出码 ${code}${stderr ? `：${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`))
      })
    })
  }
}

interface SegmentArgsInput {
  ffmpegPath: string
  source: string
  trimStart: number
  trimEnd: number | null
  fallbackDuration: number
  hasAudio: boolean
  width: number
  height: number
  output: string
}

/** ffprobe one file; null when the tool is missing or the file is unreadable. */
export async function probeVideoFile(filePath: string, ffprobePath: string): Promise<VideoProbeResult | null> {
  if (!existsSync(filePath)) return null
  try {
    const { stdout } = await runCommand(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      60_000,
    )
    return parseProbeOutput(stdout)
  } catch {
    return null
  }
}

/**
 * URL of the most recent completed export for a video content, used by the
 * render pipeline so 渲染记录 can preview the exported cut. Returns null for
 * article contents or when nothing has been exported yet.
 */
export function latestExportOutputUrl(database: Database, userId: string, contentId: string): string | null {
  const record = database
    .listVideoExports(userId, contentId)
    .find((item) => item.status === 'completed' && item.outputMedia)
  return record?.outputMedia?.url ?? null
}

/**
 * Build the ffmpeg arguments that cut one clip and normalize it onto the
 * shared canvas: h264 + aac, yuv420p, 30fps, even dimensions, letterboxed.
 * Exported with -progress so the runner can report job progress.
 */
export function buildSegmentArgs(input: SegmentArgsInput): string[] {
  const end = input.trimEnd ?? (input.trimStart + input.fallbackDuration)
  const duration = Math.max(MIN_CLIP_SECONDS, end - input.trimStart)
  const filters = [
    `scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease`,
    `pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    'fps=30',
    'format=yuv420p',
  ]
  const args = ['-y', '-ss', trimNumber(input.trimStart)]
  if (input.trimEnd !== null) args.push('-to', trimNumber(input.trimEnd))
  args.push('-i', input.source)
  if (!input.hasAudio) {
    // Keep every segment mux-compatible: fill missing audio with silence.
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo')
  }
  args.push(
    '-t', trimNumber(duration),
    '-vf', filters.join(','),
    '-map', '0:v:0',
    '-map', input.hasAudio ? '0:a:0' : '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    input.output,
  )
  return args
}

function trimNumber(value: number): string {
  return (Math.round(value * 1000) / 1000).toFixed(3)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

interface RawProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  duration?: string | number
  avg_frame_rate?: string
  r_frame_rate?: string
}

/** Parse `ffprobe -print_format json` output into a compact probe result. */
export function parseProbeOutput(stdout: string): VideoProbeResult | null {
  let payload: { streams?: RawProbeStream[]; format?: { duration?: string | number; format_name?: string } }
  try {
    payload = JSON.parse(stdout)
  } catch {
    return null
  }
  const streams = Array.isArray(payload.streams) ? payload.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video')
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  if (!video) return null
  const toSeconds = (value: string | number | undefined): number | null => {
    const num = typeof value === 'string' ? Number(value) : value
    return typeof num === 'number' && Number.isFinite(num) && num > 0 ? num : null
  }
  const duration = toSeconds(payload.format?.duration) ?? toSeconds(video.duration)
  const fpsValue = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate)
  return {
    duration: duration === null ? null : Math.round(duration * 1000) / 1000,
    width: typeof video.width === 'number' ? video.width : null,
    height: typeof video.height === 'number' ? video.height : null,
    hasAudio: Boolean(audio),
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    fps: fpsValue,
    formatName: payload.format?.format_name ?? null,
  }
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null
  const [numerator, denominator] = value.split('/')
  const num = Number(numerator)
  const den = Number(denominator)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null
  const fps = num / den
  return fps > 0 && fps < 1000 ? Math.round(fps * 100) / 100 : null
}
