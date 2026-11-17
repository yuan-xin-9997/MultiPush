import { marked } from 'marked'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import JSZip from 'jszip'
import type { ContentDetail, ContentInput, RichTextJson } from '@shared/types'
import { isFigureCaptionText } from '@shared/figure-caption'
import { downloadBlob, downloadText, safeFilename } from '@/lib/utils'

export type ExportFormat = 'markdown' | 'html' | 'json'

export const IMPORT_ACCEPT = '.md,.markdown,.html,.htm,.txt,.json'
export const IMPORT_MAX_FILES = 30
export const IMPORT_MAX_SIZE = 5 * 1024 * 1024

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
})
turndown.use(gfm)

marked.setOptions({ gfm: true, breaks: false })

const BLOCKED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM'])

function sanitizeImportedHtml(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const visit = (element: Element) => {
    for (const child of Array.from(element.children)) {
      if (BLOCKED_TAGS.has(child.tagName)) {
        child.remove()
        continue
      }
      for (const attribute of Array.from(child.attributes)) {
        const name = attribute.name.toLowerCase()
        if (name.startsWith('on')) child.removeAttribute(attribute.name)
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attribute.value)) {
          child.removeAttribute(attribute.name)
        }
        if (name === 'srcdoc') child.removeAttribute(attribute.name)
      }
      visit(child)
    }
  }
  visit(document.body)
  return document.body.innerHTML
}

export function htmlToPlainText(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return (document.body.textContent || '').replace(/\s+/g, ' ').trim()
}

function filenameTitle(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || '导入文档'
}

function isBlankImportSpacer(element: Element): boolean {
  if (element.tagName === 'BR') return true
  if (!['P', 'DIV', 'SECTION'].includes(element.tagName)) return false
  if ((element.textContent || '').replace(/[\u200b\u200c\u200d\ufeff\s]/g, '').length > 0) return false
  return !element.querySelector('img,video,audio,iframe,svg,table,hr,figure')
}

function isCaptionElement(element: Element): boolean {
  if (element.tagName !== 'P' && element.tagName !== 'DIV') return false
  if (element.querySelector('img,video,audio,iframe,svg,table,hr,figure')) return false
  return isFigureCaptionText(element.textContent || '')
}

function previousBlockHasImage(block: Element): boolean {
  let previous = block.previousElementSibling
  while (previous && isBlankImportSpacer(previous)) previous = previous.previousElementSibling
  if (!previous) return false
  if (previous.tagName === 'IMG') return true
  if (!['P', 'DIV', 'SECTION'].includes(previous.tagName)) return false
  return Boolean(previous.querySelector('img'))
    && (previous.textContent || '').replace(/[\u200b\u200c\u200d\ufeff\s]/g, '').length === 0
}

function appendCaptionContent(figcaption: HTMLElement, caption: Element): void {
  const children = Array.from(caption.childNodes).filter(
    (child) => child.nodeType !== Node.TEXT_NODE || Boolean(child.textContent?.trim()),
  )
  const only = children.length === 1 && children[0].nodeType === Node.ELEMENT_NODE
    && ['EM', 'I'].includes((children[0] as Element).tagName)
  if (only) {
    for (const child of Array.from(children[0].childNodes)) figcaption.appendChild(child)
  } else {
    for (const child of Array.from(caption.childNodes)) figcaption.appendChild(child)
  }
}

/**
 * Merge one image block followed by one `图：…` paragraph into figure/figcaption.
 * Runs after Markdown/HTML import and before the editor parses the fragment, so
 * both contentHtml and contentJson are created from the same canonical shape.
 *
 * Only adjacent nodes are considered; multiple images, non-caption paragraphs
 * and orphan captions are left exactly as they were.
 */
export function groupImageCaptions(html: string): string {
  if (!html || !/<img\b/i.test(html)) return html
  const document = new DOMParser().parseFromString(html, 'text/html')
  const root = document.body

  for (const image of Array.from(root.querySelectorAll('img'))) {
    if (image.closest('figure')) continue
    const parent = image.parentElement
    let block: Element = image
    if (
      parent
      && ['P', 'DIV', 'SECTION'].includes(parent.tagName)
      && parent.querySelectorAll('img').length === 1
      && (parent.textContent || '').replace(/[\u200b\u200c\u200d\ufeff\s]/g, '').length === 0
      && !parent.querySelector('video,audio,iframe,svg,table,hr,figure')
    ) {
      block = parent
    }

    // Two images sharing one caption are intentionally left untouched.
    if (previousBlockHasImage(block)) continue
    let next: Element | null = block.nextElementSibling
    const spacers: Element[] = []
    while (next && isBlankImportSpacer(next)) {
      spacers.push(next)
      next = next.nextElementSibling
    }
    if (!next || !isCaptionElement(next)) continue

    const caption = next
    // Drop formatting-only whitespace between the two blocks; it would leave a
    // stray newline next to the figure after the source paragraphs disappear.
    let sibling = block.nextSibling
    while (sibling && sibling !== caption) {
      const following = sibling.nextSibling
      if (sibling.nodeType === Node.TEXT_NODE && !sibling.textContent?.trim()) sibling.remove()
      sibling = following
    }
    const figure = document.createElement('figure')
    if (block === image) {
      image.replaceWith(figure)
      figure.appendChild(image)
    } else {
      block.replaceWith(figure)
      figure.appendChild(image)
    }
    const figcaption = document.createElement('figcaption')
    appendCaptionContent(figcaption, caption)
    figure.appendChild(figcaption)
    for (const spacer of spacers) spacer.remove()
    caption.remove()
  }

  return root.innerHTML
}

function stripLeadingDuplicateTitle(html: string, title: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const firstHeading = document.body.querySelector('h1')
  if (firstHeading && firstHeading.textContent?.trim() === title.trim()) firstHeading.remove()
  return document.body.innerHTML
}

function isRichTextJson(value: unknown): value is RichTextJson {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeJsonDoc(value: unknown): ContentInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const rawHtml = typeof item.contentHtml === 'string' ? item.contentHtml : ''
  const contentJson = isRichTextJson(item.contentJson) ? item.contentJson : { type: 'doc', content: [] }
  const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '导入文档'
  const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : []
  const coverImage = typeof item.coverImage === 'string' && item.coverImage ? item.coverImage : null
  if (!rawHtml && !isRichTextJson(item.contentJson)) return null
  return {
    title,
    contentHtml: groupImageCaptions(sanitizeImportedHtml(rawHtml)),
    contentJson,
    excerpt: typeof item.excerpt === 'string' ? item.excerpt : htmlToPlainText(rawHtml).slice(0, 160),
    tags,
    coverImage,
    status: item.status === 'ready' ? 'ready' : 'draft',
  }
}

export async function parseImportFile(file: File): Promise<ContentInput[]> {
  if (file.size > IMPORT_MAX_SIZE) {
    throw new Error(`「${file.name}」超过 5 MB，已跳过`)
  }
  const extension = file.name.split('.').pop()?.toLowerCase() || ''
  const title = filenameTitle(file.name)

  if (extension === 'json') {
    const text = await file.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`「${file.name}」不是合法的 JSON 文件`)
    }
    const wrapper = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    const candidates = Array.isArray(parsed)
      ? parsed
      : wrapper && wrapper.format === 'multipush-content' && wrapper.content && typeof wrapper.content === 'object'
        ? [wrapper.content]
        : wrapper && Array.isArray(wrapper.contents)
          ? wrapper.contents
          : [parsed]
    const docs = candidates.map(normalizeJsonDoc).filter((doc): doc is ContentInput => Boolean(doc))
    if (!docs.length) throw new Error(`「${file.name}」不包含可导入的 MultiPush 文档`)
    return docs
  }

  if (extension === 'html' || extension === 'htm') {
    const text = await file.text()
    const source = new DOMParser().parseFromString(text, 'text/html')
    const pageTitle = source.querySelector('title')?.textContent?.trim()
    const heading = source.querySelector('h1')?.textContent?.trim()
    const resolvedTitle = pageTitle || heading || title
    const cleaned = groupImageCaptions(sanitizeImportedHtml(source.body.innerHTML))
    const html = stripLeadingDuplicateTitle(cleaned, resolvedTitle)
    return [
      {
        title: resolvedTitle,
        contentHtml: html,
        contentJson: { type: 'doc', content: [] },
        excerpt: htmlToPlainText(html).slice(0, 160),
        tags: [],
      },
    ]
  }

  if (extension === 'md' || extension === 'markdown' || extension === 'txt') {
    const text = await file.text()
    const source = extension === 'txt'
      ? text
          .split(/\r?\n\s*\r?\n/)
          .map((paragraph) => `<p>${paragraph.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>')}</p>`)
          .join('\n')
      : String(await marked.parse(text))
    const cleaned = groupImageCaptions(sanitizeImportedHtml(source))
    const heading = new DOMParser().parseFromString(cleaned, 'text/html').querySelector('h1')?.textContent?.trim()
    const resolvedTitle = heading || title
    const html = stripLeadingDuplicateTitle(cleaned, resolvedTitle)
    return [
      {
        title: resolvedTitle,
        contentHtml: html,
        contentJson: { type: 'doc', content: [] },
        excerpt: htmlToPlainText(html).slice(0, 160),
        tags: [],
      },
    ]
  }

  throw new Error(`不支持的文件类型：${file.name}`)
}

function absolutizeMediaUrls(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const origin = window.location.origin
  for (const element of Array.from(document.body.querySelectorAll('[src], [href]'))) {
    for (const attribute of ['src', 'href'] as const) {
      const value = element.getAttribute(attribute)
      if (value && value.startsWith('/') && !value.startsWith('//')) {
        element.setAttribute(attribute, `${origin}${value}`)
      }
    }
  }
  return document.body.innerHTML
}

export function contentToMarkdown(content: Pick<ContentDetail, 'title' | 'contentHtml'>): string {
  const body = turndown.turndown(absolutizeMediaUrls(content.contentHtml || ''))
  const heading = `# ${content.title || '无标题文档'}`
  if (!body.trim()) return `${heading}\n`
  if (/^#\s/.test(body.trim())) return body
  return `${heading}\n\n${body.trim()}\n`
}

export function contentToStandaloneHtml(content: Pick<ContentDetail, 'title' | 'contentHtml'>): string {
  const title = content.title || '无标题文档'
  const bodyHtml = absolutizeMediaUrls(content.contentHtml || '')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f5f6f7; color: #1f2329; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  article { max-width: 760px; margin: 40px auto; padding: 48px 56px; background: #fff; border-radius: 12px; box-shadow: 0 8px 40px rgba(31,35,41,.08); }
  h1 { font-size: 30px; line-height: 1.35; margin: 0 0 28px; }
  h2 { font-size: 22px; margin: 36px 0 14px; }
  h3 { font-size: 18px; margin: 28px 0 12px; }
  p, li { font-size: 16px; line-height: 1.85; }
  img, video { max-width: 100%; border-radius: 8px; }
  blockquote { margin: 20px 0; padding: 12px 18px; border-left: 3px solid #00b96b; background: #f2fbf7; color: #4e5969; }
  pre { padding: 16px; border-radius: 8px; background: #1f2329; color: #f5f6f7; overflow: auto; }
  code { font-family: "SFMono-Regular", Consolas, monospace; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 9px 12px; border: 1px solid #e5e6eb; }
  @media (max-width: 720px) { article { margin: 0; padding: 28px 20px; border-radius: 0; } }
</style>
</head>
<body>
<article>
<h1>${escapeText(title)}</h1>
${bodyHtml}
</article>
</body>
</html>`
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function contentToJson(content: ContentDetail): string {
  return JSON.stringify(
    {
      format: 'multipush-content',
      version: 1,
      exportedAt: new Date().toISOString(),
      content,
    },
    null,
    2,
  )
}

export function exportContentFile(content: ContentDetail, format: ExportFormat): void {
  const base = safeFilename(content.title || 'multipush-content')
  if (format === 'markdown') {
    downloadText(`${base}.md`, contentToMarkdown(content), 'text/markdown;charset=utf-8')
    return
  }
  if (format === 'html') {
    downloadText(`${base}.html`, contentToStandaloneHtml(content), 'text/html;charset=utf-8')
    return
  }
  downloadText(`${base}.multipush.json`, contentToJson(content), 'application/json;charset=utf-8')
}

export async function exportContentsZip(contents: ContentDetail[], format: ExportFormat): Promise<void> {
  const zip = new JSZip()
  const used = new Set<string>()
  for (const content of contents) {
    const base = safeFilename(content.title || 'untitled')
    let filename = base
    let index = 2
    while (used.has(filename)) filename = `${base}-${index++}`
    used.add(filename)
    if (format === 'markdown') zip.file(`${filename}.md`, contentToMarkdown(content))
    else if (format === 'html') zip.file(`${filename}.html`, contentToStandaloneHtml(content))
    else zip.file(`${filename}.multipush.json`, contentToJson(content))
  }
  zip.file(
    'README.txt',
    `MultiPush 内容导出\n导出时间：${new Date().toLocaleString('zh-CN')}\n文档数量：${contents.length}\n格式：${format}\n`,
  )
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  downloadBlob(`multipush-export-${new Date().toISOString().slice(0, 10)}.zip`, blob)
}
