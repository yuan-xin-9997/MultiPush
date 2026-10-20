import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { AuthResponse, User } from '../../../shared/types'
import type { AppConfig } from '../config'
import { hashPassword, signToken, verifyPassword, currentUser } from '../auth'
import type { Database } from '../db'
import { ApiError, asyncHandler, notFound, unauthorized } from '../errors'
import {
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

function authResponse(user: User, secret: string): AuthResponse {
  return { token: signToken(user, secret), user }
}

export function createAuthRouter(database: Database, config: AppConfig, requireAuth: RequestHandler): Router {
  const router = Router()

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
      res.json(authResponse(user, config.jwtSecret))
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
      const valid = await verifyPassword(input.password, user.passwordHash)
      if (!valid) {
        throw new ApiError(401, 'invalid_credentials', '账号或密码错误')
      }
      const { passwordHash: _passwordHash, ...publicUser } = user
      res.json(authResponse(publicUser, config.jwtSecret))
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
