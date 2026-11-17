import { createHash } from 'node:crypto'

type JsonObject = Record<string, unknown>

export function contentHtmlHash(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex')
}

export function jsonHasContent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const content = (value as JsonObject).content
  return Array.isArray(content) && content.length > 0
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : ''
  if (!url) return ''
  if (/^(?:https?:|mailto:|tel:|data:image\/)/i.test(url) || url.startsWith('/') || url.startsWith('#')) return url
  return ''
}

function attrs(values: Record<string, string>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('')
}

function markHtml(text: string, mark: JsonObject): string {
  const type = typeof mark.type === 'string' ? mark.type : ''
  const attributes = mark.attrs && typeof mark.attrs === 'object' ? mark.attrs as JsonObject : {}
  switch (type) {
    case 'bold':
    case 'strong':
      return `<strong>${text}</strong>`
    case 'italic':
    case 'em':
      return `<em>${text}</em>`
    case 'strike':
      return `<s>${text}</s>`
    case 'underline':
      return `<u>${text}</u>`
    case 'code':
      return `<code>${text}</code>`
    case 'link': {
      const href = safeUrl(attributes.href)
      if (!href) return text
      const title = typeof attributes.title === 'string' ? attributes.title : ''
      return `<a${attrs({ href, title })}>${text}</a>`
    }
    case 'textStyle': {
      const color = typeof attributes.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(attributes.color) ? attributes.color : ''
      return color ? `<span${attrs({ style: `color:${color}` })}>${text}</span>` : text
    }
    case 'highlight': {
      const color = typeof attributes.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(attributes.color) ? attributes.color : ''
      return `<mark${attrs({ style: color ? `background-color:${color}` : '' })}>${text}</mark>`
    }
    case 'subscript':
      return `<sub>${text}</sub>`
    case 'superscript':
      return `<sup>${text}</sup>`
    default:
      return text
  }
}

function blockStyle(attributes: JsonObject): string {
  const align = typeof attributes.textAlign === 'string' ? attributes.textAlign : ''
  return ['left', 'right', 'center', 'justify'].includes(align) ? `text-align:${align}` : ''
}

function inlineHtml(nodes: unknown): string {
  if (!Array.isArray(nodes)) return ''
  let result = ''
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue
    const node = raw as JsonObject
    if (node.type === 'text') {
      let text = escapeHtml(typeof node.text === 'string' ? node.text : '')
      const marks = Array.isArray(node.marks) ? node.marks as JsonObject[] : []
      for (const mark of marks) text = markHtml(text, mark)
      result += text
      continue
    }
    if (node.type === 'hardBreak') {
      result += '<br>'
      continue
    }
    if (node.type === 'image') {
      const attributes = node.attrs && typeof node.attrs === 'object' ? node.attrs as JsonObject : {}
      const src = safeUrl(attributes.src)
      if (!src) continue
      result += `<img${attrs({
        src,
        alt: typeof attributes.alt === 'string' ? attributes.alt : '',
        title: typeof attributes.title === 'string' ? attributes.title : '',
      })}>`
      continue
    }
    result += inlineHtml(node.content)
  }
  return result
}

function nodeHtml(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const node = raw as JsonObject
  const type = typeof node.type === 'string' ? node.type : ''
  const attributes = node.attrs && typeof node.attrs === 'object' ? node.attrs as JsonObject : {}
  const content = node.content

  switch (type) {
    case 'doc':
      return blockHtml(content)
    case 'paragraph': {
      const style = blockStyle(attributes)
      return `<p${style ? attrs({ style }) : ''}>${inlineHtml(content)}</p>`
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attributes.level) || 1))
      const style = blockStyle(attributes)
      return `<h${level}${style ? attrs({ style }) : ''}>${inlineHtml(content)}</h${level}>`
    }
    case 'blockquote':
      return `<blockquote>${blockHtml(content)}</blockquote>`
    case 'bulletList':
      return `<ul>${blockHtml(content)}</ul>`
    case 'orderedList': {
      const start = Number(attributes.start)
      return `<ol${Number.isFinite(start) && start > 1 ? attrs({ start: String(start) }) : ''}>${blockHtml(content)}</ol>`
    }
    case 'listItem':
      return `<li>${blockHtml(content)}</li>`
    case 'taskList':
      return `<ul data-type="taskList">${blockHtml(content)}</ul>`
    case 'taskItem': {
      const checked = attributes.checked === true ? 'true' : 'false'
      return `<li data-type="taskItem" data-checked="${checked}">${blockHtml(content)}</li>`
    }
    case 'codeBlock': {
      const language = typeof attributes.language === 'string' && /^[\w+#.-]{1,32}$/.test(attributes.language) ? attributes.language : ''
      return `<pre><code${language ? ` class="language-${language}"` : ''}>${escapeHtml(textContent(content))}</code></pre>`
    }
    case 'horizontalRule':
      return '<hr>'
    case 'hardBreak':
      return '<br>'
    case 'image': {
      const src = safeUrl(attributes.src)
      if (!src) return ''
      return `<img${attrs({
        src,
        alt: typeof attributes.alt === 'string' ? attributes.alt : '',
        title: typeof attributes.title === 'string' ? attributes.title : '',
      })}>`
    }
    case 'video': {
      const src = safeUrl(attributes.src)
      if (!src) return ''
      return `<video${attrs({ src, poster: safeUrl(attributes.poster), controls: 'controls' })}></video>`
    }
    case 'figure': {
      const children = Array.isArray(content) ? content : []
      const image = children.find((child) => (child as JsonObject)?.type === 'image')
      const caption = children.find((child) => (child as JsonObject)?.type === 'figcaption')
      if (!image) return ''
      return `<figure>${nodeHtml(image)}${caption ? nodeHtml(caption) : ''}</figure>`
    }
    case 'figcaption':
      return `<figcaption>${inlineHtml(content)}</figcaption>`
    case 'table':
      return `<table><tbody>${blockHtml(content)}</tbody></table>`
    case 'tableRow':
      return `<tr>${blockHtml(content)}</tr>`
    case 'tableHeader':
      return `<th>${blockHtml(content)}</th>`
    case 'tableCell':
      return `<td>${blockHtml(content)}</td>`
    case 'text':
      return escapeHtml(typeof node.text === 'string' ? node.text : '')
    default:
      return blockHtml(content)
  }
}

function blockHtml(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map(nodeHtml).join('')
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let result = ''
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const node = raw as JsonObject
    if (typeof node.text === 'string') result += node.text
    else if (node.type === 'hardBreak') result += '\n'
    else result += textContent(node.content)
  }
  return result
}

/**
 * Minimal Tiptap JSON → HTML serializer for API clients that PATCH only
 * `contentJson`. The editor sends both representations; this fallback keeps
 * `contentHtml` (used by all renderers) from going stale for JSON-only writes.
 */
export function tiptapJsonToHtml(value: unknown): string {
  return nodeHtml(value)
}
