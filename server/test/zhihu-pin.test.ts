import { describe, expect, it } from 'vitest'
import type { ContentDetail } from '../../shared/types'
import { renderPlatforms } from '../src/renderers'

function content(overrides: Partial<ContentDetail> = {}): ContentDetail {
  return {
    id: 'pin-content',
    bookId: null,
    bookName: null,
    title: '腰突康复记录',
    excerpt: '',
    coverImage: null,
    tags: ['腰突'],
    status: 'ready',
    favorite: false,
    wordCount: 20,
    imageCount: 2,
    videoCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    contentJson: {},
    contentHtml: '<p>今天记录一下康复情况。</p><p><img src="/uploads/a.png"></p><p>继续坚持。</p><p><img src="/uploads/b.png"></p>',
    kind: 'gallery',
    ...overrides,
  }
}

describe('Zhihu pin renderer', () => {
  it('renders gallery content as a pin instead of an article', async () => {
    const [result] = await renderPlatforms({
      content: content(),
      platforms: ['zhihu'],
      options: { includeTags: false },
      authorName: '作者',
      baseUrl: 'http://localhost',
    })
    expect(result.previewMode).toBe('pin')
    expect(result.title).toBe('腰突康复记录')
    expect(result.captionBody).toContain('今天记录一下康复情况')
    expect(result.assets.filter(asset => asset.kind === 'image')).toHaveLength(2)
    expect(result.downloads.some(item => item.filename.endsWith('知乎想法.txt'))).toBe(true)
  })

  it('keeps normal article content on the Zhihu article path', async () => {
    const [result] = await renderPlatforms({
      content: content({ kind: 'article', title: '长文', contentHtml: '<p>正文</p>', imageCount: 0 }),
      platforms: ['zhihu'],
      options: {},
      authorName: '作者',
      baseUrl: 'http://localhost',
    })
    expect(result.previewMode).toBe('article')
  })
})
