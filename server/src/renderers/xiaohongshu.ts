import { getPlatformInfo } from '../../../shared/types'
import type { PlatformRender, XhsCard } from '../../../shared/types'
import type { RenderInput, RendererContext } from './types'
import {
  ARTICLE_WRAPPER_STYLE,
  buildHashtags,
  buildHtmlDocument,
  buildMeta,
  buildPlatformWarnings,
  buildStyledArticle,
  charLength,
  prepareContent,
  safeFilename,
  truncateToChars,
} from './common'

const XHS_THEME = '#ff2442'
const MAX_CONTENT_CARDS = 8
const CARD_TEXT_BUDGET = 170

const XHS_STYLES: Record<string, string> = {
  p: 'font-size:16px;line-height:1.9;color:#333;margin:0 0 16px;word-break:break-word;',
  h1: 'font-size:22px;line-height:1.45;color:#1f1f1f;font-weight:700;margin:28px 0 14px;',
  h2: 'font-size:19px;line-height:1.5;color:#1f1f1f;font-weight:700;margin:26px 0 14px;',
  h3: 'font-size:17px;line-height:1.6;color:#1f1f1f;font-weight:600;margin:22px 0 12px;',
  strong: 'font-weight:700;color:#1f1f1f;',
  a: 'color:#ff2442;text-decoration:none;',
  blockquote:
    'margin:18px 0;padding:12px 14px;background-color:#fff5f6;border-left:3px solid #ff2442;border-radius:0 6px 6px 0;color:#6b4b50;',
  'blockquote p': 'margin:0;color:inherit;font-size:inherit;line-height:inherit;',
  pre: 'margin:18px 0;padding:14px;background-color:#222;border-radius:8px;overflow-x:auto;color:#f2f2f2;font-size:13px;line-height:1.7;',
  code: 'font-family:SFMono-Regular,Consolas,Menlo,monospace;font-size:14px;background-color:#f6f6f8;color:#c7254e;padding:2px 5px;border-radius:3px;',
  'pre code': 'display:block;background:transparent;color:inherit;padding:0;font-size:13px;white-space:pre;',
  ul: 'margin:0 0 16px;padding-left:24px;',
  ol: 'margin:0 0 16px;padding-left:24px;',
  li: 'font-size:16px;line-height:1.9;color:#333;margin:5px 0;',
  img: 'display:block;max-width:100%;height:auto;border-radius:10px;margin:18px auto;',
  video: 'display:block;width:100%;border-radius:10px;margin:18px 0;background:#000;',
  table: 'width:100%;border-collapse:collapse;font-size:14px;min-width:460px;',
  th: 'border:1px solid #f0d9dd;background-color:#fff5f6;padding:9px 11px;text-align:left;',
  td: 'border:1px solid #ececec;padding:9px 11px;text-align:left;',
  hr: 'border:none;border-top:1px solid #eee;margin:24px 0;',
}

function splitLongText(value: string, budget: number): string[] {
  if (charLength(value) <= budget) return [value]
  const parts = value
    .split(/(?<=[。！？!?；;…])\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length <= 1) {
    const chunks: string[] = []
    let current = ''
    for (const char of Array.from(value)) {
      current += char
      if (charLength(current) >= budget) {
        chunks.push(current)
        current = ''
      }
    }
    if (current) chunks.push(current)
    return chunks
  }

  const chunks: string[] = []
  let current = ''
  for (const part of parts) {
    if (charLength(part) > budget) {
      if (current) chunks.push(current)
      current = ''
      chunks.push(...splitLongText(part, budget))
      continue
    }
    if (current && charLength(current) + charLength(part) > budget) {
      chunks.push(current)
      current = part
    } else {
      current += part
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export interface CardPage {
  body: string[]
  images: string[]
}

/** Paginate paragraphs into readable Xiaohongshu cards without breaking sentences. */
export function paginateForCards(
  blocks: string[],
  images: string[],
  budget = CARD_TEXT_BUDGET,
): CardPage[] {
  const pieces: string[] = []
  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue
    pieces.push(...splitLongText(trimmed, budget))
  }

  const pages: CardPage[] = []
  let current: string[] = []
  let currentLength = 0
  const flush = (): void => {
    if (current.length === 0) return
    pages.push({ body: current, images: [] })
    current = []
    currentLength = 0
  }

  for (const piece of pieces) {
    const length = charLength(piece)
    if (current.length > 0 && currentLength + length > budget) flush()
    current.push(piece)
    currentLength += length
  }
  flush()

  // Attach images after pagination so a card with no text can still exist for
  // image-heavy notes. One image per card keeps the 3:4 composition clean.
  for (let index = 0; index < images.length; index += 1) {
    if (index >= pages.length) pages.push({ body: [], images: [] })
    pages[index].images.push(images[index])
  }

  if (pages.length === 0 && images.length === 0) {
    pages.push({ body: ['这篇内容暂时没有正文，欢迎直接查看原文。'], images: [] })
  }

  return pages
}

/**
 * Render a Xiaohongshu note.
 *
 * The downloadable PNG cards are generated in the browser from these card
 * specs (`html-to-image`), so `body` is deliberately plain text. Images and
 * videos stay as absolute URLs for the preview and ZIP asset collection.
 */
export async function renderXiaohongshu(
  input: RenderInput,
  context?: RendererContext,
): Promise<PlatformRender> {
  const info = getPlatformInfo('xiaohongshu')
  const prepared = prepareContent(input, context, info)
  const title = truncateToChars(prepared.rawTitle, info.limits.titleMax ?? 20)
  const warnings = buildPlatformWarnings(prepared)

  const handle = prepared.authorName || 'MultiPush'
  const coverImage = prepared.coverImage
  const inlineImages = prepared.media.images.filter((image) => image !== coverImage)
  const includeTags = prepared.options.includeTags !== false
  const hashtags = includeTags ? buildHashtags(prepared.tags) : []
  const pages = paginateForCards(prepared.textBlocks, inlineImages)
  if (pages.length > MAX_CONTENT_CARDS) {
    warnings.push('内容较长，已生成额外卡片以保留全文和图片；发布时请按平台上限分批使用。')
  }
  const coverExtension = coverImage.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png'
  const assets =
    coverImage && !prepared.media.assets.some((asset) => asset.url === coverImage)
      ? [{ filename: `封面${coverExtension}`, url: coverImage, kind: 'image' as const }, ...prepared.media.assets]
      : prepared.media.assets

  if (!coverImage) {
    warnings.push('未检测到图片，封面卡将使用渐变背景。')
  }
  if (prepared.media.videos.length > 0) {
    warnings.push('检测到视频，建议在小红书发布视频笔记；卡片与文案仍会生成。')
  }
  if (prepared.textLength > (info.limits.bodyMax ?? 1000)) {
    warnings.push('小红书正文已截断到 1000 字以内，完整内容可在卡片中查看。')
  }

  const coverBody = [
    truncateToChars(prepared.summary || '一次创作，多平台发布', 72),
  ].filter(Boolean)
  const cards: XhsCard[] = [
    {
      id: 'cover',
      type: 'cover',
      index: 1,
      total: pages.length + 2,
      title,
      body: coverBody,
      images: coverImage ? [coverImage] : [],
      footer: `@${handle} · MultiPush`,
    },
  ]

  for (let index = 0; index < pages.length; index += 1) {
    cards.push({
      id: `content-${index + 1}`,
      type: 'content',
      index: index + 2,
      total: pages.length + 2,
      title: '',
      body: pages[index].body.length > 0 ? pages[index].body : ['图片笔记'],
      images: pages[index].images,
      footer: `@${handle} · MultiPush`,
    })
  }

  cards.push({
    id: 'end',
    type: 'end',
    index: cards.length + 1,
    total: cards.length + 1,
    title: '感谢阅读',
    body: ['如果这篇内容对你有帮助', '点赞 · 收藏 · 关注', '我们下期再见'],
    images: [],
    footer: `@${handle} · MultiPush`,
  })

  // Ensure every card carries the final total after the end card is appended.
  for (const card of cards) card.total = cards.length

  const captionBody = truncateToChars(
    prepared.plainText || prepared.summary || '（正文为空，请查看卡片内容）',
    info.limits.bodyMax ?? 1000,
  )
  const captionParts = [title, '', captionBody]
  if (hashtags.length > 0) captionParts.push('', hashtags.join(' '))
  const caption = captionParts.join('\n').trim()

  const article = buildStyledArticle(prepared.html, {
    styles: XHS_STYLES,
    wrapperStyle: `${ARTICLE_WRAPPER_STYLE}max-width:540px;margin:0 auto;`,
    tableWrapStyle: 'width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:18px 0;',
  })

  const htmlDocument = buildHtmlDocument({
    title,
    html: article.html,
    themeColor: XHS_THEME,
    authorName: prepared.authorName || undefined,
    maxWidth: 540,
  })

  const noteJson = JSON.stringify(
    {
      platform: 'xiaohongshu',
      title,
      text: caption,
      tags: includeTags ? prepared.tags : [],
      hashtags,
      images: prepared.media.images,
      videos: prepared.media.videos,
      cards,
      meta: buildMeta(prepared),
      generatedAt: prepared.generatedAt,
    },
    null,
    2,
  )

  const safeTitle = safeFilename(title)
  const downloads: PlatformRender['downloads'] = [
    {
      filename: `${safeTitle}-小红书文案.txt`,
      mimeType: 'text/plain;charset=utf-8',
      kind: 'text',
      content: caption,
    },
    {
      filename: `${safeTitle}-小红书笔记.json`,
      mimeType: 'application/json;charset=utf-8',
      kind: 'json',
      content: noteJson,
    },
    {
      filename: `${safeTitle}-小红书图文.html`,
      mimeType: 'text/html;charset=utf-8',
      kind: 'html',
      content: htmlDocument,
    },
  ]

  return {
    platform: 'xiaohongshu',
    title,
    html: article.html,
    markdown: null,
    text: caption,
    previewMode: prepared.media.videos.length > 0 ? 'video' : 'cards',
    themeColor: XHS_THEME,
    meta: { ...buildMeta(prepared), tags: includeTags ? prepared.tags : [] },
    cards,
    assets,
    videos: prepared.media.videos,
    warnings: Array.from(new Set(warnings)),
    downloads,
    generatedAt: prepared.generatedAt,
  }
}
