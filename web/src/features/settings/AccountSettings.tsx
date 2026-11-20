import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AtSign, CheckCircle2, LoaderCircle, Mail, ShieldCheck, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import { useServerInfo } from '@/contexts/ServerContext'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDate } from '@/lib/utils'
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

  useEffect(() => {
    setDisplayName(user?.displayName ?? '')
    setAvatarUrl(user?.avatarUrl ?? '')
  }, [user?.displayName, user?.avatarUrl])

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
