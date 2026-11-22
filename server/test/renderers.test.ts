import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import type { ContentDetail, RenderOptions } from '../../shared/types'
import { renderPlatforms } from '../src/renderers'
import { paginateForCards } from '../src/renderers/xiaohongshu'
import { normalizeWechatCaptions } from '../src/renderers/wechat'

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

function input(platforms: ('wechat' | 'xiaohongshu' | 'zhihu' | 'weibo' | 'toutiao' | 'baijiahao' | 'douban' | 'juejin' | 'csdn' | 'jianshu' | 'bilibili' | 'douyin' | 'sspai' | 'blog')[], overrides: Partial<ContentDetail> = {}) {
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

  it('renders Sspai Matrix article with Markdown and HTML downloads', async () => {
    const [result] = await renderPlatforms(input(['sspai']))
    expect(result.platform).toBe('sspai')
    expect(result.previewMode).toBe('article')
    expect(result.html).toContain('font-size:16px')
    expect(result.markdown).toContain('# 一次创作，多平台发布')
    expect(result.downloads.map((download) => download.kind)).toEqual(['html', 'markdown'])
    expect(result.downloads[0].filename).toContain('少数派')
    expect(result.warnings).toEqual([])
  })

  it('adds a copyable address for external links on Toutiao and Baijiahao, but keeps them clickable elsewhere', async () => {
    const linked = content({
      contentHtml: '<h1>一次创作，多平台发布</h1><p>去影视库看看：<a href="https://movies.yuan-xin.top/item/a1">影视库条目</a></p>',
    })
    const results = await renderPlatforms({
      content: linked,
      platforms: ['toutiao', 'baijiahao', 'zhihu', 'blog'],
      options,
      authorName: 'MultiPush 编辑部',
      baseUrl: 'http://192.168.0.111:34080',
    })
    const [toutiao, baijiahao, zhihu, blog] = results
    for (const result of [toutiao, baijiahao]) {
      expect(result.html).not.toContain('<a href="https://movies.yuan-xin.top/item/a1"')
      expect(result.html).toContain('https://movies.yuan-xin.top/item/a1')
      expect(result.warnings.join('')).toContain('可复制地址')
    }
    for (const result of [zhihu, blog]) {
      expect(result.html).toContain('<a href="https://movies.yuan-xin.top/item/a1"')
    }
  })

  it('renders a Toutiao graphic article with Markdown and HTML downloads', async () => {
    const [result] = await renderPlatforms(input(['toutiao']))
    expect(result.platform).toBe('toutiao')
    expect(result.previewMode).toBe('article')
    expect(result.title).toBe('一次创作，多平台发布')
    expect(result.markdown).toContain('# 一次创作，多平台发布')
    expect(result.downloads.map((download) => download.kind)).toEqual(['html', 'markdown'])
    expect(result.downloads[0].filename).toContain('今日头条')
  })

  it('renders a Baijiahao graphic article with Markdown and HTML downloads', async () => {
    const [result] = await renderPlatforms(input(['baijiahao']))
    expect(result.platform).toBe('baijiahao')
    expect(result.previewMode).toBe('article')
    expect(result.title).toBe('一次创作，多平台发布')
    expect(result.markdown).toContain('# 一次创作，多平台发布')
    expect(result.downloads.map((download) => download.kind)).toEqual(['html', 'markdown'])
    expect(result.downloads[0].filename).toContain('百家号')
  })

  it('renders a Weibo caption with double-hash topics and text downloads', async () => {
    const [result] = await renderPlatforms(input(['weibo']))
    expect(result.platform).toBe('weibo')
    expect(result.previewMode).toBe('vertical')
    expect(result.captionBody).toContain('这是')
    expect(result.text).toContain('#内容创作#')
    expect(result.text).toContain('#效率#')
    expect(result.downloads.map((download) => download.kind)).toEqual(['text', 'html', 'json'])
    expect(result.downloads[0].filename).toContain('微博')
  })

  it('keeps resolved link URLs in the Weibo caption', async () => {
    const [result] = await renderPlatforms(input(['weibo'], {
      contentHtml: '<p>影视资料：<a href="https://example.com/movies/1917">打开《1917》影视库条目</a></p>',
    }))
    expect(result.captionBody).toContain('打开《1917》影视库条目')
    expect(result.captionBody).toContain('https://example.com/movies/1917')
  })

  it('does not duplicate a Weibo link whose label is its URL', async () => {
    const [result] = await renderPlatforms(input(['weibo'], {
      contentHtml: '<p><a href="https://example.com/only-link">https://example.com/only-link</a></p>',
    }))
    expect(result.captionBody.split('https://example.com/only-link').length - 1).toBe(1)
  })

  it('splits a long Weibo caption into complete thread segments', async () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) => `<p>第 ${index + 1} 段：${'这是一段较长的微博正文内容。'.repeat(8)}</p>`).join('')
    const [result] = await renderPlatforms(input(['weibo'], { contentHtml: paragraphs }))
    expect(result.thread?.length).toBeGreaterThan(1)
    expect(result.thread!.every((part) => Array.from(part).length <= 2000)).toBe(true)
    expect(result.thread![0]).toContain(result.title)
    expect(result.thread!.at(-1)).toContain('#内容创作#')
    expect(result.thread!.join('\n')).toContain('第 40 段')
    expect(result.warnings.some((warning) => warning.includes('微博串'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('截断'))).toBe(false)
  })

  it('renders a Douban diary with Markdown/HTML downloads and figure captions', async () => {
    const [result] = await renderPlatforms(input(['douban'], {
      contentHtml: '<p>正文</p><p><img src="/uploads/cover.png" alt="图"></p><p><em>图：说明：）</em></p>',
    }))
    expect(result.platform).toBe('douban')
    expect(result.previewMode).toBe('article')
    expect(result.title).toBe('一次创作，多平台发布')
    expect(result.html).toContain('font-size:17px')
    expect(result.html).toContain('<figure')
    expect(result.html).toContain('<figcaption')
    expect(result.markdown).toContain('# 一次创作，多平台发布')
    expect(result.downloads.map((download) => download.kind)).toEqual(['html', 'markdown'])
    expect(result.downloads[0].filename).toContain('豆瓣')
  })

  it('renders Juejin, CSDN and Jianshu articles with Markdown/HTML downloads', async () => {
    for (const platform of ['juejin', 'csdn', 'jianshu'] as const) {
      const [result] = await renderPlatforms(input([platform], {
        contentHtml: '<h2>小节</h2><p>正文</p><p><img src="/uploads/cover.png" alt="图"></p><p><em>图：说明</em></p>',
      }))
      expect(result.platform).toBe(platform)
      expect(result.previewMode).toBe('article')
      expect(result.html).toContain('<figure')
      expect(result.html).toContain('<figcaption')
      expect(result.markdown).toContain('# 一次创作，多平台发布')
      expect(result.downloads.map((download) => download.kind)).toEqual(['html', 'markdown'])
      expect(result.downloads[0].filename).toContain(platform === 'juejin' ? '掘金' : platform === 'csdn' ? 'CSDN' : '简书')
    }
  })

  it('renders personal blog article with Markdown and HTML downloads', async () => {
    const [result] = await renderPlatforms(input(['blog']))
    expect(result.platform).toBe('blog')
    expect(result.previewMode).toBe('article')
    expect(result.html).toContain('font-size:17px')
    expect(result.markdown).toContain('# 一次创作，多平台发布')
    expect(result.downloads.map((download) => download.kind)).toEqual(['html', 'markdown'])
    expect(result.downloads[0].filename).toContain('博客')
    expect(result.warnings).toEqual([])
  })

  it('truncates a long Sspai title to 32 characters and warns about video', async () => {
    const [result] = await renderPlatforms(input(['sspai'], {
      title: '这是一个非常非常长的少数派文章标题，需要在生成排版时自动截断到三十二个字以内并明确提示作者',
      contentHtml: '<p>正文</p><video src="/uploads/demo.mp4"></video>',
    }))
    expect(Array.from(result.title).length).toBeLessThanOrEqual(32)
    expect(result.downloads[0].content).toContain('<!DOCTYPE html>')
    expect(result.warnings.some((warning) => warning.includes('标题'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('视频'))).toBe(true)
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

  it('normalizes legacy image + caption paragraphs into one compact WeChat figure', async () => {
    const [result] = await renderPlatforms(input(['wechat'], { contentHtml: '<p><img src="/uploads/first.png" alt="首图"></p><p><br></p><p><em>图 1：图片说明</em></p><p>后续正文</p><figure><img src="/uploads/figure.png"><figcaption>图：语义图注</figcaption></figure><p><img src="/uploads/plain.png"></p><p><br></p><p>普通正文不应当作图注</p>' }))
    const $ = load(result.html)
    expect($('figure')).toHaveLength(2)
    expect($('figcaption')).toHaveLength(2)
    expect($('p img')).toHaveLength(1)
    expect($('p img').attr('src')).toContain('plain.png')
    const first = $('figure').first()
    expect(first.find('img').attr('alt')).toBe('首图')
    expect(first.find('img').css('margin')).toBe('0 auto')
    expect(first.css('margin')).toBe('20px 0')
    expect(first.find('figcaption').text()).toBe('图 1：图片说明')
    expect(first.find('figcaption').css('margin')).toBe('8px 0 0')
    expect(first.find('figcaption').find('em').length).toBe(0)
    expect(first.next().text()).toBe('后续正文')
    for (const element of [first, first.find('img'), first.find('figcaption')]) {
      expect(element.attr('style')).not.toMatch(/margin-(?:top|right|bottom|left)\s*:/)
    }
    expect($('figure').last().find('figcaption').text()).toBe('图：语义图注')
    expect($('img').last().parent().next().text()).toBe('普通正文不应当作图注')
    expect(result.downloads[0].content).toContain(result.html)
  })

  it('flattens legacy overlapping image margins without changing material metadata or text', () => {
    const $ = load('<section style="margin:0 0 16px;margin-bottom:0;color:#333"><img data-imgfileid="100000843" src="https://mmbiz.qpic.cn/image" style="margin:20px auto;margin-bottom:0;max-width:100%"></section><p style="margin:0 0 16px;margin-top:8px"><em>图 1：说明</em></p>', null, false)
    normalizeWechatCaptions($)
    expect($('img').css('margin')).toBe('20px auto 0')
    expect($('section').css('margin')).toBe('0')
    expect($('p').css('margin')).toBe('8px 0 16px')
    expect($.html()).not.toMatch(/margin-(?:top|right|bottom|left)\s*:/)
    expect($('img').attr('data-imgfileid')).toBe('100000843')
    expect($('section').css('color')).toBe('#333')
    expect($('p em').text()).toBe('图 1：说明')
    const normalized = $.html()
    normalizeWechatCaptions($)
    expect($.html()).toBe(normalized)
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

  describe('video contents with an exported cut', () => {
    function videoInput(platforms: Parameters<typeof input>[0], videoUrl: string | null) {
      const base = input(platforms, {
        kind: 'video',
        contentHtml: '<p>这条视频记录了一次完整的创作流程。</p>',
        videoCount: 2,
      })
      return { ...base, videoUrl }
    }

    it('injects the exported cut as the leading video on WeChat', async () => {
      const [result] = await renderPlatforms(videoInput(['wechat'], '/uploads/export-cut.mp4'))
      expect(result.videos).toEqual(['http://192.168.0.111:34080/uploads/export-cut.mp4'])
      expect(result.meta.videoCount).toBe(1)
      const $ = load(result.html)
      expect($('video[src*="export-cut.mp4"][controls]')).toHaveLength(1)
      // The video figure comes before the body text.
      const html = result.html
      expect(html.indexOf('export-cut.mp4')).toBeLessThan(html.indexOf('创作流程'))
    })

    it('drives Douyin and Xiaohongshu video-note previews from the exported cut', async () => {
      const [douyin, xiaohongshu] = await renderPlatforms(videoInput(['douyin', 'xiaohongshu'], '/uploads/export-cut.mp4'))
      expect(douyin.videos[0]).toBe('http://192.168.0.111:34080/uploads/export-cut.mp4')
      expect(douyin.warnings.some((warning) => warning.includes('视频素材'))).toBe(true)
      // The caption text must stay plain — no video URL inside.
      expect(douyin.text).not.toContain('export-cut')
      expect(xiaohongshu.previewMode).toBe('video')
      expect(xiaohongshu.videos).toHaveLength(1)
    })

    it('warns platforms without video publishing and keeps articles untouched', async () => {
      const [weibo, article] = await renderPlatforms(videoInput(['weibo', 'zhihu'], '/uploads/export-cut.mp4'))
      expect(weibo.warnings.some((warning) => warning.includes('视频'))).toBe(true)
      // Without a videoUrl the render must not gain any video.
      const [plainZhihu] = await renderPlatforms(input(['zhihu'], { kind: 'video', contentHtml: '<p>正文</p>' }))
      expect(plainZhihu.videos).toEqual([])
      expect(plainZhihu.html).not.toContain('<video')
    })
  })

  it('renders Zhihu Markdown and HTML', async () => {
    const [result] = await renderPlatforms(input(['zhihu']))
    expect(result.previewMode).toBe('article')
    expect(result.markdown).toContain('# 一次创作，多平台发布')
    expect(result.markdown).toContain('MultiPush')
    expect(result.downloads.map((download) => download.kind)).toEqual(['html', 'markdown'])
    expect(result.downloads[1].content).toContain('核心流程')
  })

  it('warns when Zhihu has to convert tables to lists', async () => {
    const [withTable] = await renderPlatforms(input(['zhihu']))
    expect(withTable.html).not.toContain('<table')
    expect(withTable.html).toContain('<li ')
    expect(withTable.warnings.some((warning) => warning.includes('不保留表格') && warning.includes('1 张表'))).toBe(true)

    const [plain] = await renderPlatforms(input(['zhihu'], { contentHtml: '<h2>小节</h2><p>正文</p>' }))
    expect(plain.warnings.some((warning) => warning.includes('表格'))).toBe(false)
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

  it('renders Bilibili column/opus article with title limit, Markdown and downloads', async () => {
    const [result] = await renderPlatforms(input(['bilibili'], { title: '这是一篇超过四十个字的 B 站专栏标题，用来验证标题会被截断而不影响正文内容' }))
    expect(result.platform).toBe('bilibili')
    expect(result.previewMode).toBe('article')
    expect(Array.from(result.title).length).toBeLessThanOrEqual(40)
    expect(result.markdown).toContain('# ')
    expect(result.markdown).toContain('核心流程')
    expect(result.downloads.map((download) => download.kind)).toEqual(['html', 'markdown', 'text', 'json'])
    expect(result.html).toContain('00aeec')
  })

  it('renders Bilibili video page with the exported cut and publish metadata', async () => {
    const base = input(['bilibili'], {
      kind: 'video',
      contentHtml: '<p>这条视频记录了一次完整的创作流程。</p>',
      videoCount: 2,
    })
    const [result] = await renderPlatforms({ ...base, videoUrl: '/uploads/export-cut.mp4' })
    expect(result.platform).toBe('bilibili')
    expect(result.previewMode).toBe('video')
    expect(result.videos[0]).toBe('http://192.168.0.111:34080/uploads/export-cut.mp4')
    expect(result.html).toContain('export-cut.mp4')
    expect(result.text).toContain('完整的创作流程')
    expect(result.downloads.map((download) => download.kind)).toEqual(['html', 'text', 'json'])
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
      input(['wechat', 'xiaohongshu', 'zhihu', 'douyin', 'sspai', 'blog'], {
        title: '空文档',
        contentHtml: '',
        contentJson: {},
        tags: [],
      }),
    )
    expect(results).toHaveLength(6)
    expect(results[0].html).toContain('暂无正文')
    expect(results[1].cards.length).toBeGreaterThanOrEqual(2)
    expect(results[2].markdown).toContain('# 空文档')
    expect(results[3].text).toContain('空文档')
    expect(results[4].html).toContain('暂无正文')
    expect(results[5].html).toContain('暂无正文')
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
