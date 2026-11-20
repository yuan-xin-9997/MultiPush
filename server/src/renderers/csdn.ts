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

const CSDN_THEME = '#fc5531'

/**
 * CSDN 博客正文风格：白色内容区、橙色主色、较紧凑的代码块。
 * 发布时使用 Markdown（CSDN 的 Markdown 编辑器），HTML 仅用于预览与下载。
 */
const CSDN_STYLES: Record<string, string> = {
  p: 'font-size:16px;line-height:1.8;color:#222226;margin:0 0 18px;letter-spacing:0.01em;word-break:break-word;',
  h1: 'font-size:28px;line-height:1.4;color:#222226;font-weight:700;margin:36px 0 16px;',
  h2: 'font-size:22px;line-height:1.5;color:#222226;font-weight:700;margin:34px 0 14px;',
  h3: 'font-size:19px;line-height:1.6;color:#222226;font-weight:600;margin:28px 0 12px;',
  h4: 'font-size:17px;line-height:1.7;color:#222226;font-weight:600;margin:24px 0 10px;',
  strong: 'font-weight:700;color:#1f2328;',
  em: 'font-style:italic;',
  u: 'text-decoration:underline;text-underline-offset:2px;',
  a: 'color:#fc5531;text-decoration:none;border-bottom:1px solid rgba(252,85,49,0.25);word-break:break-all;',
  blockquote: 'margin:22px 0;padding:14px 18px;background:#fafafa;border-left:4px solid #fc5531;border-radius:0 4px 4px 0;color:#555;font-size:15px;line-height:1.8;',
  'blockquote p': 'margin:0;color:inherit;font-size:inherit;line-height:inherit;',
  pre: 'margin:22px 0;padding:18px;background:#282c34;border-radius:6px;overflow-x:auto;font-size:13.5px;line-height:1.7;color:#dcdfe4;',
  code: 'font-family:SFMono-Regular,Consolas,Menlo,Monaco,monospace;font-size:14px;background:#f4f5f5;color:#c7254e;padding:2px 5px;border-radius:3px;',
  'pre code': 'display:block;background:transparent;color:inherit;padding:0;font-size:13.5px;line-height:1.7;white-space:pre;',
  ul: 'margin:0 0 18px;padding-left:26px;',
  ol: 'margin:0 0 18px;padding-left:26px;',
  'ul[data-mp-task]': 'list-style:none;padding-left:4px;',
  'ul[data-mp-task] li': 'list-style:none;',
  li: 'font-size:16px;line-height:1.8;color:#222226;margin:7px 0;',
  'li p': 'margin:0;font-size:inherit;line-height:inherit;',
  table: 'width:100%;border-collapse:collapse;font-size:14px;line-height:1.7;min-width:520px;border-spacing:0;',
  th: 'border:1px solid #e4e6eb;background:#f7f8fa;padding:10px 12px;text-align:left;font-weight:600;vertical-align:top;',
  td: 'border:1px solid #e4e6eb;padding:10px 12px;text-align:left;vertical-align:top;',
  img: 'display:block;max-width:100%;height:auto;border-radius:4px;margin:22px auto;',
  'figure img': 'display:block;max-width:100%;height:auto;border-radius:4px;margin:0 auto;',
  figure: 'margin:20px 0;',
  figcaption: 'margin-top:8px;text-align:center;color:#8f9399;font-size:13px;line-height:1.6;',
  hr: 'border:none;border-top:1px solid #e4e6eb;margin:30px 0;',
}

/** Render a CSDN technical blog article; publishing uses its Markdown representation. */
export async function renderCsdn(input: RenderInput, context?: RendererContext): Promise<PlatformRender> {
  const info = getPlatformInfo('csdn')
  const prepared = prepareContent(input, context, info)
  const title = truncateToChars(prepared.rawTitle, info.limits.titleMax ?? 100)
  const warnings = buildPlatformWarnings(prepared, [
    ...(prepared.media.videos.length ? ['CSDN 文章暂不支持视频嵌入，正文中的视频会在发布时忽略。'] : []),
    ...(Array.from(title).length < 5 ? ['CSDN 标题需要 5–100 个字，发布前请补充标题。'] : []),
  ])
  const article = buildStyledArticle(prepareDoubanContent(prepared.html), {
    styles: CSDN_STYLES,
    wrapperStyle: `${ARTICLE_WRAPPER_STYLE}font-size:16px;line-height:1.8;color:#222226;`,
    tableWrapStyle: 'width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:22px 0;border-radius:6px;',
    includeToc: false,
  })
  const bodyMarkdown = htmlToMarkdown(article.html)
  const markdown = [title ? `# ${title}` : '', bodyMarkdown].filter(Boolean).join('\n\n').trim()
  const document = buildHtmlDocument({ title, html: article.html, themeColor: CSDN_THEME, authorName: prepared.authorName || undefined, maxWidth: 860 })
  const safeTitle = safeFilename(title)
  return {
    platform: 'csdn', title, html: article.html, markdown, text: prepared.plainText,
    previewMode: 'article', themeColor: CSDN_THEME, meta: buildMeta(prepared),
    cards: [], assets: prepared.media.assets, videos: prepared.media.videos, warnings,
    downloads: [
      { filename: `${safeTitle}-CSDN.html`, mimeType: 'text/html;charset=utf-8', kind: 'html', content: document },
      { filename: `${safeTitle}-CSDN.md`, mimeType: 'text/markdown;charset=utf-8', kind: 'markdown', content: markdown },
    ],
    generatedAt: prepared.generatedAt,
  }
}
