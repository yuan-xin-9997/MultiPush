import { load } from 'cheerio'
import { ApiError } from './errors'
import { normalizeArticleLists } from './renderers/article-normalization'

const IMAGE_HOSTS = ['cdnfile.sspai.com', 'cdn-static.sspai.com']
const ALLOWED_ATTRIBUTES = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start', 'lang'])

export function sspaiImageUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    if (!IMAGE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null
    return url.href
  } catch {
    return null
  }
}

/**
 * Clean an article fragment for the Matrix editor: demote the duplicated page
 * title, normalize lists, wrap images in figures and drop styling that would
 * bypass Sspai's own article typography.
 */
export function prepareSspaiContent(html: string): string {
  const $ = load(html, null, false)
  $('script,noscript,style,meta,link,iframe,object,embed,form,input,button,video,audio,svg,nav').remove()
  normalizeArticleLists($)
  $('h1').each((_, node) => {
    node.name = 'h2'
  })
  $('section,article').each((_, node) => {
    node.name = 'div'
  })
  $('img').each((_, node) => {
    const image = $(node)
    image.removeAttr('srcset').removeAttr('sizes')
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
    if (href.startsWith('#')) return
    try {
      const url = new URL(href, 'https://sspai.com')
      if (!['http:', 'https:'].includes(url.protocol)) link.removeAttr('href')
      else link.attr('href', url.href)
    } catch {
      link.removeAttr('href')
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

/**
 * Sspai's image blocks are stored as figure/image; captions are flattened so
 * the text survives whatever normalization the editor applies.
 */
export function sspaiEditorContent(html: string): string {
  const $ = load(prepareSspaiContent(html), null, false)
  $('figure').each((_, node) => {
    const figure = $(node)
    if (figure.find('img').length !== 1) return
    const caption = figure.find('figcaption').text().trim()
    figure.removeAttr('class')
    if (!caption) return
    figure.after($('<p>').append($('<em>').text(caption)))
    figure.find('figcaption').remove()
  })
  $('*').each((_, node) => {
    if (!('attribs' in node)) return
    for (const attribute of Object.keys(node.attribs)) {
      if (attribute === 'style' || attribute.startsWith('on') || attribute.startsWith('data-')) $(node).removeAttr(attribute)
    }
  })
  $('p').each((_, node) => {
    const paragraph = $(node)
    if (!paragraph.parents('pre,code,td,th,figure').length && !paragraph.text().replace(/[\s\u200b]/g, '') && !paragraph.find('img,video,table,hr').length) paragraph.remove()
  })
  return $.html()
}

function linkTarget(value: string): string {
  try {
    return new URL(value).href
  } catch {
    return value
  }
}

/** Read back the stored article and compare what Sspai actually kept. */
export function verifySspaiContent(expected: string, stored: string): void {
  const before = load(prepareSspaiContent(expected), null, false)
  const after = load(prepareSspaiContent(stored), null, false)
  const text = ($: ReturnType<typeof load>) => $.text().replace(/[\s\u200b]+/g, '')
  const links = ($: ReturnType<typeof load>) => $('a[href]').toArray().map((node) => linkTarget($(node).attr('href')!)).filter((url) => !url.startsWith('#'))
  const images = ($: ReturnType<typeof load>) => $('img').toArray().map((node) => {
    const src = $(node).attr('src') || $(node).attr('data-original') || ''
    try { return new URL(src, 'https://sspai.com').pathname } catch { return src }
  })
  const structure = ($: ReturnType<typeof load>) => $('h1,h2,h3,h4,h5,h6,ul,ol').toArray().map((node) => ({
    tag: node.type === 'tag' ? node.name : '',
    heading: $(node).is('h1,h2,h3,h4,h5,h6') ? $(node).text().trim() : '',
    start: $(node).attr('start') || '',
    depth: $(node).parents('li').length,
  }))
  const code = ($: ReturnType<typeof load>) => $('pre').toArray().map((node) => $(node).text())
  const storedImages = images(after)
  const expectedLinks = links(before)
  const storedLinks = links(after)
  if (text(before) !== text(after)
    || JSON.stringify(images(before)) !== JSON.stringify(storedImages)
    || storedImages.some((src) => !src)
    || before('li').length !== after('li').length
    || expectedLinks.some((url) => !storedLinks.includes(url))
    || JSON.stringify(code(before)) !== JSON.stringify(code(after))
    || JSON.stringify(structure(before)) !== JSON.stringify(structure(after))
    || before('table tr').length !== after('table tr').length
    || before('table th,table td').length !== after('table th,table td').length) {
    throw new ApiError(502, 'sspai_content_mismatch', '少数派保存后的正文与提交内容不一致（图片、列表、图注、链接或代码），已保留草稿并停止发布，请检查少数派编辑器')
  }
}
