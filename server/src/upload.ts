import { randomUUID } from 'node:crypto'
import path from 'node:path'
import multer from 'multer'
import type { MediaKind } from '../../shared/types'
import { ApiError } from './errors'

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024

export interface MediaDescriptor {
  ext: string
  kind: MediaKind
  mimeType: string
}

const MEDIA_TYPES: Record<string, MediaDescriptor> = {
  jpg: { ext: 'jpg', kind: 'image', mimeType: 'image/jpeg' },
  jpeg: { ext: 'jpeg', kind: 'image', mimeType: 'image/jpeg' },
  png: { ext: 'png', kind: 'image', mimeType: 'image/png' },
  webp: { ext: 'webp', kind: 'image', mimeType: 'image/webp' },
  gif: { ext: 'gif', kind: 'image', mimeType: 'image/gif' },
  svg: { ext: 'svg', kind: 'image', mimeType: 'image/svg+xml' },
  mp4: { ext: 'mp4', kind: 'video', mimeType: 'video/mp4' },
  webm: { ext: 'webm', kind: 'video', mimeType: 'video/webm' },
  mov: { ext: 'mov', kind: 'video', mimeType: 'video/quicktime' },
}

export const UPLOAD_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/** Resolve a supported extension to its canonical kind/mime type. */
export function getMediaDescriptor(originalName: string): MediaDescriptor | null {
  const ext = path.extname(originalName).replace(/^\./, '').toLowerCase()
  return MEDIA_TYPES[ext] ?? null
}

/** Multer/busboy decodes multipart filenames as latin1; recover UTF-8 names. */
export function decodeOriginalName(name: string): string {
  if (!name) return 'file'
  if (/[^\x00-\xff]/.test(name)) return name
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8')
    return decoded.includes('\ufffd') ? name : decoded
  } catch {
    return name
  }
}

function mimeMatches(descriptor: MediaDescriptor, mimeType: string): boolean {
  const mime = (mimeType || '').toLowerCase()
  if (!mime || mime === 'application/octet-stream') return true
  return mime.startsWith(descriptor.kind === 'image' ? 'image/' : 'video/')
}

export function maxBytesFor(descriptor: MediaDescriptor): number {
  return descriptor.kind === 'image' ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES
}

/**
 * Multer instance writing random UUID filenames into DATA_DIR/uploads. The
 * global limit is the video limit; image-specific limits are enforced in the
 * route after the file has been written (and the file removed on rejection).
 */
export function createUploader(uploadsDir: string) {
  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadsDir),
    filename: (_req, file, callback) => {
      const descriptor = getMediaDescriptor(file.originalname)
      if (!descriptor) {
        callback(new ApiError(400, 'unsupported_media_type', '不支持的媒体类型'), '')
        return
      }
      callback(null, `${randomUUID()}.${descriptor.ext}`)
    },
  })

  return multer({
    storage,
    limits: {
      fileSize: VIDEO_MAX_BYTES,
      files: 1,
      fields: 10,
    },
    fileFilter: (_req, file, callback) => {
      const descriptor = getMediaDescriptor(file.originalname)
      if (!descriptor) {
        callback(
          new ApiError(400, 'unsupported_media_type', '仅支持 JPG、PNG、WebP、GIF、SVG、MP4、WebM、MOV 文件'),
        )
        return
      }
      if (!mimeMatches(descriptor, file.mimetype)) {
        callback(new ApiError(400, 'unsupported_media_type', '文件类型与扩展名不匹配'))
        return
      }
      callback(null, true)
    },
  })
}
