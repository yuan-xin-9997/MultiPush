import type { Editor } from '@tiptap/core'

/** Where a body image lives, which decides whether it can be reused as-is. */
export type CoverImageSource = 'local' | 'embedded' | 'external'

export interface CoverImageCandidate {
  /** Canonical URL that is safe to persist as the document cover. */
  src: string
  /** URL exactly as it appears in the document, used when it must be fetched. */
  originalSrc: string
  alt: string
  source: CoverImageSource
}

const COVER_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])

function hasUnsupportedScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^(?:https?:|data:)/i.test(value)
}

function sameOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value, origin).origin === new URL(origin).origin
  } catch {
    return false
  }
}

/**
 * Turn a document image URL into the value stored on `coverImage`.
 *
 * Same-origin URLs become root-relative so the cover keeps working when the
 * deployment domain changes. Data and external URLs stay untouched.
 */
export function normalizeCoverSrc(raw: string, origin = window.location.origin): string {
  const value = (raw ?? '').trim()
  if (!value || value.startsWith('#')) return value
  if (/^data:/i.test(value)) return value
  if (hasUnsupportedScheme(value)) return value
  try {
    const url = new URL(value, origin)
    if (sameOrigin(value, origin)) return `${url.pathname}${url.search}${url.hash}`
    return url.href
  } catch {
    return value
  }
}

export function coverImageSource(src: string): CoverImageSource {
  if (/^data:/i.test(src)) return 'embedded'
  if (/^https?:\/\//i.test(src)) return 'external'
  return 'local'
}

/** Local uploads can be referenced directly; embedded/external images must be copied first. */
export function coverImageNeedsUpload(src: string): boolean {
  return coverImageSource(src) !== 'local'
}

export function isSameCoverSource(
  coverImage: string | null | undefined,
  candidate: string,
  origin = window.location.origin,
): boolean {
  if (!coverImage) return false
  return normalizeCoverSrc(coverImage, origin) === normalizeCoverSrc(candidate, origin)
}

/**
 * Collect every image in the editor document, in reading order and without
 * duplicates. Images inside figures/tables are included.
 */
export function collectBodyImages(editor: Editor, origin = window.location.origin): CoverImageCandidate[] {
  const images: CoverImageCandidate[] = []
  const seen = new Set<string>()

  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'image') return true
    const originalSrc = typeof node.attrs.src === 'string' ? node.attrs.src.trim() : ''
    if (!originalSrc || originalSrc.startsWith('blob:') || hasUnsupportedScheme(originalSrc)) return true
    if (/^data:/i.test(originalSrc) && !/^data:image\//i.test(originalSrc)) return true
    const src = normalizeCoverSrc(originalSrc, origin)
    if (!src || src.startsWith('blob:') || seen.has(src)) return true
    seen.add(src)
    images.push({
      src,
      originalSrc,
      alt: typeof node.attrs.alt === 'string' ? node.attrs.alt.trim() : '',
      source: coverImageSource(src),
    })
    return true
  })

  return images
}

/**
 * Pick a supported extension for a fetched image. MIME type wins; the URL (or
 * data URI header) is used as a fallback when servers omit Content-Type.
 */
export function coverFileExtension(src: string, mimeType: string): string | null {
  const mime = mimeType.toLowerCase().split(';')[0].trim()
  const byMime = COVER_MIME_EXTENSIONS[mime]
  if (byMime) return byMime

  const dataMime = /^data:([^;,]+)/i.exec(src)?.[1]?.toLowerCase().trim()
  if (dataMime && COVER_MIME_EXTENSIONS[dataMime]) return COVER_MIME_EXTENSIONS[dataMime]

  try {
    const pathname = new URL(src, 'http://placeholder.invalid/').pathname
    const extension = pathname.split('.').pop()?.toLowerCase() ?? ''
    if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) return extension
  } catch {
    // Fall through to the caller's unsupported-format message.
  }

  return null
}
