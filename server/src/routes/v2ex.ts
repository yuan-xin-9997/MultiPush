import { Router } from 'express'
import { z } from 'zod'
import { currentUser } from '../auth'
import { asyncHandler } from '../errors'
import { parseInput } from '../validation'
import type { V2exService } from '../v2ex'

const connectSchema = z.object({ cookie: z.string().trim().min(10).max(20_000) }).strict()
const publishSchema = z.object({
  renderId: z.uuid(),
  nodeName: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, '节点名称格式不正确'),
}).strict()
const resolveSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check') }).strict(),
  z.object({ action: z.literal('not_published') }).strict(),
  z.object({ action: z.literal('published'), topicUrl: z.string().trim().min(1).max(2048) }).strict(),
])

export function createV2exRouter(service: V2exService): Router {
  const router = Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  router.get('/account', asyncHandler(async (req, res) => { res.json({ account: await service.account(currentUser(req).id) }) }))
  router.post('/connect', asyncHandler(async (req, res) => { res.json({ account: await service.connect(currentUser(req).id, parseInput(connectSchema, req.body)) }) }))
  router.delete('/account', asyncHandler(async (req, res) => { await service.disconnect(currentUser(req).id); res.json({ ok: true }) }))
  router.get('/nodes', asyncHandler(async (req, res) => { res.json({ nodes: await service.nodes(currentUser(req).id) }) }))
  router.get('/publications', asyncHandler((req, res) => { res.json({ publications: service.list(currentUser(req).id) }) }))
  router.get('/publications/:id', asyncHandler((req, res) => { res.json({ publication: service.get(currentUser(req).id, req.params.id) }) }))
  router.delete('/publications/:id', asyncHandler(async (req, res) => { res.json(await service.remove(currentUser(req).id, req.params.id)) }))
  router.post('/publications/:id/resolve', asyncHandler(async (req, res) => {
    const input = parseInput(resolveSchema, req.body)
    res.status(input.action === 'check' ? 202 : 200).json({ publication: await service.resolve(currentUser(req).id, req.params.id, input) })
  }))
  router.post('/publications', asyncHandler(async (req, res) => {
    res.json({ publication: await service.publish(currentUser(req).id, parseInput(publishSchema, req.body)) })
  }))
  return router
}
