import { describe, expect, it, vi } from 'vitest'
import { createCardId, fitCardBody, selectXhsPublishCards, getCaptionBody, parsePreferences, publishChecks } from '../../shared/render-workbench'
import { renderPlatforms } from '../src/renderers'
import { adjustPlatformRender } from '../src/render-adjustment'
import { platformAdjustmentSchema } from '../src/validation'
import type { ContentDetail } from '../../shared/types'

const source = {
  id: 'source', title: '原文标题', contentHtml: '<h2>段落</h2><p>这是<strong>正文</strong>。</p><img src="/uploads/a.png">',
  contentJson: {}, tags: ['原话题'], updatedAt: '2026-10-22T01:00:00Z',
} as ContentDetail
const input = { content: source, options: { authorName: '作者设置' }, authorName: '账号名', baseUrl: 'https://example.com' }

describe('render workbench', () => {
  it('creates card IDs on HTTP origins where randomUUID is unavailable', () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    vi.stubGlobal('crypto', { getRandomValues })
    try {
      const ids = new Set(Array.from({ length: 50 }, createCardId))
      expect(ids.size).toBe(50)
      expect([...ids].every((id) => /^[0-9a-f]{32}$/.test(id))).toBe(true)
    } finally { vi.unstubAllGlobals() }
  })
  it('splits by measured paragraph height and preserves every character, including emoji', () => {
    const body = ['甲乙🙂丙丁戊己庚辛壬', '第二段没有丢失']
    const pages = fitCardBody(body, (paragraphs) => paragraphs.reduce((n, paragraph) => n + Array.from(paragraph).length + 1, 0) <= 8)
    expect(pages.flat().join('')).toBe(body.join(''))
    expect(pages.every((paragraphs) => paragraphs.reduce((n, paragraph) => n + Array.from(paragraph).length + 1, 0) <= 8)).toBe(true)
    expect(pages.length).toBeGreaterThan(2)
    expect(() => fitCardBody(['a'], () => false)).toThrow('可用空间不足')
  })

  it('selects at most 18 ordered excerpt cards without changing originals, retaining the opening and ending', () => {
    const cards = Array.from({ length: 22 }, (_, index) => ({ id: `card-${index}`, type: 'content' as const, index: index + 1, total: 22, title: `标题 ${index}`, body: [`原文 ${index}🙂`], images: [`image-${index}.png`], footer: '作者' }))
    const before = JSON.stringify(cards)
    const selected = selectXhsPublishCards(cards)
    expect(selected).toHaveLength(18)
    expect(selected[0].id).toBe(cards[0].id)
    expect(selected.at(-1)!.id).toBe(cards.at(-1)!.id)
    expect(new Set(selected.map(card => card.id)).size).toBe(18)
    expect(selected.map(card => cards.findIndex(source => source.id === card.id))).toEqual(selected.map(card => cards.findIndex(source => source.id === card.id)).sort((a, b) => a - b))
    expect(selected.every((card, i) => card.index === i + 1 && card.total === 18)).toBe(true)
    expect(selected.every(card => card.body === cards.find(source => source.id === card.id)!.body && card.images === cards.find(source => source.id === card.id)!.images)).toBe(true)
    expect(JSON.stringify(cards)).toBe(before)
    for (const size of [0, 1, 18]) expect(selectXhsPublishCards(cards.slice(0, size))).toEqual(cards.slice(0, size))
    const many = selectXhsPublishCards(Array.from({ length: 1000 }, (_, i) => ({ ...cards[0], id: String(i) })))
    expect(many).toHaveLength(18)
    expect(many.at(-1)!.id).toBe('999')
  })

  it('validates stored account preferences and removes invalid platforms', () => {
    expect(parsePreferences({ platforms: ['unknown'] })).toBeNull()
    expect(parsePreferences({ platforms: ['zhihu', 'zhihu', 'unknown'], options: { cardStyle: 'invalid', authorName: '昵称', includeTags: false } }))
      .toEqual({ platforms: ['zhihu'], options: { cardStyle: 'clean', authorName: '昵称', includeTags: false, includeToc: false } })
  })

  it('records source version and honors the requested author', async () => {
    const [render] = await renderPlatforms({ ...input, platforms: ['wechat'] })
    expect(render.sourceUpdatedAt).toBe(source.updatedAt)
    expect(render.authorName).toBe('作者设置')
    expect(render.downloads[0].content).toContain('作者设置')
    expect(publishChecks(render, true).find((check) => check.label === '原文与设置版本')?.ok).toBe(false)
  })

  it('omits disabled hashtags from both captions and rendered card metadata', async () => {
    const results = await renderPlatforms({ ...input, options: { includeTags: false }, platforms: ['xiaohongshu', 'douyin'] })
    for (const result of results) {
      expect(result.meta.tags).toEqual([])
      expect(result.text).not.toContain('#原话题')
      expect(JSON.parse(result.downloads.find((file) => file.kind === 'json')!.content).tags).toEqual([])
    }
  })

  it('replaces obsolete draft-only image assets after another card adjustment', async () => {
    const [original] = await renderPlatforms({ ...input, platforms: ['xiaohongshu'] })
    const first = await adjustPlatformRender(original, { title: original.title, tags: [], cards: original.cards.map((card, i) => i === 0 ? { ...card, images: ['https://example.com/obsolete.png'] } : card) }, {}, input.baseUrl, original)
    const next = await adjustPlatformRender(first, { title: original.title, tags: [], cards: original.cards }, {}, input.baseUrl, original)
    expect(next.assets.some((asset) => asset.url.includes('obsolete'))).toBe(false)
    expect(next.meta.imageCount).toBe(original.meta.imageCount)
  })

  it('keeps adjusted caption, title, tags, cards, downloads and snapshot consistent', async () => {
    const [render] = await renderPlatforms({ ...input, platforms: ['xiaohongshu'] })
    const result = await adjustPlatformRender(render, { title: '专属标题', body: '独立正文', tags: ['新话题'], cards: render.cards.slice().reverse() }, input.options, input.baseUrl)
    expect(result.text).toBe('专属标题\n\n独立正文\n\n#新话题')
    expect(getCaptionBody(result)).toBe('独立正文')
    expect(result.cards.every((card, i) => card.index === i + 1 && card.total === result.cards.length)).toBe(true)
    expect(result.downloads.find((file) => file.kind === 'text')?.content).toBe(result.text)
    expect(JSON.parse(result.downloads.find((file) => file.kind === 'json')!.content).cards).toEqual(result.cards)
    expect(result.sourceUpdatedAt).toBe(source.updatedAt)
    expect(render.title).toBe('原文标题')
  })

  it('sanitizes rich text changes and regenerates article exports', async () => {
    const [render] = await renderPlatforms({ ...input, platforms: ['zhihu'] })
    const result = await adjustPlatformRender(render, { title: '知乎专属', html: '<p onclick="alert(1)">新<strong>正文</strong></p><script>alert(2)</script>', tags: [] }, input.options, input.baseUrl)
    expect(result.html).toContain('新')
    expect(result.html).not.toMatch(/onclick|<script/)
    expect(result.markdown).toContain('# 知乎专属')
    expect(result.markdown).toContain('**正文**')
    expect(result.downloads.find((file) => file.kind === 'html')?.content).toContain('<title>知乎专属</title>')
  })

  it('checks the final caption including title and hashtags rather than source counts', async () => {
    const [render] = await renderPlatforms({ ...input, platforms: ['xiaohongshu'] })
    const result = await adjustPlatformRender(render, { title: '标题', body: '文'.repeat(997), tags: ['话题'] }, {}, input.baseUrl)
    expect(publishChecks(result).find((check) => check.label.includes('完整发布文案'))?.ok).toBe(false)
    expect(platformAdjustmentSchema.safeParse({ title: 'a', tags: [], cards: [{ ...render.cards[0], images: ['javascript:alert(1)'] }] }).success).toBe(false)
    expect(platformAdjustmentSchema.safeParse({ title: 'a', tags: [], cards: [render.cards[0], render.cards[0]] }).success).toBe(false)
  })
})
