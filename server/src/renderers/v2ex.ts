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

const V2EX_THEME = '#333333'

const V2EX_STYLES: Record<string, string> = {
  p: 'font-size:15px;line-height:1.9;color:#333;margin:0 0 17px;word-break:break-word;',
  h1: 'font-size:24px;line-height:1.45;color:#222;font-weight:600;margin:30px 0 14px;',
  h2: 'font-size:20px;line-height:1.5;color:#222;font-weight:600;margin:28px 0 13px;',
  h3: 'font-size:17px;line-height:1.6;color:#222;font-weight:600;margin:24px 0 11px;',
  h4: 'font-size:15px;line-height:1.7;color:#222;font-weight:600;margin:20px 0 9px;',
  strong: 'font-weight:700;color:#222;',
  em: 'font-style:italic;',
  u: 'text-decoration:underline;text-underline-offset:2px;',
  a: 'color:#2c5fa8;text-decoration:none;word-break:break-all;',
  blockquote: 'margin:18px 0;padding:11px 14px;background:#f5f5f5;border-left:3px solid #b9b9b9;color:#555;font-size:14px;line-height:1.8;',
  'blockquote p': 'margin:0;color:inherit;font-size:inherit;line-height:inherit;',
  pre: 'margin:18px 0;padding:14px;background:#f7f7f7;border:1px solid #e3e3e3;border-radius:4px;overflow-x:auto;font-size:13px;line-height:1.7;color:#333;',
  code: 'font-family:SFMono-Regular,Consolas,Menlo,Monaco,monospace;font-size:13.5px;background:#f2f2f2;color:#c7254e;padding:2px 4px;border-radius:3px;',
  'pre code': 'display:block;background:transparent;color:inherit;padding:0;font-size:13px;line-height:1.7;white-space:pre;',
  ul: 'margin:0 0 17px;padding-left:25px;',
  ol: 'margin:0 0 17px;padding-left:25px;',
  'ul[data-mp-task]': 'list-style:none;padding-left:4px;',
  'ul[data-mp-task] li': 'list-style:none;',
  li: 'font-size:15px;line-height:1.9;color:#333;margin:5px 0;',
  'li p': 'margin:0;font-size:inherit;line-height:inherit;',
  table: 'width:100%;border-collapse:collapse;font-size:13.5px;line-height:1.7;min-width:500px;',
  th: 'border:1px solid #dcdcdc;background:#f7f7f7;padding:8px 10px;text-align:left;font-weight:600;vertical-align:top;',
  td: 'border:1px solid #dcdcdc;padding:8px 10px;text-align:left;vertical-align:top;',
  img: 'display:block;max-width:100%;height:auto;margin:18px auto;',
  'figure img': 'display:block;max-width:100%;height:auto;margin:0 auto;',
  figure: 'margin:18px 0;',
  figcaption: 'margin-top:6px;text-align:center;color:#999;font-size:12.5px;line-height:1.6;',
  hr: 'border:none;border-top:1px solid #e5e5e5;margin:25px 0;',
}

/** Render a V2EX topic; publishing uses the Markdown body with the title separate. */
export async function renderV2ex(input: RenderInput, context?: RendererContext): Promise<PlatformRender> {
  const info = getPlatformInfo('v2ex')
  const prepared = prepareContent(input, context, info)
  const title = truncateToChars(prepared.rawTitle, info.limits.titleMax ?? 120)
  const cleanHtml = prepareDoubanContent(prepared.html)
  const article = buildStyledArticle(cleanHtml, {
    styles: V2EX_STYLES,
    wrapperStyle: `${ARTICLE_WRAPPER_STYLE}font-size:15px;line-height:1.9;color:#333;`,
    tableWrapStyle: 'width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:18px 0;',
    includeToc: false,
  })
  const bodyMarkdown = htmlToMarkdown(article.html)
  const markdown = [title ? `# ${title}` : '', bodyMarkdown].filter(Boolean).join('\n\n').trim()
  const warnings = buildPlatformWarnings(prepared, [
    ...(prepared.media.videos.length ? ['V2EX 主题不支持视频嵌入，正文中的视频会在发布时忽略。'] : []),
    ...(/\|[^\n]*\|/.test(bodyMarkdown) ? ['V2EX Markdown 不保证支持表格，表格可能显示为普通文本，建议发布前预览。'] : []),
    ...(bodyMarkdown.length > (info.limits.bodyMax ?? 20_000)
      ? [`V2EX 主题正文最多 20000 个字符，当前约 ${bodyMarkdown.length} 个字符，发布时会被拒绝，请精简后再发布。`]
      : []),
  ])
  const document = buildHtmlDocument({
    title,
    html: article.html,
    themeColor: V2EX_THEME,
    authorName: prepared.authorName || undefined,
    maxWidth: 700,
  })
  const safeTitle = safeFilename(title)
  const noteJson = JSON.stringify(
    {
      platform: 'v2ex',
      title,
      markdown,
      text: prepared.plainText,
      tags: prepared.tags,
      meta: buildMeta(prepared),
      generatedAt: prepared.generatedAt,
    },
    null,
    2,
  )
  return {
    platform: 'v2ex',
    title,
    html: article.html,
    markdown,
    text: prepared.plainText,
    previewMode: 'article',
    themeColor: V2EX_THEME,
    meta: buildMeta(prepared),
    cards: [],
    assets: prepared.media.assets,
    videos: prepared.media.videos,
    warnings,
    downloads: [
      { filename: `${safeTitle}-V2EX.html`, mimeType: 'text/html;charset=utf-8', kind: 'html', content: document },
      { filename: `${safeTitle}-V2EX.md`, mimeType: 'text/markdown;charset=utf-8', kind: 'markdown', content: markdown },
      { filename: `${safeTitle}-V2EX.json`, mimeType: 'application/json;charset=utf-8', kind: 'json', content: noteJson },
    ],
    generatedAt: prepared.generatedAt,
  }
}
