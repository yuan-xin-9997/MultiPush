import { Router } from 'express'
import type { PlatformRender, RenderOptions } from '../../../shared/types'
import { currentUser } from '../auth'
import type { AppConfig } from '../config'
import type { Database } from '../db'
import { ApiError, asyncHandler, notFound } from '../errors'
import { renderPlatforms } from '../renderers'
import { parseInput, renderListQuerySchema, renderRequestSchema } from '../validation'
import { platformAdjustmentSchema, renderPlatformParamsSchema } from '../validation'
import { adjustPlatformRender } from '../render-adjustment'

export function createRendersRouter(database: Database, config: AppConfig): Router {
  const router = Router()

  router.patch('/:id/platforms/:platform', asyncHandler(async (req, res) => {
    const user = currentUser(req)
    const { id, platform } = parseInput(renderPlatformParamsSchema, req.params)
    const record = database.getRender(user.id, id)
    const current = record?.results.find((item) => item.platform === platform)
    if (!record || !current) throw notFound('渲染记录不存在')
    const input = parseInput(platformAdjustmentSchema, req.body)
    const baseUrl = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`
    const original = database.getRender(user.id, id, true)?.results.find((item) => item.platform === platform)
    const result = await adjustPlatformRender(current, input, record.options, baseUrl, original)
    if (!database.saveRenderDraft(user.id, id, result)) throw notFound('渲染记录不存在')
    res.json({ result })
  }))

  router.delete('/:id/platforms/:platform', asyncHandler((req, res) => {
    const user = currentUser(req)
    const { id, platform } = parseInput(renderPlatformParamsSchema, req.params)
    if (!database.resetRenderDraft(user.id, id, platform)) throw notFound('渲染记录不存在')
    const result = database.getRender(user.id, id, true)?.results.find((item) => item.platform === platform)
    res.json({ result })
  }))

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
