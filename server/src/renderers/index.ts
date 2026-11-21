import type { PlatformId, PlatformRender } from '../../../shared/types'
import type { PlatformRenderer, RenderInput } from './types'
import { renderWechat } from './wechat'
import { renderWechatpic } from './wechatpic'
import { renderXiaohongshu } from './xiaohongshu'
import { renderZhihu } from './zhihu'
import { renderWeibo } from './weibo'
import { renderToutiao } from './toutiao'
import { renderBaijiahao } from './baijiahao'
import { renderDouban } from './douban'
import { renderJuejin } from './juejin'
import { renderCsdn } from './csdn'
import { renderJianshu } from './jianshu'
import { renderV2ex } from './v2ex'
import { renderDouyin } from './douyin'
import { renderSspai } from './sspai'
import { renderBlog } from './blog'

const RENDERERS: Record<PlatformId, PlatformRenderer> = {
  wechat: renderWechat,
  wechatpic: renderWechatpic,
  xiaohongshu: renderXiaohongshu,
  zhihu: renderZhihu,
  weibo: renderWeibo,
  toutiao: renderToutiao,
  baijiahao: renderBaijiahao,
  douban: renderDouban,
  juejin: renderJuejin,
  csdn: renderCsdn,
  jianshu: renderJianshu,
  v2ex: renderV2ex,
  douyin: renderDouyin,
  sspai: renderSspai,
  blog: renderBlog,
}

/**
 * Render the requested platforms in request order.
 *
 * Each platform is isolated: one platform's failure is reported with its
 * platform id so the API can return an actionable error. The rendering rules
 * live in the individual platform modules; this entry point is also the place
 * where a future AI enhancement layer can be inserted without changing the
 * PlatformRender contract consumed by the web app.
 */
export async function renderPlatforms(input: RenderInput): Promise<PlatformRender[]> {
  const generatedAt = new Date().toISOString()
  const context = { generatedAt }
  const platforms = Array.from(new Set(input.platforms))
  const results: PlatformRender[] = []

  // Video contents carry their exported cut (成片) as the leading figure so
  // every platform renderer treats it like a normal video in the document.
  const content = input.videoUrl
    ? {
        ...input.content,
        contentHtml: `${videoFigureHtml(input.videoUrl)}${input.content.contentHtml ?? ''}`,
      }
    : input.content
  const effectiveInput: RenderInput = { ...input, content }

  for (const platform of platforms) {
    const renderer = RENDERERS[platform]
    if (!renderer) {
      throw new Error(`不支持的平台：${platform}`)
    }
    try {
      const platformOptions = { ...effectiveInput.options, ...(effectiveInput.platformOptions?.[platform] ?? {}) }
      const authorName = platformOptions.authorName?.trim() || effectiveInput.authorName
      results.push({ ...await renderer({ ...effectiveInput, options: platformOptions, authorName, platforms }, context), sourceUpdatedAt: effectiveInput.content.updatedAt, authorName })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`渲染${platform}失败：${message}`)
    }
  }

  return results
}

/** Minimal, sanitize-safe video figure (only attributes the allow-list keeps). */
function videoFigureHtml(url: string): string {
  const escaped = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<figure><video src="${escaped}" controls="controls"></video></figure>`
}

export type { RenderInput, RendererContext, PlatformRenderer } from './types'
