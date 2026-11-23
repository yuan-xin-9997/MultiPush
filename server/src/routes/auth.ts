import { EmailVerification } from '../email'
import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { AuthResponse, User } from '../../../shared/types'
import type { AppConfig } from '../config'
import {
  hashPassword,
  signToken,
  signTwoFactorChallenge,
  verifyPassword,
  verifyTwoFactorChallenge,
  currentUser,
} from '../auth'
import { TwoFactorService } from '../two-factor'
import { clientIp } from '../request-ip'
import { ACCOUNT_LIMITER, IP_LIMITER, TWO_FACTOR_LIMITER, accountKey, ipKey } from '../login-guard'
import { InviteCodeError, type Database } from '../db'
import { ApiError, asyncHandler, notFound, unauthorized } from '../errors'
import {
  desktopRegisterSchema,
  emailCodeSchema, bindEmailSchema, resetPasswordSchema,
  changePasswordSchema,
  loginSchema,
  parseInput,
  registerSchema,
  twoFactorCodeSchema,
  twoFactorPasswordSchema,
  twoFactorVerifySchema,
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

function assertNotRateLimited(
  limiter: { check: (key: string) => { allowed: boolean; retryAfterSeconds: number } },
  key: string,
  res: import('express').Response,
): void {
  const decision = limiter.check(key)
  if (decision.allowed) return
  res.setHeader('Retry-After', String(decision.retryAfterSeconds))
  throw new ApiError(429, 'too_many_attempts', `尝试次数过多，请 ${Math.max(1, Math.ceil(decision.retryAfterSeconds / 60))} 分钟后再试`)
}

export function createAuthRouter(database: Database, config: AppConfig, requireAuth: RequestHandler): Router {
  const router = Router()
  const verification = new EmailVerification(database, config.jwtSecret)
  const twoFactor = new TwoFactorService(database, config)
  const sendLimits = new Map<string, { count: number; start: number }>()
  router.get('/registration-config', (_req, res) => {
    res.json({ inviteRequired: config.inviteCodeRequired === true })
  })
  router.post('/email-code', asyncHandler(async (req, res) => {
    if (config.desktopMode) throw new ApiError(400, 'desktop_local_account', '本地版无需邮箱验证码')
    const input = parseInput(emailCodeSchema, req.body)
    if (input.purpose === 'bind') {
      await new Promise<void>((resolve, reject) => requireAuth(req, res, (error?: unknown) => error ? reject(error) : resolve()))
      if (currentUser(req).email) throw new ApiError(409, 'email_bound', '当前账号已绑定邮箱')
    }
    const now = Date.now()
    for (const [key, entry] of sendLimits) if (now - entry.start >= 3600000) sendLimits.delete(key)
    const key = clientIp(req)
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
    if (config.desktopMode) throw new ApiError(400, 'desktop_local_account', '本地版注册时已填写邮箱，无需绑定')
    const user = currentUser(req)
    if (user.email) throw new ApiError(409, 'email_bound', '当前账号已绑定邮箱')
    const input = parseInput(bindEmailSchema, req.body)
    if (database.emailTaken(input.email)) throw new ApiError(409, 'email_taken', '该邮箱已被注册')
    verification.verify(input.email, 'bind', input.code, user.id)
    try { res.json({ user: database.bindUserEmail(user.id, input.email) }) }
    catch (error) { throw uniqueConstraintMessage(error) || error }
  }))

  router.post('/reset-password', asyncHandler(async (req, res) => {
    if (config.desktopMode) throw new ApiError(400, 'desktop_local_account', '本地版不支持邮箱找回密码，请登录后修改密码')
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
      const input = parseInput(config.desktopMode ? desktopRegisterSchema : registerSchema, req.body)
      if (database.usernameTaken(input.username)) {
        throw new ApiError(409, 'username_taken', '该用户名已被使用')
      }
      if (database.emailTaken(input.email)) {
        throw new ApiError(409, 'email_taken', '该邮箱已被注册')
      }

      if (!config.desktopMode) verification.verify(input.email, 'register', input.code ?? '')
      const inviteRequired = config.inviteCodeRequired === true
      if (inviteRequired && !input.inviteCode?.trim()) {
        throw new ApiError(400, 'invite_code_required', '请输入邀请码')
      }
      const passwordHash = await hashPassword(input.password)
      const displayName = input.displayName?.trim() || input.username
      let user: User
      try {
        user = inviteRequired
          ? database.createUserWithInvite({
              username: input.username,
              email: input.email,
              passwordHash,
              displayName,
            }, input.inviteCode!.trim())
          : database.createUser({
              username: input.username,
              email: input.email,
              passwordHash,
              displayName,
            })
      } catch (error) {
        if (error instanceof InviteCodeError) {
          const messages = {
            missing: '请输入邀请码',
            invalid: '邀请码不存在',
            inactive: '邀请码已停用',
            expired: '邀请码已过期',
            exhausted: '邀请码使用次数已用完',
          } as const
          const codes = {
            missing: 'invite_code_required',
            invalid: 'invite_code_invalid',
            inactive: 'invite_code_inactive',
            expired: 'invite_code_expired',
            exhausted: 'invite_code_exhausted',
          } as const
          throw new ApiError(400, codes[error.reason], messages[error.reason])
        }
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
      const accountBucket = accountKey(input.account)
      const clientBucket = ipKey(clientIp(req))
      assertNotRateLimited(ACCOUNT_LIMITER, accountBucket, res)
      assertNotRateLimited(IP_LIMITER, clientBucket, res)
      const user = database.findUserByAccount(input.account)
      const version = user ? database.authVersion(user.id) : 0
      const valid = user ? await verifyPassword(input.password, user.passwordHash) : false
      if (!user || !valid || version !== database.authVersion(user.id)) {
        ACCOUNT_LIMITER.fail(accountBucket)
        IP_LIMITER.fail(clientBucket)
        throw new ApiError(401, 'invalid_credentials', '账号或密码错误')
      }
      ACCOUNT_LIMITER.reset(accountBucket)
      if (twoFactor.isEnabled(user.id)) {
        res.json({
          twoFactorRequired: true,
          challenge: signTwoFactorChallenge(user.id, config.jwtSecret, version),
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        })
        return
      }
      const { passwordHash: _passwordHash, ...publicUser } = user
      res.json(authResponse(publicUser, config.jwtSecret, version))
    }),
  )

  router.post(
    '/2fa/verify',
    asyncHandler(async (req, res) => {
      const input = parseInput(twoFactorVerifySchema, req.body)
      const clientBucket = ipKey(clientIp(req))
      assertNotRateLimited(IP_LIMITER, clientBucket, res)
      const payload = verifyTwoFactorChallenge(input.challenge, config.jwtSecret)
      if (!payload) throw new ApiError(401, 'two_factor_challenge_invalid', '登录凭证已失效，请重新输入密码')
      const user = database.findUserById(payload.userId)
      if (!user || payload.version !== database.authVersion(user.id)) {
        throw new ApiError(401, 'two_factor_challenge_invalid', '登录凭证已失效，请重新输入密码')
      }
      const userBucket = `2fa:${user.id}`
      assertNotRateLimited(TWO_FACTOR_LIMITER, userBucket, res)
      if (!twoFactor.verify(user.id, input.code)) {
        TWO_FACTOR_LIMITER.fail(userBucket)
        IP_LIMITER.fail(clientBucket)
        throw new ApiError(401, 'two_factor_code_invalid', '验证码不正确或已失效')
      }
      TWO_FACTOR_LIMITER.reset(userBucket)
      res.json(authResponse(user, config.jwtSecret, payload.version))
    }),
  )

  router.get('/2fa', requireAuth, (req, res) => {
    res.json({ twoFactor: twoFactor.status(currentUser(req).id), serverTime: new Date().toISOString() })
  })

  router.post('/2fa/setup', requireAuth, (req, res) => {
    const user = currentUser(req)
    res.json({ setup: twoFactor.setup(user.id, user.username) })
  })

  router.post('/2fa/enable', requireAuth, asyncHandler((req, res) => {
    const user = currentUser(req)
    const { code } = parseInput(twoFactorCodeSchema, req.body)
    const result = twoFactor.enable(user.id, code)
    res.json({ twoFactor: twoFactor.status(user.id), recoveryCodes: result.recoveryCodes })
  }))

  router.post('/2fa/disable', requireAuth, asyncHandler(async (req, res) => {
    const user = currentUser(req)
    const input = parseInput(twoFactorPasswordSchema, req.body)
    const stored = database.findUserWithPasswordById(user.id)
    if (!stored || !(await verifyPassword(input.password, stored.passwordHash))) {
      throw new ApiError(400, 'invalid_password', '当前密码不正确')
    }
    if (!twoFactor.verify(user.id, input.code)) {
      throw new ApiError(400, 'two_factor_code_invalid', '验证码不正确或已失效')
    }
    twoFactor.disable(user.id)
    res.json({ twoFactor: twoFactor.status(user.id) })
  }))

  router.post('/2fa/recovery-codes', requireAuth, asyncHandler(async (req, res) => {
    const user = currentUser(req)
    const input = parseInput(twoFactorPasswordSchema, req.body)
    const stored = database.findUserWithPasswordById(user.id)
    if (!stored || !(await verifyPassword(input.password, stored.passwordHash))) {
      throw new ApiError(400, 'invalid_password', '当前密码不正确')
    }
    if (!twoFactor.verify(user.id, input.code)) {
      throw new ApiError(400, 'two_factor_code_invalid', '验证码不正确或已失效')
    }
    res.json({ recoveryCodes: twoFactor.regenerateRecoveryCodes(user.id) })
  }))

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
