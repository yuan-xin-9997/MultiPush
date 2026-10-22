import type { ContentDetail, PlatformAdjustment, PlatformRender, RenderOptions } from '../../shared/types'
import { renderPlatforms } from './renderers'
import { buildHtmlDocument, htmlToMarkdown, normalizeTags, safeFilename, charLength } from './renderers/common'
import { getCaptionBody } from '../../shared/render-workbench'

export async function adjustPlatformRender(current: PlatformRender, input: PlatformAdjustment, options: RenderOptions, baseUrl: string, original = current): Promise<PlatformRender> {
  let result = { ...current }
  if (input.html !== undefined && input.html !== current.html) {
    // Reuse the normal sanitization and platform styles for edited article HTML.
    const content = { title: input.title, contentHtml: input.html, contentJson: {}, tags: input.tags, updatedAt: current.sourceUpdatedAt } as ContentDetail
    ;[result] = await renderPlatforms({ content, options, platforms: [current.platform], authorName: options.authorName ?? '', baseUrl })
  }
  result = { ...result, title: input.title, generatedAt: current.generatedAt, sourceUpdatedAt: current.sourceUpdatedAt, authorName: current.authorName, editedAt: new Date().toISOString() }
  const tags = normalizeTags(input.tags)
  result.meta = { ...result.meta, tags, titleLength: charLength(input.title) }
  if (current.platform === 'xiaohongshu' || current.platform === 'douyin') {
    result.captionBody = input.body ?? getCaptionBody(current)
    result.text = [input.title, result.captionBody, tags.map((tag) => `#${tag}`).join(' ')].filter(Boolean).join('\n\n')
    result.meta = { ...result.meta, wordCount: charLength(result.captionBody), readMinutes: Math.max(1, Math.ceil(charLength(result.captionBody) / 350)), summary: result.captionBody.slice(0, 120) }
  }
  if (current.platform === 'xiaohongshu') {
    result.assets = original.assets
    result.cards = (input.cards ?? current.cards).map((card, index, cards) => ({
      ...card, index: index + 1, total: cards.length,
      title: card.type === 'cover' && card.title === current.title ? input.title : card.title,
    }))
    const imageUrls = new Set(result.assets.filter((asset) => asset.kind === 'image').map((asset) => asset.url))
    for (const url of result.cards.flatMap((card) => card.images)) {
      if (!imageUrls.has(url)) {
        result.assets = [...result.assets, { url, kind: 'image', filename: `卡片图片-${imageUrls.size + 1}` }]
        imageUrls.add(url)
      }
    }
    result.meta = { ...result.meta, imageCount: imageUrls.size }
  }
  result.warnings = result.warnings.filter((warning) => !/标题.*字|正文.*字|截断/.test(warning))
  const base = safeFilename(input.title)
  result.downloads = [{ filename: `${base}.html`, kind: 'html', mimeType: 'text/html;charset=utf-8', content: buildHtmlDocument({ title: input.title, html: result.html, themeColor: result.themeColor, authorName: result.authorName }) }]
  if (current.platform === 'zhihu') {
    result.markdown = `# ${input.title}\n\n${htmlToMarkdown(result.html)}`
    result.downloads.push({ filename: `${base}.md`, kind: 'markdown', mimeType: 'text/markdown;charset=utf-8', content: result.markdown })
  }
  if (result.text) result.downloads.push({ filename: `${base}-文案.txt`, kind: 'text', mimeType: 'text/plain;charset=utf-8', content: result.text })
  if (current.platform === 'xiaohongshu' || current.platform === 'douyin') {
    const { downloads: _downloads, ...note } = result
    result.downloads.push({ filename: `${base}-笔记.json`, kind: 'json', mimeType: 'application/json;charset=utf-8', content: JSON.stringify(note, null, 2) })
  }
  return result
}
