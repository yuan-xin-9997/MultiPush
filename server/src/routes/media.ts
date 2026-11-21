import { Router } from 'express'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { currentUser } from '../auth'
import type { AppConfig } from '../config'
import type { Database } from '../db'
import { ApiError, asyncHandler, notFound } from '../errors'
import { createUploader, decodeOriginalName, getMediaDescriptor, maxBytesFor } from '../upload'
import {
  mediaFolderInputSchema,
  mediaListQuerySchema,
  mediaMoveInputSchema,
  mediaStatsQuerySchema,
  parseInput,
} from '../validation'
import { probeVideoFile } from '../video'

async function removeFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch {
    // Best effort: a missing file is already the desired state.
  }
}

export function createMediaRouter(database: Database, config: AppConfig): Router {
  const router = Router()
  const uploader = createUploader(config.uploadsDir)
  const ffprobePath = process.env.FFPROBE_PATH?.trim() || 'ffprobe'

  router.post(
    '/',
    uploader.single('file'),
    asyncHandler(async (req, res) => {
      const user = currentUser(req)
      const file = req.file
      if (!file) {
        throw new ApiError(400, 'missing_file', '请选择要上传的文件')
      }

      const originalName = decodeOriginalName(file.originalname)
      const descriptor = getMediaDescriptor(originalName)
      if (!descriptor) {
        await removeFile(file.path)
        throw new ApiError(400, 'unsupported_media_type', '不支持的媒体类型')
      }

      if (file.size <= 0) {
        await removeFile(file.path)
        throw new ApiError(400, 'empty_file', '不能上传空文件')
      }

      const limit = maxBytesFor(descriptor)
      if (file.size > limit) {
        await removeFile(file.path)
        const limitMb = Math.round(limit / (1024 * 1024))
        const label = descriptor.kind === 'image' ? '图片' : descriptor.kind === 'video' ? '视频' : '文档'
        throw new ApiError(413, 'file_too_large', `${label}不能超过 ${limitMb}MB`)
      }

      try {
        const folderId = typeof req.body?.folderId === 'string' && req.body.folderId.trim()
          ? req.body.folderId.trim()
          : null
        if (folderId && !database.getMediaFolder(user.id, folderId)) {
          throw notFound('素材文件夹不存在')
        }
        // ffprobe runs inline: it only reads container headers, so it is fast
        // even for large videos and the duration is available immediately.
        const probe = descriptor.kind === 'video' ? await probeVideoFile(file.path, ffprobePath) : null
        const media = database.createMedia(user.id, {
          folderId,
          kind: descriptor.kind,
          filename: path.basename(file.filename),
          originalName,
          mimeType: descriptor.mimeType,
          size: file.size,
          meta: probe
            ? {
                duration: probe.duration ?? null,
                width: probe.width ?? null,
                height: probe.height ?? null,
                hasAudio: probe.hasAudio,
                videoCodec: probe.videoCodec ?? null,
                audioCodec: probe.audioCodec ?? null,
              }
            : null,
        })
        res.json({ media })
      } catch (error) {
        await removeFile(file.path)
        throw error
      }
    }),
  )

  router.get(
    '/folders',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      res.json({ folders: database.listMediaFolders(user.id) })
    }),
  )

  router.post(
    '/folders',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const input = parseInput(mediaFolderInputSchema, req.body)
      if (database.getMediaFolderByName(user.id, input.name)) {
        throw new ApiError(409, 'media_folder_exists', '同名文件夹已存在')
      }
      res.json({ folder: database.createMediaFolder(user.id, input.name) })
    }),
  )

  router.patch(
    '/folders/:id',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      if (!database.getMediaFolder(user.id, req.params.id)) throw notFound('素材文件夹不存在')
      const input = parseInput(mediaFolderInputSchema, req.body)
      const existing = database.getMediaFolderByName(user.id, input.name)
      if (existing && existing.id !== req.params.id) {
        throw new ApiError(409, 'media_folder_exists', '同名文件夹已存在')
      }
      res.json({ folder: database.renameMediaFolder(user.id, req.params.id, input.name) })
    }),
  )

  router.delete(
    '/folders/:id',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const result = database.deleteMediaFolder(user.id, req.params.id)
      if (!result) throw notFound('素材文件夹不存在')
      res.json({ ok: true, moved: result.moved })
    }),
  )

  router.get(
    '/',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const query = parseInput(mediaListQuerySchema, req.query)
      res.json({
        media: database.listMedia(user.id, query),
        total: database.countMedia(user.id, query),
        page: query.page,
        pageSize: query.pageSize,
      })
    }),
  )

  router.get(
    '/stats',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const query = parseInput(mediaStatsQuerySchema, req.query)
      res.json({ stats: database.getMediaStats(user.id, query) })
    }),
  )

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const media = database.getMedia(user.id, req.params.id)
      if (!media) throw notFound('媒体文件不存在')
      const input = parseInput(mediaMoveInputSchema, req.body)
      if (input.folderId && !database.getMediaFolder(user.id, input.folderId)) {
        throw notFound('素材文件夹不存在')
      }
      const updated = database.moveMedia(user.id, media.id, input.folderId)
      if (!updated) throw notFound('媒体文件不存在')
      res.json({ media: updated })
    }),
  )

  router.get(
    '/:id/probe',
    asyncHandler(async (req, res) => {
      const user = currentUser(req)
      const media = database.getMedia(user.id, req.params.id)
      if (!media) throw notFound('媒体文件不存在')
      if (media.kind !== 'video') throw new ApiError(400, 'not_video', '只能探测视频素材')
      const probe = await probeVideoFile(path.join(config.uploadsDir, media.filename), ffprobePath)
      if (!probe) throw new ApiError(503, 'ffprobe_missing', '服务器未安装 ffprobe，无法探测视频信息')
      database.updateMediaMeta(user.id, media.id, {
        duration: probe.duration ?? null,
        width: probe.width ?? null,
        height: probe.height ?? null,
        hasAudio: probe.hasAudio,
        videoCodec: probe.videoCodec ?? null,
        audioCodec: probe.audioCodec ?? null,
      })
      res.json({ probe })
    }),
  )

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const user = currentUser(req)
      const media = database.getMedia(user.id, req.params.id)
      if (!media) throw notFound('媒体文件不存在')
      database.deleteMedia(user.id, media.id)
      await removeFile(path.join(config.uploadsDir, media.filename))
      res.json({ ok: true })
    }),
  )

  return router
}
