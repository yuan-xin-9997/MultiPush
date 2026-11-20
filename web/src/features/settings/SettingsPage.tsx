import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bot, ShieldCheck, UserRound } from 'lucide-react'
import AccountSettings from './AccountSettings'
import AiModelSettings from './AiModelSettings'
import ProviderSettings from './ProviderSettings'
import './settings.css'

type TabId = 'account' | 'ai' | 'providers'

const TABS: Array<{ id: TabId; label: string; description: string; icon: typeof UserRound }> = [
  { id: 'account', label: '账号与安全', description: '个人资料、邮箱和密码', icon: UserRound },
  { id: 'ai', label: '大模型', description: '账号级模型、接口和 Key', icon: Bot },
  { id: 'providers', label: '大模型高可用', description: '提供商池、Key 与回退', icon: ShieldCheck },
]

function normalizeTab(value: string | null): TabId {
  return value === 'ai' || value === 'providers' ? value : 'account'
}

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const active = useMemo(() => normalizeTab(searchParams.get('tab')), [searchParams])
  const current = TABS.find(tab => tab.id === active) ?? TABS[0]

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
          {TABS.map(tab => {
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
        </main>
      </div>
    </div>
  )
}
