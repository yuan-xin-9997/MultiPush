import type { User } from '../../shared/types'

declare global {
  namespace Express {
    interface Request {
      /** Populated by the requireAuth middleware (never contains a password hash). */
      user?: User
    }
  }
}

export {}
