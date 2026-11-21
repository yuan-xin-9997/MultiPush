import { randomUUID } from 'node:crypto'
import path from 'node:path'
import multer from 'multer'
import type { MediaKind } from '../../shared/types'
import { ApiError } from './errors'

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024
export const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024

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
  mp4: { ext: 'mp4', kind: 'video', mimeType: 'video/mp4' },
  webm: { ext: 'webm', kind: 'video', mimeType: 'video/webm' },
  mov: { ext: 'mov', kind: 'video', mimeType: 'video/quicktime' },
  pdf: { ext: 'pdf', kind: 'document', mimeType: 'application/pdf' },
  doc: { ext: 'doc', kind: 'document', mimeType: 'application/msword' },
  docx: { ext: 'docx', kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xls: { ext: 'xls', kind: 'document', mimeType: 'application/vnd.ms-excel' },
  xlsx: { ext: 'xlsx', kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  ppt: { ext: 'ppt', kind: 'document', mimeType: 'application/vnd.ms-powerpoint' },
  pptx: { ext: 'pptx', kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  txt: { ext: 'txt', kind: 'document', mimeType: 'text/plain' },
  md: { ext: 'md', kind: 'document', mimeType: 'text/markdown' },
  markdown: { ext: 'markdown', kind: 'document', mimeType: 'text/markdown' },
  csv: { ext: 'csv', kind: 'document', mimeType: 'text/csv' },
  json: { ext: 'json', kind: 'document', mimeType: 'application/json' },
  html: { ext: 'html', kind: 'document', mimeType: 'text/html' },
  htm: { ext: 'htm', kind: 'document', mimeType: 'text/html' },
  xml: { ext: 'xml', kind: 'document', mimeType: 'application/xml' },
  yml: { ext: 'yml', kind: 'document', mimeType: 'application/yaml' },
  yaml: { ext: 'yaml', kind: 'document', mimeType: 'application/yaml' },
  rtf: { ext: 'rtf', kind: 'document', mimeType: 'application/rtf' },
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
  if (descriptor.kind === 'image') return mime.startsWith('image/')
  if (descriptor.kind === 'video') return mime.startsWith('video/')
  // Browsers report Office files, Markdown and YAML inconsistently. The
  // extension already decided the storage type, so accept text/ and
  // application/ MIME types for documents instead of rejecting valid uploads.
  return mime.startsWith('text/') || mime.startsWith('application/')
}

export function maxBytesFor(descriptor: MediaDescriptor): number {
  if (descriptor.kind === 'image') return IMAGE_MAX_BYTES
  if (descriptor.kind === 'video') return VIDEO_MAX_BYTES
  return DOCUMENT_MAX_BYTES
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
          new ApiError(
            400,
            'unsupported_media_type',
            '仅支持图片、视频和常见文档（PDF / Word / Excel / PPT / TXT / Markdown / CSV / JSON / HTML 等）',
          ),
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
