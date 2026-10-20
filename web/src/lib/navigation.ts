/**
 * Only allow same-origin absolute paths as post-login redirects.
 * Rejects protocol-relative and external URLs.
 */
export function safeRedirect(value: string | null | undefined, fallback = '/library'): string {
  if (!value) return fallback
  if (!value.startsWith('/') || value.startsWith('//')) return fallback
  return value
}
