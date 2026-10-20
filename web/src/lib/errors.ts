import { ApiError } from '@/lib/api'

/**
 * Turn an unknown thrown value (usually ApiError) into a user-facing message.
 * Prefers field-level validation issues when the API returns them.
 */
export function getErrorMessage(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof ApiError) {
    const issueText = error.issues
      ?.map((issue) => issue.message)
      .filter(Boolean)
      .join('；')
    if (issueText) return issueText
    return error.message || fallback
  }
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}
