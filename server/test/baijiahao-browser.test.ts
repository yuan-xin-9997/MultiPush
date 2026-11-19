import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/errors'
import {
  BAIJIAHAO_PLACEHOLDER_HASH,
  assertBaijiahaoBodyImages,
  buildBaijiahaoBodyHtml,
  countBaijiahaoFeedImages,
  isBaijiahaoImageSrc,
  isBaijiahaoPlaceholder,
  parseBaijiahaoPublished,
  parseBaijiahaoUpload,
  verifyEditorImages,
} from '../src/baijiahao-browser'

const PICPROXY = 'https://baijiahao.baidu.com/bjh/picproxy?param=abc123/xyz+def'
const CDN = 'https://pic.rmb.bdstatic.com/bjh/fff73118e2c/261119/example.png'
const PLACEHOLDER = `https://pic.rmb.bdstatic.com/${BAIJIAHAO_PLACEHOLDER_HASH}.gif`

describe('baijiahao image hosts and placeholders', () => {
  it('recognizes baijiahao CDN urls and rejects external ones', () => {
    expect(isBaijiahaoImageSrc(PICPROXY)).toBe(true)
    expect(isBaijiahaoImageSrc(CDN)).toBe(true)
    expect(isBaijiahaoImageSrc('https://pics5.baidu.com/feed/abc.jpeg?token=x')).toBe(true)
    expect(isBaijiahaoImageSrc('https://publish.yuan-xin.top/uploads/a.jpg')).toBe(false)
    expect(isBaijiahaoImageSrc('http://baijiahao.baidu.com/bjh/picproxy?param=x')).toBe(true)
    expect(isBaijiahaoImageSrc('data:image/png;base64,AAA=')).toBe(false)
    expect(isBaijiahaoImageSrc('not a url')).toBe(false)
    // lookalike hosts must not pass the suffix check
    expect(isBaijiahaoImageSrc('https://evil.baidu.com.example.com/a.png')).toBe(false)
    expect(isBaijiahaoImageSrc('https://evilstuffbdstatic.com/a.png')).toBe(false)
  })

  it('detects the placeholder gif', () => {
    expect(isBaijiahaoPlaceholder(PLACEHOLDER)).toBe(true)
    expect(isBaijiahaoPlaceholder(CDN)).toBe(false)
  })
})

describe('buildBaijiahaoBodyHtml', () => {
  const uploads = new Map([
    ['https://publish.yuan-xin.top/uploads/poster.jpg', PICPROXY],
    ['/uploads/shot.png', CDN],
  ])

  it('rewrites figure images into the editor container form and keeps native captions', () => {
    const { html, images } = buildBaijiahaoBodyHtml(
      '<p>开头</p><figure><img src="https://publish.yuan-xin.top/uploads/poster.jpg" alt="海报" width="460" height="690"><figcaption>中文海报</figcaption></figure><p>结尾</p>',
      uploads,
    )
    expect(html).toContain(`src="${PICPROXY}"`)
    expect(html).toContain('data-bjh-origin-src="https://baijiahao.baidu.com/bjh/picproxy?param=abc123/xyz+def"')
    expect(html).toContain('data-bjh-type="IMG"')
    expect(html).toContain('data-w="460"')
    expect(html).toContain('data-h="690"')
    expect(html).toContain('alt="海报"')
    expect(html).toContain('class="bjh-image-container"')
    expect(html).toContain('data-bjh-caption-id="cap-mp-1"')
    expect(html).toContain('class="bjh-image-caption ue_t" data-bjh-caption-for="cap-mp-1">中文海报</p>')
    expect(html).not.toContain('<figure')
    expect(html).not.toContain('<figcaption')
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ src: 'https://publish.yuan-xin.top/uploads/poster.jpg', url: PICPROXY, alt: '海报', width: '460', height: '690', caption: '中文海报' })
  })

  it('keeps long captions as styled paragraphs instead of truncating them', () => {
    const caption = '《黑客帝国》中文海报。图片来源：TMDB'
    const { html, images } = buildBaijiahaoBodyHtml(
      `<figure><img src="https://publish.yuan-xin.top/uploads/poster.jpg"><figcaption>${caption}</figcaption></figure>`,
      uploads,
    )
    expect(html).toContain(caption)
    expect(html).not.toContain('bjh-image-caption')
    expect(html).toContain('text-align:center;')
    expect(images[0].caption).toBe(caption)
  })

  it('wraps bare image-only paragraphs and preserves document order', () => {
    const { html, images } = buildBaijiahaoBodyHtml(
      '<p><img src="https://publish.yuan-xin.top/uploads/poster.jpg" alt="海报"></p><p>中间文字</p><p><img src="/uploads/shot.png"></p>',
      uploads,
    )
    const poster = html.indexOf(PICPROXY)
    const text = html.indexOf('中间文字')
    const shot = html.indexOf(CDN)
    expect(poster).toBeGreaterThan(-1)
    expect(text).toBeGreaterThan(poster)
    expect(shot).toBeGreaterThan(text)
    expect(images).toHaveLength(2)
    expect(images[0].src).toBe('https://publish.yuan-xin.top/uploads/poster.jpg')
    expect(images[1].src).toBe('/uploads/shot.png')
  })

  it('keeps already-hosted images untouched and strips srcset/data-src', () => {
    const { html, images } = buildBaijiahaoBodyHtml(
      `<p><img src="${CDN}" srcset="${CDN} 2x" data-src="${CDN}"></p>`,
      uploads,
    )
    expect(html).toContain(CDN)
    expect(html).not.toContain('srcset')
    expect(html).not.toContain('data-src')
    expect(images).toHaveLength(0)
  })

  it('fails when an image was not uploaded', () => {
    expect(() => buildBaijiahaoBodyHtml('<p><img src="https://external.test/a.png"></p>', uploads)).toThrowError(
      expect.objectContaining({ code: 'baijiahao_image_upload_failed' }) as ApiError,
    )
  })
})

describe('assertBaijiahaoBodyImages / verifyEditorImages', () => {
  it('accepts html that only references baijiahao hosts', () => {
    expect(() => assertBaijiahaoBodyImages(`<p><img src="${CDN}"></p><p><img src="${PICPROXY}"></p>`)).not.toThrow()
  })

  it('verifyEditorImages compares counts, hosts and placeholders', () => {
    expect(() => verifyEditorImages([PICPROXY, CDN], [PICPROXY, CDN])).not.toThrow()
    expect(() => verifyEditorImages([PICPROXY], [PICPROXY, CDN])).toThrowError(expect.objectContaining({ code: 'baijiahao_image_upload_failed' }) as ApiError)
    expect(() => verifyEditorImages([PICPROXY, PLACEHOLDER], [PICPROXY, PLACEHOLDER])).toThrowError(/占位图/)
    expect(() => verifyEditorImages([PICPROXY, 'https://external.test/a.png'], [PICPROXY, CDN])).toThrowError(/外链图片/)
    expect(() => verifyEditorImages([PICPROXY, PICPROXY], [PICPROXY, CDN])).toThrowError(/不一致/)
    expect(() => verifyEditorImages(null, [])).toThrowError(/无法读取/)
  })
})

describe('parseBaijiahaoUpload', () => {
  it('returns the https url from the live payload', () => {
    expect(parseBaijiahaoUpload({ errno: 0, errmsg: 'success', ret: { https_url: 'https://baijiahao.baidu.com/bjh/picproxy?param=a+b/c', bos_url: 'http://x' } })).toBe('https://baijiahao.baidu.com/bjh/picproxy?param=a+b/c')
  })

  it('upgrades http bos urls to https', () => {
    expect(parseBaijiahaoUpload({ errno: 0, ret: { bos_url: 'http://baijiahao.baidu.com/bjh/picproxy?param=a' } })).toBe('https://baijiahao.baidu.com/bjh/picproxy?param=a')
  })

  it('rejects failed payloads', () => {
    expect(parseBaijiahaoUpload({ errno: 1, ret: { https_url: 'https://x' } })).toBeNull()
    expect(parseBaijiahaoUpload({ errno: 0, ret: {} })).toBeNull()
    expect(parseBaijiahaoUpload(null)).toBeNull()
  })
})

describe('parseBaijiahaoPublished', () => {
  it('reads the article id from the live ret payload', () => {
    const payload = { errno: 0, data: null, ret: { article_id: '1882242466899273664', nid: '9809771472357913393', id: '1882242466899273664', url: 'http://baijiahao.baidu.com/builder/preview/s?id=9809771472357913393' } }
    expect(parseBaijiahaoPublished(payload)).toEqual({ remoteId: '1882242466899273664', url: 'https://baijiahao.baidu.com/s?id=1882242466899273664' })
  })

  it('keeps legacy data payloads working and ignores the preview nid', () => {
    expect(parseBaijiahaoPublished({ errno: 0, data: { id: '5000000000000001' } })).toEqual({ remoteId: '5000000000000001', url: 'https://baijiahao.baidu.com/s?id=5000000000000001' })
    expect(parseBaijiahaoPublished({ errno: 0, data: { url: 'https://baijiahao.baidu.com/s?id=5000000000000001&wfr=x' } })).toEqual({ remoteId: '5000000000000001', url: 'https://baijiahao.baidu.com/s?id=5000000000000001' })
    expect(parseBaijiahaoPublished({ errno: 0, ret: { nid: '9809771472357913393' } })).toBeNull()
    expect(parseBaijiahaoPublished({ errno: 20040001 })).toBeNull()
  })
})

describe('countBaijiahaoFeedImages', () => {
  it('counts distinct CDN images in a published page', () => {
    const html = `
      <img src="https://pics5.baidu.com/feed/0df431adcbef76091f5797896af302de7cd99e0c.jpeg@f_auto?token=a">
      <img src="https://pics1.baidu.com/feed/3ac79f3df8dcd100d9bce80ce93ce702b8122fc0.jpeg@f_auto?token=b">
      <img src="https://pics5.baidu.com/feed/0df431adcbef76091f5797896af302de7cd99e0c.jpeg@f_auto?token=a">
      <img src="https://pic.rmb.bdstatic.com/bjh/fff73118e2c/261119/example.png">
    `
    expect(countBaijiahaoFeedImages(html)).toBe(3)
    expect(countBaijiahaoFeedImages('<p>没有图片</p>')).toBe(0)
  })
})
