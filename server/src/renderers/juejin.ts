import { getPlatformInfo } from '../../../shared/types'
import type { PlatformRender } from '../../../shared/types'
import type { RenderInput, RendererContext } from './types'
import { prepareDoubanContent } from '../douban-content'
import {
  ARTICLE_WRAPPER_STYLE,
  buildHtmlDocument,
  buildMeta,
  buildPlatformWarnings,
  buildStyledArticle,
  htmlToMarkdown,
  prepareContent,
  safeFilename,
  truncateToChars,
} from './common'

const JUEJIN_THEME = '#1e80ff'

const JUEJIN_STYLES: Record<string, string> = {
  p: 'font-size:16px;line-height:1.85;color:#252933;margin:0 0 18px;letter-spacing:0.01em;word-break:break-word;',
  h1: 'font-size:26px;line-height:1.4;color:#252933;font-weight:700;margin:36px 0 16px;',
  h2: 'font-size:22px;line-height:1.5;color:#252933;font-weight:700;margin:34px 0 14px;',
  h3: 'font-size:19px;line-height:1.6;color:#252933;font-weight:600;margin:28px 0 12px;',
  h4: 'font-size:17px;line-height:1.7;color:#252933;font-weight:600;margin:24px 0 10px;',
  strong: 'font-weight:700;color:#1d2129;',
  em: 'font-style:italic;',
  u: 'text-decoration:underline;text-underline-offset:2px;',
  a: 'color:#1e80ff;text-decoration:none;border-bottom:1px solid rgba(30,128,255,0.25);word-break:break-all;',
  blockquote: 'margin:22px 0;padding:14px 18px;background:#f7f8fa;border-left:4px solid #1e80ff;border-radius:0 6px 6px 0;color:#4e5969;font-size:15px;line-height:1.8;',
  'blockquote p': 'margin:0;color:inherit;font-size:inherit;line-height:inherit;',
  pre: 'margin:22px 0;padding:18px;background:#1f2329;border-radius:8px;overflow-x:auto;font-size:13.5px;line-height:1.7;color:#e6edf3;',
  code: 'font-family:SFMono-Regular,Consolas,Menlo,Monaco,monospace;font-size:14px;background:#f2f3f5;color:#c7254e;padding:2px 5px;border-radius:4px;',
  'pre code': 'display:block;background:transparent;color:inherit;padding:0;font-size:13.5px;line-height:1.7;white-space:pre;',
  ul: 'margin:0 0 18px;padding-left:26px;',
  ol: 'margin:0 0 18px;padding-left:26px;',
  'ul[data-mp-task]': 'list-style:none;padding-left:4px;',
  'ul[data-mp-task] li': 'list-style:none;',
  li: 'font-size:16px;line-height:1.85;color:#252933;margin:7px 0;',
  'li p': 'margin:0;font-size:inherit;line-height:inherit;',
  table: 'width:100%;border-collapse:collapse;font-size:14px;line-height:1.7;min-width:520px;border-spacing:0;',
  th: 'border:1px solid #e5e6eb;background:#f7f8fa;padding:10px 12px;text-align:left;font-weight:600;vertical-align:top;',
  td: 'border:1px solid #e5e6eb;padding:10px 12px;text-align:left;vertical-align:top;',
  img: 'display:block;max-width:100%;height:auto;border-radius:8px;margin:22px auto;',
  'figure img': 'display:block;max-width:100%;height:auto;border-radius:8px;margin:0 auto;',
  figure: 'margin:20px 0;',
  figcaption: 'margin-top:8px;text-align:center;color:#8a8f99;font-size:13px;line-height:1.6;',
  hr: 'border:none;border-top:1px solid #e5e6eb;margin:30px 0;',
}

/** Render a Juejin technical article; publish uses its Markdown representation. */
export async function renderJuejin(input: RenderInput, context?: RendererContext): Promise<PlatformRender> {
  const info = getPlatformInfo('juejin')
  const prepared = prepareContent(input, context, info)
  const title = truncateToChars(prepared.rawTitle, info.limits.titleMax ?? 100)
  const warnings = buildPlatformWarnings(prepared, [
    ...(prepared.media.videos.length ? ['掘金文章暂不支持视频嵌入，正文中的视频会在发布时忽略。'] : []),
  ])
  const article = buildStyledArticle(prepareDoubanContent(prepared.html), {
    styles: JUEJIN_STYLES,
    wrapperStyle: `${ARTICLE_WRAPPER_STYLE}font-size:16px;line-height:1.85;color:#252933;`,
    tableWrapStyle: 'width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:22px 0;border-radius:8px;',
    includeToc: false,
  })
  const bodyMarkdown = htmlToMarkdown(article.html)
  const markdown = [title ? `# ${title}` : '', bodyMarkdown].filter(Boolean).join('\n\n').trim()
  const document = buildHtmlDocument({ title, html: article.html, themeColor: JUEJIN_THEME, authorName: prepared.authorName || undefined, maxWidth: 760 })
  const safeTitle = safeFilename(title)
  return {
    platform: 'juejin', title, html: article.html, markdown, text: prepared.plainText,
    previewMode: 'article', themeColor: JUEJIN_THEME, meta: buildMeta(prepared),
    cards: [], assets: prepared.media.assets, videos: prepared.media.videos, warnings,
    downloads: [
      { filename: `${safeTitle}-掘金.html`, mimeType: 'text/html;charset=utf-8', kind: 'html', content: document },
      { filename: `${safeTitle}-掘金.md`, mimeType: 'text/markdown;charset=utf-8', kind: 'markdown', content: markdown },
    ],
    generatedAt: prepared.generatedAt,
  }
}
