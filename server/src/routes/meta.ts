import { Router } from 'express'
import type { RequestHandler } from 'express'
import { PLATFORMS } from '../../../shared/types'
import type { AppConfig } from '../config'
import { asyncHandler } from '../errors'

export function createMetaRouter(config: AppConfig, requireAuth: RequestHandler): Router {
  const router = Router()

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'multipush',
      version: config.version,
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
    })
  })

  router.get(
    '/platforms',
    requireAuth,
    asyncHandler((_req, res) => {
      res.json({ platforms: PLATFORMS })
    }),
  )

  return router
}
