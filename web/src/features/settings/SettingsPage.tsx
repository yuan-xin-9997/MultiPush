import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Activity, Bot, ShieldCheck, Ticket, UserRound } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import AccountSettings from './AccountSettings'
import InviteCodesSettings from './InviteCodesSettings'
import AiModelSettings from './AiModelSettings'
import ProviderSettings from './ProviderSettings'
import AiUsageSettings from './AiUsageSettings'
import './settings.css'

type TabId = 'account' | 'ai' | 'providers' | 'invites' | 'usage'

type SettingsTab = { id: TabId; label: string; description: string; icon: typeof UserRound }

const BASE_TABS: SettingsTab[] = [
  { id: 'account', label: '账号与安全', description: '个人资料、邮箱和密码', icon: UserRound },
  { id: 'ai', label: '大模型', description: '账号级模型、接口和 Key', icon: Bot },
  { id: 'providers', label: '大模型高可用', description: '提供商池、Key 与回退', icon: ShieldCheck },
]

const ADMIN_TABS: SettingsTab[] = [
  { id: 'invites', label: '邀请码', description: '注册邀请码与使用限制', icon: Ticket },
  { id: 'usage', label: 'AI 用量', description: '按账号统计大模型消耗', icon: Activity },
]

function normalizeTab(value: string | null, admin: boolean): TabId {
  if (admin && (value === 'invites' || value === 'usage')) return value
  return value === 'ai' || value === 'providers' ? value : 'account'
}

export default function SettingsPage() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const admin = user?.isAdmin === true
  const tabs = useMemo(() => admin ? [...BASE_TABS, ...ADMIN_TABS] : BASE_TABS, [admin])
  const active = useMemo(() => normalizeTab(searchParams.get('tab'), admin), [searchParams, admin])
  const current = tabs.find(tab => tab.id === active) ?? tabs[0]

  function selectTab(tab: TabId) {
    setSearchParams(tab === 'account' ? {} : { tab })
  }

  return (
    <div className="settings-page">
      <header className="settings-page-head">
        <div>
          <span className="settings-eyebrow">Settings</span>
          <h1>设置</h1>
          <p>账号、大模型接入和服务器提供商池都集中在这里管理。</p>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="设置分类">
          {tabs.map(tab => {
            const Icon = tab.icon
            return (
              <button key={tab.id} type="button" className={`settings-tab ${tab.id === active ? 'is-active' : ''}`} aria-current={tab.id === active ? 'page' : undefined} onClick={() => selectTab(tab.id)}>
                <Icon size={17} />
                <span><strong>{tab.label}</strong><small>{tab.description}</small></span>
              </button>
            )
          })}
        </nav>

        <main className="settings-content" aria-label={current.label}>
          {active === 'account' ? <AccountSettings /> : null}
          {active === 'ai' ? <AiModelSettings onOpenProviders={() => selectTab('providers')} /> : null}
          {active === 'providers' ? <ProviderSettings /> : null}
          {active === 'invites' && admin ? <InviteCodesSettings /> : null}
          {active === 'usage' && admin ? <AiUsageSettings /> : null}
        </main>
      </div>
    </div>
  )
}
