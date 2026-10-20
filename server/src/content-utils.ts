import * as cheerio from 'cheerio'
import type { RichTextJson } from '../../shared/types'

export const DEFAULT_CONTENT_TITLE = '无标题文档'
export const EXCERPT_LENGTH = 160
export const MAX_TAGS = 10
export const MAX_TAG_LENGTH = 24

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
const WORD_PATTERN = /[A-Za-z0-9]+(?:[._'’-][A-Za-z0-9]+)*/g

/** Normalize whitespace so excerpts and word counts are stable. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

export function sliceChars(text: string, length: number): string {
  if (length <= 0) return ''
  return Array.from(text).slice(0, length).join('')
}

/** Extract readable text from an HTML fragment, inserting spaces at block boundaries. */
export function htmlToPlainText(html: string): string {
  if (!html || !html.trim()) return ''
  try {
    const $ = cheerio.load(html)
    $('script, style, noscript, template, svg').remove()
    $('br').replaceWith(' ')
    $(
      'p, div, section, article, header, footer, main, aside, h1, h2, h3, h4, h5, h6, li, ul, ol, tr, td, th, blockquote, pre, code, figure, figcaption, hr, table',
    ).each((_index, element) => {
      $(element).append(' ')
    })
    return normalizeWhitespace($('body').text() || $.root().text())
  } catch {
    return normalizeWhitespace(html.replace(/<[^>]*>/g, ' '))
  }
}

/** Best-effort text extraction from a Tiptap JSON document. */
export function jsonToPlainText(value: unknown): string {
  const parts: string[] = []
  const visit = (node: unknown): void => {
    if (!node) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if (typeof record.text === 'string') parts.push(record.text)
    if (record.type === 'hardBreak') parts.push(' ')
    if (Array.isArray(record.content)) {
      for (const child of record.content) visit(child)
    }
  }
  visit(value)
  return normalizeWhitespace(parts.join(' '))
}

export function plainTextFromContent(html: string | null | undefined, json: unknown): string {
  const fromHtml = htmlToPlainText(html ?? '')
  if (fromHtml) return fromHtml
  return jsonToPlainText(json)
}

/** Chinese characters count as one word each; Latin/number tokens count as words. */
export function countWords(text: string): number {
  if (!text) return 0
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0
  const withoutCjk = text.replace(CJK_PATTERN, ' ')
  const latinCount = withoutCjk.match(WORD_PATTERN)?.length ?? 0
  return cjkCount + latinCount
}

export function countMediaFromJson(json: unknown): { imageCount: number; videoCount: number } {
  let imageCount = 0
  let videoCount = 0
  const visit = (node: unknown): void => {
    if (!node) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if (record.type === 'image') imageCount += 1
    if (record.type === 'video') videoCount += 1
    if (Array.isArray(record.content)) {
      for (const child of record.content) visit(child)
    }
  }
  visit(json)
  return { imageCount, videoCount }
}

export function countMedia(html: string | null | undefined, json: unknown): { imageCount: number; videoCount: number } {
  if (html && html.trim()) {
    try {
      const $ = cheerio.load(html)
      return { imageCount: $('img').length, videoCount: $('video').length }
    } catch {
      const images = (html.match(/<img\b/gi) ?? []).length
      const videos = (html.match(/<video\b/gi) ?? []).length
      return { imageCount: images, videoCount: videos }
    }
  }
  return countMediaFromJson(json)
}

/** Trim, truncate, de-duplicate and cap tags according to the product spec. */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    let tag = normalizeWhitespace(raw)
    if (!tag) continue
    if (Array.from(tag).length > MAX_TAG_LENGTH) {
      tag = Array.from(tag).slice(0, MAX_TAG_LENGTH).join('').trim()
    }
    if (!tag) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
    if (result.length >= MAX_TAGS) break
  }
  return result
}

export function defaultContentTitle(title: string | null | undefined): string {
  const trimmed = (title ?? '').trim()
  return trimmed || DEFAULT_CONTENT_TITLE
}

export interface ContentMetricsInput {
  contentHtml?: string | null
  contentJson?: unknown
  excerpt?: string | null
}

export interface ContentMetrics {
  excerpt: string
  wordCount: number
  imageCount: number
  videoCount: number
}

/** Derive excerpt/counts for create and content-changing update requests. */
export function deriveContentMetrics(input: ContentMetricsInput): ContentMetrics {
  const plainText = plainTextFromContent(input.contentHtml, input.contentJson)
  const explicitExcerpt = typeof input.excerpt === 'string' ? normalizeWhitespace(input.excerpt) : ''
  const excerpt = explicitExcerpt || sliceChars(plainText, EXCERPT_LENGTH)
  const media = countMedia(input.contentHtml, input.contentJson)
  return {
    excerpt,
    wordCount: countWords(plainText),
    imageCount: media.imageCount,
    videoCount: media.videoCount,
  }
}
