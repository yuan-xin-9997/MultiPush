import { load } from 'cheerio'
import { getPlatformInfo } from '../../../shared/types'
import type { PlatformRender } from '../../../shared/types'
import type { RenderInput, RendererContext } from './types'
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

const BILIBILI_THEME = '#00aeec'
const BILIBILI_ARTICLE_TITLE_MAX = 40
const BILIBILI_VIDEO_DESC_MAX = 2000

const BILIBILI_STYLES: Record<string, string> = {
  p: 'font-size:16px;line-height:1.9;color:#18191c;margin:0 0 18px;word-break:break-word;',
  h1: 'font-size:24px;line-height:1.45;color:#18191c;font-weight:700;margin:30px 0 16px;',
  h2: 'font-size:21px;line-height:1.5;color:#18191c;font-weight:700;margin:28px 0 14px;',
  h3: 'font-size:18px;line-height:1.6;color:#18191c;font-weight:600;margin:24px 0 12px;',
  h4: 'font-size:16px;line-height:1.7;color:#18191c;font-weight:600;margin:20px 0 10px;',
  strong: 'font-weight:700;color:#18191c;',
  em: 'font-style:italic;',
  u: 'text-decoration:underline;text-underline-offset:2px;',
  a: 'color:#00aeec;text-decoration:none;border-bottom:1px solid rgba(0,174,236,0.35);word-break:break-all;',
  blockquote:
    'margin:20px 0;padding:14px 16px;background-color:#f2faff;border-left:3px solid #00aeec;border-radius:0 6px 6px 0;color:#4b5563;font-size:15px;line-height:1.85;',
  'blockquote p': 'margin:0;color:inherit;font-size:inherit;line-height:inherit;',
  pre: 'margin:20px 0;padding:16px;background-color:#18191c;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.7;color:#f5f7fa;',
  code: 'font-family:SFMono-Regular,Consolas,Menlo,Monaco,monospace;font-size:14px;background-color:#f2f4f7;color:#d6336c;padding:2px 5px;border-radius:3px;',
  'pre code': 'display:block;background-color:transparent;color:inherit;padding:0;font-size:13px;line-height:1.7;white-space:pre;',
  ul: 'margin:0 0 18px;padding-left:24px;',
  ol: 'margin:0 0 18px;padding-left:24px;',
  'ul[data-mp-task]': 'list-style:none;padding-left:0;',
  'ul[data-mp-task] li': 'list-style:none;',
  li: 'font-size:16px;line-height:1.9;color:#18191c;margin:6px 0;',
  'li p': 'margin:0;font-size:inherit;line-height:inherit;',
  table:
    'width:100%;border-collapse:collapse;font-size:14px;line-height:1.7;min-width:480px;border-spacing:0;',
  th: 'border:1px solid #d9edf7;background-color:#f2faff;padding:10px 12px;text-align:left;font-weight:600;vertical-align:top;',
  td: 'border:1px solid #e5e7eb;padding:10px 12px;text-align:left;vertical-align:top;',
  img: 'display:block;max-width:100%;height:auto;border-radius:8px;margin:20px auto;',
  video: 'display:block;width:100%;border-radius:8px;margin:20px 0;background:#000;',
  'figure img': 'display:block;max-width:100%;height:auto;border-radius:6px;margin:0 auto;',
  figure: 'margin:20px 0;',
  figcaption: 'margin-top:8px;text-align:center;color:#8a8f99;font-size:13px;line-height:1.6;',
  hr: 'border:none;border-top:1px solid #e5e7eb;margin:28px 0;',
}

function tagText(tags: string[], limit = 10): string {
  return tags.slice(0, limit).join(', ')
}

function videoDescription(prepared: ReturnType<typeof prepareContent>): string {
  const body = prepared.plainText.trim()
  if (!body) return ''
  return truncateToChars(body, BILIBILI_VIDEO_DESC_MAX)
}

/**
 * Render a Bilibili deliverable.
 *
 * Video contents become a 16:9 player page plus a publish-ready description and
 * tag list. Image-text contents become a Bilibili column/opus style article.
 */
export async function renderBilibili(input: RenderInput, context?: RendererContext): Promise<PlatformRender> {
  const info = getPlatformInfo('bilibili')
  const prepared = prepareContent(input, context, info)
  const isVideo = input.content.kind === 'video'
  const warnings = buildPlatformWarnings(prepared)
  const tags = tagText(prepared.tags)

  if (isVideo) {
    const title = truncateToChars(prepared.rawTitle, info.limits.titleMax ?? 80)
    const videoUrl = prepared.media.videos[0] ?? ''
    if (!videoUrl) warnings.push('这篇视频内容还没有导出成片；B 站视频投稿需要 MP4 成片，请先在视频工作台导出。')
    if (prepared.tags.length > 10) warnings.push('B 站视频标签建议不超过 10 个，发布时会取前 10 个。')
    const desc = videoDescription(prepared)
    const bodyHtml = [
      videoUrl
        ? `<div style="position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:10px;overflow:hidden;margin:0 0 22px;"><video controls playsinline style="width:100%;height:100%;object-fit:contain;background:#000;" src="${escapeAttribute(videoUrl)}"></video></div>`
        : '<div style="padding:28px;text-align:center;background:#f2f4f7;border-radius:10px;color:#8a8f99;margin-bottom:22px;">尚未导出成片</div>',
      `<h1 style="font-size:24px;line-height:1.45;margin:0 0 14px;color:#18191c;">${escapeHtml(title)}</h1>`,
      desc ? `<p style="font-size:15px;line-height:1.9;color:#4b5563;margin:0 0 18px;white-space:pre-wrap;">${escapeHtml(desc)}</p>` : '',
      tags ? `<p style="font-size:13px;line-height:1.8;color:#00aeec;margin:0;">${escapeHtml(tags)}</p>` : '',
    ].filter(Boolean).join('')
    const html = buildStyledArticle(bodyHtml, {
      styles: BILIBILI_STYLES,
      wrapperStyle: `${ARTICLE_WRAPPER_STYLE}background:#fff;`,
      tableWrapStyle: 'width:100%;overflow-x:auto;margin:20px 0;border-radius:8px;',
    }).html
    const document = buildHtmlDocument({ title, html, themeColor: BILIBILI_THEME, authorName: prepared.authorName || undefined, maxWidth: 960 })
    const text = [title, '', desc, '', tags].filter((part, index) => part !== '' || index === 1).join('\n').trim()
    const filename = safeFilename(title)
    return {
      platform: 'bilibili',
      title,
      html,
      markdown: null,
      text,
      previewMode: 'video',
      themeColor: BILIBILI_THEME,
      meta: buildMeta(prepared),
      cards: [],
      assets: prepared.media.assets,
      videos: prepared.media.videos,
      warnings: Array.from(new Set(warnings)),
      downloads: [
        { filename: `${filename}-B站视频.html`, mimeType: 'text/html;charset=utf-8', kind: 'html', content: document },
        { filename: `${filename}-B站视频-文案.txt`, mimeType: 'text/plain;charset=utf-8', kind: 'text', content: text },
        { filename: `${filename}-B站视频.json`, mimeType: 'application/json;charset=utf-8', kind: 'json', content: JSON.stringify({ title, desc, tags: prepared.tags, video: videoUrl, meta: buildMeta(prepared) }, null, 2) },
      ],
      generatedAt: prepared.generatedAt,
    }
  }

  const requestedTitle = prepared.rawTitle
  const title = truncateToChars(requestedTitle, BILIBILI_ARTICLE_TITLE_MAX)
  if (charLength(requestedTitle) > BILIBILI_ARTICLE_TITLE_MAX) {
    warnings.push(`B 站专栏/opus 标题建议不超过 ${BILIBILI_ARTICLE_TITLE_MAX} 字，已截断。`)
  }
  const body = load(prepared.html, null, false)
  const firstHeading = body('h1').first()
  if (firstHeading.length && firstHeading.text().trim() === requestedTitle.trim()) firstHeading.remove()
  const article = buildStyledArticle(body.html(), {
    styles: BILIBILI_STYLES,
    wrapperStyle: `${ARTICLE_WRAPPER_STYLE}background:#fff;`,
    tableWrapStyle: 'width:100%;overflow-x:auto;margin:20px 0;border-radius:8px;',
    includeToc: prepared.options.includeToc === true,
    toc: {
      containerStyle: 'margin:0 0 24px;padding:14px 18px;background:#f2faff;border:1px solid #d9edf7;border-radius:8px;',
      titleStyle: 'font-size:13px;font-weight:700;color:#00aeec;margin-bottom:7px;',
      linkStyle: 'display:block;padding:2px 0;color:#3d4a5c;font-size:14px;line-height:1.7;text-decoration:none;',
      levelStyles: {
        1: 'display:block;padding:2px 0;color:#18191c;font-size:14px;font-weight:600;line-height:1.7;text-decoration:none;',
        2: 'display:block;padding:2px 0 2px 14px;color:#3d4a5c;font-size:14px;line-height:1.7;text-decoration:none;',
        3: 'display:block;padding:2px 0 2px 28px;color:#6b7788;font-size:13px;line-height:1.7;text-decoration:none;',
      },
    },
  })
  const document = buildHtmlDocument({ title, html: article.html, themeColor: BILIBILI_THEME, authorName: prepared.authorName || undefined, maxWidth: 860 })
  const markdown = `# ${title}\n\n${htmlToMarkdown(article.html)}`.trim()
  const filename = safeFilename(title)
  return {
    platform: 'bilibili',
    title,
    html: article.html,
    markdown,
    text: [title, '', prepared.plainText, tags ? `\n${tags}` : ''].filter(Boolean).join('\n').trim(),
    previewMode: 'article',
    themeColor: BILIBILI_THEME,
    meta: buildMeta(prepared),
    cards: [],
    assets: prepared.media.assets,
    videos: prepared.media.videos,
    warnings: Array.from(new Set(warnings)),
    downloads: [
      { filename: `${filename}-B站图文.html`, mimeType: 'text/html;charset=utf-8', kind: 'html', content: document },
      { filename: `${filename}-B站图文.md`, mimeType: 'text/markdown;charset=utf-8', kind: 'markdown', content: markdown },
      { filename: `${filename}-B站图文-文案.txt`, mimeType: 'text/plain;charset=utf-8', kind: 'text', content: [title, '', prepared.plainText, tags].filter(Boolean).join('\n') },
      { filename: `${filename}-B站图文.json`, mimeType: 'application/json;charset=utf-8', kind: 'json', content: JSON.stringify({ title, html: article.html, tags: prepared.tags, meta: buildMeta(prepared) }, null, 2) },
    ],
    generatedAt: prepared.generatedAt,
  }
}

function charLength(value: string): number {
  return Array.from(value).length
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
}
