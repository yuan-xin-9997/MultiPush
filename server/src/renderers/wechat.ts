import { load, type CheerioAPI } from 'cheerio'
import { getPlatformInfo } from '../../../shared/types'
import type { PlatformRender } from '../../../shared/types'
import type { RenderInput, RendererContext } from './types'
import {
  ARTICLE_WRAPPER_STYLE,
  buildHtmlDocument,
  buildMeta,
  buildPlatformWarnings,
  buildStyledArticle,
  prepareContent,
  safeFilename,
  truncateToChars,
} from './common'

const WECHAT_THEME = '#07c160'

export function normalizeWechatLists($: CheerioAPI): void {
  for (const node of $('ul,ol').toArray().reverse()) {
    const list = $(node)
    // WeChat turns whitespace text between list items into empty bullet items.
    list.contents().filter((_, child) => child.type === 'comment' || child.type === 'text' && !$(child).text().trim()).remove()
    list.children('li').each((_, child) => {
      const item = $(child)
      if (!item.text().replace(/\u200b/g, '').trim() && !item.find('img,video,audio,iframe,svg,table,hr').length) item.remove()
    })
  }
}

function setWechatMargins(element: ReturnType<CheerioAPI>, overrides: { top?: string; bottom?: string }): void {
  const [top = '0', right = top, bottom = top, left = right] = (element.css('margin') || '0').trim().split(/\s+/)
  const sides = [top, right, bottom, left].map((value, index) => element.css(`margin-${['top', 'right', 'bottom', 'left'][index]}`) || value)
  sides[0] = overrides.top ?? sides[0]
  sides[2] = overrides.bottom ?? sides[2]
  // Native editors need one margin declaration rather than shorthand/longhand overrides.
  const style = (element.attr('style') || '').split(';').filter(part => !/^\s*margin(?:-(?:top|right|bottom|left))?\s*:/i.test(part)).join(';')
  element.attr('style', style).css('margin', sides.join(' '))
}

export function normalizeWechatCaptions($: CheerioAPI): void {
  $('img').each((_, node) => {
    const image = $(node)
    const parent = image.closest('p,section')
    const block = parent.length && parent.find('img').length === 1 && !parent.text().trim()
      && !parent.find('video,audio,iframe,table,hr').length ? parent : image
    let caption = block.next()
    const spacers = []
    while (caption.is('p,section,br') && !caption.text().replace(/\u200b/g, '').trim() && !caption.find('img,video,audio,iframe,svg,table,hr').length) {
      spacers.push(caption)
      caption = caption.next()
    }
    if (!caption.is('figcaption') && !(caption.is('p,section') && /^(?:图\s*[0-9一二三四五六七八九十百]+|fig(?:ure)?\.?\s*\d+)(?:\s|[:：.．、-]|$)/i.test(caption.text().trim()))) return
    // Image and paragraph margins must not add up to a blank line before a caption.
    for (const spacer of spacers) spacer.remove()
    setWechatMargins(image, { bottom: '0' })
    if (block[0] !== node) setWechatMargins(block, { bottom: '0' })
    setWechatMargins(caption, { top: '8px' })
  })
}

const WECHAT_STYLES: Record<string, string> = {
  p: 'font-size:16px;line-height:1.8;color:#333;margin:0 0 16px;letter-spacing:0.5px;word-break:break-word;',
  h1: 'font-size:22px;line-height:1.5;color:#1a1a1a;font-weight:700;margin:30px 0 16px;letter-spacing:0.5px;',
  h2: 'font-size:19px;line-height:1.5;color:#1a1a1a;font-weight:700;margin:30px 0 16px;padding-left:10px;border-left:4px solid #07c160;letter-spacing:0.5px;',
  h3: 'font-size:17px;line-height:1.6;color:#202020;font-weight:600;margin:24px 0 12px;',
  h4: 'font-size:16px;line-height:1.7;color:#202020;font-weight:600;margin:20px 0 10px;',
  h5: 'font-size:15px;line-height:1.7;color:#202020;font-weight:600;margin:18px 0 8px;',
  h6: 'font-size:14px;line-height:1.7;color:#5b6470;font-weight:600;margin:16px 0 8px;',
  'strong, b': 'font-weight:700;color:#1a1a1a;',
  'em, i': 'font-style:italic;',
  u: 'text-decoration:underline;text-underline-offset:2px;',
  's, del, strike': 'text-decoration:line-through;color:#8a8f99;',
  mark: 'background-color:#fff3cd;color:#7a4b00;padding:0 2px;',
  a: 'color:#07c160;text-decoration:none;border-bottom:1px solid rgba(7,193,96,0.35);word-break:break-all;',
  blockquote:
    'margin:20px 0;padding:14px 16px;background-color:#f0faf4;border-left:3px solid #07c160;border-radius:0 6px 6px 0;color:#405046;font-size:15px;line-height:1.8;',
  'blockquote p': 'margin:0;color:inherit;font-size:inherit;line-height:inherit;',
  pre: 'margin:20px 0;padding:16px;background-color:#1e1e1e;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.7;color:#e6e6e6;',
  code: 'font-family:SFMono-Regular,Consolas,Menlo,Monaco,monospace;font-size:14px;background-color:#f2f3f5;color:#c7254e;padding:2px 5px;border-radius:3px;',
  'pre code':
    'display:block;background-color:transparent;color:inherit;padding:0;font-size:13px;line-height:1.7;white-space:pre;',
  ul: 'margin:0 0 16px;padding-left:24px;',
  ol: 'margin:0 0 16px;padding-left:24px;',
  'ul[data-mp-task]': 'list-style:none;padding-left:0;',
  'ul[data-mp-task] li': 'list-style:none;',
  li: 'font-size:16px;line-height:1.8;color:#333;margin:6px 0;',
  'li p': 'margin:0;font-size:inherit;line-height:inherit;',
  table:
    'width:100%;border-collapse:collapse;font-size:14px;line-height:1.6;color:#333;min-width:480px;border-spacing:0;',
  th: 'border:1px solid #d9e7de;background-color:#f0faf4;padding:10px 12px;text-align:left;font-weight:600;vertical-align:top;',
  td: 'border:1px solid #e5e7eb;padding:10px 12px;text-align:left;vertical-align:top;',
  img: 'display:block;max-width:100%;height:auto;border-radius:8px;margin:20px auto;',
  video:
    'display:block;width:100%;max-width:100%;height:auto;border-radius:8px;margin:20px 0;background-color:#000;',
  figure: 'margin:20px 0;',
  figcaption: 'margin-top:8px;text-align:center;color:#8a8f99;font-size:13px;line-height:1.6;',
  hr: 'border:none;border-top:1px solid #e5e7eb;margin:28px 0;',
}

const WECHAT_TOC = {
  containerStyle:
    'margin:0 0 24px;padding:14px 16px;background-color:#f7faf8;border:1px solid #dfeee5;border-radius:8px;',
  titleStyle: 'margin:0 0 8px;font-size:14px;font-weight:700;color:#07c160;line-height:1.6;letter-spacing:0.5px;',
  linkStyle: 'display:block;padding:3px 0;color:#3f4a44;font-size:14px;line-height:1.7;text-decoration:none;',
  levelStyles: {
    1: 'display:block;padding:3px 0;color:#1f2933;font-size:14px;font-weight:600;line-height:1.7;text-decoration:none;',
    2: 'display:block;padding:3px 0 3px 12px;color:#3f4a44;font-size:14px;line-height:1.7;text-decoration:none;',
    3: 'display:block;padding:3px 0 3px 24px;color:#6b7280;font-size:13px;line-height:1.7;text-decoration:none;',
  },
}

/**
 * Render a WeChat Official Account article.
 *
 * `html` is a body fragment (inline styles only, suitable for iframe srcDoc and
 * rich-text copy). The downloadable document wraps the same fragment with
 * charset/title/base body styles.
 */
export async function renderWechat(input: RenderInput, context?: RendererContext): Promise<PlatformRender> {
  const info = getPlatformInfo('wechat')
  const prepared = prepareContent(input, context, info)
  const limit = info.limits.titleMax ?? 64
  const title = truncateToChars(prepared.rawTitle, limit)
  const warnings = buildPlatformWarnings(prepared)

  const article = buildStyledArticle(prepared.html, {
    styles: WECHAT_STYLES,
    wrapperStyle: `${ARTICLE_WRAPPER_STYLE}letter-spacing:0.3px;`,
    tableWrapStyle:
      'width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:20px 0;border-radius:8px;',
    includeToc: prepared.options.includeToc === true,
    toc: WECHAT_TOC,
  })
  const $ = load(article.html, null, false)
  normalizeWechatLists($)
  normalizeWechatCaptions($)
  article.html = $.html()

  const document = buildHtmlDocument({
    title,
    html: article.html,
    themeColor: WECHAT_THEME,
    authorName: prepared.authorName || undefined,
    maxWidth: 677,
  })

  return {
    platform: 'wechat',
    title,
    html: article.html,
    markdown: null,
    text: prepared.plainText,
    previewMode: 'article',
    themeColor: WECHAT_THEME,
    meta: buildMeta(prepared),
    cards: [],
    assets: prepared.media.assets,
    videos: prepared.media.videos,
    warnings,
    downloads: [
      {
        filename: `${safeFilename(title)}-公众号.html`,
        mimeType: 'text/html;charset=utf-8',
        kind: 'html',
        content: document,
      },
    ],
    generatedAt: prepared.generatedAt,
  }
}
