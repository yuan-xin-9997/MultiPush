import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CircleAlert, Eye, EyeOff, LoaderCircle, LockKeyhole, UserRound } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { ApiError } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { safeRedirect } from '@/lib/navigation'
import AuthLayout from './AuthLayout'

interface LoginForm {
  account: string
  password: string
}

type LoginErrors = Partial<Record<keyof LoginForm, string>>

function fieldErrorFromApi(error: unknown): LoginErrors {
  if (!(error instanceof ApiError) || !error.issues?.length) return {}
  const next: LoginErrors = {}
  for (const issue of error.issues) {
    if (issue.path.endsWith('account')) next.account = issue.message
    if (issue.path.endsWith('password')) next.password = issue.message
  }
  return next
}

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const redirect = searchParams.get('redirect')
  const registerHref = redirect ? `/register?redirect=${encodeURIComponent(redirect)}` : '/register'

  const [form, setForm] = useState<LoginForm>({ account: '', password: '' })
  const [errors, setErrors] = useState<LoginErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  function updateField(key: keyof LoginForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const nextErrors: LoginErrors = {}
    const account = form.account.trim()
    if (!account) nextErrors.account = '请输入用户名或邮箱'
    if (!form.password) nextErrors.password = '请输入密码'
    setErrors(nextErrors)
    setServerError(null)
    if (Object.keys(nextErrors).length > 0) return

    setSubmitting(true)
    try {
      await login({ account, password: form.password })
      navigate(safeRedirect(redirect), { replace: true })
    } catch (error) {
      setErrors(fieldErrorFromApi(error))
      setServerError(getErrorMessage(error, '登录失败，请检查账号和密码'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout>
      <div className="auth-form-head">
        <span className="auth-form-eyebrow">欢迎回来</span>
        <h1>登录 MultiPush</h1>
        <p>继续你的内容创作，把一篇稿子带到每个平台。</p>
      </div>

      {serverError ? (
        <div className="auth-error-banner" role="alert">
          <CircleAlert size={15} />
          <span>{serverError}</span>
        </div>
      ) : null}

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label className="label" htmlFor="login-account">
            账号
          </label>
          <div className="auth-input-wrap">
            <UserRound size={16} />
            <input
              id="login-account"
              className={`input${errors.account ? ' error' : ''}`}
              type="text"
              name="account"
              autoComplete="username"
              autoFocus
              placeholder="用户名或邮箱"
              value={form.account}
              onChange={(event) => updateField('account', event.target.value)}
              aria-invalid={Boolean(errors.account)}
              aria-describedby={errors.account ? 'login-account-error' : undefined}
            />
          </div>
          {errors.account ? (
            <p className="auth-field-error" id="login-account-error">
              {errors.account}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="label" htmlFor="login-password">
            密码
          </label>
          <div className="auth-input-wrap has-action">
            <LockKeyhole size={16} />
            <input
              id="login-password"
              className={`input${errors.password ? ' error' : ''}`}
              type={showPassword ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              placeholder="请输入密码"
              value={form.password}
              onChange={(event) => updateField('password', event.target.value)}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? 'login-password-error' : undefined}
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
              title={showPassword ? '隐藏密码' : '显示密码'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {errors.password ? (
            <p className="auth-field-error" id="login-password-error">
              {errors.password}
            </p>
          ) : null}
        </div>

        <button type="submit" className="btn btn-primary btn-block auth-submit" disabled={submitting}>
          {submitting ? <LoaderCircle size={17} className="spin" /> : null}
          {submitting ? '正在登录…' : '登录'}
          {!submitting ? <ArrowRight size={16} /> : null}
        </button>
      </form>

      <p className="auth-switch"><Link to="/forgot-password">忘记密码？</Link></p>
      <p className="auth-switch">
        还没有账号？<Link to={registerHref}>立即注册</Link>
      </p>

      <p className="auth-form-footnote">一次创作，渲染适配微信公众号、小红书、知乎与抖音。</p>
    </AuthLayout>
  )
}
