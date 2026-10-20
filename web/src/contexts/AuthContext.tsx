import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { LoginInput, RegisterInput, User } from '@shared/types'
import { api, setAuthToken, getAuthToken } from '@/lib/api'

interface AuthContextValue {
  user: User | null
  token: string | null
  loading: boolean
  login: (input: LoginInput) => Promise<User>
  register: (input: RegisterInput) => Promise<User>
  logout: () => void
  refreshUser: () => Promise<User | null>
  setUser: (user: User | null) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(() => getAuthToken())
  const [loading, setLoading] = useState(true)

  const applySession = useCallback((nextToken: string | null, nextUser: User | null) => {
    setAuthToken(nextToken)
    setToken(nextToken)
    setUser(nextUser)
  }, [])

  const refreshUser = useCallback(async () => {
    if (!getAuthToken()) {
      setUser(null)
      return null
    }
    try {
      const result = await api.auth.me()
      setUser(result.user)
      return result.user
    } catch {
      applySession(null, null)
      return null
    }
  }, [applySession])

  useEffect(() => {
    let active = true
    const boot = async () => {
      const current = getAuthToken()
      if (!current) {
        if (active) setLoading(false)
        return
      }
      try {
        const result = await api.auth.me()
        if (active) setUser(result.user)
      } catch {
        if (active) applySession(null, null)
      } finally {
        if (active) setLoading(false)
      }
    }
    void boot()
    return () => {
      active = false
    }
  }, [applySession])

  useEffect(() => {
    const onUnauthorized = () => {
      setToken(null)
      setUser(null)
    }
    window.addEventListener('multipush:unauthorized', onUnauthorized)
    return () => window.removeEventListener('multipush:unauthorized', onUnauthorized)
  }, [])

  const login = useCallback(
    async (input: LoginInput) => {
      const result = await api.auth.login(input)
      applySession(result.token, result.user)
      return result.user
    },
    [applySession],
  )

  const register = useCallback(
    async (input: RegisterInput) => {
      const result = await api.auth.register(input)
      applySession(result.token, result.user)
      return result.user
    },
    [applySession],
  )

  const logout = useCallback(() => {
    applySession(null, null)
  }, [applySession])

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, loading, login, register, logout, refreshUser, setUser }),
    [user, token, loading, login, register, logout, refreshUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>')
  return context
}
