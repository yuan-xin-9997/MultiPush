import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { prepareZhihuContent, verifyZhihuContent, zhihuImageUrl } from '../src/zhihu-content'

const source = '<section style="color:red"><h2>章节</h2><p><img src="https://pic4.zhimg.com/image.png" style="margin:22px auto;margin-bottom:22px"></p><p><br></p><p style="margin:0 0 18px"><em>图 1：说明</em></p><ul>\n<li><a href="https://github.com/org/repo?a=1&amp;b=2">下载地址</a><ol start="3">\n<li>嵌套项</li>\n</ol></li>\n<li><p><br></p></li>\n<li>第二项</li>\n</ul><pre><code class="language-js">  first\n    second</code></pre><table><tbody><tr><th>字段</th><th>类型</th></tr><tr><td>标题</td><td>文本</td></tr></tbody></table></section>'

describe('Zhihu native article formatting', () => {
  it('uses semantic figures/captions, clean lists, native tables and exact code whitespace', () => {
    const html = prepareZhihuContent(source), $ = load(html)
    expect($('figure').length).toBe(1)
    expect($('figure > img').length).toBe(1)
    expect($('figure > figcaption em').text()).toBe('图 1：说明')
    expect($('figure').next().is('ul')).toBe(true)
    expect($('li').length).toBe(3)
    expect($('ol').attr('start')).toBe('3')
    for (const list of $('ul,ol').toArray()) expect($(list).contents().toArray().every(n => n.type === 'tag' && n.name === 'li')).toBe(true)
    expect($('pre').attr('lang')).toBe('js')
    expect($('pre code').text()).toBe('  first\n    second')
    expect($('table').attr('data-draft-type')).toBe('table')
    expect($('a').attr('href')).toBe('https://github.com/org/repo?a=1&b=2')
    expect(html).not.toMatch(/\s(?:style|class)=/)
    expect(prepareZhihuContent(html)).toBe(html)
    expect(() => verifyZhihuContent(html, html)).not.toThrow()
  })

  it.each([
    (html: string) => html.replace('src="https://pic4.zhimg.com/image.png"', 'src="https://external.test/image.png"'),
    (html: string) => html.replace('<img', '<i').replace(/<\/i>/g, ''),
    (html: string) => html.replace('href="https://github.com/org/repo?a=1&amp;b=2"', ''),
    (html: string) => html.replace('</ul>', '<li><br></li></ul>'),
    (html: string) => html.replace(/<figcaption[^>]*>/, '<p>').replace('</figcaption>', '</p>'),
    (html: string) => html.replace('    second', 'second'),
    (html: string) => html.replace(/h2/g, 'p'),
    (html: string) => html.replace('start="3"', 'start="1"'),
  ])('stops publication if stored content loses image, link, list, caption, code, or heading structure', mutate => {
    const html = prepareZhihuContent(source)
    expect(() => verifyZhihuContent(html, mutate(html))).toThrow('停止发布')
  })

  it('accepts Zhihu link redirects while preserving the original target', () => {
    const html = prepareZhihuContent(source), $ = load(html)
    $('a').attr('href', 'https://link.zhihu.com/?target=' + encodeURIComponent($('a').attr('href')!))
    expect(() => verifyZhihuContent(html, $.html())).not.toThrow()
  })

  it('does not accept attacker-controlled or insecure upload URLs', () => {
    for (const url of ['https://pic4.zhimg.com/image', 'https://pic-private.zhihu.com/image']) expect(zhihuImageUrl(url)).toBe(url)
    for (const url of ['http://pic4.zhimg.com/image', 'https://zhimg.com.evil.test/a', 'https://evilzhimg.com/a', 'https://u:p@pic4.zhimg.com/a', 'file:///a', 'https://pic4.zhimg.com:123/a']) expect(zhihuImageUrl(url)).toBeNull()
  })
})
