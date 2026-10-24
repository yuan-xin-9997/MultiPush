import type { CheerioAPI } from 'cheerio'

export function normalizeArticleLists($: CheerioAPI): void {
  for (const node of $('ul,ol').toArray().reverse()) {
    const list = $(node)
    list.contents().filter((_, child) => child.type === 'comment' || child.type === 'text' && !$(child).text().trim()).remove()
    list.children('li').each((_, child) => {
      const item = $(child)
      if (!item.text().replace(/\u200b/g, '').trim() && !item.find('img,video,audio,iframe,svg,table,hr').length) item.remove()
    })
  }
}
