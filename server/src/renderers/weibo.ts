import { getPlatformInfo } from '../../../shared/types'
import type { PlatformRender } from '../../../shared/types'
import type { RenderInput, RendererContext } from './types'
import {
  ARTICLE_WRAPPER_STYLE,
  buildHtmlDocument,
  buildMeta,
  buildPlatformWarnings,
  buildStyledArticle,
  normalizeTags,
  prepareContent,
  safeFilename,
  truncateToChars,
} from './common'

const WEIBO_THEME = '#ff8200'
const WEIBO_BODY_MAX = 2000
const WEIBO_IMAGE_MAX = 9

const WEIBO_STYLES: Record<string, string> = {
  p: 'font-size:17px;line-height:1.85;color:#1f2329;margin:0 0 18px;letter-spacing:0.2px;word-break:break-word;',
  h1: 'font-size:24px;line-height:1.4;color:#1f2329;font-weight:700;margin:30px 0 16px;',
  h2: 'font-size:21px;line-height:1.5;color:#1f2329;font-weight:700;margin:28px 0 14px;',
  h3: 'font-size:18px;line-height:1.6;color:#1f2329;font-weight:600;margin:24px 0 12px;',
  h4: 'font-size:16px;line-height:1.7;color:#1f2329;font-weight:600;margin:20px 0 10px;',
  strong: 'font-weight:700;color:#1f2329;',
  em: 'font-style:italic;',
  u: 'text-decoration:underline;text-underline-offset:2px;',
  a: 'color:#ff8200;text-decoration:none;border-bottom:1px solid rgba(255,130,0,0.35);word-break:break-all;',
  blockquote:
    'margin:20px 0;padding:14px 16px;background-color:#fff7ec;border-left:3px solid #ff8200;border-radius:0 6px 6px 0;color:#5d4a32;font-size:15px;line-height:1.85;',
  'blockquote p': 'margin:0;color:inherit;font-size:inherit;line-height:inherit;',
  pre: 'margin:20px 0;padding:16px;background-color:#1f2328;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.7;color:#f2f3f5;',
  code: 'font-family:SFMono-Regular,Consolas,Menlo,Monaco,monospace;font-size:14px;background-color:#f5f5f5;color:#c7254e;padding:2px 5px;border-radius:3px;',
  'pre code': 'display:block;background-color:transparent;color:inherit;padding:0;font-size:13px;line-height:1.7;white-space:pre;',
  ul: 'margin:0 0 18px;padding-left:24px;',
  ol: 'margin:0 0 18px;padding-left:24px;',
  'ul[data-mp-task]': 'list-style:none;padding-left:0;',
  'ul[data-mp-task] li': 'list-style:none;',
  li: 'font-size:17px;line-height:1.85;color:#1f2329;margin:6px 0;',
  'li p': 'margin:0;font-size:inherit;line-height:inherit;',
  table: 'width:100%;border-collapse:collapse;font-size:14px;line-height:1.7;min-width:480px;border-spacing:0;',
  th: 'border:1px solid #eadfd2;background-color:#fff7ec;padding:10px 12px;text-align:left;font-weight:600;vertical-align:top;',
  td: 'border:1px solid #ececec;padding:10px 12px;text-align:left;vertical-align:top;',
  img: 'display:block;max-width:100%;height:auto;border-radius:10px;margin:20px auto;',
  figure: 'margin:20px 0;',
  figcaption: 'margin-top:8px;text-align:center;color:#8a8f99;font-size:13px;line-height:1.6;',
  hr: 'border:none;border-top:1px solid #ececec;margin:28px 0;',
}

export function buildWeiboTopics(tags: string[], limit = 5): string[] {
  const unique = Array.from(new Set(normalizeTags(tags).map(tag => tag.replace(/\s+/g, '').replace(/#/g, '')).filter(Boolean))).slice(0, limit)
  return unique.map(tag => `#${tag}#`)
}

/**
 * Render a Weibo image-text post.
 *
 * Weibo has no separate article title in the simple composer, so the post is
 * delivered as one caption: title line, body and `#topic#` tags. Images are
 * passed through as assets for the browser upload step.
 */
export async function renderWeibo(input: RenderInput, context?: RendererContext): Promise<PlatformRender> {
  const info = getPlatformInfo('weibo')
  const prepared = prepareContent(input, context, info)
  const title = truncateToChars(prepared.rawTitle, info.limits.titleMax ?? 64)
  const warnings = buildPlatformWarnings(prepared, [
    ...(prepared.media.videos.length ? ['微博发布暂不支持视频，正文中的视频会被忽略。'] : []),
    ...(prepared.media.images.length > WEIBO_IMAGE_MAX ? [`微博最多发布 ${WEIBO_IMAGE_MAX} 张图片，超出部分不会上传。`] : []),
  ])

  const includeTags = prepared.options.includeTags !== false
  const topics = includeTags ? buildWeiboTopics(prepared.tags, 5) : []
  const topicText = topics.join(' ')
  const reserved = topicText ? Array.from(topicText).length + 2 : 0
  const titleReserved = title ? Array.from(title).length + 2 : 0
  const budget = Math.max(1, WEIBO_BODY_MAX - reserved - titleReserved)
  const rawBody = prepared.plainText || prepared.summary || '（正文为空，可先补充文案再发布）'
  const body = truncateToChars(rawBody, budget)
  const caption = [title, body, topicText].filter(Boolean).join('\n\n').trim()
  if (Array.from(rawBody).length > budget) warnings.push(`微博正文已截断到 ${WEIBO_BODY_MAX} 字以内，完整内容可在 HTML 文件中查看。`)

  const article = buildStyledArticle(prepared.html, {
    styles: WEIBO_STYLES,
    wrapperStyle: `${ARTICLE_WRAPPER_STYLE}max-width:620px;margin:0 auto;`,
    tableWrapStyle: 'width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:20px 0;border-radius:8px;',
  })

  const document = buildHtmlDocument({
    title,
    html: article.html,
    themeColor: WEIBO_THEME,
    authorName: prepared.authorName || undefined,
    maxWidth: 680,
  })

  const noteJson = JSON.stringify({
    platform: 'weibo',
    title,
    caption,
    body,
    topics,
    tags: includeTags ? prepared.tags : [],
    images: prepared.media.images,
    meta: { ...buildMeta(prepared), tags: includeTags ? prepared.tags : [] },
    generatedAt: prepared.generatedAt,
  }, null, 2)

  const safeTitle = safeFilename(title)
  return {
    platform: 'weibo',
    title,
    html: article.html,
    markdown: null,
    text: caption,
    previewMode: 'vertical',
    themeColor: WEIBO_THEME,
    meta: { ...buildMeta(prepared), tags: includeTags ? prepared.tags : [] },
    cards: [],
    assets: prepared.media.assets.slice(0, WEIBO_IMAGE_MAX),
    videos: prepared.media.videos,
    warnings: Array.from(new Set(warnings)),
    captionBody: body,
    downloads: [
      {
        filename: `${safeTitle}-微博文案.txt`,
        mimeType: 'text/plain;charset=utf-8',
        kind: 'text',
        content: caption,
      },
      {
        filename: `${safeTitle}-微博图文.html`,
        mimeType: 'text/html;charset=utf-8',
        kind: 'html',
        content: document,
      },
      {
        filename: `${safeTitle}-微博.json`,
        mimeType: 'application/json;charset=utf-8',
        kind: 'json',
        content: noteJson,
      },
    ],
    generatedAt: prepared.generatedAt,
  }
}
