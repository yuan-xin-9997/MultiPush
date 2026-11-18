import { Router } from 'express'
import { currentUser } from '../auth'
import { asyncHandler } from '../errors'
import { parseInput, wechatpicConnectSchema, wechatpicPublishSchema } from '../validation'
import type { WechatpicService } from '../wechatpic'

export function createWechatpicRouter(service: WechatpicService): Router {
  const router = Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  router.get('/account', asyncHandler(async (req, res) => { res.json({ account: await service.account(currentUser(req).id) }) }))
  router.post('/connect', asyncHandler(async (req, res) => {
    const input = parseInput(wechatpicConnectSchema, req.body)
    res.json({ account: await service.connect(currentUser(req).id, input) })
  }))
  router.delete('/account', asyncHandler(async (req, res) => { await service.disconnect(currentUser(req).id); res.json({ ok: true }) }))
  router.get('/publications', asyncHandler((req, res) => { res.json({ publications: service.list(currentUser(req).id) }) }))
  router.get('/publications/:id', asyncHandler((req, res) => { res.json({ publication: service.get(currentUser(req).id, req.params.id) }) }))
  router.delete('/publications/:id', asyncHandler(async (req, res) => { res.json(await service.remove(currentUser(req).id, req.params.id)) }))
  router.post('/publications', asyncHandler(async (req, res) => {
    const input = parseInput(wechatpicPublishSchema, req.body)
    res.status(202).json({ publication: await service.publish(currentUser(req).id, input, `${req.protocol}://${req.get('host')}`) })
  }))
  return router
}
