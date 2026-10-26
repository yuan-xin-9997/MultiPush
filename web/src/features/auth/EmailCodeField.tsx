import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'

export default function EmailCodeField({ email, purpose, code, onChange }: {
  email: string; purpose: 'register' | 'bind' | 'reset'; code: string; onChange: (code: string) => void
}) {
  const [until, setUntil] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    const tick = () => setSeconds(Math.max(0, Math.ceil((until - Date.now()) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [until])
  async function send() {
    setSending(true)
    setMessage('')
    try {
      await api.auth.sendEmailCode(email, purpose)
      setUntil(Date.now() + 60000)
      setMessage(purpose === 'reset' ? '如果该邮箱已注册，验证码将发送至邮箱，请检查收件箱或垃圾邮件。' : '验证码已发送，10 分钟内有效，请检查收件箱或垃圾邮件。')
    } catch (error) { setMessage(getErrorMessage(error, '发送失败')) }
    finally { setSending(false) }
  }
  return <div className="field">
    <label className="label" htmlFor="email-code">邮箱验证码</label>
    <div style={{ display: 'flex', gap: 8 }}>
      <input className="input" id="email-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" required value={code} onChange={e => onChange(e.target.value)} placeholder="六位验证码" />
      <button className="btn" type="button" disabled={sending || seconds > 0 || !email.trim()} onClick={() => void send()} style={{ whiteSpace: 'nowrap' }}>{sending ? '发送中…' : seconds ? `${seconds} 秒后重发` : '发送验证码'}</button>
    </div>
    {message && <p className="hint" role="status">{message}</p>}
  </div>
}
