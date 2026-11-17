import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { normalizeFigureCaptions, normalizeFigureCaptionsHtml } from '../src/renderers/figure-captions'

function figures(html: string) {
  const $ = load(html, null, false)
  return $('figure').toArray().map((node) => ({
    image: $(node).find('img').attr('src') || '',
    alt: $(node).find('img').attr('alt') || '',
    caption: $(node).find('figcaption').text(),
    captionHtml: $(node).find('figcaption').html(),
    hasParagraph: $(node).find('p').length > 0,
  }))
}

describe('figure normalization', () => {
  it('merges one image and an italic caption with full-width punctuation and emoji', () => {
    const html = '<p><img src="/a.png" alt="器材"></p><p><em>图：我的器材：）</em></p>'
    expect(figures(normalizeFigureCaptionsHtml(html))).toEqual([
      { image: '/a.png', alt: '器材', caption: '图：我的器材：）', captionHtml: '图：我的器材：）', hasParagraph: false },
    ])
  })

  it('merges a plain caption (no em)', () => {
    expect(figures(normalizeFigureCaptionsHtml('<p><img src="/a.png"></p><p>图:普通图注</p>'))[0]).toMatchObject({
      caption: '图:普通图注',
      hasParagraph: false,
    })
    expect(figures(normalizeFigureCaptionsHtml('<p><img src="/a.png"></p><p>图 1：编号图注</p>'))[0]).toMatchObject({
      caption: '图 1：编号图注',
      hasParagraph: false,
    })
  })

  it('skips multiple paragraphs or a non-caption paragraph', () => {
    for (const html of [
      '<p><img src="/a.png"></p><p>正文第一段</p><p>图：这里只是正文</p>',
      '<p><img src="/a.png"></p><h2>图：这是小标题</h2>',
    ]) {
      expect(normalizeFigureCaptionsHtml(html)).toBe(html)
    }
  })

  it('does not merge multiple images that share one caption', () => {
    for (const html of [
      '<p><img src="/a.png"><img src="/b.png"></p><p><em>图：两张图</em></p>',
      '<p><img src="/a.png"></p><p><img src="/b.png"></p><p><em>图：两张图</em></p>',
    ]) {
      expect(normalizeFigureCaptionsHtml(html)).toBe(html)
    }
  })

  it('does not merge an orphan caption or a body paragraph that merely contains 图：', () => {
    for (const html of [
      '<p>正文</p><p><em>图：没有图片</em></p>',
      '<p><img src="/a.png"></p><p>正文里提到图：不是图注</p>',
    ]) {
      expect(normalizeFigureCaptionsHtml(html)).toBe(html)
    }
  })

  it('adds a missing figcaption to an existing figure and strips p wrappers', () => {
    const html = '<figure><p><img src="/a.png"></p></figure><p><br></p><p><em>图：已有图片</em></p>'
    expect(figures(normalizeFigureCaptionsHtml(html))[0]).toMatchObject({
      image: '/a.png',
      caption: '图：已有图片',
      hasParagraph: false,
    })
  })

  it('is idempotent and leaves an existing figure unchanged', () => {
    const html = '<figure><img src="/a.png"><figcaption>图：已有</figcaption></figure>'
    expect(normalizeFigureCaptionsHtml(html)).toBe(html)
    const $ = load(html, null, false)
    expect(normalizeFigureCaptions($)).toBe(0)
  })

  it('removes blank spacers only when a real caption follows', () => {
    const merged = normalizeFigureCaptionsHtml('<p><img src="/a.png"></p><p><br></p><p>图：说明</p>')
    expect(merged).toBe('<figure><img src="/a.png"><figcaption>图：说明</figcaption></figure>')
    const untouched = normalizeFigureCaptionsHtml('<p><img src="/a.png"></p><p><br></p><p>后续正文</p>')
    expect(untouched).toContain('<p><br></p>')
  })
})
