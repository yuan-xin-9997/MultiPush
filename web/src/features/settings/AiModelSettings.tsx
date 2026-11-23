import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, KeyRound, LoaderCircle, Server, ShieldCheck, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { AiSettings } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { routeReasonLabel } from '@/features/ai/ai-labels'
import ConfirmDialog from '@/components/ConfirmDialog'

const OPENCODE_GO = { baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'deepseek-v4.1-flash', label: 'OpenCode Go' }

interface AiModelSettingsProps {
  onOpenProviders: () => void
}

export default function AiModelSettings({ onOpenProviders }: AiModelSettingsProps) {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '', temperature: 0.7 })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.ai.settings()
      setSettings(result.settings)
      setForm({ baseUrl: result.settings.baseUrl, model: result.settings.model, apiKey: '', temperature: result.settings.temperature })
      setError('')
    } catch (cause) {
      setError(getErrorMessage(cause, '读取大模型配置失败'))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function save(test = false) {
    setError('')
    setSaving(true)
    try {
      const result = await api.ai.saveSettings({
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        temperature: form.temperature,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      })
      setSettings(result.settings)
      setForm(current => ({ ...current, apiKey: '' }))
      if (test) {
        setTesting(true)
        try {
          const testResult = await api.ai.testSettings()
          const routing = testResult.routing
          const target = routing ? `${routing.providerLabel} · ${routing.model}` : (testResult.model || result.settings.model)
          if (routing?.fallback && result.settings.source === 'user') {
            toast.warning(`连接成功，但账号 Key 不可用，已自动使用 ${routing.providerLabel} / ${routing.keyLabel}（${routeReasonLabel(routing.reason)}）`)
          } else if (routing?.fallback) {
            toast.warning(`连接成功（已使用备用路由 ${target} / ${routing.keyLabel}）`)
          } else {
            toast.success(`连接成功：${target}`)
          }
        } finally { setTesting(false) }
      } else {
        toast.success('大模型配置已保存')
      }
    } catch (cause) {
      setError(getErrorMessage(cause, '保存大模型配置失败'))
    } finally { setSaving(false) }
  }

  async function clearSettings() {
    setClearing(true)
    try {
      await api.ai.deleteSettings()
      await load()
      setConfirmClear(false)
      toast.success('已清除账号自定义大模型配置')
    } catch (cause) {
      setError(getErrorMessage(cause, '清除配置失败'))
    } finally { setClearing(false) }
  }

  return (
    <div className="settings-sections">
      <section className="settings-card">
        <header className="settings-card-head">
          <div><h2>账号自定义大模型</h2><p>仅对当前账号生效，优先于服务器提供商池；服务器池仅管理员可用，普通账号需要配置自己的 API Key。</p></div>
          <Sparkles size={18} />
        </header>

        {loading ? <div className="settings-loading"><LoaderCircle size={16} className="spin" />正在读取配置…</div> : (
          <>
            <div className="settings-provider-summary">
              <span className={`settings-source-badge ${settings?.source === 'user' ? 'is-user' : ''}`}>
                {settings?.source === 'user' ? <KeyRound size={12} /> : <Server size={12} />}
                {settings?.source === 'user' ? '当前使用账号配置' : settings?.source === 'server' ? '当前使用服务器提供商池' : '尚未配置'}
              </span>
              {settings?.configured ? (
                <span>
                  {settings.label ? `${settings.label} · ` : ''}{settings.model}
                  {settings.keys ? ` · ${settings.providers ?? 1} 个提供商 / ${settings.keys} 个 Key` : ''}
                  {settings.fallback ? ' · 自动回退已启用' : ''}
                </span>
              ) : <span>{settings?.serverPoolAvailable === false ? '服务器池仅管理员可用，请配置自己的 API Key' : '还没有任何可用的大模型配置'}</span>}
            </div>

            <div className="settings-preset">
              <button type="button" className="btn btn-sm" onClick={() => setForm(current => ({ ...current, baseUrl: OPENCODE_GO.baseUrl, model: OPENCODE_GO.model }))}>
                <Sparkles size={13} />使用 OpenCode Go
              </button>
              <small>接口：{OPENCODE_GO.baseUrl} · 模型：{OPENCODE_GO.model}</small>
            </div>

            <div className="settings-form-grid">
              <label className="field">
                <span className="label">接口地址</span>
                <input className="input" type="url" value={form.baseUrl} placeholder="https://api.deepseek.com/v1" onChange={event => setForm(current => ({ ...current, baseUrl: event.target.value }))} disabled={saving || testing} />
              </label>
              <label className="field">
                <span className="label">模型名称</span>
                <input className="input" value={form.model} placeholder="deepseek-chat" onChange={event => setForm(current => ({ ...current, model: event.target.value }))} disabled={saving || testing} />
              </label>
              <label className="field">
                <span className="label">API Key</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={form.apiKey}
                  placeholder={settings?.source === 'server' ? '留空沿用服务器 Key（须同一接口地址）' : settings?.hasApiKey ? '已保存，留空表示不修改' : 'sk-…'}
                  onChange={event => setForm(current => ({ ...current, apiKey: event.target.value }))}
                  disabled={saving || testing}
                />
              </label>
              <label className="field">
                <span className="label">温度</span>
                <input className="input" type="number" min={0} max={2} step={0.1} value={form.temperature} onChange={event => setForm(current => ({ ...current, temperature: Number(event.target.value) }))} disabled={saving || testing} />
                <span className="hint">0 更稳定，1 更有创造性</span>
              </label>
            </div>

            <p className="settings-inline-note">
              <CheckCircle2 size={13} />
              API Key 加密保存在当前账号，页面不会显示明文；留空沿用服务器 Key 时，接口地址必须与服务器默认地址一致。
            </p>
            {error ? <p className="settings-error" role="alert">{error}</p> : null}

            <div className="settings-actions settings-actions-wrap">
              {settings?.source === 'user' ? (
                <button type="button" className="btn btn-ghost settings-danger" onClick={() => setConfirmClear(true)} disabled={saving || testing}>
                  清除账号配置
                </button>
              ) : null}
              <span className="settings-actions-spacer" />
              <button type="button" className="btn" onClick={onOpenProviders}><ShieldCheck size={14} />配置提供商池</button>
              <button type="button" className="btn" onClick={() => void save(true)} disabled={saving || testing}>
                {testing ? <LoaderCircle size={14} className="spin" /> : null}保存并测试
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void save(false)} disabled={saving || testing}>
                {saving ? <LoaderCircle size={14} className="spin" /> : null}保存
              </button>
            </div>
          </>
        )}
      </section>

      <section className="settings-card settings-card-soft">
        <header className="settings-card-head">
          <div><h2>服务器提供商池</h2><p>所有未单独配置的账号都会按优先级和回退链使用这里的提供商与 Key。</p></div>
          <Server size={18} />
        </header>
        <p className="settings-inline-note">
          提供商、Key、模型映射、冷却和探活参数都在「大模型高可用」页统一管理。账号自定义 Key 失效时，仍会自动回退到服务器池。
        </p>
        <div className="settings-actions">
          <button type="button" className="btn" onClick={onOpenProviders}>前往大模型高可用</button>
        </div>
      </section>

      <ConfirmDialog
        open={confirmClear}
        title="清除账号自定义配置？"
        description={<><strong>{settings?.model}</strong><p>清除后当前账号会直接使用服务器提供商池，API Key 不再保存在账号配置中。</p></>}
        confirmLabel="清除配置"
        loading={clearing}
        onConfirm={clearSettings}
        onClose={() => setConfirmClear(false)}
      />
    </div>
  )
}
