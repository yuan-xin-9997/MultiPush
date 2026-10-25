import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { LibraryBig, LogOut, Menu, Send, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import { cn } from '@/lib/utils'
import Avatar from './Avatar'
import Dropdown from './Dropdown'
import Logo from './Logo'
import './app-shell.css'

const NAV_ITEMS = [
  { to: '/library', label: '内容库', icon: LibraryBig, badge: null },
  { to: '/render', label: '智能渲染', icon: Sparkles, badge: null },
  { to: '/publish', label: '发布管理', icon: Send, badge: null },
] as const

export default function AppShell() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!mobileOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [mobileOpen])

  const displayName = user?.displayName || user?.username || '创作者'

  function handleLogout() {
    logout()
    toast.success('已退出登录')
    navigate('/login', { replace: true })
  }

  return (
    <div className="app-shell">
      <aside id="app-sidebar" className={cn('app-sidebar', mobileOpen && 'is-open')} aria-label="主导航">
        <div className="app-sidebar-inner">
          <div className="app-sidebar-brand">
            <Logo size={34} subtitle />
          </div>

          <button
            type="button"
            className="app-mobile-close"
            onClick={() => setMobileOpen(false)}
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>

          <nav className="app-nav">
            <span className="app-nav-label">工作台</span>
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => cn('app-nav-link', isActive && 'active')}
                  onClick={() => setMobileOpen(false)}
                >
                  <Icon size={18} />
                  <span className="app-nav-label-text">{item.label}</span>
                  {item.badge ? <span className="app-nav-badge">{item.badge}</span> : null}
                </NavLink>
              )
            })}
          </nav>

          <div className="app-sidebar-spacer" />

          <div className="app-sidebar-note">
            <span className="app-sidebar-note-icon">
              <Sparkles size={14} />
            </span>
            <div>
              <p className="app-sidebar-note-title">一次创作，多端适配</p>
              <p className="app-sidebar-note-text">支持公众号、知乎、小红书与抖音扫码连接和发布。</p>
            </div>
          </div>

          <div className="app-sidebar-footer">
            <Dropdown
              align="start"
              minWidth={210}
              trigger={
                <button type="button" className="app-user-trigger" aria-label="打开用户菜单">
                  <Avatar name={displayName} src={user?.avatarUrl} size="md" />
                  <span className="app-user-meta">
                    <span className="app-user-name">{displayName}</span>
                    <span className="app-user-sub">@{user?.username ?? 'multipush'}</span>
                  </span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="m7 9 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              }
              header={
                <div>
                  <div className="dropdown-header-title">{displayName}</div>
                  <div className="dropdown-header-sub">{user?.email ?? '—'}</div>
                </div>
              }
              items={[
                {
                  key: 'logout',
                  label: '退出登录',
                  icon: <LogOut size={16} />,
                  danger: true,
                  onSelect: handleLogout,
                },
              ]}
            />
          </div>
        </div>
      </aside>

      {mobileOpen ? (
        <button
          type="button"
          className="app-sidebar-overlay"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <div className="app-frame">
        <header className="app-mobile-bar">
          <button
            type="button"
            className="app-mobile-menu"
            onClick={() => setMobileOpen(true)}
            aria-label="打开导航"
            aria-controls="app-sidebar"
            aria-expanded={mobileOpen}
          >
            <Menu size={20} />
          </button>
          <Logo size={28} subtitle={false} />
          <Avatar name={displayName} src={user?.avatarUrl} size="sm" />
        </header>
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
