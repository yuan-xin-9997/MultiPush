import { getPlatformInfo } from '../../../shared/types'
import type { PlatformRender } from '../../../shared/types'
import type { RenderInput, RendererContext } from './types'
import { preserveExternalLinksAsText } from './link-fallback'
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

const TOUTIAO_THEME = '#f04142'

const TOUTIAO_STYLES: Record<string, string> = {
  p: 'font-size:17px;line-height:1.9;color:#222;margin:0 0 20px;letter-spacing:.2px;word-break:break-word;',
  h1: 'font-size:24px;line-height:1.4;color:#222;font-weight:700;margin:34px 0 16px;',
  h2: 'font-size:22px;line-height:1.5;color:#222;font-weight:700;margin:32px 0 15px;',
  h3: 'font-size:19px;line-height:1.6;color:#222;font-weight:600;margin:28px 0 13px;',
  h4: 'font-size:17px;line-height:1.7;color:#222;font-weight:600;margin:24px 0 11px;',
  strong: 'font-weight:700;color:#222;',
  em: 'font-style:italic;',
  u: 'text-decoration:underline;text-underline-offset:2px;',
  a: 'color:#f04142;text-decoration:none;border-bottom:1px solid rgba(240,65,66,.3);word-break:break-all;',
  blockquote: 'margin:24px 0;padding:16px 20px;background:#fff5f5;border-left:4px solid #f04142;border-radius:0 6px 6px 0;color:#5b4a4a;font-size:15px;line-height:1.85;',
  'blockquote p': 'margin:0;color:inherit;font-size:inherit;line-height:inherit;',
  pre: 'margin:24px 0;padding:18px;background:#1f2328;border-radius:8px;overflow-x:auto;font-size:13.5px;line-height:1.7;color:#e6edf3;',
  code: 'font-family:SFMono-Regular,Consolas,Menlo,Monaco,monospace;font-size:14px;background:#f3f4f6;color:#c7254e;padding:2px 5px;border-radius:4px;',
  'pre code': 'display:block;background:transparent;color:inherit;padding:0;font-size:13.5px;line-height:1.7;white-space:pre;',
  ul: 'margin:0 0 20px;padding-left:26px;',
  ol: 'margin:0 0 20px;padding-left:26px;',
  'ul[data-mp-task]': 'list-style:none;padding-left:4px;',
  'ul[data-mp-task] li': 'list-style:none;',
  li: 'font-size:17px;line-height:1.9;color:#222;margin:7px 0;',
  'li p': 'margin:0;font-size:inherit;line-height:inherit;',
  table: 'width:100%;border-collapse:collapse;font-size:14px;line-height:1.7;min-width:520px;border-spacing:0;',
  th: 'border:1px solid #eee;background:#fff5f5;padding:10px 12px;text-align:left;font-weight:600;vertical-align:top;',
  td: 'border:1px solid #eee;padding:10px 12px;text-align:left;vertical-align:top;',
  img: 'display:block;max-width:100%;height:auto;border-radius:8px;margin:24px auto;',
  'figure img': 'display:block;max-width:100%;height:auto;border-radius:8px;margin:0 auto;',
  figure: 'margin:24px 0;',
  figcaption: 'margin-top:8px;text-align:center;color:#8a8f99;font-size:13px;line-height:1.6;',
  hr: 'border:none;border-top:1px solid #ececec;margin:32px 0;',
}

/** Render a Toutiao graphic article with Markdown/HTML downloads. */
export async function renderToutiao(input: RenderInput, context?: RendererContext): Promise<PlatformRender> {
  const info = getPlatformInfo('toutiao')
  const prepared = prepareContent(input, context, info)
  const title = truncateToChars(prepared.rawTitle, info.limits.titleMax ?? 30)
  const warnings = buildPlatformWarnings(prepared, [
    ...(prepared.media.videos.length ? ['今日头条发布暂不支持视频，正文中的视频会在发布时忽略。'] : []),
  ])
  if (Array.from(prepared.rawTitle).length < 2) warnings.push('今日头条标题至少需要 2 个字。')

  const linkFallback = preserveExternalLinksAsText(prepared.html, { allowedHosts: ['toutiao.com'] })
  if (linkFallback.converted > 0) {
    warnings.push(`今日头条正文不支持站外可点击链接，${linkFallback.converted} 个外链已保留为可复制地址。`)
  }

  const article = buildStyledArticle(linkFallback.html, {
    styles: TOUTIAO_STYLES,
    wrapperStyle: `${ARTICLE_WRAPPER_STYLE}font-size:17px;line-height:1.9;`,
    tableWrapStyle: 'width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:24px 0;border-radius:8px;',
    includeToc: false,
  })

  const bodyMarkdown = htmlToMarkdown(article.html)
  const markdown = [title ? `# ${title}` : '', bodyMarkdown].filter(Boolean).join('\n\n').trim()
  const document = buildHtmlDocument({ title, html: article.html, themeColor: TOUTIAO_THEME, authorName: prepared.authorName || undefined, maxWidth: 760 })
  const safeTitle = safeFilename(title)
  return {
    platform: 'toutiao',
    title,
    html: article.html,
    markdown,
    text: prepared.plainText,
    previewMode: 'article',
    themeColor: TOUTIAO_THEME,
    meta: buildMeta(prepared),
    cards: [],
    assets: prepared.media.assets,
    videos: prepared.media.videos,
    warnings: Array.from(new Set(warnings)),
    downloads: [
      { filename: `${safeTitle}-今日头条.html`, mimeType: 'text/html;charset=utf-8', kind: 'html', content: document },
      { filename: `${safeTitle}-今日头条.md`, mimeType: 'text/markdown;charset=utf-8', kind: 'markdown', content: markdown },
    ],
    generatedAt: prepared.generatedAt,
  }
}
