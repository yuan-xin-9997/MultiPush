import { load } from 'cheerio'
import { ApiError } from './errors'
import { normalizeArticleLists } from './renderers/article-normalization'

export function zhihuImageUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname.endsWith('.zhimg.com') || url.hostname === 'pic-private.zhihu.com') ? url.href : null
  } catch { return null }
}

export function prepareZhihuContent(html: string): string {
  const $ = load(html, null, false)
  $('script,style,meta,link').remove()
  normalizeArticleLists($)
  $('section').each((_, node) => { node.name = 'div' })
  $('img').each((_, node) => {
    const image = $(node)
    image.removeAttr('srcset')
    let figure = image.closest('figure')
    if (!figure.length) {
      const parent = image.parent()
      if (parent.is('p,div') && parent.find('img').length === 1 && !parent.text().trim()) {
        parent.replaceWith($('<figure>').append(parent.contents()))
      } else image.wrap('<figure></figure>')
      figure = image.closest('figure')
    }
    figure.attr({ 'data-draft-node': 'block', 'data-draft-type': 'image' })
    if (figure.find('figcaption').length) return
    let caption = figure.next()
    const spacers = []
    while (caption.is('p,div,br') && !caption.text().replace(/\u200b/g, '').trim() && !caption.find('img,video,audio,table,hr').length) {
      spacers.push(caption)
      caption = caption.next()
    }
    if (!caption.is('p,div') || !/^(?:图\s*[0-9一二三四五六七八九十百]+|fig(?:ure)?\.?\s*\d+)(?:\s|[:：.．、-]|$)/i.test(caption.text().trim())) return
    for (const spacer of spacers) spacer.remove()
    figure.append($('<figcaption>').append(caption.contents()))
    caption.remove()
  })
  $('pre').each((_, node) => {
    const code = $(node).children('code')
    const language = code.attr('class')?.match(/(?:^|\s)language-([\w+-]+)/)?.[1]
    if (language) $(node).attr('lang', language)
  })
  $('table').attr({ 'data-draft-node': 'block', 'data-draft-type': 'table', 'data-size': 'normal', 'data-row-style': 'normal' })
  $('a[href]').each((_, node) => {
    const link = $(node), href = link.attr('href')!
    if (href.startsWith('#')) return
    try {
      const url = new URL(href, 'https://www.zhihu.com')
      if (!['http:', 'https:'].includes(url.protocol)) link.removeAttr('href')
      else link.attr('href', url.href)
    } catch { link.removeAttr('href') }
  })
  $('*').each((_, node) => {
    if (!('attribs' in node)) return
    for (const attr of Object.keys(node.attribs)) {
      if (attr === 'style' || attr === 'class' || attr.startsWith('on') || attr.startsWith('data-') && !attr.startsWith('data-draft-') && !['data-size', 'data-row-style'].includes(attr)) $(node).removeAttr(attr)
    }
  })
  return $.html()
}

function linkTarget(value: string): string {
  try {
    const url = new URL(value)
    return url.hostname === 'link.zhihu.com' ? url.searchParams.get('target') || value : url.href
  } catch { return value }
}

/** Read back the platform's stored HTML; an accepted request alone is not verification. */
export function verifyZhihuContent(expected: string, stored: string): void {
  const before = load(expected, null, false), after = load(stored, null, false)
  const text = ($: ReturnType<typeof load>) => $.text().replace(/[\s\u200b]+/g, '')
  const urls = ($: ReturnType<typeof load>) => $('a[href]').toArray().map(n => linkTarget($(n).attr('href')!)).filter(u => !u.startsWith('#'))
  const links = urls(after)
  const images = after('img').toArray()
  const captions = ($: ReturnType<typeof load>) => $('figcaption').toArray().map(n => $(n).text().trim())
  const code = ($: ReturnType<typeof load>) => $('pre').toArray().map(n => $(n).text())
  const structure = ($: ReturnType<typeof load>) => $('h1,h2,h3,h4,h5,h6,ul,ol').toArray().map(n => ({ tag: n.type === 'tag' ? n.name : '', heading: $(n).is('h1,h2,h3,h4,h5,h6') ? $(n).text() : '', start: $(n).attr('start') || '', depth: $(n).parents('li').length }))
  const emptyItems = after('li').toArray().some(n => !after(n).text().replace(/\u200b/g, '').trim() && !after(n).find('img').length)
  if (text(before) !== text(after) || before('img').length !== images.length
    || images.some(n => !zhihuImageUrl(after(n).attr('src') || after(n).attr('data-original-src')))
    || before('li').length !== after('li').length || emptyItems
    || urls(before).some(url => !links.includes(url))
    || JSON.stringify(captions(before)) !== JSON.stringify(captions(after))
    || JSON.stringify(code(before)) !== JSON.stringify(code(after))
    || JSON.stringify(structure(before)) !== JSON.stringify(structure(after))
    || before('table tr').length !== after('table tr').length
    || before('table th,table td').length !== after('table th,table td').length) {
    throw new ApiError(502, 'zhihu_content_mismatch', '知乎保存后的正文与提交内容不一致（图片、列表、图注、链接或代码），已保留草稿并停止发布，请检查知乎编辑器')
  }
}
