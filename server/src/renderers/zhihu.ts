import { getPlatformInfo } from '../../../shared/types'
import type { PlatformRender } from '../../../shared/types'
import type { RenderInput, RendererContext } from './types'
import { prepareZhihuContent } from '../zhihu-content'
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

const ZHIHU_THEME = '#1772f6'

const ZHIHU_STYLES: Record<string, string> = {
  p: 'font-size:16px;line-height:1.85;color:#121212;margin:0 0 18px;letter-spacing:0.2px;word-break:break-word;',
  h1: 'font-size:24px;line-height:1.4;color:#121212;font-weight:700;margin:32px 0 16px;',
  h2: 'font-size:20px;line-height:1.5;color:#121212;font-weight:700;margin:30px 0 14px;',
  h3: 'font-size:18px;line-height:1.6;color:#121212;font-weight:600;margin:26px 0 12px;',
  h4: 'font-size:16px;line-height:1.7;color:#121212;font-weight:600;margin:22px 0 10px;',
  strong: 'font-weight:700;color:#121212;',
  em: 'font-style:italic;',
  u: 'text-decoration:underline;text-underline-offset:2px;',
  a: 'color:#1772f6;text-decoration:none;border-bottom:1px solid rgba(23,114,246,0.3);',
  blockquote:
    'margin:22px 0;padding:14px 18px;background-color:#f6f9ff;border-left:4px solid #1772f6;border-radius:0 6px 6px 0;color:#4b5563;font-size:15px;line-height:1.8;',
  'blockquote p': 'margin:0;color:inherit;font-size:inherit;line-height:inherit;',
  pre: 'margin:22px 0;padding:18px;background-color:#1f2328;border-radius:8px;overflow-x:auto;font-size:13.5px;line-height:1.7;color:#e6edf3;',
  code: 'font-family:SFMono-Regular,Consolas,Menlo,Monaco,monospace;font-size:14px;background-color:#f2f4f7;color:#c7254e;padding:2px 5px;border-radius:4px;',
  'pre code': 'display:block;background:transparent;color:inherit;padding:0;font-size:13.5px;line-height:1.7;white-space:pre;',
  ul: 'margin:0 0 18px;padding-left:26px;',
  ol: 'margin:0 0 18px;padding-left:26px;',
  'ul[data-mp-task]': 'list-style:none;padding-left:4px;',
  'ul[data-mp-task] li': 'list-style:none;',
  li: 'font-size:16px;line-height:1.85;color:#121212;margin:6px 0;',
  'li p': 'margin:0;font-size:inherit;line-height:inherit;',
  table:
    'width:100%;border-collapse:collapse;font-size:14px;line-height:1.7;min-width:520px;border-spacing:0;',
  th: 'border:1px solid #dfe5ef;background-color:#f5f8fe;padding:10px 12px;text-align:left;font-weight:600;vertical-align:top;',
  td: 'border:1px solid #e5e9f0;padding:10px 12px;text-align:left;vertical-align:top;',
  img: 'display:block;max-width:100%;height:auto;border-radius:8px;margin:22px auto;',
  'figure img': 'display:block;max-width:100%;height:auto;border-radius:8px;margin:0 auto;',
  video: 'display:block;width:100%;border-radius:8px;margin:22px 0;background:#000;',
  figure: 'margin:22px 0;',
  figcaption: 'margin-top:8px;text-align:center;color:#8a94a6;font-size:13px;line-height:1.6;',
  hr: 'border:none;border-top:1px solid #e8ebf0;margin:30px 0;',
}

const ZHIHU_TOC = {
  containerStyle:
    'margin:0 0 26px;padding:16px 18px;background-color:#f7f9fd;border:1px solid #e2e9f5;border-radius:8px;',
  titleStyle: 'margin:0 0 8px;font-size:14px;font-weight:700;color:#1772f6;line-height:1.6;',
  linkStyle: 'display:block;padding:3px 0;color:#3d4a5c;font-size:14px;line-height:1.7;text-decoration:none;',
  levelStyles: {
    1: 'display:block;padding:3px 0;color:#121212;font-size:14px;font-weight:600;line-height:1.7;text-decoration:none;',
    2: 'display:block;padding:3px 0 3px 14px;color:#3d4a5c;font-size:14px;line-height:1.7;text-decoration:none;',
    3: 'display:block;padding:3px 0 3px 28px;color:#6b7788;font-size:13px;line-height:1.7;text-decoration:none;',
  },
}

/** Render a Zhihu column/article with Markdown and standalone HTML downloads. */
export async function renderZhihu(input: RenderInput, context?: RendererContext): Promise<PlatformRender> {
  const info = getPlatformInfo('zhihu')
  const prepared = prepareContent(input, context, info)
  const title = truncateToChars(prepared.rawTitle, info.limits.titleMax ?? 100)
  const warnings = buildPlatformWarnings(prepared)

  const article = buildStyledArticle(prepareZhihuContent(prepared.html), {
    styles: ZHIHU_STYLES,
    wrapperStyle: `${ARTICLE_WRAPPER_STYLE}font-size:16px;line-height:1.85;`,
    tableWrapStyle: 'width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:22px 0;border-radius:8px;',
    includeToc: prepared.options.includeToc === true,
    toc: ZHIHU_TOC,
  })

  const bodyMarkdown = htmlToMarkdown(article.html)
  const markdown = [title ? `# ${title}` : '', bodyMarkdown].filter(Boolean).join('\n\n').trim()
  const document = buildHtmlDocument({
    title,
    html: article.html,
    themeColor: ZHIHU_THEME,
    authorName: prepared.authorName || undefined,
    maxWidth: 720,
  })

  const safeTitle = safeFilename(title)
  return {
    platform: 'zhihu',
    title,
    html: article.html,
    markdown,
    text: prepared.plainText,
    previewMode: 'article',
    themeColor: ZHIHU_THEME,
    meta: buildMeta(prepared),
    cards: [],
    assets: prepared.media.assets,
    videos: prepared.media.videos,
    warnings,
    downloads: [
      {
        filename: `${safeTitle}-知乎.html`,
        mimeType: 'text/html;charset=utf-8',
        kind: 'html',
        content: document,
      },
      {
        filename: `${safeTitle}-知乎.md`,
        mimeType: 'text/markdown;charset=utf-8',
        kind: 'markdown',
        content: markdown,
      },
    ],
    generatedAt: prepared.generatedAt,
  }
}
