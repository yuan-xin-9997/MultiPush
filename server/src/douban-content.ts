import { load } from 'cheerio'
import { ApiError } from './errors'
import { normalizeArticleLists } from './renderers/article-normalization'
import { normalizeFigureCaptions } from './renderers/figure-captions'

const ALLOWED_ATTRIBUTES = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start', 'lang'])

/**
 * Clean a fragment for the Douban diary editor. Douban has no public write API,
 * so the same HTML is used for preview, export and the browser publish path.
 * Inline platform styles are stripped here and re-applied for the preview.
 */
export function prepareDoubanContent(html: string): string {
  const $ = load(html, null, false)
  $('script,noscript,style,meta,link,iframe,object,embed,form,input,button,video,audio,svg,nav').remove()
  normalizeArticleLists($)
  normalizeFigureCaptions($)
  $('h1').each((_, node) => { node.name = 'h2' })
  $('section,article').each((_, node) => { node.name = 'div' })
  $('img').each((_, node) => {
    const image = $(node)
    image.removeAttr('srcset').removeAttr('sizes').removeAttr('width').removeAttr('height')
    if (!image.attr('alt')) image.attr('alt', '')
  })
  $('a[href]').each((_, node) => {
    const link = $(node)
    const href = link.attr('href') || ''
    if (/^#/.test(href)) return
    try {
      const url = new URL(href, 'https://www.douban.com')
      if (!['http:', 'https:'].includes(url.protocol)) link.removeAttr('href')
      else link.attr('href', url.href).attr('rel', 'nofollow noopener noreferrer')
    } catch { link.removeAttr('href') }
  })
  $('*').each((_, node) => {
    if (!('attribs' in node)) return
    for (const attribute of Object.keys(node.attribs)) {
      if (attribute.startsWith('on') || attribute === 'srcdoc') $(node).removeAttr(attribute)
      else if (!ALLOWED_ATTRIBUTES.has(attribute) && attribute !== 'class') $(node).removeAttr(attribute)
    }
  })
  $('*').removeAttr('class')
  return $.html()
}

export function doubanNoteUrl(remoteId: string): string {
  // The diary editor moved to the topic service in 2026: /note/<id>/ now redirects to /topic/<id>/.
  return `https://www.douban.com/topic/${encodeURIComponent(remoteId)}/`
}

export function parseDoubanNoteId(value: unknown): string | null {
  const text = typeof value === 'string' ? value : ''
  if (!text) return null
  if (/^\d{6,30}$/.test(text.trim())) return text.trim()
  try {
    const url = new URL(text, 'https://www.douban.com')
    if (url.hostname !== 'www.douban.com' && url.hostname !== 'douban.com') return null
    const match = url.pathname.match(/^\/(?:note|topic)\/(\d{6,30})\/?$/)
    return match?.[1] ?? null
  } catch { return null }
}

/** Read back the stored diary; never report success from a request alone. */
export function verifyDoubanContent(expected: string, stored: string): void {
  const before = load(prepareDoubanContent(expected), null, false)
  const after = load(prepareDoubanContent(stored), null, false)
  const text = ($: ReturnType<typeof load>) => $.text().replace(/[\s\u200b]+/g, '')
  const images = ($: ReturnType<typeof load>) => $('img').toArray().map((node) => {
    const src = $(node).attr('src') || ''
    try { return new URL(src, 'https://www.douban.com').pathname } catch { return src }
  })
  const links = ($: ReturnType<typeof load>) => $('a[href]').toArray().map((node) => {
    try { return new URL($(node).attr('href')!, 'https://www.douban.com').href } catch { return $(node).attr('href') || '' }
  }).filter((url) => !url.startsWith('#'))
  const structure = ($: ReturnType<typeof load>) => $('h1,h2,h3,h4,h5,h6,ul,ol').toArray().map((node) => ({
    tag: node.type === 'tag' ? node.name : '',
    text: $(node).is('h1,h2,h3,h4,h5,h6') ? $(node).text().trim() : '',
    start: $(node).attr('start') || '',
    depth: $(node).parents('li').length,
  }))
  const expectedLinks = links(before)
  const storedLinks = links(after)
  if (text(before) !== text(after)
    || images(before).length !== images(after).length
    || expectedLinks.some((url) => !storedLinks.includes(url))
    || JSON.stringify(structure(before)) !== JSON.stringify(structure(after))) {
    throw new ApiError(502, 'douban_content_mismatch', '豆瓣日记保存后的正文与提交内容不一致（文字、图片、链接或标题层级），已停止发布并保留记录，请到豆瓣核实')
  }
}
