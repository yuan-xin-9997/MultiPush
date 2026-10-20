import { Router } from 'express'
import type { PlatformRender, RenderOptions } from '../../../shared/types'
import { currentUser } from '../auth'
import type { AppConfig } from '../config'
import type { Database } from '../db'
import { ApiError, asyncHandler, notFound } from '../errors'
import { renderPlatforms } from '../renderers'
import { parseInput, renderListQuerySchema, renderRequestSchema } from '../validation'

export function createRendersRouter(database: Database, config: AppConfig): Router {
  const router = Router()

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const user = currentUser(req)
      const input = parseInput(renderRequestSchema, req.body)
      const content = database.getContentDetail(user.id, input.contentId)
      if (!content) throw notFound('内容不存在')

      const options = (input.options ?? {}) as RenderOptions
      const host = req.get('host') || `localhost:${config.port}`
      const baseUrl = (config.publicBaseUrl || `${req.protocol}://${host}`).replace(/\/+$/, '')

      let results: PlatformRender[]
      try {
        results = await renderPlatforms({
          content,
          platforms: input.platforms,
          options,
          authorName: user.displayName || user.username,
          baseUrl,
        })
      } catch (error) {
        console.error('[multipush] render failed:', error)
        throw new ApiError(500, 'render_failed', '渲染失败，请稍后重试')
      }

      if (!Array.isArray(results) || results.length === 0) {
        throw new ApiError(500, 'render_failed', '渲染结果为空，请稍后重试')
      }

      const render = database.createRender(user.id, {
        contentId: content.id,
        contentTitle: content.title,
        platforms: input.platforms,
        options,
        results,
      })
      res.json({ render })
    }),
  )

  router.get(
    '/',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const query = parseInput(renderListQuerySchema, req.query)
      res.json({ renders: database.listRenders(user.id, query.contentId || undefined) })
    }),
  )

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const render = database.getRender(user.id, req.params.id)
      if (!render) throw notFound('渲染记录不存在')
      res.json({ render })
    }),
  )

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const removed = database.deleteRender(user.id, req.params.id)
      if (!removed) throw notFound('渲染记录不存在')
      res.json({ ok: true })
    }),
  )

  return router
}
