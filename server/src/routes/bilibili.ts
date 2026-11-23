import { Router } from 'express'
import { z } from 'zod'
import { currentUser } from '../auth'
import { asyncHandler } from '../errors'
import { parseInput } from '../validation'
import type { BilibiliService } from '../bilibili'

const publishSchema = z.object({
  renderId: z.uuid(),
  type: z.enum(['video', 'article']),
  mode: z.enum(['draft', 'publish']),
  videoMediaId: z.uuid().optional(),
  coverMediaId: z.uuid().optional(),
  title: z.string().trim().max(80).optional(),
  desc: z.string().max(2000).optional(),
  tags: z.string().trim().max(1000).optional(),
  partitionId: z.number().int().positive().optional(),
}).strict()

const resolveSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check') }).strict(),
  z.object({ action: z.literal('not_published') }).strict(),
  z.object({ action: z.literal('published'), videoUrl: z.string().trim().min(1).max(2048) }).strict(),
])

export function createBilibiliRouter(service: BilibiliService): Router {
  const router = Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  router.get('/account', asyncHandler(async (req, res) => { res.json({ account: await service.account(currentUser(req).id, req.query.refresh === '1') }) }))
  router.post('/login', asyncHandler(async (req, res) => { res.json({ login: await service.beginLogin(currentUser(req).id) }) }))
  router.get('/login/:id', asyncHandler(async (req, res) => { res.json({ login: await service.loginStatus(currentUser(req).id, req.params.id) }) }))
  router.delete('/account', asyncHandler(async (req, res) => { await service.disconnect(currentUser(req).id); res.json({ ok: true }) }))
  router.get('/partitions', asyncHandler((_req, res) => { res.json({ partitions: service.partitions() }) }))
  router.get('/publications', asyncHandler((req, res) => { res.json({ publications: service.list(currentUser(req).id) }) }))
  router.get('/publications/:id', asyncHandler((req, res) => { res.json({ publication: service.get(currentUser(req).id, req.params.id) }) }))
  router.delete('/publications/:id', asyncHandler(async (req, res) => { res.json(await service.remove(currentUser(req).id, req.params.id)) }))
  router.post('/publications/:id/resolve', asyncHandler(async (req, res) => {
    const input = parseInput(resolveSchema, req.body)
    res.json({ publication: await service.resolve(currentUser(req).id, req.params.id, input) })
  }))
  router.post('/publications', asyncHandler(async (req, res) => {
    res.json({ publication: await service.publish(currentUser(req).id, parseInput(publishSchema, req.body)) })
  }))
  return router
}
