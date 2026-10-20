import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express'
import type { ApiErrorBody } from '../../shared/types'

export type ApiErrorIssue = NonNullable<ApiErrorBody['issues']>[number]

/**
 * Error carrying an HTTP status and a stable machine-readable code. Route code
 * throws these; the final error middleware turns them into the documented
 * `{ error, message, issues? }` JSON shape.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly issues?: ApiErrorIssue[]

  constructor(status: number, code: string, message: string, issues?: ApiErrorIssue[]) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.issues = issues
  }
}

export function notFound(message = '资源不存在'): ApiError {
  return new ApiError(404, 'not_found', message)
}

export function unauthorized(message = '请先登录'): ApiError {
  return new ApiError(401, 'unauthorized', message)
}

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => unknown

/** Wrap async handlers so rejected promises reach the Express error middleware. */
export function asyncHandler(handler: AsyncRoute): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function multerErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { name?: unknown; code?: unknown }
  if (candidate.name !== 'MulterError') return null
  return typeof candidate.code === 'string' ? candidate.code : 'UPLOAD_ERROR'
}

/** Final error middleware. Always responds with the unified JSON error body. */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error)
    return
  }

  if (error instanceof ApiError) {
    const body: ApiErrorBody = { error: error.code, message: error.message }
    if (error.issues?.length) body.issues = error.issues
    res.status(error.status).json(body)
    return
  }

  // Zod errors thrown directly rather than via `parseInput`.
  if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'ZodError') {
    const issues = (error as { issues?: Array<{ path?: PropertyKey[]; message?: string }> }).issues ?? []
    res.status(400).json({
      error: 'validation_failed',
      message: '请求参数有误',
      issues: issues.map((issue) => ({
        path: (issue.path ?? []).map((segment) => String(segment)).join('.') || '(root)',
        message: issue.message || '参数不合法',
      })),
    })
    return
  }

  const uploadCode = multerErrorCode(error)
  if (uploadCode) {
    if (uploadCode === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'file_too_large', message: '文件大小超出限制' })
      return
    }
    if (uploadCode === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({ error: 'invalid_upload', message: '上传字段必须为 file' })
      return
    }
    res.status(400).json({ error: 'invalid_upload', message: '文件上传失败，请重试' })
    return
  }

  const typed = error as { type?: unknown; status?: unknown; statusCode?: unknown } | null
  if (typed?.type === 'entity.too.large' || typed?.status === 413) {
    res.status(413).json({ error: 'payload_too_large', message: '请求内容过大' })
    return
  }
  if (typed?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json', message: '请求体必须是合法的 JSON' })
    return
  }

  const status = typeof typed?.statusCode === 'number' ? typed.statusCode : 500
  if (status >= 500) {
    console.error(`[multipush] ${req.method} ${req.originalUrl} failed:`, error)
  }
  res.status(500).json({ error: 'internal_error', message: '服务器内部错误' })
}

export { errorMessage }
