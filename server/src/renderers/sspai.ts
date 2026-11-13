import { getPlatformInfo } from '../../../shared/types'
import type { PlatformRender } from '../../../shared/types'
import type { RenderInput, RendererContext } from './types'
import { prepareSspaiContent } from '../sspai-content'
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

const SSPAI_THEME = '#d71a1b'

const SSPAI_STYLES: Record<string, string> = {
  p: 'font-size:16px;line-height:1.9;color:#1f2329;margin:0 0 20px;letter-spacing:0.2px;word-break:break-word;',
  h1: 'font-size:24px;line-height:1.45;color:#1f2329;font-weight:700;margin:36px 0 16px;',
  h2: 'font-size:22px;line-height:1.5;color:#1f2329;font-weight:700;margin:36px 0 16px;',
  h3: 'font-size:18px;line-height:1.6;color:#1f2329;font-weight:600;margin:28px 0 12px;',
  h4: 'font-size:16px;line-height:1.7;color:#1f2329;font-weight:600;margin:24px 0 10px;',
  strong: 'font-weight:700;color:#1f2329;',
  em: 'font-style:italic;',
  u: 'text-decoration:underline;text-underline-offset:2px;',
  a: 'color:#d71a1b;text-decoration:none;border-bottom:1px solid rgba(215,26,27,0.28);',
  blockquote:
    'margin:24px 0;padding:16px 20px;background-color:#faf7f7;border-left:4px solid #d71a1b;border-radius:0 6px 6px 0;color:#4b5563;font-size:15px;line-height:1.85;',
  'blockquote p': 'margin:0;color:inherit;font-size:inherit;line-height:inherit;',
  pre: 'margin:24px 0;padding:18px;background-color:#1f2328;border-radius:8px;overflow-x:auto;font-size:13.5px;line-height:1.7;color:#e6edf3;',
  code: 'font-family:SFMono-Regular,Consolas,Menlo,Monaco,monospace;font-size:14px;background-color:#f3f4f6;color:#b42318;padding:2px 5px;border-radius:4px;',
  'pre code': 'display:block;background:transparent;color:inherit;padding:0;font-size:13.5px;line-height:1.7;white-space:pre;',
  ul: 'margin:0 0 20px;padding-left:26px;',
  ol: 'margin:0 0 20px;padding-left:26px;',
  'ul[data-mp-task]': 'list-style:none;padding-left:4px;',
  'ul[data-mp-task] li': 'list-style:none;',
  li: 'font-size:16px;line-height:1.9;color:#1f2329;margin:8px 0;',
  'li p': 'margin:0;font-size:inherit;line-height:inherit;',
  table: 'width:100%;border-collapse:collapse;font-size:14px;line-height:1.7;min-width:520px;border-spacing:0;',
  th: 'border:1px solid #e5e7eb;background-color:#fafafa;padding:10px 12px;text-align:left;font-weight:600;vertical-align:top;',
  td: 'border:1px solid #e5e7eb;padding:10px 12px;text-align:left;vertical-align:top;',
  img: 'display:block;max-width:100%;height:auto;border-radius:8px;margin:24px auto;',
  'figure img': 'display:block;max-width:100%;height:auto;border-radius:8px;margin:0 auto;',
  figure: 'margin:24px 0;',
  figcaption: 'margin-top:8px;text-align:center;color:#8a94a6;font-size:13px;line-height:1.6;',
  hr: 'border:none;border-top:1px solid #ececec;margin:32px 0;',
}

/** Render a Sspai Matrix article with Markdown and standalone HTML downloads. */
export async function renderSspai(input: RenderInput, context?: RendererContext): Promise<PlatformRender> {
  const info = getPlatformInfo('sspai')
  const prepared = prepareContent(input, context, info)
  const title = truncateToChars(prepared.rawTitle, info.limits.titleMax ?? 32)
  const warnings = buildPlatformWarnings(prepared, [
    ...(prepared.media.videos.length ? ['少数派发布暂不支持视频，正文中的视频会在发布时移除。'] : []),
    ...(prepared.options.includeToc ? ['少数派排版与发布不包含自动目录，正文标题层级会保留。'] : []),
  ])

  const article = buildStyledArticle(prepareSspaiContent(prepared.html), {
    styles: SSPAI_STYLES,
    wrapperStyle: `${ARTICLE_WRAPPER_STYLE}font-size:16px;line-height:1.9;`,
    tableWrapStyle: 'width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:24px 0;border-radius:8px;',
    includeToc: false,
  })

  const bodyMarkdown = htmlToMarkdown(article.html)
  const markdown = [title ? `# ${title}` : '', bodyMarkdown].filter(Boolean).join('\n\n').trim()
  const document = buildHtmlDocument({
    title,
    html: article.html,
    themeColor: SSPAI_THEME,
    authorName: prepared.authorName || undefined,
    maxWidth: 720,
  })

  const safeTitle = safeFilename(title)
  return {
    platform: 'sspai',
    title,
    html: article.html,
    markdown,
    text: prepared.plainText,
    previewMode: 'article',
    themeColor: SSPAI_THEME,
    meta: buildMeta(prepared),
    cards: [],
    assets: prepared.media.assets,
    videos: prepared.media.videos,
    warnings,
    downloads: [
      {
        filename: `${safeTitle}-少数派.html`,
        mimeType: 'text/html;charset=utf-8',
        kind: 'html',
        content: document,
      },
      {
        filename: `${safeTitle}-少数派.md`,
        mimeType: 'text/markdown;charset=utf-8',
        kind: 'markdown',
        content: markdown,
      },
    ],
    generatedAt: prepared.generatedAt,
  }
}
