/**
 * Shared figure/caption rules.
 *
 * The editor, import pipeline and every renderer must agree on what counts as
 * an image caption, otherwise a document can gain or lose a figure after a
 * round-trip. Keep this module pure so it can be bundled in both the browser
 * and the server.
 */

/** Inline styles required by the WeChat / Zhihu / blog article body. */
export const FIGURE_INLINE_STYLE = 'margin:20px 0;'
export const FIGURE_IMAGE_INLINE_STYLE =
  'display:block;max-width:100%;height:auto;border-radius:8px;margin:0 auto;'
export const FIGCAPTION_INLINE_STYLE =
  'margin-top:8px;text-align:center;color:#8a8f99;font-size:13px;line-height:1.6;'

/**
 * A caption must start with `图` followed by an optional number and a real
 * colon. Only the beginning is checked: punctuation, emoji and further colons
 * belong to the caption text and are never rewritten.
 */
export const FIGURE_CAPTION_PATTERN = /^图\s*(?:[0-9０-９]+|[一二三四五六七八九十百]+)?\s*[:：]/

/** Ignore zero-width markers before deciding whether a paragraph is a caption. */
export function isFigureCaptionText(value: string): boolean {
  const text = value.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim()
  return text.length > 0 && FIGURE_CAPTION_PATTERN.test(text)
}

/** A block that only contains this image has no readable text of its own. */
export function isBlankCaptionContainerText(value: string): boolean {
  return value.replace(/[\u200b\u200c\u200d\ufeff\s]/g, '').length === 0
}

export const FIGURE_CAPTION_HINT = '图：'
