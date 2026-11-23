import { Router } from 'express'
import { z } from 'zod'
import { currentUser } from '../auth'
import { asyncHandler } from '../errors'
import { parseInput } from '../validation'
import type { JianshuService } from '../jianshu'

const connectSchema = z.object({ cookie: z.string().trim().min(10).max(20_000) }).strict()
const publishSchema = z.object({
  renderId: z.uuid(),
  mode: z.enum(['draft', 'publish']),
  notebookId: z.string().trim().regex(/^\d{5,30}$/).optional(),
}).strict()
const resolveSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check') }).strict(),
  z.object({ action: z.literal('not_published') }).strict(),
  z.object({ action: z.literal('published'), articleUrl: z.string().trim().min(1).max(2048) }).strict(),
])

export function createJianshuRouter(service: JianshuService): Router {
  const router = Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  router.get('/account', asyncHandler(async (req, res) => { res.json({ account: await service.account(currentUser(req).id, req.query.refresh === '1') }) }))
  router.post('/connect', asyncHandler(async (req, res) => { res.json({ account: await service.connect(currentUser(req).id, parseInput(connectSchema, req.body)) }) }))
  router.delete('/account', asyncHandler(async (req, res) => { await service.disconnect(currentUser(req).id); res.json({ ok: true }) }))
  router.get('/publications', asyncHandler((req, res) => { res.json({ publications: service.list(currentUser(req).id) }) }))
  router.get('/publications/:id', asyncHandler((req, res) => { res.json({ publication: service.get(currentUser(req).id, req.params.id) }) }))
  router.delete('/publications/:id', asyncHandler(async (req, res) => { res.json(await service.remove(currentUser(req).id, req.params.id)) }))
  router.post('/publications/:id/resolve', asyncHandler(async (req, res) => {
    const input = parseInput(resolveSchema, req.body)
    res.status(input.action === 'check' ? 202 : 200).json({ publication: await service.resolve(currentUser(req).id, req.params.id, input) })
  }))
  router.post('/publications', asyncHandler(async (req, res) => {
    res.status(202).json({ publication: await service.publish(currentUser(req).id, parseInput(publishSchema, req.body)) })
  }))
  return router
}
