import { compare, hash } from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { Request, RequestHandler } from 'express'
import type { User } from '../../shared/types'
import type { Database } from './db'
import { unauthorized } from './errors'

export const BCRYPT_ROUNDS = 12
export const JWT_TTL = '7d'

export async function hashPassword(password: string): Promise<string> {
  return hash(password, BCRYPT_ROUNDS)
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (!passwordHash) return false
  try {
    return await compare(password, passwordHash)
  } catch {
    return false
  }
}

export interface TokenPayload {
  userId: string
  username?: string
}

export function signToken(user: Pick<User, 'id' | 'username'>, secret: string): string {
  return jwt.sign({ username: user.username }, secret, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: JWT_TTL,
  })
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] })
    if (typeof decoded === 'string' || !decoded.sub) return null
    return {
      userId: String(decoded.sub),
      username: typeof decoded.username === 'string' ? decoded.username : undefined,
    }
  } catch {
    return null
  }
}

/** Express middleware: verify the bearer token and attach the current user. */
export function createRequireAuth(database: Database, secret: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      next(unauthorized())
      return
    }
    const token = header.slice('Bearer '.length).trim()
    if (!token) {
      next(unauthorized())
      return
    }
    const payload = verifyToken(token, secret)
    if (!payload) {
      next(unauthorized('登录已过期，请重新登录'))
      return
    }
    const user = database.findUserById(payload.userId)
    if (!user) {
      next(unauthorized('登录已过期，请重新登录'))
      return
    }
    req.user = user
    next()
  }
}

/** Read the authenticated user; throws 401 when the middleware was not applied. */
export function currentUser(req: Request): User {
  if (!req.user) throw unauthorized()
  return req.user
}
