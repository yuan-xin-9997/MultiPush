import { Router } from 'express'
import { z } from 'zod'
import { currentUser } from '../auth'
import { asyncHandler } from '../errors'
import { parseInput } from '../validation'
import type { SmsLoginManager } from '../sms-login'
import { SMS_LOGIN_PLATFORMS } from '../sms-login'
import type { SmsLoginPlatform } from '../../../shared/types'

const platformSchema = z.enum(SMS_LOGIN_PLATFORMS as [SmsLoginPlatform, ...SmsLoginPlatform[]])
const startSchema = z.object({ phone: z.string().trim().min(1).max(32) }).strict()
const verifySchema = z.object({ code: z.string().trim().min(4).max(8) }).strict()
const idSchema = z.uuid()

export function createPlatformSmsRouter(manager: SmsLoginManager): Router {
  const router = Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })

  router.post('/:platform/start', asyncHandler(async (req, res) => {
    const platform = platformSchema.parse(req.params.platform)
    const { phone } = parseInput(startSchema, req.body)
    res.json({ login: await manager.start(currentUser(req).id, platform, phone) })
  }))

  router.post('/:platform/:id/verify', asyncHandler(async (req, res) => {
    const platform = platformSchema.parse(req.params.platform)
    const id = idSchema.parse(req.params.id)
    const { code } = parseInput(verifySchema, req.body)
    res.json({ login: await manager.verify(currentUser(req).id, platform, id, code) })
  }))

  router.delete('/:platform/:id', asyncHandler(async (req, res) => {
    const platform = platformSchema.parse(req.params.platform)
    const id = idSchema.parse(req.params.id)
    await manager.cancel(currentUser(req).id, platform, id)
    res.json({ ok: true })
  }))

  return router
}
