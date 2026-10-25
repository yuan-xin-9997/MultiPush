import { Router } from 'express'
import { z } from 'zod'
import { currentUser } from '../auth'
import { asyncHandler } from '../errors'
import { parseInput } from '../validation'
import type { DouyinService } from '../douyin'

const schema = z.object({ renderId: z.uuid(), mode: z.literal('publish'), imageMediaIds: z.array(z.uuid()).min(1).max(35).optional(), videoMediaId: z.uuid().optional() }).strict()
const resolveSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('check') }).strict(), z.object({ action: z.literal('not_published') }).strict(), z.object({ action: z.literal('published'), articleUrl: z.string().trim().min(1).max(2048) }).strict()])

export function createDouyinRouter(service: DouyinService): Router {
  const router = Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  router.get('/account', asyncHandler(async (req, res) => { res.json({ account: await service.account(currentUser(req).id) }) }))
  router.delete('/account', asyncHandler(async (req, res) => { await service.disconnect(currentUser(req).id); res.json({ ok: true }) }))
  router.post('/login', asyncHandler(async (req, res) => { res.status(202).json({ login: await service.startLogin(currentUser(req).id) }) }))
  router.get('/login/:id', asyncHandler(async (req, res) => { res.json({ login: await service.pollLogin(currentUser(req).id, req.params.id) }) }))
  router.get('/publications', asyncHandler((req, res) => { res.json({ publications: service.list(currentUser(req).id) }) }))
  router.get('/publications/:id', asyncHandler((req, res) => { res.json({ publication: service.get(currentUser(req).id, req.params.id) }) }))
  router.post('/publications/:id/resolve', asyncHandler(async (req, res) => {
    const input = parseInput(resolveSchema, req.body)
    res.status(input.action === 'check' ? 202 : 200).json({ publication: await service.resolve(currentUser(req).id, req.params.id, input) })
  }))
  router.post('/publications', asyncHandler(async (req, res) => {
    res.status(202).json({ publication: await service.publish(currentUser(req).id, parseInput(schema, req.body), `${req.protocol}://${req.get('host')}`) })
  }))
  return router
}
