import { load } from 'cheerio'

/**
 * Editors such as Bilibili's Tiptap turn pretty-printed HTML whitespace into
 * empty paragraphs. Remove whitespace-only text nodes between block elements
 * while preserving meaningful inline spaces and whitespace inside <pre>/<code>.
 */
export function compactEditorHtml(html: string): string {
  if (!html.trim()) return ''
  const $ = load(`<div data-mp-compact-root="1">${html}</div>`, null, false)
  const root = $('[data-mp-compact-root="1"]').first()
  const blockParents = new Set(['div', 'section', 'article', 'main', 'body', 'figure'])

  root.find('*').addBack().contents().each((_, node) => {
    if (node.type !== 'text') return
    if (((node as { data?: string }).data ?? '').trim()) return
    const parent = (node as { parent?: { tagName?: string } }).parent
    const tag = (parent?.tagName ?? '').toLowerCase()
    if (blockParents.has(tag)) $(node).remove()
  })

  // Empty paragraphs with only a <br> or whitespace become visible gaps.
  root.find('p').each((_, element) => {
    const $element = $(element)
    if ($element.text().trim()) return
    if ($element.find('img, video, source, table, figure').length > 0) return
    $element.remove()
  })

  return root.html()?.trim() ?? ''
}
