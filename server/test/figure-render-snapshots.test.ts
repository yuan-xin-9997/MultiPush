import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import type { ContentDetail } from '../../shared/types'
import { renderPlatforms } from '../src/renderers'

const content: ContentDetail = {
  id: 'figure-snapshot',
  bookId: null,
  bookName: null,
  title: '图注快照',
  excerpt: '',
  coverImage: null,
  tags: [],
  status: 'ready',
  favorite: false,
  wordCount: 30,
  imageCount: 3,
  videoCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  contentJson: { type: 'doc', content: [] },
  contentHtml: [
    '<p>开头正文。</p>',
    '<p><img src="/uploads/one.png" alt="器材"></p><p><em>图：我的器材：）</em></p>',
    '<p>中间正文。</p>',
    '<figure><img src="/uploads/two.png" alt="书房"><figcaption>图 2：书房</figcaption></figure>',
    '<p><img src="/uploads/three.png" alt="机架"></p><p>图:机架与灯</p>',
    '<p>结尾正文。</p>',
  ].join(''),
}

function figureSnapshot(platform: 'wechat' | 'zhihu' | 'blog') {
  return renderPlatforms({
    content,
    platforms: [platform],
    options: {},
    authorName: '作者',
    baseUrl: 'https://example.com',
  }).then(([result]) => {
    const $ = load(result.html)
    const figures = $('figure').toArray().map((node) => {
      const $figure = $(node)
      const $image = $figure.children('img')
      const $caption = $figure.children('figcaption')
      return {
        image: {
          src: $image.attr('src'),
          alt: $image.attr('alt'),
          style: $image.attr('style'),
        },
        caption: {
          text: $caption.text(),
          style: $caption.attr('style'),
        },
        figureStyle: $figure.attr('style'),
      }
    })
    return {
      platform,
      count: figures.length,
      figures,
      captionsInsideParagraphs: $('p figcaption').length,
      paragraphsInsideFigures: $('figure p').length,
    }
  })
}

describe('figure rendering snapshots', () => {
  it.each(['wechat', 'zhihu', 'blog'] as const)('renders %s as figure + figcaption with an 8px gap', async (platform) => {
    const snapshot = await figureSnapshot(platform)
    expect(snapshot.count).toBe(3)
    expect(snapshot.captionsInsideParagraphs).toBe(0)
    expect(snapshot.paragraphsInsideFigures).toBe(0)
    expect(snapshot.figures[0].caption.text).toBe('图：我的器材：）')
    expect(snapshot.figures[1].caption.text).toBe('图 2：书房')
    expect(snapshot.figures[2].caption.text).toBe('图:机架与灯')
    for (const figure of snapshot.figures) {
      expect(figure.image.style).toMatch(/margin:\s*0 auto(?: 0 auto)?/)
      expect(figure.image.style).toMatch(/border-radius:\s*8px/)
      expect(figure.caption.style).toMatch(/margin(?:-top)?:\s*8px/)
      expect(figure.figureStyle).toMatch(/margin:\s*20px 0(?: 20px 0)?/)
    }
    expect(snapshot).toMatchSnapshot()
  })
})
