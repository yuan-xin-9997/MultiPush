import { Router } from 'express'
import { unlink } from 'node:fs'
import path from 'node:path'
import { currentUser } from '../auth'
import type { AppConfig } from '../config'
import type { Database } from '../db'
import { ApiError, asyncHandler, notFound } from '../errors'
import { createUploader, decodeOriginalName, getMediaDescriptor, maxBytesFor } from '../upload'

function removeFile(filePath: string): void {
  unlink(filePath, () => {
    // Best effort: a missing file is already the desired state.
  })
}

export function createMediaRouter(database: Database, config: AppConfig): Router {
  const router = Router()
  const uploader = createUploader(config.uploadsDir)

  router.post(
    '/',
    uploader.single('file'),
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const file = req.file
      if (!file) {
        throw new ApiError(400, 'missing_file', '请选择要上传的文件')
      }

      const originalName = decodeOriginalName(file.originalname)
      const descriptor = getMediaDescriptor(originalName)
      if (!descriptor) {
        removeFile(file.path)
        throw new ApiError(400, 'unsupported_media_type', '不支持的媒体类型')
      }

      if (file.size <= 0) {
        removeFile(file.path)
        throw new ApiError(400, 'empty_file', '不能上传空文件')
      }

      const limit = maxBytesFor(descriptor)
      if (file.size > limit) {
        removeFile(file.path)
        const limitMb = Math.round(limit / (1024 * 1024))
        throw new ApiError(413, 'file_too_large', `${descriptor.kind === 'image' ? '图片' : '视频'}不能超过 ${limitMb}MB`)
      }

      try {
        const media = database.createMedia(user.id, {
          kind: descriptor.kind,
          filename: path.basename(file.filename),
          originalName,
          mimeType: descriptor.mimeType,
          size: file.size,
        })
        res.json({ media })
      } catch (error) {
        removeFile(file.path)
        throw error
      }
    }),
  )

  router.get(
    '/',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      res.json({ media: database.listMedia(user.id) })
    }),
  )

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const media = database.getMedia(user.id, req.params.id)
      if (!media) throw notFound('媒体文件不存在')
      database.deleteMedia(user.id, media.id)
      removeFile(path.join(config.uploadsDir, media.filename))
      res.json({ ok: true })
    }),
  )

  return router
}
