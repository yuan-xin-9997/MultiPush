import type { PlatformId, PlatformRender } from '../../../shared/types'
import type { PlatformRenderer, RenderInput } from './types'
import { renderWechat } from './wechat'
import { renderXiaohongshu } from './xiaohongshu'
import { renderZhihu } from './zhihu'

const RENDERERS: Record<PlatformId, PlatformRenderer> = {
  wechat: renderWechat,
  xiaohongshu: renderXiaohongshu,
  zhihu: renderZhihu,
}

/**
 * Render the requested platforms in input order.
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

  for (const platform of platforms) {
    const renderer = RENDERERS[platform]
    if (!renderer) {
      throw new Error(`不支持的平台：${platform}`)
    }
    try {
      results.push(await renderer({ ...input, platforms }, context))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`渲染${platform}失败：${message}`)
    }
  }

  return results
}

export type { RenderInput, RendererContext, PlatformRenderer } from './types'
