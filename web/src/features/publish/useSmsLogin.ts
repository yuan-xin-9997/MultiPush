import { useCallback, useEffect, useRef, useState } from 'react'
import type { SmsLogin, SmsLoginPlatform } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'

interface UseSmsLoginOptions {
  platform: SmsLoginPlatform
  onConnected: (login: SmsLogin) => void | Promise<void>
}

export interface SmsLoginController {
  open: boolean
  login: SmsLogin | null
  busy: boolean
  error: string
  openModal: () => void
  close: () => void
  reset: () => void
  start: (phone: string) => Promise<void>
  verify: (code: string) => Promise<void>
}

/**
 * Owns one SMS login attempt for a publish page. The backend keeps the
 * platform browser alive between "send code" and "verify code"; closing the
 * modal cancels that browser so no stale session lingers.
 */
export function useSmsLogin({ platform, onConnected }: UseSmsLoginOptions): SmsLoginController {
  const [open, setOpen] = useState(false)
  const [login, setLogin] = useState<SmsLogin | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const loginRef = useRef<SmsLogin | null>(null)
  const openRef = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => { loginRef.current = login }, [login])

  useEffect(() => { openRef.current = open }, [open])

  useEffect(() => () => {
    const current = loginRef.current
    if (current && current.status !== 'connected') {
      void api.platformSms.cancel(platform, current.id).catch(() => {})
    }
  }, [platform])

  const cancel = useCallback((current: SmsLogin | null) => {
    if (current && current.status !== 'connected') {
      void api.platformSms.cancel(platform, current.id).catch(() => {})
    }
  }, [platform])

  const openModal = useCallback(() => {
    setLogin(null)
    setError('')
    setOpen(true)
  }, [])

  const reset = useCallback(() => {
    cancel(loginRef.current)
    setLogin(null)
    setError('')
  }, [cancel])

  const close = useCallback(() => {
    cancel(loginRef.current)
    setOpen(false)
    setLogin(null)
    setError('')
  }, [cancel])

  const start = useCallback(async (phone: string) => {
    setBusy(true)
    setError('')
    try {
      const { login: next } = await api.platformSms.start(platform, phone)
      if (!mounted.current) return
      if (!openRef.current) {
        void api.platformSms.cancel(platform, next.id).catch(() => {})
        return
      }
      setLogin(next)
      if (next.status === 'connected') {
        await onConnected(next)
        if (mounted.current) setOpen(false)
      } else if (next.status === 'failed' || next.status === 'expired') {
        setError(next.message)
      }
    } catch (cause) {
      if (mounted.current) setError(getErrorMessage(cause, '发送验证码失败，请稍后重试'))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [onConnected, platform])

  const verify = useCallback(async (code: string) => {
    const current = loginRef.current
    if (!current) return
    setBusy(true)
    setError('')
    try {
      const { login: next } = await api.platformSms.verify(platform, current.id, code)
      if (!mounted.current) return
      setLogin(next)
      if (next.status === 'connected') {
        await onConnected(next)
        if (mounted.current) setOpen(false)
      } else if (next.status === 'failed' || next.status === 'expired') {
        setError(next.message)
      } else if (next.status === 'waiting') {
        setError(next.message)
      }
    } catch (cause) {
      if (mounted.current) setError(getErrorMessage(cause, '验证码验证失败，请稍后重试'))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [onConnected, platform])

  return { open, login, busy, error, openModal, close, reset, start, verify }
}
