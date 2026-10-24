import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import type { ContentDetail, RenderOptions } from '../../shared/types'
import { renderPlatforms } from '../src/renderers'
import { paginateForCards } from '../src/renderers/xiaohongshu'

function content(overrides: Partial<ContentDetail> = {}): ContentDetail {
  return {
    id: 'content-1',
    bookId: null,
    bookName: null,
    title: '一次创作，多平台发布',
    excerpt: '摘要',
    coverImage: null,
    tags: ['内容创作', '效率'],
    status: 'ready',
    favorite: false,
    wordCount: 120,
    imageCount: 1,
    videoCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    contentJson: { type: 'doc', content: [] },
    contentHtml: [
      '<h1>一次创作，多平台发布</h1>',
      '<p>这是 <strong>MultiPush</strong> 的示例内容，包含中文与 English。</p>',
      '<h2>核心流程</h2>',
      '<ul><li>创建内容</li><li>智能渲染</li><li>预览下载</li></ul>',
      '<blockquote>好的排版，是内容被读完的第一步。</blockquote>',
      '<pre><code>const message = "hello"</code></pre>',
      '<table><thead><tr><th>平台</th><th>输出</th></tr></thead><tbody><tr><td>小红书</td><td>卡片</td></tr></tbody></table>',
      '<p><img src="/uploads/cover.png" alt="cover"></p>',
    ].join(''),
    ...overrides,
  }
}

const options: RenderOptions = { cardStyle: 'clean', includeTags: true }

function input(platforms: ('wechat' | 'xiaohongshu' | 'zhihu' | 'douyin')[], overrides: Partial<ContentDetail> = {}) {
  return {
    content: content(overrides),
    platforms,
    options,
    authorName: 'MultiPush 编辑部',
    baseUrl: 'http://192.168.0.111:34080',
  }
}

describe('renderPlatforms', () => {
  it('renders all four platforms in request order', async () => {
    const results = await renderPlatforms(input(['douyin', 'zhihu', 'wechat', 'xiaohongshu']))
    expect(results.map((result) => result.platform)).toEqual(['douyin', 'zhihu', 'wechat', 'xiaohongshu'])
    expect(results.every((result) => result.generatedAt)).toBe(true)
    expect(results.every((result) => result.meta.wordCount > 0)).toBe(true)
  })

  it('renders WeChat article with inline styles, downloads and absolute media URLs', async () => {
    const [result] = await renderPlatforms(input(['wechat']))
    expect(result.platform).toBe('wechat')
    expect(result.previewMode).toBe('article')
    expect(result.html).toContain('font-size:16px')
    expect(result.html).toContain('http://192.168.0.111:34080/uploads/cover.png')
    expect(result.downloads[0].kind).toBe('html')
    expect(result.downloads[0].content).toContain('<!DOCTYPE html>')
    expect(result.downloads[0].content).toContain('一次创作，多平台发布')
    expect(result.videos).toEqual([])
  })

  it('keeps WeChat lists compact without changing nesting, inline spaces, images, or code whitespace', async () => {
    const [result] = await renderPlatforms(input(['wechat'], { contentHtml: '<ul>\n<li><p><strong>第一项</strong> <em>说明</em></p><ol start="3">\n<li>嵌套一</li>\n<li>嵌套二</li>\n</ol></li>\n<li><p><br></p></li>\n<li><img src="/uploads/cover.png"></li>\n</ul><pre><code>  first\n    second</code></pre>' }))
    const $ = load(result.html)
    expect($('ul > li').length).toBe(2)
    expect($('ol > li').length).toBe(2)
    expect($('ol').attr('start')).toBe('3')
    expect($('li img').length).toBe(1)
    expect($('li p').first().text()).toBe('第一项 说明')
    expect($('code').text()).toBe('  first\n    second')
    for (const list of $('ul,ol').toArray()) expect($(list).contents().toArray().every(node => node.type === 'tag' && node.name === 'li')).toBe(true)
    expect(result.downloads[0].content).toContain(result.html)
  })

  it('keeps images close to numbered and semantic captions while retaining ordinary paragraph spacing', async () => {
    const [result] = await renderPlatforms(input(['wechat'], { contentHtml: '<p><img src="/uploads/first.png" alt="首图"></p><p><br></p><p><em>图 1：图片说明</em></p><p>后续正文</p><figure><img src="/uploads/figure.png"><figcaption>语义图注</figcaption></figure><p><img src="/uploads/plain.png"></p><p><br></p><p>普通正文不应当作图注</p>' }))
    const $ = load(result.html)
    const first = $('img').first()
    expect(first.css('margin-bottom')).toBe('0')
    expect(first.parent().css('margin-bottom')).toBe('0')
    expect(first.parent().next().text()).toBe('图 1：图片说明')
    expect(first.parent().next().css('margin-top')).toBe('8px')
    expect(first.parent().next().find('em').length).toBe(1)
    expect(first.attr('alt')).toBe('首图')
    expect($('figcaption').css('margin-top')).toBe('8px')
    expect($('figure img').css('margin-bottom')).toBe('0')
    expect($('img').last().css('margin-bottom')).toBeUndefined()
    expect($('img').last().parent().next().text()).toBe('普通正文不应当作图注')
    expect($('img').last().parent().css('margin-bottom')).toBeUndefined()
    expect(result.downloads[0].content).toContain(result.html)
  })

  it('renders Xiaohongshu cards, caption and hashtags', async () => {
    const [result] = await renderPlatforms(input(['xiaohongshu']))
    expect(result.previewMode).toBe('cards')
    expect(result.title.length).toBeLessThanOrEqual(20)
    expect(result.cards[0].type).toBe('cover')
    expect(result.cards.at(-1)?.type).toBe('end')
    expect(result.cards.every((card) => card.total === result.cards.length)).toBe(true)
    expect(result.cards.map((card) => card.index)).toEqual(result.cards.map((_, index) => index + 1))
    expect(result.text).toContain('#内容创作')
    expect(result.downloads.some((download) => download.kind === 'text')).toBe(true)
    expect(result.downloads.some((download) => download.kind === 'json')).toBe(true)
    expect(result.cards[0].images[0]).toBe('http://192.168.0.111:34080/uploads/cover.png')
  })

  it('truncates a long Xiaohongshu title', async () => {
    const [result] = await renderPlatforms(
      input(['xiaohongshu'], { title: '这是一个非常非常长的小红书标题，需要被自动截断到二十个字以内' }),
    )
    expect(Array.from(result.title).length).toBeLessThanOrEqual(20)
    expect(result.warnings.some((warning) => warning.includes('标题'))).toBe(true)
  })

  it('switches Xiaohongshu to video mode when a video exists', async () => {
    const [result] = await renderPlatforms(
      input(['xiaohongshu'], {
        contentHtml: '<p>视频教程</p><video src="/uploads/demo.mp4" poster="/uploads/cover.png"></video>',
      }),
    )
    expect(result.previewMode).toBe('video')
    expect(result.videos[0]).toBe('http://192.168.0.111:34080/uploads/demo.mp4')
    expect(result.warnings.some((warning) => warning.includes('视频'))).toBe(true)
  })

  it('renders Zhihu Markdown and HTML', async () => {
    const [result] = await renderPlatforms(input(['zhihu']))
    expect(result.previewMode).toBe('article')
    expect(result.markdown).toContain('# 一次创作，多平台发布')
    expect(result.markdown).toContain('MultiPush')
    expect(result.downloads.map((download) => download.kind)).toEqual(['html', 'markdown'])
    expect(result.downloads[1].content).toContain('核心流程')
  })

  it('renders Douyin caption, hashtags and vertical preview', async () => {
    const [result] = await renderPlatforms(input(['douyin']))
    expect(result.platform).toBe('douyin')
    expect(result.previewMode).toBe('vertical')
    expect(result.title.length).toBeLessThanOrEqual(55)
    expect(result.text).toContain('#内容创作')
    expect(result.text).toContain('一次创作，多平台发布')
    expect(result.downloads.map((download) => download.kind)).toEqual(['text', 'html', 'json'])
    expect(result.downloads[1].content).toContain('<!DOCTYPE html>')
    expect(result.warnings.some((warning) => warning.includes('视频'))).toBe(true)
  })

  it('switches Douyin warnings to the video recommendation when a video exists', async () => {
    const [result] = await renderPlatforms(
      input(['douyin'], {
        contentHtml: '<p>视频教程</p><video src="/uploads/demo.mp4" poster="/uploads/cover.png"></video>',
      }),
    )
    expect(result.videos[0]).toBe('http://192.168.0.111:34080/uploads/demo.mp4')
    expect(result.warnings.some((warning) => warning.includes('视频版本'))).toBe(true)
  })

  it('sanitizes scripts and javascript URLs', async () => {
    const [result] = await renderPlatforms(
      input(['wechat'], {
        contentHtml:
          '<p>safe</p><script>alert(1)</script><a href="javascript:alert(2)">bad</a><img src="javascript:alert(3)">',
      }),
    )
    expect(result.html).not.toMatch(/<script/i)
    expect(result.html).not.toContain('javascript:')
  })

  it('handles empty content without throwing', async () => {
    const results = await renderPlatforms(
      input(['wechat', 'xiaohongshu', 'zhihu', 'douyin'], {
        title: '空文档',
        contentHtml: '',
        contentJson: {},
        tags: [],
      }),
    )
    expect(results).toHaveLength(4)
    expect(results[0].html).toContain('暂无正文')
    expect(results[1].cards.length).toBeGreaterThanOrEqual(2)
    expect(results[2].markdown).toContain('# 空文档')
    expect(results[3].text).toContain('空文档')
  })
})

describe('paginateForCards', () => {
  it('preserves all text beyond eight cards and splits oversized sentences', () => {
    const blocks = Array.from({ length: 12 }, () => '文'.repeat(168) + '。短句。')
    const pages = paginateForCards(blocks, [])
    expect(pages.length).toBeGreaterThan(8)
    expect(pages.flatMap((page) => page.body).join('')).toBe(blocks.join(''))
    expect(pages.every((page) => Array.from(page.body.join('')).length <= 170)).toBe(true)
  })

  it('gives every image a visible page even when images outnumber text pages', () => {
    const images = Array.from({ length: 12 }, (_, i) => `${i}.png`)
    for (const blocks of [[], ['short text']]) {
      const pages = paginateForCards(blocks, images)
      expect(pages.flatMap((page) => page.images)).toEqual(images)
      expect(pages.every((page) => page.images.length <= 1)).toBe(true)
    }
  })

  it('paginates long paragraphs and assigns images', () => {
    const blocks = Array.from({ length: 6 }, (_, index) => `第${index + 1}段：` + '内容'.repeat(60))
    const pages = paginateForCards(blocks, ['a.png', 'b.png'], 150)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.some((page) => page.images.length > 0)).toBe(true)
    expect(pages.every((page) => page.body.join('').length <= 170)).toBe(true)
  })

  it('creates an image-only page and a fallback page', () => {
    expect(paginateForCards([], ['a.png'])[0].images).toEqual(['a.png'])
    expect(paginateForCards([], [])[0].body[0]).toContain('暂时没有正文')
  })
})
