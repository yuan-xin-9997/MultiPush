import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AtSign, CheckCircle2, Copy, KeyRound, LoaderCircle, Mail, ShieldCheck, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import { useServerInfo } from '@/contexts/ServerContext'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDate } from '@/lib/utils'
import type { TwoFactorSetup, TwoFactorStatus } from '@shared/types'
import Avatar from '@/components/Avatar'

export default function AccountSettings() {
  const { user, setUser, logout } = useAuth()
  const navigate = useNavigate()
  const { desktopMode, version } = useServerInfo()
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? '')
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [password, setPassword] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [twoFactor, setTwoFactor] = useState<TwoFactorStatus | null>(null)
  const [twoFactorSetup, setTwoFactorSetup] = useState<TwoFactorSetup | null>(null)
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [twoFactorPassword, setTwoFactorPassword] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [twoFactorBusy, setTwoFactorBusy] = useState(false)
  const [twoFactorError, setTwoFactorError] = useState('')

  useEffect(() => {
    setDisplayName(user?.displayName ?? '')
    setAvatarUrl(user?.avatarUrl ?? '')
  }, [user?.displayName, user?.avatarUrl])

  useEffect(() => {
    let active = true
    api.auth.twoFactorStatus()
      .then(result => { if (active) setTwoFactor(result.twoFactor) })
      .catch(() => { if (active) setTwoFactor(null) })
    return () => { active = false }
  }, [])

  async function beginTwoFactorSetup() {
    setTwoFactorError('')
    setTwoFactorBusy(true)
    try {
      const result = await api.auth.setupTwoFactor()
      setTwoFactorSetup(result.setup)
      setRecoveryCodes(null)
      setTwoFactorCode('')
    } catch (cause) {
      setTwoFactorError(getErrorMessage(cause, '生成两步验证密钥失败'))
    } finally { setTwoFactorBusy(false) }
  }

  async function enableTwoFactor(event: React.FormEvent) {
    event.preventDefault()
    if (!twoFactorCode.trim()) { setTwoFactorError('请输入身份验证器中的 6 位验证码'); return }
    setTwoFactorError('')
    setTwoFactorBusy(true)
    try {
      const result = await api.auth.enableTwoFactor(twoFactorCode.trim())
      setTwoFactor(result.twoFactor)
      setRecoveryCodes(result.recoveryCodes)
      setTwoFactorSetup(null)
      setTwoFactorCode('')
      toast.success('两步验证已开启，请保存恢复码')
    } catch (cause) {
      setTwoFactorError(getErrorMessage(cause, '开启两步验证失败'))
    } finally { setTwoFactorBusy(false) }
  }

  async function disableTwoFactor(event: React.FormEvent) {
    event.preventDefault()
    if (!twoFactorPassword) { setTwoFactorError('请输入当前密码'); return }
    if (!twoFactorCode.trim()) { setTwoFactorError('请输入动态验证码或恢复码'); return }
    setTwoFactorError('')
    setTwoFactorBusy(true)
    try {
      const result = await api.auth.disableTwoFactor(twoFactorPassword, twoFactorCode.trim())
      setTwoFactor(result.twoFactor)
      setRecoveryCodes(null)
      setTwoFactorPassword('')
      setTwoFactorCode('')
      toast.success('两步验证已关闭')
    } catch (cause) {
      setTwoFactorError(getErrorMessage(cause, '关闭两步验证失败'))
    } finally { setTwoFactorBusy(false) }
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label}已复制`)
    } catch {
      toast.error('复制失败，请手动选择文本')
    }
  }


  async function saveProfile(event: React.FormEvent) {
    event.preventDefault()
    setProfileError('')
    const name = displayName.trim()
    if (!name) { setProfileError('请填写显示名称'); return }
    setProfileSaving(true)
    try {
      const result = await api.auth.updateProfile({
        displayName: name,
        avatarUrl: avatarUrl.trim() || null,
      })
      setUser(result.user)
      toast.success('个人资料已保存')
    } catch (cause) {
      setProfileError(getErrorMessage(cause, '保存个人资料失败'))
    } finally { setProfileSaving(false) }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault()
    setPasswordError('')
    if (!password.currentPassword) { setPasswordError('请输入当前密码'); return }
    if (password.newPassword.length < 8) { setPasswordError('新密码至少 8 位'); return }
    if (password.newPassword !== password.confirmPassword) { setPasswordError('两次输入的新密码不一致'); return }
    setPasswordSaving(true)
    try {
      await api.auth.changePassword({ currentPassword: password.currentPassword, newPassword: password.newPassword })
      setPassword({ currentPassword: '', newPassword: '', confirmPassword: '' })
      logout()
      toast.success('密码已修改，请重新登录')
      navigate('/login', { replace: true })
    } catch (cause) {
      setPasswordError(getErrorMessage(cause, '修改密码失败'))
    } finally { setPasswordSaving(false) }
  }

  return (
    <div className="settings-sections">
      <section className="settings-card">
        <header className="settings-card-head">
          <div><h2>个人资料</h2><p>显示名称和头像会出现在界面与发布记录中。</p></div>
          <UserRound size={18} />
        </header>
        <form className="settings-form" onSubmit={event => void saveProfile(event)}>
          <div className="settings-profile-row">
            <Avatar name={displayName || user?.username || '创作者'} src={avatarUrl || null} size="lg" />
            <div className="settings-profile-fields">
              <label className="field">
                <span className="label">显示名称</span>
                <input className="input" value={displayName} maxLength={60} onChange={event => setDisplayName(event.target.value)} disabled={profileSaving} />
              </label>
              <label className="field">
                <span className="label">头像地址 <span className="optional">可选</span></span>
                <input className="input" type="url" value={avatarUrl} placeholder="https://…" onChange={event => setAvatarUrl(event.target.value)} disabled={profileSaving} />
              </label>
            </div>
          </div>
          {profileError ? <p className="settings-error" role="alert">{profileError}</p> : null}
          <div className="settings-actions">
            <button type="submit" className="btn btn-primary" disabled={profileSaving}>
              {profileSaving ? <LoaderCircle size={14} className="spin" /> : null}保存资料
            </button>
          </div>
        </form>
      </section>

      <section className="settings-card">
        <header className="settings-card-head">
          <div><h2>账号</h2><p>登录账号与邮箱信息。</p></div>
          <AtSign size={18} />
        </header>
        <dl className="settings-facts">
          <div><dt>用户名</dt><dd>@{user?.username ?? '—'}</dd></div>
          <div><dt>邮箱</dt><dd>{user?.email ?? '未绑定'}</dd></div>
          <div><dt>注册时间</dt><dd>{formatDate(user?.createdAt)}</dd></div>
          <div><dt>系统版本</dt><dd>{version || '—'}{desktopMode ? ' · 本地桌面版' : ''}</dd></div>
        </dl>
        {!desktopMode && !user?.email ? (
          <p className="settings-inline-note"><Mail size={13} />当前账号还没有绑定邮箱，绑定后可用于找回密码。<Link className="btn-link" to="/bind-email">立即绑定</Link></p>
        ) : null}
        {desktopMode ? <p className="settings-inline-note"><ShieldCheck size={13} />本地桌面版账号无需邮箱验证，数据保存在本机。</p> : null}
      </section>

      <section className="settings-card">
        <header className="settings-card-head">
          <div><h2>两步验证</h2><p>登录时额外要求动态验证码，降低密码泄露后的账号风险。</p></div>
          <KeyRound size={18} />
        </header>
        {twoFactor?.enabled ? (
          <div className="settings-form">
            <p className="settings-inline-note"><ShieldCheck size={13} />两步验证已开启，剩余恢复码 {twoFactor.recoveryCodesLeft} 个。</p>
            {recoveryCodes ? (
              <div>
                <p className="hint">请立即保存以下恢复码（每个只能使用一次）：</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 16px', padding: 12, borderRadius: 10, background: 'var(--surface-2, #f5f5f4)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}>
                  {recoveryCodes.map(code => <span key={code}>{code}</span>)}
                </div>
                <div className="settings-actions">
                  <button type="button" className="btn" onClick={() => void copyText(recoveryCodes.join('\n'), '恢复码')}><Copy size={14} />复制全部</button>
                  <button type="button" className="btn" onClick={() => setRecoveryCodes(null)}>我已保存</button>
                </div>
              </div>
            ) : null}
            <form className="settings-form-grid" onSubmit={event => void disableTwoFactor(event)}>
              <label className="field">
                <span className="label">当前密码</span>
                <input className="input" type="password" autoComplete="current-password" value={twoFactorPassword} onChange={event => setTwoFactorPassword(event.target.value)} disabled={twoFactorBusy} />
              </label>
              <label className="field">
                <span className="label">动态验证码或恢复码</span>
                <input className="input" inputMode="numeric" autoComplete="one-time-code" value={twoFactorCode} onChange={event => setTwoFactorCode(event.target.value)} disabled={twoFactorBusy} />
              </label>
              {twoFactorError ? <p className="settings-error" role="alert">{twoFactorError}</p> : null}
              <div className="settings-actions">
                <button type="submit" className="btn" disabled={twoFactorBusy}>关闭两步验证</button>
              </div>
            </form>
          </div>
        ) : twoFactorSetup ? (
          <form className="settings-form" onSubmit={event => void enableTwoFactor(event)}>
            <p className="hint">在身份验证器（1Password、Google Authenticator、Microsoft Authenticator 等）中手动添加以下密钥，然后输入生成的 6 位验证码。</p>
            <label className="field">
              <span className="label">密钥</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" readOnly value={twoFactorSetup.secret} onFocus={event => event.currentTarget.select()} />
                <button type="button" className="btn" onClick={() => void copyText(twoFactorSetup.secret, '密钥')}><Copy size={14} />复制</button>
              </div>
            </label>
            <label className="field">
              <span className="label">验证码</span>
              <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={twoFactorCode} onChange={event => setTwoFactorCode(event.target.value)} disabled={twoFactorBusy} />
            </label>
            {twoFactorError ? <p className="settings-error" role="alert">{twoFactorError}</p> : null}
            <div className="settings-actions">
              <button type="submit" className="btn btn-primary" disabled={twoFactorBusy}>{twoFactorBusy ? '正在验证…' : '验证并开启'}</button>
              <button type="button" className="btn" onClick={() => { setTwoFactorSetup(null); setTwoFactorCode(''); setTwoFactorError('') }}>取消</button>
            </div>
          </form>
        ) : (
          <div className="settings-form">
            <p className="settings-inline-note"><ShieldCheck size={13} />尚未开启。开启后，每次登录都需要输入身份验证器中的动态验证码。</p>
            {twoFactorError ? <p className="settings-error" role="alert">{twoFactorError}</p> : null}
            <div className="settings-actions">
              <button type="button" className="btn btn-primary" disabled={twoFactorBusy} onClick={() => void beginTwoFactorSetup()}>{twoFactorBusy ? '正在生成…' : '开启两步验证'}</button>
            </div>
          </div>
        )}
      </section>

      <section className="settings-card">
        <header className="settings-card-head">
          <div><h2>修改密码</h2><p>修改后所有设备（包括当前设备）都需要重新登录。</p></div>
          <CheckCircle2 size={18} />
        </header>
        <form className="settings-form" onSubmit={event => void changePassword(event)}>
          <div className="settings-form-grid">
            <label className="field">
              <span className="label">当前密码</span>
              <input className="input" type="password" autoComplete="current-password" value={password.currentPassword} onChange={event => setPassword(current => ({ ...current, currentPassword: event.target.value }))} disabled={passwordSaving} />
            </label>
            <label className="field">
              <span className="label">新密码</span>
              <input className="input" type="password" autoComplete="new-password" value={password.newPassword} onChange={event => setPassword(current => ({ ...current, newPassword: event.target.value }))} disabled={passwordSaving} />
            </label>
            <label className="field">
              <span className="label">确认新密码</span>
              <input className="input" type="password" autoComplete="new-password" value={password.confirmPassword} onChange={event => setPassword(current => ({ ...current, confirmPassword: event.target.value }))} disabled={passwordSaving} />
            </label>
          </div>
          {passwordError ? <p className="settings-error" role="alert">{passwordError}</p> : null}
          <div className="settings-actions">
            <button type="submit" className="btn btn-primary" disabled={passwordSaving}>
              {passwordSaving ? <LoaderCircle size={14} className="spin" /> : null}修改密码
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
