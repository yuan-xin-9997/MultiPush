import { describe, expect, it } from 'vitest'
import {
  countWords,
  deriveContentMetrics,
  htmlToPlainText,
  normalizeTags,
  plainTextFromContent,
} from '../src/content-utils'

describe('content metrics', () => {
  it('counts Chinese characters and Latin words', () => {
    expect(countWords('你好世界')).toBe(4)
    expect(countWords('Hello MultiPush 2026')).toBe(3)
    expect(countWords('你好 MultiPush')).toBe(3)
    expect(countWords('')).toBe(0)
  })

  it('extracts text from html and Tiptap JSON', () => {
    expect(htmlToPlainText('<h1>标题</h1><p>正文&nbsp;内容</p>')).toContain('标题')
    expect(htmlToPlainText('<script>bad()</script><p>safe</p>')).not.toContain('bad')
    expect(plainTextFromContent('', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'JSON fallback' }] }] })).toBe('JSON fallback')
  })

  it('normalizes tags', () => {
    expect(normalizeTags([' 测试 ', '测试', '', 'A'.repeat(30), 'second'])).toEqual([
      '测试',
      'A'.repeat(24),
      'second',
    ])
    expect(normalizeTags(null)).toEqual([])
  })

  it('derives excerpt, word and media counts', () => {
    const metrics = deriveContentMetrics({
      contentHtml: '<h2>标题</h2><p>正文内容</p><img src="/a.png"><video src="/v.mp4"></video>',
    })
    expect(metrics.excerpt).toContain('正文内容')
    expect(metrics.wordCount).toBeGreaterThan(0)
    expect(metrics.imageCount).toBe(1)
    expect(metrics.videoCount).toBe(1)
  })
})
