import { EmailVerification } from '../email'
import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { AuthResponse, User } from '../../../shared/types'
import type { AppConfig } from '../config'
import { hashPassword, signToken, verifyPassword, currentUser } from '../auth'
import type { Database } from '../db'
import { ApiError, asyncHandler, notFound, unauthorized } from '../errors'
import {
  emailCodeSchema, bindEmailSchema, resetPasswordSchema,
  changePasswordSchema,
  loginSchema,
  parseInput,
  registerSchema,
  updateProfileSchema,
} from '../validation'

function uniqueConstraintMessage(error: unknown): ApiError | null {
  if (!(error instanceof Error)) return null
  const message = error.message
  if (!message.includes('UNIQUE constraint failed')) return null
  if (message.includes('users.username')) {
    return new ApiError(409, 'username_taken', '该用户名已被使用')
  }
  if (message.includes('users.email')) {
    return new ApiError(409, 'email_taken', '该邮箱已被注册')
  }
  return new ApiError(409, 'conflict', '数据已存在')
}

function authResponse(user: User, secret: string, version: number): AuthResponse {
  return { token: signToken(user, secret, version), user }
}

export function createAuthRouter(database: Database, config: AppConfig, requireAuth: RequestHandler): Router {
  const router = Router()
  const verification = new EmailVerification(database, config.jwtSecret)
  const sendLimits = new Map<string, { count: number; start: number }>()
  router.post('/email-code', asyncHandler(async (req, res) => {
    const input = parseInput(emailCodeSchema, req.body)
    if (input.purpose === 'bind') {
      await new Promise<void>((resolve, reject) => requireAuth(req, res, (error?: unknown) => error ? reject(error) : resolve()))
      if (currentUser(req).email) throw new ApiError(409, 'email_bound', '当前账号已绑定邮箱')
    }
    const now = Date.now()
    for (const [key, entry] of sendLimits) if (now - entry.start >= 3600000) sendLimits.delete(key)
    const key = req.ip || 'unknown'
    const limit = sendLimits.get(key) || { count: 0, start: now }
    if (limit.count >= 10) throw new ApiError(429, 'mail_rate_limited', '发送过于频繁，请稍后重试')
    limit.count++
    sendLimits.set(key, limit)
    if (input.purpose !== 'reset' && database.emailTaken(input.email)) throw new ApiError(409, 'email_taken', '该邮箱已被注册')
    if (input.purpose !== 'reset' || database.emailTaken(input.email)) {
      await verification.send(input.email, input.purpose, input.purpose === 'bind' ? currentUser(req).id : '')
    }
    res.json({ ok: true })
  }))

  router.post('/bind-email', requireAuth, asyncHandler((req, res) => {
    const user = currentUser(req)
    if (user.email) throw new ApiError(409, 'email_bound', '当前账号已绑定邮箱')
    const input = parseInput(bindEmailSchema, req.body)
    if (database.emailTaken(input.email)) throw new ApiError(409, 'email_taken', '该邮箱已被注册')
    verification.verify(input.email, 'bind', input.code, user.id)
    try { res.json({ user: database.bindUserEmail(user.id, input.email) }) }
    catch (error) { throw uniqueConstraintMessage(error) || error }
  }))

  router.post('/reset-password', asyncHandler(async (req, res) => {
    const input = parseInput(resetPasswordSchema, req.body)
    verification.verify(input.email, 'reset', input.code)
    const user = database.findUserByAccount(input.email)
    if (!user || user.email.toLowerCase() !== input.email) throw new ApiError(400, 'invalid_code', '验证码错误或已失效')
    database.updateUserPassword(user.id, await hashPassword(input.newPassword))
    res.json({ ok: true })
  }))

  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const input = parseInput(registerSchema, req.body)
      if (database.usernameTaken(input.username)) {
        throw new ApiError(409, 'username_taken', '该用户名已被使用')
      }
      if (database.emailTaken(input.email)) {
        throw new ApiError(409, 'email_taken', '该邮箱已被注册')
      }

      verification.verify(input.email, 'register', input.code)
      const passwordHash = await hashPassword(input.password)
      const displayName = input.displayName?.trim() || input.username
      let user: User
      try {
        user = database.createUser({
          username: input.username,
          email: input.email,
          passwordHash,
          displayName,
        })
      } catch (error) {
        const duplicate = uniqueConstraintMessage(error)
        if (duplicate) throw duplicate
        throw error
      }
      res.json(authResponse(user, config.jwtSecret, database.authVersion(user.id)))
    }),
  )

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const input = parseInput(loginSchema, req.body)
      const user = database.findUserByAccount(input.account)
      if (!user) {
        throw new ApiError(401, 'invalid_credentials', '账号或密码错误')
      }
      const version = database.authVersion(user.id)
      const valid = await verifyPassword(input.password, user.passwordHash)
      if (!valid || version !== database.authVersion(user.id)) {
        throw new ApiError(401, 'invalid_credentials', '账号或密码错误')
      }
      const { passwordHash: _passwordHash, ...publicUser } = user
      res.json(authResponse(publicUser, config.jwtSecret, version))
    }),
  )

  router.get(
    '/me',
    requireAuth,
    asyncHandler((req, res) => {
      res.json({ user: currentUser(req) })
    }),
  )

  router.patch(
    '/me',
    requireAuth,
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const input = parseInput(updateProfileSchema, req.body)
      const updated = database.updateUserProfile(user.id, {
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
      })
      if (!updated) throw notFound('用户不存在')
      res.json({ user: updated })
    }),
  )

  router.post(
    '/password',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(req)
      const input = parseInput(changePasswordSchema, req.body)
      const stored = database.findUserWithPasswordById(user.id)
      if (!stored) throw unauthorized()
      const valid = await verifyPassword(input.currentPassword, stored.passwordHash)
      if (!valid) {
        throw new ApiError(400, 'invalid_password', '当前密码不正确')
      }
      const passwordHash = await hashPassword(input.newPassword)
      database.updateUserPassword(user.id, passwordHash)
      res.json({ ok: true })
    }),
  )

  return router
}
