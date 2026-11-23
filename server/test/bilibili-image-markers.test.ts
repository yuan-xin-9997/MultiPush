import { describe, expect, it } from 'vitest'
import { replaceBilibiliImageMarkers, stripBilibiliImageMarkers } from '../src/bilibili-image-markers'

describe('Bilibili article image markers', () => {
  const html = [
    '<p>开头</p>',
    '<figure><span data-multipush-image="0" data-multipush-block="0"></span><figcaption>图注</figcaption></figure>',
    '<p>中间</p>',
    '<span data-multipush-image="1" data-multipush-block="1"></span>',
    '<p>结尾</p>',
  ].join('')

  it('replaces markers in place and preserves existing figure wrappers', () => {
    const result = replaceBilibiliImageMarkers(html, [
      { url: 'https://i0.hdslb.com/a.png', name: '图一', alt: '图片说明一' },
      { url: 'https://i0.hdslb.com/b.png', name: '图二' },
    ])
    expect(result.replaced).toBe(2)
    expect(result.html.indexOf('开头')).toBeLessThan(result.html.indexOf('https://i0.hdslb.com/a.png'))
    expect(result.html.indexOf('https://i0.hdslb.com/a.png')).toBeLessThan(result.html.indexOf('图注'))
    expect(result.html.indexOf('图注')).toBeLessThan(result.html.indexOf('中间'))
    expect(result.html).toContain('<img src="https://i0.hdslb.com/a.png" alt="图片说明一">')
    expect(result.html).toContain('<figure><img src="https://i0.hdslb.com/b.png" alt="图二"></figure>')
    expect(result.html).not.toContain('data-multipush-image')
  })

  it('strips markers when the upload falls back to clipboard images', () => {
    expect(stripBilibiliImageMarkers(html)).not.toContain('data-multipush-image')
    expect(stripBilibiliImageMarkers(html)).toContain('开头')
    expect(stripBilibiliImageMarkers(html)).toContain('图注')
  })
})
