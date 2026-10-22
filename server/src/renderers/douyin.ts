import { getPlatformInfo } from '../../../shared/types'
import type { PlatformRender } from '../../../shared/types'
import type { RenderInput, RendererContext } from './types'
import {
  ARTICLE_WRAPPER_STYLE,
  buildHashtags,
  buildHtmlDocument,
  buildMeta,
  buildPlatformWarnings,
  buildStyledArticle,
  prepareContent,
  safeFilename,
  truncateToChars,
} from './common'

const DOUYIN_THEME = '#fe2c55'

const DOUYIN_STYLES: Record<string, string> = {
  p: 'font-size:16px;line-height:1.9;color:#161823;margin:0 0 18px;letter-spacing:0.2px;word-break:break-word;',
  h1: 'font-size:23px;line-height:1.4;color:#161823;font-weight:700;margin:30px 0 16px;',
  h2: 'font-size:20px;line-height:1.5;color:#161823;font-weight:700;margin:28px 0 14px;',
  h3: 'font-size:18px;line-height:1.6;color:#161823;font-weight:600;margin:24px 0 12px;',
  h4: 'font-size:16px;line-height:1.7;color:#161823;font-weight:600;margin:20px 0 10px;',
  strong: 'font-weight:700;color:#161823;',
  em: 'font-style:italic;',
  u: 'text-decoration:underline;text-underline-offset:2px;',
  a: 'color:#fe2c55;text-decoration:none;border-bottom:1px solid rgba(254,44,85,0.35);word-break:break-all;',
  blockquote:
    'margin:20px 0;padding:14px 16px;background-color:#fff2f4;border-left:3px solid #fe2c55;border-radius:0 6px 6px 0;color:#5b4046;font-size:15px;line-height:1.85;',
  'blockquote p': 'margin:0;color:inherit;font-size:inherit;line-height:inherit;',
  pre: 'margin:20px 0;padding:16px;background-color:#161823;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.7;color:#f2f3f5;',
  code: 'font-family:SFMono-Regular,Consolas,Menlo,Monaco,monospace;font-size:14px;background-color:#f4f4f6;color:#c7254e;padding:2px 5px;border-radius:3px;',
  'pre code': 'display:block;background-color:transparent;color:inherit;padding:0;font-size:13px;line-height:1.7;white-space:pre;',
  ul: 'margin:0 0 18px;padding-left:24px;',
  ol: 'margin:0 0 18px;padding-left:24px;',
  'ul[data-mp-task]': 'list-style:none;padding-left:0;',
  'ul[data-mp-task] li': 'list-style:none;',
  li: 'font-size:16px;line-height:1.9;color:#161823;margin:6px 0;',
  'li p': 'margin:0;font-size:inherit;line-height:inherit;',
  table:
    'width:100%;border-collapse:collapse;font-size:14px;line-height:1.7;min-width:480px;border-spacing:0;',
  th: 'border:1px solid #f3d6dc;background-color:#fff2f4;padding:10px 12px;text-align:left;font-weight:600;vertical-align:top;',
  td: 'border:1px solid #ebebee;padding:10px 12px;text-align:left;vertical-align:top;',
  img: 'display:block;max-width:100%;height:auto;border-radius:10px;margin:20px auto;',
  video: 'display:block;width:100%;border-radius:10px;margin:20px 0;background:#000;',
  figure: 'margin:20px 0;',
  figcaption: 'margin-top:8px;text-align:center;color:#8a8f99;font-size:13px;line-height:1.6;',
  hr: 'border:none;border-top:1px solid #ebebee;margin:28px 0;',
}

/**
 * Render a Douyin (抖音) post.
 *
 * Douyin is a vertical-feed product: the deliverable is a caption (title +
 * body + hashtags) plus the media assets, so the renderer focuses on a clean
 * caption, a standalone HTML copy and a structured JSON payload. The browser
 * previews it inside a 9:16 feed mockup.
 */
export async function renderDouyin(input: RenderInput, context?: RendererContext): Promise<PlatformRender> {
  const info = getPlatformInfo('douyin')
  const prepared = prepareContent(input, context, info)
  const title = truncateToChars(prepared.rawTitle, info.limits.titleMax ?? 55)
  const warnings = buildPlatformWarnings(prepared)

  const includeTags = prepared.options.includeTags !== false
  const hashtags = includeTags ? buildHashtags(prepared.tags, 5) : []
  const body = truncateToChars(
    prepared.plainText || prepared.summary || '（正文为空，可先补充文案再发布）',
    info.limits.bodyMax ?? 1000,
  )
  const caption = [title, '', body, hashtags.length > 0 ? '' : null, hashtags.join(' ')]
    .filter((part): part is string => part !== null)
    .join('\n')
    .trim()

  if (prepared.media.videos.length > 0) {
    warnings.push('检测到视频素材，建议发布视频版本，并在首帧或素材中选择竖屏封面。')
  } else {
    warnings.push('未检测到视频素材，将按图文发布；抖音视频内容通常能获得更多推荐。')
  }
  if (prepared.textLength > (info.limits.bodyMax ?? 1000)) {
    warnings.push('抖音正文已截断到 1000 字以内，完整内容可在 HTML 文件中查看。')
  }

  const article = buildStyledArticle(prepared.html, {
    styles: DOUYIN_STYLES,
    wrapperStyle: `${ARTICLE_WRAPPER_STYLE}max-width:540px;margin:0 auto;`,
    tableWrapStyle: 'width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:20px 0;border-radius:8px;',
  })

  const document = buildHtmlDocument({
    title,
    html: article.html,
    themeColor: DOUYIN_THEME,
    authorName: prepared.authorName || undefined,
    maxWidth: 620,
  })

  const noteJson = JSON.stringify(
    {
      platform: 'douyin',
      title,
      caption,
      text: body,
      tags: includeTags ? prepared.tags : [],
      hashtags,
      cover: prepared.coverImage || null,
      images: prepared.media.images,
      videos: prepared.media.videos,
      meta: { ...buildMeta(prepared), tags: includeTags ? prepared.tags : [] },
      generatedAt: prepared.generatedAt,
    },
    null,
    2,
  )

  const safeTitle = safeFilename(title)
  const coverExtension = prepared.coverImage.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png'
  const assets =
    prepared.coverImage && !prepared.media.assets.some((asset) => asset.url === prepared.coverImage)
      ? [{ filename: `封面${coverExtension}`, url: prepared.coverImage, kind: 'image' as const }, ...prepared.media.assets]
      : prepared.media.assets

  return {
    platform: 'douyin',
    title,
    html: article.html,
    markdown: null,
    text: caption,
    previewMode: 'vertical',
    themeColor: DOUYIN_THEME,
    meta: { ...buildMeta(prepared), tags: includeTags ? prepared.tags : [] },
    cards: [],
    assets,
    videos: prepared.media.videos,
    warnings: Array.from(new Set(warnings)),
    downloads: [
      {
        filename: `${safeTitle}-抖音文案.txt`,
        mimeType: 'text/plain;charset=utf-8',
        kind: 'text',
        content: caption,
      },
      {
        filename: `${safeTitle}-抖音图文.html`,
        mimeType: 'text/html;charset=utf-8',
        kind: 'html',
        content: document,
      },
      {
        filename: `${safeTitle}-抖音笔记.json`,
        mimeType: 'application/json;charset=utf-8',
        kind: 'json',
        content: noteJson,
      },
    ],
    generatedAt: prepared.generatedAt,
  }
}
