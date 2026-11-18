import { Router } from 'express'
import type { RequestHandler } from 'express'
import { currentUser } from '../auth'
import type { Database } from '../db'
import type { VideoService } from '../video'
import { asyncHandler } from '../errors'
import { parseInput, videoTimelineSchema } from '../validation'

/**
 * Timeline editing + export endpoints for video contents. Auth is applied per
 * route (the router is mounted at the shared `/api` prefix), and every route
 * resolves the content through the database with the caller's userId, so
 * cross-tenant access falls through to 404 like the rest of the API.
 */
export function createVideoRouter(database: Database, video: VideoService, requireAuth: RequestHandler): Router {
  const router = Router()

  router.get(
    '/contents/:id/video',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(req)
      const project = await video.getProject(user.id, req.params.id)
      const capability = await video.capability()
      res.json({ project, capability })
    }),
  )

  router.put(
    '/contents/:id/video/timeline',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(req)
      const input = parseInput(videoTimelineSchema, req.body)
      const project = await video.saveTimeline(user.id, req.params.id, input.clips)
      res.json({ project })
    }),
  )

  router.post(
    '/contents/:id/video/export',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(req)
      const record = await video.createExport(user.id, req.params.id)
      res.json({ export: record })
    }),
  )

  router.get(
    '/contents/:id/video/exports',
    requireAuth,
    asyncHandler((req, res) => {
      const user = currentUser(req)
      res.json({ exports: video.listExports(user.id, req.params.id) })
    }),
  )

  router.get(
    '/video-exports/:exportId',
    requireAuth,
    asyncHandler((req, res) => {
      const user = currentUser(req)
      res.json({ export: video.getExport(user.id, req.params.exportId) })
    }),
  )

  router.delete(
    '/video-exports/:exportId',
    requireAuth,
    asyncHandler((req, res) => {
      const user = currentUser(req)
      video.deleteExport(user.id, req.params.exportId)
      res.json({ ok: true })
    }),
  )

  return router
}
