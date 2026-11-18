import type { ContentDetail, PlatformId, PlatformRender, RenderOptions } from '../../../shared/types'

export interface RenderInput {
  content: ContentDetail
  platforms: PlatformId[]
  options: RenderOptions
  authorName: string
  /** Absolute base URL, e.g. http://192.168.0.111:34080 (no trailing slash). */
  baseUrl: string
  /**
   * Exported cut of a video content (latest completed 导出成片), injected as
   * the leading figure so every platform renderer sees a normal `<video>` in
   * the document. Null for article contents or when nothing was exported.
   */
  videoUrl?: string | null
}

export type RenderPlatforms = (input: RenderInput) => Promise<PlatformRender[]>

/** Internal context shared by every platform renderer for one render run. */
export interface RendererContext {
  /** ISO timestamp used by every platform result. */
  generatedAt: string
}

export type PlatformRenderer = (input: RenderInput, context: RendererContext) => Promise<PlatformRender>
