import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  CircleAlert,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Mail,
  UserRound,
  Smile,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { ApiError } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { safeRedirect } from '@/lib/navigation'
import AuthLayout from './AuthLayout'

interface RegisterForm {
  username: string
  email: string
  password: string
  confirmPassword: string
  displayName: string
}

type RegisterErrors = Partial<Record<keyof RegisterForm, string>>

const USERNAME_PATTERN = /^[A-Za-z0-9_\u3400-\u9fff]{3,24}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function fieldErrorFromApi(error: unknown): RegisterErrors {
  if (!(error instanceof ApiError) || !error.issues?.length) return {}
  const next: RegisterErrors = {}
  for (const issue of error.issues) {
    if (issue.path.endsWith('username')) next.username = issue.message
    else if (issue.path.endsWith('email')) next.email = issue.message
    else if (issue.path.endsWith('password')) next.password = issue.message
    else if (issue.path.endsWith('displayName')) next.displayName = issue.message
  }
  return next
}

export default function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const redirect = searchParams.get('redirect')
  const loginHref = redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : '/login'

  const [form, setForm] = useState<RegisterForm>({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    displayName: '',
  })
  const [errors, setErrors] = useState<RegisterErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  function updateField(key: keyof RegisterForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const nextErrors: RegisterErrors = {}
    const username = form.username.trim()
    const email = form.email.trim()
    const displayName = form.displayName.trim()

    if (!username) nextErrors.username = '请输入用户名'
    else if (!USERNAME_PATTERN.test(username)) {
      nextErrors.username = '用户名为 3–24 个字符，仅支持字母、数字、下划线和汉字'
    }

    if (!email) nextErrors.email = '请输入邮箱'
    else if (!EMAIL_PATTERN.test(email)) nextErrors.email = '请输入有效的邮箱地址'

    if (!form.password) nextErrors.password = '请设置密码'
    else if (form.password.length < 8) nextErrors.password = '密码至少 8 个字符'

    if (!form.confirmPassword) nextErrors.confirmPassword = '请再次输入密码'
    else if (form.password !== form.confirmPassword) nextErrors.confirmPassword = '两次输入的密码不一致'

    setErrors(nextErrors)
    setServerError(null)
    if (Object.keys(nextErrors).length > 0) return

    setSubmitting(true)
    try {
      await register({
        username,
        email,
        password: form.password,
        displayName: displayName || undefined,
      })
      navigate(safeRedirect(redirect), { replace: true })
    } catch (error) {
      setErrors(fieldErrorFromApi(error))
      setServerError(getErrorMessage(error, '注册失败，请稍后重试'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout>
      <div className="auth-form-head">
        <span className="auth-form-eyebrow">开始创作</span>
        <h1>创建你的账号</h1>
        <p>注册后即可建立知识库、导入旧稿，并尝试四平台渲染。</p>
      </div>

      {serverError ? (
        <div className="auth-error-banner" role="alert">
          <CircleAlert size={15} />
          <span>{serverError}</span>
        </div>
      ) : null}

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label className="label" htmlFor="register-username">
            用户名
          </label>
          <div className="auth-input-wrap">
            <UserRound size={16} />
            <input
              id="register-username"
              className={`input${errors.username ? ' error' : ''}`}
              type="text"
              name="username"
              autoComplete="username"
              autoFocus
              placeholder="3–24 个字符"
              value={form.username}
              onChange={(event) => updateField('username', event.target.value)}
              aria-invalid={Boolean(errors.username)}
              aria-describedby={errors.username ? 'register-username-error' : 'register-username-hint'}
            />
          </div>
          {errors.username ? (
            <p className="auth-field-error" id="register-username-error">
              {errors.username}
            </p>
          ) : (
            <p className="hint" id="register-username-hint">
              支持字母、数字、下划线和汉字
            </p>
          )}
        </div>

        <div className="field">
          <label className="label" htmlFor="register-email">
            邮箱
          </label>
          <div className="auth-input-wrap">
            <Mail size={16} />
            <input
              id="register-email"
              className={`input${errors.email ? ' error' : ''}`}
              type="email"
              name="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={form.email}
              onChange={(event) => updateField('email', event.target.value)}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? 'register-email-error' : undefined}
            />
          </div>
          {errors.email ? (
            <p className="auth-field-error" id="register-email-error">
              {errors.email}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="label" htmlFor="register-password">
            密码
          </label>
          <div className="auth-input-wrap has-action">
            <LockKeyhole size={16} />
            <input
              id="register-password"
              className={`input${errors.password ? ' error' : ''}`}
              type={showPassword ? 'text' : 'password'}
              name="password"
              autoComplete="new-password"
              placeholder="至少 8 个字符"
              value={form.password}
              onChange={(event) => updateField('password', event.target.value)}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? 'register-password-error' : 'register-password-hint'}
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
            <p className="auth-field-error" id="register-password-error">
              {errors.password}
            </p>
          ) : (
            <p className="hint" id="register-password-hint">
              建议使用字母、数字和符号的组合
            </p>
          )}
        </div>

        <div className="field">
          <label className="label" htmlFor="register-confirm">
            确认密码
          </label>
          <div className="auth-input-wrap has-action">
            <LockKeyhole size={16} />
            <input
              id="register-confirm"
              className={`input${errors.confirmPassword ? ' error' : ''}`}
              type={showConfirm ? 'text' : 'password'}
              name="confirmPassword"
              autoComplete="new-password"
              placeholder="再次输入密码"
              value={form.confirmPassword}
              onChange={(event) => updateField('confirmPassword', event.target.value)}
              aria-invalid={Boolean(errors.confirmPassword)}
              aria-describedby={errors.confirmPassword ? 'register-confirm-error' : undefined}
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowConfirm((value) => !value)}
              aria-label={showConfirm ? '隐藏确认密码' : '显示确认密码'}
              title={showConfirm ? '隐藏确认密码' : '显示确认密码'}
            >
              {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {errors.confirmPassword ? (
            <p className="auth-field-error" id="register-confirm-error">
              {errors.confirmPassword}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="label" htmlFor="register-display-name">
            昵称 <span className="optional">选填</span>
          </label>
          <div className="auth-input-wrap">
            <Smile size={16} />
            <input
              id="register-display-name"
              className={`input${errors.displayName ? ' error' : ''}`}
              type="text"
              name="displayName"
              autoComplete="nickname"
              placeholder="展示在导航与渲染署名中"
              maxLength={30}
              value={form.displayName}
              onChange={(event) => updateField('displayName', event.target.value)}
              aria-invalid={Boolean(errors.displayName)}
              aria-describedby={errors.displayName ? 'register-display-name-error' : undefined}
            />
          </div>
          {errors.displayName ? (
            <p className="auth-field-error" id="register-display-name-error">
              {errors.displayName}
            </p>
          ) : null}
        </div>

        <button type="submit" className="btn btn-primary btn-block auth-submit" disabled={submitting}>
          {submitting ? <LoaderCircle size={17} className="spin" /> : null}
          {submitting ? '正在创建账号…' : '注册并开始创作'}
          {!submitting ? <ArrowRight size={16} /> : null}
        </button>
      </form>

      <p className="auth-switch">
        已有账号？<Link to={loginHref}>直接登录</Link>
      </p>

      <p className="auth-form-footnote">账号仅用于保存你的内容与渲染记录，数据按用户严格隔离。</p>
    </AuthLayout>
  )
}
