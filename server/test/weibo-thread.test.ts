import { describe, expect, it } from 'vitest'
import { splitWeiboThread, weiboLength } from '../src/weibo-thread'

describe('splitWeiboThread', () => {
  it('keeps every paragraph and puts topics on the last post', () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段：这是一段较长的微博正文内容。`.repeat(4))
    const parts = splitWeiboThread('长文标题', paragraphs.join('\n\n'), ['#长文#', '#测试#'])
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => weiboLength(part) <= 2000)).toBe(true)
    expect(parts[0]).toContain('长文标题')
    expect(parts.at(-1)).toContain('#长文# #测试#')
    expect(parts.join('\n')).toContain('第 40 段')
  })

  it('splits an oversized paragraph without sending more than the limit', () => {
    const body = '这是一段没有句号的超长正文'.repeat(300)
    const parts = splitWeiboThread('标题', body, [])
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => weiboLength(part) <= 2000)).toBe(true)
    expect(parts.join('')).toContain('这是一段没有句号的超长正文')
  })

  it('does not split a normal URL into another post', () => {
    const url = 'https://example.com/movies/1917?from=weibo'
    const parts = splitWeiboThread('标题', `条目：${url}`, ['#电影#'])
    expect(parts).toHaveLength(1)
    expect(parts[0]).toContain(url)
  })
})
