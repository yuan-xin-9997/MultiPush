import sanitizeHtml from 'sanitize-html'
import * as cheerio from 'cheerio'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type {
  ContentDetail,
  PlatformInfo,
  PlatformRenderMeta,
  RenderedAsset,
  RenderOptions,
} from '../../../shared/types'
import type { RenderInput, RendererContext } from './types'

export const DEFAULT_TITLE = '无标题文档'

/**
 * The iframe preview only receives HTML, no external stylesheet. Every article
 * fragment therefore carries its typography inline. Keep the font stack free of
 * double quotes so it is safe inside a double-quoted style attribute.
 */
export const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"

export const ARTICLE_WRAPPER_STYLE = `font-family:${FONT_STACK};font-size:16px;line-height:1.8;color:#333;word-break:break-word;`

export const EMPTY_ARTICLE_HTML =
  '<p style="margin:0;padding:20px 0;text-align:center;color:#9ca3af;font-size:15px;">暂无正文内容</p>'

export interface HeadingInfo {
  level: number
  text: string
  id: string
}

export interface MediaInfo {
  /** Unique image URLs in document order. */
  images: string[]
  /** Unique video URLs in document order. */
  videos: string[]
  /** Unique assets (images + videos) in document order. */
  assets: RenderedAsset[]
  /** Number of unique images hosted outside the configured base URL. */
  externalImageCount: number
}

export interface PreparedContent {
  rawTitle: string
  baseUrl: string
  authorName: string
  generatedAt: string
  /** Sanitized, URL-normalized HTML fragment without platform-specific styles. */
  html: string
  textBlocks: string[]
  plainText: string
  textLength: number
  wordCount: number
  summary: string
  tags: string[]
  headings: HeadingInfo[]
  media: MediaInfo
  /** Best cover image: explicit cover first, then the first inline image. */
  coverImage: string
  /** Content-level warnings shared by all platforms. */
  warnings: string[]
  options: RenderOptions
  platformName: string
  titleLimit?: number
  bodyMax?: number
  imageMax?: number
}

/* -------------------------------------------------------------------------- */
/* Text helpers                                                               */
/* -------------------------------------------------------------------------- */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function charLength(value: string): number {
  return Array.from(value).length
}

export function truncateToChars(value: string, maxLength: number, ellipsis = '…'): string {
  const chars = Array.from(value)
  if (chars.length <= maxLength) return value
  if (maxLength <= 0) return ''
  if (maxLength === 1) return ellipsis.slice(0, 1)
  return `${chars.slice(0, maxLength - 1).join('')}${ellipsis}`
}

export function normalizeTitle(raw: string | null | undefined, fallback = DEFAULT_TITLE): string {
  const text = typeof raw === 'string' ? raw : ''
  const cleaned = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

export function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeInlineText(value: string): string {
  return normalizeText(value).replace(/\s+/g, ' ').trim()
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = raw
      .replace(/^#+/, '')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!tag) continue
    const value = truncateToChars(tag, 24)
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= 10) break
  }
  return result
}

/** Chinese characters count as one word, runs of Latin/digits count as one word. */
export function countWords(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const latin = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0
  return cjk + latin
}

/** Replace characters that are illegal in Windows/POSIX file names. */
export function safeFilename(input: string, maxLength = 80): string {
  let name = (input || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s]+$/g, '')
    .trim()
  if (!name) name = '未命名'
  const chars = Array.from(name)
  if (chars.length > maxLength) {
    name = chars
      .slice(0, maxLength)
      .join('')
      .replace(/[.\s]+$/g, '')
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`
  return name || '未命名'
}

/* -------------------------------------------------------------------------- */
/* URL helpers                                                                */
/* -------------------------------------------------------------------------- */

export function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('//')) return `http:${trimmed}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

export function resolveUrl(raw: string | null | undefined, baseUrl: string): string {
  let value = (raw ?? '').trim()
  if (!value) return ''
  value = value.replace(/[\u0000-\u001f\u007f]/g, '')
  if (!value) return ''
  if (value.startsWith('#')) return value
  if (/^data:/i.test(value)) return value
  if (/^blob:/i.test(value)) return value
  if (value.startsWith('//')) {
    const protocol = /^https:/i.test(baseUrl) ? 'https:' : 'http:'
    return `${protocol}${value}`
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (!baseUrl) return value
  try {
    return new URL(value, `${baseUrl.replace(/\/+$/, '')}/`).href
  } catch {
    return value
  }
}

/** Resolve media while refusing script-like schemes (notably poster URLs). */
export function resolveMediaUrl(raw: string | null | undefined, baseUrl: string): string {
  const resolved = resolveUrl(raw, baseUrl)
  if (!resolved) return ''
  if (/^data:/i.test(resolved)) return resolved
  if (/^https?:\/\//i.test(resolved)) return resolved
  // No base URL was configured; keep a relative media URL rather than dropping it.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(resolved)) return resolved
  return ''
}

export function isExternalMediaUrl(url: string, baseUrl: string): boolean {
  if (!url || /^data:/i.test(url)) return false
  if (/^blob:/i.test(url)) return true
  if (!baseUrl) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const base = new URL(baseUrl)
    return parsed.origin !== base.origin
  } catch {
    return true
  }
}

function mimeExtension(mimeType: string, kind: 'image' | 'video'): string {
  const mime = mimeType.toLowerCase()
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg'
  if (mime.includes('png')) return '.png'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('gif')) return '.gif'
  if (mime.includes('svg')) return '.svg'
  if (mime.includes('mp4')) return '.mp4'
  if (mime.includes('webm')) return '.webm'
  if (mime.includes('quicktime')) return '.mov'
  if (mime.includes('matroska')) return '.mkv'
  return kind === 'image' ? '.png' : '.mp4'
}

function uniqueAssetFilename(url: string, kind: 'image' | 'video', index: number, used: Set<string>): string {
  let name = ''
  if (/^data:/i.test(url)) {
    const mime = /^data:([^;,]+)/i.exec(url)?.[1] ?? ''
    name = `${kind}-${index}${mimeExtension(mime, kind)}`
  } else {
    try {
      const parsed = new URL(url, 'http://placeholder.invalid/')
      const basename = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
      name = basename || `${kind}-${index}`
    } catch {
      name = `${kind}-${index}`
    }
  }

  name = safeFilename(name, 80)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  let candidate = name
  let counter = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem}-${counter}${extension}`
    counter += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

/* -------------------------------------------------------------------------- */
/* Sanitizer                                                                  */
/* -------------------------------------------------------------------------- */

const COLOR_VALUE = [
  /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i,
  /^[a-z]{1,24}$/i,
]

const SAFE_STYLES = {
  color: COLOR_VALUE,
  'background-color': COLOR_VALUE,
  'text-align': [/^(?:left|right|center|justify)$/i],
  'font-weight': [/^(?:normal|bold|[1-9]00)$/i],
  'font-style': [/^(?:normal|italic|oblique)$/i],
  'text-decoration': [/^(?:none|underline|line-through|underline line-through)$/i],
  'font-size': [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/i],
}

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a',
    'article',
    'aside',
    'b',
    'blockquote',
    'br',
    'caption',
    'code',
    'dd',
    'del',
    'details',
    'div',
    'dl',
    'dt',
    'em',
    'figcaption',
    'figure',
    'footer',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hr',
    'i',
    'img',
    'li',
    'main',
    'mark',
    'ol',
    'p',
    'pre',
    's',
    'section',
    'source',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
    'video',
  ],
  allowedAttributes: {
    '*': ['style', 'data-mp-task', 'data-mp-task-item', 'data-mp-task-checked'],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    video: ['src', 'poster', 'controls', 'width', 'height'],
    source: ['src', 'type'],
    ol: ['start'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data'],
  allowedSchemesByTag: {
    a: ['http', 'https', 'mailto', 'tel'],
    img: ['http', 'https', 'data'],
    video: ['http', 'https'],
    source: ['http', 'https'],
  },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'poster'],
  allowProtocolRelative: true,
  allowedStyles: {
    '*': SAFE_STYLES,
  },
  allowedClasses: {},
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template'],
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => {
      const next = { ...attribs }
      if (next.target === '_blank') next.rel = 'noopener noreferrer'
      return { tagName, attribs: next }
    },
    video: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, controls: 'controls' },
    }),
  },
}

function preprocessTaskLists($: CheerioAPI): void {
  $('ul[data-type="taskList"], ol[data-type="taskList"], ul.contains-task-list, ol.contains-task-list').each(
    (_, element) => {
      $(element).attr('data-mp-task', '1').removeAttr('data-type').removeClass('contains-task-list')
    },
  )

  $('li[data-type="taskItem"], li.task-list-item').each((_, element) => {
    const $item = $(element)
    if ($item.attr('data-mp-task-item') === '1') return
    const checked =
      $item.attr('data-checked') === 'true' ||
      $item.find('input[type="checkbox"]').first().is('[checked]') ||
      $item.hasClass('task-list-item-checked')

    $item.find('input[type="checkbox"]').remove()
    $item.find('label').each((__, label) => {
      const $label = $(label)
      if (!$label.text().trim() && $label.find('img, video').length === 0) $label.remove()
    })

    const flag = checked ? '☑ ' : '☐ '
    const $target = $item.children('p, div').first()
    if ($target.length) $target.prepend(flag)
    else $item.prepend(flag)

    $item
      .attr('data-mp-task-item', '1')
      .attr('data-mp-task-checked', checked ? 'true' : 'false')
      .removeAttr('data-type')
      .removeClass('task-list-item')
      .removeClass('task-list-item-checked')

    const $parent = $item.parent()
    if ($parent.is('ul, ol')) {
      $parent.attr('data-mp-task', '1').removeAttr('data-type').removeClass('contains-task-list')
    }
  })
}

/* -------------------------------------------------------------------------- */
/* HTML normalization                                                         */
/* -------------------------------------------------------------------------- */

const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'pre', 'figcaption'])

function elementTagName(element: AnyNode): string {
  return ((element as unknown as { name?: string }).name ?? '').toLowerCase()
}

function tableBlocks($: CheerioAPI, element: AnyNode): string[] {
  const rows: string[] = []
  $(element)
    .find('tr')
    .each((_, row) => {
      const cells: string[] = []
      $(row)
        .children('th, td')
        .each((__, cell) => {
          const text = normalizeInlineText($(cell).text())
          if (text) cells.push(text)
        })
      if (cells.length) rows.push(cells.join(' | '))
    })
  return rows
}

function extractTextBlocks($: CheerioAPI, $root: Cheerio<AnyNode>): string[] {
  const blocks: string[] = []
  const push = (value: string): void => {
    const text = normalizeInlineText(value)
    if (!text) return
    if (blocks[blocks.length - 1] === text) return
    blocks.push(text)
  }

  const walk = (node: AnyNode): void => {
    const type = (node as unknown as { type?: string }).type
    if (type === 'text') {
      push((node as unknown as { data?: string }).data ?? '')
      return
    }
    if (type !== 'tag') {
      for (const child of ((node as unknown as { children?: AnyNode[] }).children ?? [])) walk(child)
      return
    }

    const tag = elementTagName(node)
    if (tag === 'table') {
      for (const row of tableBlocks($, node)) push(row)
      return
    }

    if (tag === 'li') {
      const $item = $(node)
      const $clone = $item.clone()
      $clone.find('ul, ol, table, video, img, source').remove()
      push($clone.text())
      $item.children('ul, ol').each((_, list) => walk(list))
      return
    }

    if (BLOCK_TAGS.has(tag)) {
      push($(node).text())
      return
    }

    for (const child of ((node as unknown as { children?: AnyNode[] }).children ?? [])) walk(child)
  }

  const root = $root.get(0)
  if (!root) return []
  for (const child of ((root as unknown as { children?: AnyNode[] }).children ?? [])) walk(child)
  return blocks
}

function collectHeadings($: CheerioAPI, $root: Cheerio<AnyNode>): HeadingInfo[] {
  const headings: HeadingInfo[] = []
  $root.find('h1, h2, h3').each((_, element) => {
    const text = normalizeInlineText($(element).text())
    if (!text) return
    const tag = elementTagName(element)
    const level = Number(tag.replace(/[^1-6]/g, '')) || 1
    headings.push({ level, text, id: '' })
  })
  return headings
}

function collectMedia($: CheerioAPI, $root: Cheerio<AnyNode>, baseUrl: string): MediaInfo {
  const images: string[] = []
  const videos: string[] = []
  const assets: RenderedAsset[] = []
  const seenImages = new Set<string>()
  const seenVideos = new Set<string>()
  const seenAssets = new Set<string>()
  const usedNames = new Set<string>()
  let externalImageCount = 0

  $root.find('img, video, source').each((_, element) => {
    const $element = $(element)
    const src = $element.attr('src')
    if (!src) return
    const tag = elementTagName(element)
    const kind: 'image' | 'video' = tag === 'img' ? 'image' : 'video'

    if (kind === 'image') {
      if (!seenImages.has(src)) {
        seenImages.add(src)
        images.push(src)
        if (isExternalMediaUrl(src, baseUrl)) externalImageCount += 1
      }
    } else if (!seenVideos.has(src)) {
      seenVideos.add(src)
      videos.push(src)
    }

    if (seenAssets.has(src)) return
    seenAssets.add(src)
    assets.push({
      filename: uniqueAssetFilename(src, kind, assets.length + 1, usedNames),
      url: src,
      kind,
    })
  })

  return { images, videos, assets, externalImageCount }
}

interface NormalizedContent {
  html: string
  textBlocks: string[]
  headings: HeadingInfo[]
  media: MediaInfo
}

function normalizeContentHtml(rawHtml: string, baseUrl: string): NormalizedContent {
  const empty: NormalizedContent = {
    html: '',
    textBlocks: [],
    headings: [],
    media: { images: [], videos: [], assets: [], externalImageCount: 0 },
  }
  if (!rawHtml || !rawHtml.trim()) return empty

  let inputHtml = rawHtml
  if (!/<[a-z!/][^>]*>/i.test(inputHtml)) {
    inputHtml = inputHtml
      .split(/\r?\n\s*\r?\n/)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\r?\n/g, '<br>')}</p>`)
      .join('')
  }

  const $pre = cheerio.load(`<div data-mp-pre-root="1">${inputHtml}</div>`, null, false)
  preprocessTaskLists($pre)
  const preparedRaw = $pre('[data-mp-pre-root="1"]').first().html() ?? ''
  const sanitized = sanitizeHtml(preparedRaw, SANITIZE_OPTIONS)
  if (!sanitized.trim()) return empty

  const $ = cheerio.load(`<div data-mp-clean-root="1">${sanitized}</div>`, null, false)
  const $root = $('[data-mp-clean-root="1"]').first()

  $root.find('img').each((_, element) => {
    const $element = $(element)
    const src = resolveMediaUrl($element.attr('src'), baseUrl)
    if (!src) $element.remove()
    else $element.attr('src', src)
  })

  $root.find('video').each((_, element) => {
    const $element = $(element)
    const src = resolveMediaUrl($element.attr('src'), baseUrl)
    if (src) $element.attr('src', src)
    else $element.removeAttr('src')
    const poster = resolveMediaUrl($element.attr('poster'), baseUrl)
    if (poster) $element.attr('poster', poster)
    else $element.removeAttr('poster')
    $element.attr('controls', 'controls')
  })

  $root.find('source').each((_, element) => {
    const $element = $(element)
    const src = resolveMediaUrl($element.attr('src'), baseUrl)
    if (src) $element.attr('src', src)
    else $element.remove()
  })

  $root.find('video').each((_, element) => {
    const $element = $(element)
    if (!$element.attr('src') && $element.find('source[src]').length === 0) $element.remove()
  })

  $root.find('a').each((_, element) => {
    const $element = $(element)
    const href = $element.attr('href')
    if (!href) return
    const resolved = resolveUrl(href, baseUrl)
    if (/^javascript:/i.test(resolved)) {
      $element.removeAttr('href')
      return
    }
    $element.attr('href', resolved)
    if ($element.attr('target') === '_blank') $element.attr('rel', 'noopener noreferrer')
  })

  $root.find('[class]').removeAttr('class')

  // Tiptap leaves many `<p><br></p>` shells behind; they add blank gaps.
  $root.find('p').each((_, element) => {
    const $element = $(element)
    if (!$element.text().trim() && $element.find('img, video, source, table').length === 0) $element.remove()
  })

  const html = ($root.html() ?? '').trim()
  if (!html) return empty

  return {
    html,
    textBlocks: extractTextBlocks($, $root),
    headings: collectHeadings($, $root),
    media: collectMedia($, $root, baseUrl),
  }
}

/* -------------------------------------------------------------------------- */
/* Inline styling                                                             */
/* -------------------------------------------------------------------------- */

type StyleMap = Record<string, string>

const PRESERVED_TEXT_PROPERTIES = ['color', 'background-color', 'text-align']

function parseStyle(style: string | undefined): StyleMap {
  const result: StyleMap = {}
  if (!style) return result
  for (const part of style.split(';')) {
    const separator = part.indexOf(':')
    if (separator <= 0) continue
    const property = part.slice(0, separator).trim().toLowerCase()
    const value = part.slice(separator + 1).trim()
    if (!property || !value) continue
    if (!/^[a-z-]+$/.test(property)) continue
    if (/url\s*\(|expression\s*\(|@import|javascript\s*:/i.test(value)) continue
    result[property] = value
  }
  return result
}

function serializeStyle(style: StyleMap): string {
  const entries = Object.entries(style)
  if (entries.length === 0) return ''
  return `${entries.map(([property, value]) => `${property}:${value}`).join(';')};`
}

function preservedStyle(tag: string, original: StyleMap): StyleMap {
  const result: StyleMap = {}
  // Keep alignment a user explicitly chose on paragraphs/headings.
  if (original['text-align']) result['text-align'] = original['text-align']
  // Code blocks intentionally get platform colors; a user color would be unreadable.
  if (tag !== 'pre' && tag !== 'code') {
    for (const property of PRESERVED_TEXT_PROPERTIES) {
      if (property === 'text-align') continue
      if (original[property]) result[property] = original[property]
    }
  }
  return result
}

function applyStyles($: CheerioAPI, $root: Cheerio<AnyNode>, styles: Record<string, string>): void {
  const originals = new WeakMap<object, StyleMap>()
  $root.find('*').each((_, element) => {
    originals.set(element as object, parseStyle($(element).attr('style')))
  })

  for (const [selector, style] of Object.entries(styles)) {
    const declarations = parseStyle(style)
    if (Object.keys(declarations).length === 0) continue
    $root.find(selector).each((_, element) => {
      const $element = $(element)
      const tag = elementTagName(element)
      const original = originals.get(element as object) ?? {}
      const merged: StyleMap = { ...declarations, ...preservedStyle(tag, original) }
      $element.attr('style', serializeStyle(merged))
    })
  }
}

export interface TocStyleOptions {
  containerStyle: string
  titleStyle: string
  linkStyle: string
  levelStyles?: Partial<Record<number, string>>
}

export interface StyledArticleOptions {
  styles: Record<string, string>
  wrapperStyle?: string
  tableWrapStyle: string
  includeToc?: boolean
  toc?: TocStyleOptions
  emptyHtml?: string
}

/**
 * Apply platform styles to a clean content fragment, wrap tables for horizontal
 * scrolling, optionally prepend a TOC, and return a self-contained HTML snippet.
 */
export function buildStyledArticle(
  cleanHtml: string,
  options: StyledArticleOptions,
): { html: string; headings: HeadingInfo[] } {
  const $ = cheerio.load(`<div data-mp-article-root="1">${cleanHtml}</div>`, null, false)
  const $root = $('[data-mp-article-root="1"]').first()

  $root.find('table').each((_, element) => {
    const $table = $(element)
    if ($table.parent().is('[data-mp-table-wrap="1"]')) return
    $table.wrap(`<div data-mp-table-wrap="1" style="${escapeHtml(options.tableWrapStyle)}"></div>`)
  })

  const headings: HeadingInfo[] = []
  $root.find('h1, h2, h3').each((_, element) => {
    const $element = $(element)
    const text = normalizeInlineText($element.text())
    if (!text) return
    const id = `mp-heading-${headings.length + 1}`
    $element.attr('id', id)
    const tag = elementTagName(element)
    headings.push({ level: Number(tag.replace(/[^1-6]/g, '')) || 1, text, id })
  })

  applyStyles($, $root, options.styles)

  if (options.includeToc && headings.length > 0 && options.toc) {
    const toc = options.toc
    const links = headings
      .map((heading) => {
        const style = toc.levelStyles?.[heading.level] ?? toc.linkStyle
        return `<a href="#${heading.id}" style="${escapeHtml(style)}">${escapeHtml(heading.text)}</a>`
      })
      .join('')
    $root.prepend(
      `<nav data-mp-toc="1" style="${escapeHtml(toc.containerStyle)}"><div style="${escapeHtml(
        toc.titleStyle,
      )}">目录</div>${links}</nav>`,
    )
  }

  $root.find('[class]').removeAttr('class')
  $root.find('*').each((_, element) => {
    const attribs = (element as unknown as { attribs?: Record<string, string> }).attribs
    if (!attribs) return
    for (const name of Object.keys(attribs)) {
      if (name.startsWith('data-')) delete attribs[name]
    }
  })

  const inner = ($root.html() ?? '').trim()
  const wrapperStyle = options.wrapperStyle ?? ARTICLE_WRAPPER_STYLE
  const content = inner || options.emptyHtml || EMPTY_ARTICLE_HTML
  return {
    html: `<section style="${escapeHtml(wrapperStyle)}">${content}</section>`,
    headings,
  }
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* -------------------------------------------------------------------------- */

export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return ''

  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  })
  service.use(gfm)
  service.remove(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'nav'])

  service.addRule('multiPushFigcaption', {
    filter: 'figcaption',
    replacement(content) {
      const text = content.trim()
      return text ? `\n\n_${text}_\n\n` : ''
    },
  })

  service.addRule('multiPushVideo', {
    filter: 'video',
    replacement(_content, node) {
      const element = node as unknown as {
        getAttribute(name: string): string | null
        querySelector(selector: string): { getAttribute(name: string): string | null } | null
      }
      const source = element.getAttribute('src') || element.querySelector('source')?.getAttribute('src')
      if (!source) return ''
      const poster = element.getAttribute('poster')
      const cover = poster ? `\n\n[视频封面](${poster})` : ''
      return `\n\n[视频](${source})${cover}\n\n`
    },
  })

  service.addRule('multiPushSource', {
    filter: 'source',
    replacement() {
      return ''
    },
  })

  const markdown = service.turndown(html)
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* -------------------------------------------------------------------------- */
/* Document and metadata helpers                                              */
/* -------------------------------------------------------------------------- */

export interface HtmlDocumentOptions {
  title: string
  html: string
  themeColor: string
  authorName?: string
  maxWidth?: number
}

/** Build a standalone, script-free HTML document with inline base styles. */
export function buildHtmlDocument(options: HtmlDocumentOptions): string {
  const maxWidth = options.maxWidth ?? 677
  const bodyStyle = `margin:0;padding:24px 16px;background-color:#f5f6f7;font-family:${FONT_STACK};font-size:16px;line-height:1.8;color:#333;word-break:break-word;`
  const mainStyle = `box-sizing:border-box;max-width:${maxWidth}px;margin:0 auto;padding:28px 22px;background-color:#fff;border-radius:14px;border-top:4px solid ${options.themeColor};box-shadow:0 1px 3px rgba(0,0,0,0.06);`
  const author = options.authorName
    ? `\n<meta name="author" content="${escapeHtml(options.authorName)}">`
    : ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(options.title)}</title>${author}
</head>
<body style="${escapeHtml(bodyStyle)}">
<main style="${escapeHtml(mainStyle)}">${options.html}</main>
</body>
</html>`
}

export function readMinutes(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / 350))
}

export function buildMeta(prepared: PreparedContent): PlatformRenderMeta {
  return {
    wordCount: prepared.wordCount,
    imageCount: prepared.media.images.length,
    videoCount: prepared.media.videos.length,
    readMinutes: readMinutes(prepared.wordCount),
    tags: prepared.tags,
    titleLength: charLength(prepared.rawTitle),
    titleLimit: prepared.titleLimit,
    summary: prepared.summary,
  }
}

export function buildPlatformWarnings(prepared: PreparedContent, extraWarnings: string[] = []): string[] {
  const warnings = [...prepared.warnings]
  const titleLimit = prepared.titleLimit
  const titleLength = charLength(prepared.rawTitle)
  if (titleLimit && titleLength > titleLimit) {
    warnings.push(`标题 ${titleLength} 字，超过${prepared.platformName}建议的 ${titleLimit} 字，已自动截断。`)
  }

  const bodyMax = prepared.bodyMax
  if (bodyMax && prepared.textLength > bodyMax) {
    warnings.push(`正文约 ${prepared.textLength} 字，超过${prepared.platformName}建议的 ${bodyMax} 字，建议精简。`)
  }

  const imageMax = prepared.imageMax
  const imageCount = prepared.media.images.length
  if (imageMax && imageCount > imageMax) {
    warnings.push(`图片 ${imageCount} 张，超过${prepared.platformName}建议的 ${imageMax} 张，建议精简。`)
  }

  warnings.push(...extraWarnings)
  return Array.from(new Set(warnings))
}

/* -------------------------------------------------------------------------- */
/* Content preparation                                                        */
/* -------------------------------------------------------------------------- */

export interface PreparedContentOptions extends RenderOptions {
  platformName?: string
  titleLimit?: number
  bodyMax?: number
  imageMax?: number
}

/**
 * Sanitize once and share the result across platform renderers.
 *
 * `PlatformInfo` values are small enough to keep in the prepared object, which
 * keeps `buildMeta` / `buildPlatformWarnings` free of platform-specific imports.
 */
export function prepareContent(
  input: RenderInput,
  context: RendererContext | undefined,
  platform: PlatformInfo,
): PreparedContent {
  const content = input.content as ContentDetail | undefined
  const options = input.options ?? {}
  const rawTitle = normalizeTitle(content?.title)
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const authorName = (input.authorName || options.authorName || options.accountName || '').trim()
  const generatedAt = context?.generatedAt || new Date().toISOString()
  const normalized = normalizeContentHtml(content?.contentHtml ?? '', baseUrl)
  const tags = normalizeTags(content?.tags)
  const plainText = normalized.textBlocks.join('\n\n')
  const wordCount = countWords(plainText)
  const summary = truncateToChars(normalized.textBlocks.join(' ').replace(/\s+/g, ' ').trim(), 120)
  const coverImage =
    resolveMediaUrl(content?.coverImage ?? '', baseUrl) || normalized.media.images[0] || ''

  const warnings: string[] = []
  if (!plainText && normalized.media.images.length === 0 && normalized.media.videos.length === 0) {
    warnings.push('正文为空，请补充内容后再发布。')
  } else if (!plainText) {
    warnings.push('正文为空，仅包含图片或视频内容。')
  }
  if (normalized.media.externalImageCount > 0) {
    warnings.push(
      `包含 ${normalized.media.externalImageCount} 张外部图片（非本站上传），下载或发布时可能无法正常显示。`,
    )
  }

  return {
    rawTitle,
    baseUrl,
    authorName,
    generatedAt,
    html: normalized.html,
    textBlocks: normalized.textBlocks,
    plainText,
    textLength: charLength(plainText),
    wordCount,
    summary,
    tags,
    headings: normalized.headings,
    media: normalized.media,
    coverImage,
    warnings,
    options,
    platformName: platform.name,
    titleLimit: platform.limits.titleMax,
    bodyMax: platform.limits.bodyMax,
    imageMax: platform.limits.imageMax,
  }
}

/** Comma-free, unique hashtags used by the Xiaohongshu copy. */
export function buildHashtags(tags: string[], limit = 6): string[] {
  const normalized = normalizeTags(tags).map((tag) => tag.replace(/\s+/g, '').replace(/#/g, ''))
  const unique = Array.from(new Set(normalized.filter(Boolean))).slice(0, limit)
  if (unique.length === 0) return ['#多平台发布', '#内容创作']
  const fallback = ['多平台发布', '内容创作']
  for (const tag of fallback) {
    if (unique.length >= 3) break
    if (!unique.includes(tag)) unique.push(tag)
  }
  return unique.slice(0, limit).map((tag) => `#${tag}`)
}
