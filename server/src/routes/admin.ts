import { randomInt } from 'node:crypto'
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import type { Database } from '../db'
import { ApiError, asyncHandler } from '../errors'
import { currentUser } from '../auth'
import { createInviteCodeSchema, parseInput, updateInviteCodeSchema } from '../validation'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const usageQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).optional() }).strict()

function generateCode(): string {
  let code = ''
  for (let index = 0; index < 10; index += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

export function createAdminRouter(database: Database, requireAuth: RequestHandler): Router {
  const router = Router()
  router.use(requireAuth)
  router.use((req, _res, next) => {
    if (!currentUser(req).isAdmin) {
      next(new ApiError(403, 'admin_required', '只有管理员可以访问该接口'))
      return
    }
    next()
  })

  router.get('/ai-usage', asyncHandler((req, res) => {
    const { days = 7 } = parseInput(usageQuerySchema, req.query)
    const until = new Date()
    const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000)
    const users = database.listAiUsageByUser(since.toISOString())
    const totals = users.reduce((sum, user) => ({
      requests: sum.requests + user.requests,
      success: sum.success + user.success,
      failed: sum.failed + user.failed,
      tokensIn: sum.tokensIn + user.tokensIn,
      tokensOut: sum.tokensOut + user.tokensOut,
      poolTokens: sum.poolTokens + user.poolTokensIn + user.poolTokensOut,
    }), { requests: 0, success: 0, failed: 0, tokensIn: 0, tokensOut: 0, poolTokens: 0 })
    res.json({ report: { days, since: since.toISOString(), until: until.toISOString(), totals, users } })
  }))

  router.get('/invite-codes', asyncHandler((_req, res) => {
    res.json({ invites: database.listInviteCodes() })
  }))

  router.post('/invite-codes', asyncHandler((req, res) => {
    const input = parseInput(createInviteCodeSchema, req.body)
    const user = currentUser(req)
    let invite = null
    for (let attempt = 0; attempt < 5 && !invite; attempt += 1) {
      try {
        invite = database.createInviteCode({
          code: generateCode(),
          createdBy: user.id,
          maxUses: input.maxUses,
          expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
        })
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('invite_codes.code')) throw error
      }
    }
    if (!invite) throw new ApiError(500, 'invite_code_create_failed', '邀请码生成失败，请重试')
    res.status(201).json({ invite })
  }))

  router.patch('/invite-codes/:id', asyncHandler((req, res) => {
    const input = parseInput(updateInviteCodeSchema, req.body)
    const invite = database.setInviteCodeActive(req.params.id, input.active)
    if (!invite) throw new ApiError(404, 'invite_code_missing', '邀请码不存在')
    res.json({ invite })
  }))

  return router
}
