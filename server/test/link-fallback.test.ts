import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { preserveExternalLinksAsText } from '../src/renderers/link-fallback'

describe('preserveExternalLinksAsText', () => {
  it('keeps link text and appends the absolute address', () => {
    const result = preserveExternalLinksAsText('<p><a href="https://movies.yuan-xin.top/item/a1">影视库条目</a></p>')
    expect(result.converted).toBe(1)
    expect(result.html).not.toContain('<a')
    expect(result.html).toContain('影视库条目')
    expect(result.html).toContain('https://movies.yuan-xin.top/item/a1')
    expect(load(result.html, null, false).text()).toBe('影视库条目（https://movies.yuan-xin.top/item/a1）')
  })

  it('does not duplicate a URL that is already the link text', () => {
    const result = preserveExternalLinksAsText('<p><a href="https://movies.yuan-xin.top/item/a1">https://movies.yuan-xin.top/item/a1</a></p>')
    expect(result.converted).toBe(1)
    expect(result.html.match(/https:\/\/movies\.yuan-xin\.top\/item\/a1/g)).toHaveLength(1)
  })

  it('leaves anchors, allowed hosts and non-http links alone', () => {
    const html = [
      '<p><a href="#section">目录</a></p>',
      '<p><a href="https://www.toutiao.com/article/1/">头条站内</a></p>',
      '<p><a href="mailto:a@example.com">邮件</a></p>',
    ].join('')
    const result = preserveExternalLinksAsText(html, { allowedHosts: ['toutiao.com'] })
    expect(result.converted).toBe(0)
    expect(result.html).toBe(html)
  })

  it('keeps images wrapped by an external link', () => {
    const result = preserveExternalLinksAsText('<p><a href="https://example.com/a"><img src="/uploads/a.png" alt="图"></a></p>')
    expect(result.converted).toBe(1)
    expect(result.html).not.toContain('<a')
    expect(result.html).toContain('<img src="/uploads/a.png" alt="图">')
    expect(result.html).toContain('https://example.com/a')
  })
})
