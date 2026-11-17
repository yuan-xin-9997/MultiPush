import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import { ApiError } from './errors'
import { normalizeArticleLists } from './renderers/article-normalization'
import { normalizeFigureCaptions } from './renderers/figure-captions'

const ALLOWED_ATTRIBUTES = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start', 'lang', 'loading'])

/**
 * Clean a post fragment for Halo. Halo renders the article inside its theme, so
 * inline styles, editor classes and duplicated page-level headings are removed.
 */
export function prepareBlogContent(html: string): string {
  const $ = load(html, null, false)
  $('script,noscript,style,meta,link,iframe,object,embed,form,input,button,video,audio,svg,nav').remove()
  normalizeArticleLists($)
  normalizeFigureCaptions($)
  $('h1').each((_, node) => {
    node.name = 'h2'
  })
  $('section,article').each((_, node) => {
    node.name = 'div'
  })
  $('img').each((_, node) => {
    const image = $(node)
    image.removeAttr('srcset').removeAttr('sizes').removeAttr('width').removeAttr('height')
    image.attr('loading', 'lazy')
    if (!image.closest('figure').length) {
      const parent = image.parent()
      if (parent.is('p,div') && parent.find('img').length === 1 && !parent.text().trim()) {
        parent.replaceWith($('<figure class="image">').append(parent.contents()))
      } else {
        image.wrap('<figure class="image"></figure>')
      }
    }
  })
  $('pre').each((_, node) => {
    const code = $(node).children('code')
    const language = code.attr('class')?.match(/(?:^|\s)language-([\w+-]+)/)?.[1]
    if (language) $(node).attr('lang', language)
  })
  $('a[href]').each((_, node) => {
    const link = $(node)
    const href = link.attr('href') || ''
    if (href.startsWith('#') || href.startsWith('/')) return
    try {
      const url = new URL(href)
      if (!['http:', 'https:'].includes(url.protocol)) link.removeAttr('href')
      else link.attr('href', url.href)
    } catch {
      // Keep relative article links; the Halo theme resolves them.
    }
  })
  $('*').each((_, node) => {
    if (!('attribs' in node)) return
    for (const attribute of Object.keys(node.attribs)) {
      if (!ALLOWED_ATTRIBUTES.has(attribute) && attribute !== 'class') $(node).removeAttr(attribute)
    }
  })
  return $.html()
}

/** Halo's editor keeps semantic HTML; only remove the redundant wrapper bits. */
export function blogEditorContent(html: string): string {
  const $ = load(prepareBlogContent(html), null, false)
  $('figure').removeAttr('class')
  $('*').each((_, node) => {
    if (!('attribs' in node)) return
    for (const attribute of Object.keys(node.attribs)) {
      if (attribute === 'style' || attribute === 'class' || attribute.startsWith('on') || attribute.startsWith('data-')) $(node).removeAttr(attribute)
    }
  })
  $('p').each((_, node) => {
    const paragraph = $(node)
    if (!paragraph.parents('pre,code,td,th,figure').length && !paragraph.text().replace(/[\s\u200b]/g, '') && !paragraph.find('img,table,hr').length) paragraph.remove()
  })
  return $.html()
}

export function blogImagePath(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, `${baseUrl.replace(/\/+$/, '')}/`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (!/^\/upload\//.test(url.pathname)) return null
    return url.pathname
  } catch {
    return null
  }
}

export function blogAbsoluteUrl(baseUrl: string, value: string): string {
  if (/^https?:\/\//i.test(value)) return value
  return `${baseUrl.replace(/\/+$/, '')}${value.startsWith('/') ? '' : '/'}${value}`
}

/** Generate a stable, readable-enough Halo slug for a Chinese or English title. */
export function blogSlug(title: string, seed: string): string {
  const ascii = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const hash = createHash('sha1').update(`${title}\u0000${seed}\u0000${Date.now()}`).digest('hex').slice(0, 6)
  return `${ascii || 'multipush'}-${date}-${hash}`
}

/**
 * Read back the content Halo actually stored. Halo preserves the submitted HTML
 * for HTML editor content, so image paths, text and block structure must match.
 */
export function verifyBlogContent(expected: string, stored: string): void {
  const before = load(prepareBlogContent(expected), null, false)
  const after = load(prepareBlogContent(stored), null, false)
  const text = ($: ReturnType<typeof load>) => $.text().replace(/[\s\u200b]+/g, '')
  const images = ($: ReturnType<typeof load>) => $('img').toArray().map((node) => {
    const src = $(node).attr('src') || ''
    try { return new URL(src, 'https://blog.invalid').pathname } catch { return src }
  })
  const links = ($: ReturnType<typeof load>) => $('a[href]').toArray().map((node) => {
    try { return new URL($(node).attr('href')!, 'https://blog.invalid').href } catch { return $(node).attr('href') || '' }
  }).filter((url) => !url.startsWith('#'))
  const structure = ($: ReturnType<typeof load>) => $('h1,h2,h3,h4,h5,h6,ul,ol').toArray().map((node) => ({
    tag: node.type === 'tag' ? node.name : '',
    heading: $(node).is('h1,h2,h3,h4,h5,h6') ? $(node).text().trim() : '',
    start: $(node).attr('start') || '',
    depth: $(node).parents('li').length,
  }))
  const code = ($: ReturnType<typeof load>) => $('pre').toArray().map((node) => $(node).text())
  const expectedLinks = links(before), storedLinks = links(after)
  if (text(before) !== text(after)
    || JSON.stringify(images(before)) !== JSON.stringify(images(after))
    || before('li').length !== after('li').length
    || expectedLinks.some((url) => !storedLinks.includes(url))
    || JSON.stringify(code(before)) !== JSON.stringify(code(after))
    || JSON.stringify(structure(before)) !== JSON.stringify(structure(after))
    || before('table tr').length !== after('table tr').length
    || before('table th,table td').length !== after('table th,table td').length) {
    throw new ApiError(502, 'blog_content_mismatch', '个人博客保存后的正文与提交内容不一致（图片、列表、链接或代码），已保留草稿并停止发布，请检查 Halo 编辑器')
  }
}
