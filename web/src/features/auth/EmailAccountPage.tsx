import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { useAuth } from '@/contexts/AuthContext'
import AuthLayout from './AuthLayout'
import EmailCodeField from './EmailCodeField'

export default function EmailAccountPage({ mode }: { mode: 'bind' | 'reset' }) {
  const { setUser, user, logout } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError('')
    if (mode === 'reset' && password !== confirm) { setError('两次输入的密码不一致'); return }
    setBusy(true)
    try {
      if (mode === 'bind') {
        const result = await api.auth.bindEmail(email, code)
        setUser(result.user)
        navigate('/library', { replace: true })
      } else {
        await api.auth.resetPassword(email, code, password)
        logout()
        setSuccess(true)
      }
    } catch (error) { setError(getErrorMessage(error, '操作失败，请重试')) }
    finally { setBusy(false) }
  }
  return <AuthLayout>
    <div className="auth-form-head"><h1>{mode === 'bind' ? '绑定邮箱' : '找回密码'}</h1><p>{mode === 'bind' ? '验证邮箱后，可用于登录和找回密码。' : '验证已绑定的邮箱，设置新的登录密码。'}</p></div>
    {error && <div className="auth-error-banner" role="alert">{error}</div>}
    {success ? <p role="status">密码已重置，请使用新密码<Link to="/login">重新登录</Link>。</p> : mode === 'bind' && user?.email ? <p>已绑定邮箱：{user.email}</p> :
      <form className="auth-form" onSubmit={submit}>
        <div className="field"><label className="label" htmlFor="account-email">邮箱</label><input className="input" id="account-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => { setEmail(e.target.value); setCode('') }} /></div>
        <EmailCodeField email={email} purpose={mode} code={code} onChange={setCode} />
        {mode === 'reset' && <>
          <div className="field"><label className="label" htmlFor="new-password">新密码</label><input className="input" id="new-password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} /></div>
          <div className="field"><label className="label" htmlFor="confirm-password">确认新密码</label><input className="input" id="confirm-password" type="password" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} /></div>
        </>}
        <button className="btn btn-primary btn-block auth-submit" disabled={busy}>{busy ? '正在提交…' : mode === 'bind' ? '验证并绑定' : '重置密码'}</button>
      </form>}
    <p className="auth-switch"><Link to={mode === 'bind' ? '/library' : '/login'}>返回{mode === 'bind' ? '工作台' : '登录'}</Link></p>
  </AuthLayout>
}
