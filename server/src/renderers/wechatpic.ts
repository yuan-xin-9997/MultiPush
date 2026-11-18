import { getPlatformInfo } from '../../../shared/types'
import type { PlatformRender } from '../../../shared/types'
import type { RenderInput, RendererContext } from './types'
import {
  buildHashtags,
  buildMeta,
  buildPlatformWarnings,
  escapeHtml,
  prepareContent,
  safeFilename,
  truncateToChars,
  charLength,
} from './common'

const WECHATPIC_THEME = '#07c160'

/**
 * WeChat 图片消息（后台「贴图」入口，API `article_type: newspic`）。
 *
 * The deliverable is image-first: at most 20 pictures plus a plain-text body
 * (the official draft API only accepts plain text and a few product tags), so
 * the renderer extracts the article images in document order, keeps the title
 * within 32 chars and turns the body into a clean caption.
 */
export async function renderWechatpic(input: RenderInput, context?: RendererContext): Promise<PlatformRender> {
  const info = getPlatformInfo('wechatpic')
  const prepared = prepareContent(input, context, info)
  const titleLimit = info.limits.titleMax ?? 32
  const title = truncateToChars(prepared.rawTitle, titleLimit)
  const maxImages = info.limits.imageMax ?? 20
  const imageUrls = prepared.media.images.slice(0, maxImages)
  const warnings = buildPlatformWarnings(prepared)

  if (prepared.media.images.length === 0) {
    warnings.push('未检测到正文图片：贴图（图片消息）至少需要 1 张图片，请先在正文中插入图片。')
  } else if (prepared.media.images.length > maxImages) {
    warnings.push(`贴图最多支持 ${maxImages} 张图片，已按正文顺序取前 ${maxImages} 张（共 ${prepared.media.images.length} 张）。`)
  }

  const bodyMax = info.limits.bodyMax ?? 20_000
  // Keep an empty body empty: the official draft API requires a non-empty
  // plain-text body, and the workbench check must tell the user to write one.
  const body = truncateToChars(prepared.plainText || prepared.summary || '', bodyMax)
  const includeTags = prepared.options.includeTags !== false
  const hashtags = includeTags ? buildHashtags(prepared.tags, 5) : []
  const text = [title, body, hashtags.length ? hashtags.join(' ') : null].filter((part): part is string => part !== null).join('\n\n')

  // A simple vertical preview (images stacked, then the caption). The sticker
  // itself is published as an image list plus plain text, not styled HTML.
  const imageHtml = imageUrls.map((src) => `<img src="${escapeHtml(src)}" alt="" />`).join('')
  const paragraphHtml = prepared.textBlocks
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('')
  const html = `<div data-mp-wechatpic="1">${imageHtml}${paragraphHtml}</div>`

  const allowed = new Set(imageUrls)
  const assets = prepared.media.assets.filter((asset) => asset.kind === 'image' && allowed.has(asset.url))
  if (prepared.media.videos.length) {
    warnings.push('贴图（图片消息）不支持视频，发布时请移除视频或改用公众号图文排版。')
  }
  const noteJson = JSON.stringify(
    {
      platform: 'wechatpic',
      title,
      body,
      text,
      tags: includeTags ? prepared.tags : [],
      hashtags,
      images: imageUrls,
      cover: imageUrls[0] || null,
      meta: { ...buildMeta(prepared), imageCount: imageUrls.length, wordCount: charLength(body) },
      generatedAt: prepared.generatedAt,
    },
    null,
    2,
  )

  return {
    platform: 'wechatpic',
    title,
    html,
    markdown: null,
    text,
    previewMode: 'vertical',
    themeColor: WECHATPIC_THEME,
    meta: { ...buildMeta(prepared), imageCount: imageUrls.length, wordCount: charLength(body) },
    cards: [],
    assets,
    videos: prepared.media.videos,
    warnings: Array.from(new Set(warnings)),
    downloads: [
      { filename: `${safeFilename(title)}-贴图文案.txt`, mimeType: 'text/plain;charset=utf-8', kind: 'text', content: text },
      { filename: `${safeFilename(title)}-贴图.json`, mimeType: 'application/json;charset=utf-8', kind: 'json', content: noteJson },
    ],
    generatedAt: prepared.generatedAt,
    captionBody: body,
  }
}
