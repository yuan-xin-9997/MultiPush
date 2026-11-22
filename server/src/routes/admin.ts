import { randomInt } from 'node:crypto'
import { Router, type RequestHandler } from 'express'
import type { Database } from '../db'
import { ApiError, asyncHandler } from '../errors'
import { currentUser } from '../auth'
import { createInviteCodeSchema, parseInput, updateInviteCodeSchema } from '../validation'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

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
      next(new ApiError(403, 'admin_required', '只有管理员可以管理邀请码'))
      return
    }
    next()
  })

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
