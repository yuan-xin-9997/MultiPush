import { Router } from 'express'
import { z } from 'zod'
import { currentUser } from '../auth'
import { asyncHandler } from '../errors'
import { parseInput } from '../validation'
import type { WechatService } from '../wechat'

const publicationSchema = z.object({
  renderId: z.uuid(),
  mode: z.enum(['draft', 'publish']),
  coverMediaId: z.uuid(),
  author: z.string().trim().max(8, '作者最多 8 个字').optional(),
  digest: z.string().trim().max(120, '摘要最多 120 个字').optional(),
}).strict()

export function createWechatRouter(service: WechatService): Router {
  const router = Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  router.get('/account', asyncHandler(async (req, res) => { res.json({ account: await service.account(currentUser(req).id) }) }))
  router.delete('/account', asyncHandler(async (req, res) => { await service.disconnect(currentUser(req).id); res.json({ ok: true }) }))
  router.post('/login', asyncHandler(async (req, res) => { res.json({ login: await service.startLogin(currentUser(req).id) }) }))
  router.get('/login/:id', asyncHandler(async (req, res) => { res.json({ login: await service.pollLogin(currentUser(req).id, req.params.id) }) }))
  router.get('/publications', asyncHandler((req, res) => { res.json({ publications: service.list(currentUser(req).id) }) }))
  router.get('/publications/:id', asyncHandler((req, res) => { res.json({ publication: service.get(currentUser(req).id, req.params.id) }) }))
  router.post('/publications', asyncHandler(async (req, res) => {
    const input = parseInput(publicationSchema, req.body)
    res.status(202).json({ publication: await service.publish(currentUser(req).id, input, `${req.protocol}://${req.get('host')}`) })
  }))
  return router
}
