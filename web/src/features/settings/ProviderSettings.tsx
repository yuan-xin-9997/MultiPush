import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, Clock3, KeyRound, LoaderCircle, Plus, RefreshCw, Server, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { AiGatewayKeyStatus, AiGatewayStatus, AiProviderPoolInput, AiProviderPoolView } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import AiGatewayPanel from '@/features/ai/AiGatewayPanel'

interface DraftKey {
  id: string
  label: string
  maskedKey: string
  baseUrl: string
  enabled: boolean
  apiKey: string
  original: boolean
}

interface DraftProvider {
  id: string
  label: string
  baseUrl: string
  defaultModel: string
  modelsText: string
  highAvailability: boolean
  keys: DraftKey[]
  original: boolean
}

interface DraftPool {
  providers: DraftProvider[]
  probeMinutes: number
  maxProviderFailures: number
  cooldownMinutes: { quota: number; auth: number; rateLimit: number; transient: number; provider: number }
  modelMapText: string
}

const KEY_STATE_LABEL: Record<AiGatewayKeyStatus['state'], string> = {
  available: '可用',
  cooling: '冷却中',
  exhausted: '额度不足',
  invalid: '失效',
}

const COOLDOWN_FIELDS: Array<{ key: keyof DraftPool['cooldownMinutes']; label: string; hint: string }> = [
  { key: 'quota', label: '额度不足冷却', hint: 'Key 额度耗尽后等待多久再探活' },
  { key: 'auth', label: '认证失效冷却', hint: '401/403 后等待多久再探活' },
  { key: 'rateLimit', label: '限流冷却', hint: '429 限流后的短暂轮换窗口' },
  { key: 'transient', label: '网络/5xx 冷却', hint: '临时异常后的冷却时间' },
  { key: 'provider', label: '提供商熔断', hint: '整个提供商不可用时的冷却时间' },
]

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

function splitModels(value: string): string[] {
  return [...new Set(value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean))]
}

function toDraft(pool: AiProviderPoolView): DraftPool {
  return {
    providers: pool.providers.map(provider => ({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      modelsText: provider.models.join(', '),
      highAvailability: provider.highAvailability,
      original: true,
      keys: provider.keys.map(key => ({
        ...key,
        baseUrl: key.baseUrl ?? '',
        apiKey: '',
        original: true,
      })),
    })),
    probeMinutes: Math.max(1, Math.round(pool.probeIntervalMs / 60_000)),
    maxProviderFailures: pool.maxProviderFailures,
    cooldownMinutes: {
      quota: Math.max(1, Math.round(pool.cooldowns.quotaMs / 60_000)),
      auth: Math.max(1, Math.round(pool.cooldowns.authMs / 60_000)),
      rateLimit: Math.max(1, Math.round(pool.cooldowns.rateLimitMs / 60_000)),
      transient: Math.max(1, Math.round(pool.cooldowns.transientMs / 60_000)),
      provider: Math.max(1, Math.round(pool.cooldowns.providerMs / 60_000)),
    },
    modelMapText: JSON.stringify(pool.modelMap, null, 2),
  }
}

function newKey(index: number): DraftKey {
  return {
    id: `key-${randomSuffix()}`,
    label: `Key ${index + 1}`,
    maskedKey: '',
    baseUrl: '',
    enabled: true,
    apiKey: '',
    original: false,
  }
}

function keyStateLabel(key: DraftKey, runtime: AiGatewayKeyStatus | null): string {
  if (!key.enabled) return '已停用'
  if (!runtime) return '未启用'
  if (runtime.state === 'available') return '可用'
  if (runtime.cooldownUntil && new Date(runtime.cooldownUntil).getTime() <= Date.now()) return '待探活'
  return KEY_STATE_LABEL[runtime.state]
}

function keyStateClass(key: DraftKey, runtime: AiGatewayKeyStatus | null): string {
  if (!key.enabled) return 'is-off'
  if (!runtime) return 'is-off'
  if (runtime.state === 'available') return 'is-ok'
  if (runtime.state === 'cooling') return 'is-warn'
  return 'is-error'
}

export default function ProviderSettings() {
  const [pool, setPool] = useState<AiProviderPoolView | null>(null)
  const [gateway, setGateway] = useState<AiGatewayStatus | null>(null)
  const [draft, setDraft] = useState<DraftPool | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [gatewayOpen, setGatewayOpen] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [poolResult, gatewayResult] = await Promise.all([api.ai.providers(), api.ai.gatewayStatus()])
      setPool(poolResult.pool)
      setDraft(toDraft(poolResult.pool))
      setGateway(gatewayResult.gateway)
      setDirty(false)
      setError('')
    } catch (cause) {
      setError(getErrorMessage(cause, '读取提供商配置失败'))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const runtime = useMemo(() => {
    const providers = new Map<string, AiGatewayStatus['providers'][number]>()
    const keys = new Map<string, AiGatewayKeyStatus>()
    for (const provider of gateway?.providers ?? []) {
      providers.set(provider.id, provider)
      for (const key of provider.keys) keys.set(`${provider.id}/${key.keyId}`, key)
    }
    return { providers, keys }
  }, [gateway])

  function updateDraft(updater: (current: DraftPool) => DraftPool) {
    setDraft(current => current ? updater(current) : current)
    setDirty(true)
  }

  function updateProvider(index: number, patch: Partial<DraftProvider>) {
    updateDraft(current => ({
      ...current,
      providers: current.providers.map((provider, providerIndex) => providerIndex === index ? { ...provider, ...patch } : provider),
    }))
  }

  function updateKey(providerIndex: number, keyIndex: number, patch: Partial<DraftKey>) {
    updateDraft(current => ({
      ...current,
      providers: current.providers.map((provider, index) => index !== providerIndex ? provider : {
        ...provider,
        keys: provider.keys.map((key, itemIndex) => itemIndex === keyIndex ? { ...key, ...patch } : key),
      }),
    }))
  }

  function addProvider() {
    updateDraft(current => ({
      ...current,
      providers: [...current.providers, {
        id: `provider-${randomSuffix()}`,
        label: '新提供商',
        baseUrl: '',
        defaultModel: '',
        modelsText: '',
        highAvailability: true,
        original: false,
        keys: [newKey(0)],
      }],
    }))
  }

  function removeProvider(index: number) {
    updateDraft(current => ({ ...current, providers: current.providers.filter((_provider, itemIndex) => itemIndex !== index) }))
  }

  function moveProvider(index: number, delta: number) {
    updateDraft(current => {
      const next = [...current.providers]
      const target = index + delta
      if (target < 0 || target >= next.length) return current
      ;[next[index], next[target]] = [next[target], next[index]]
      return { ...current, providers: next }
    })
  }

  function addKey(providerIndex: number) {
    updateDraft(current => ({
      ...current,
      providers: current.providers.map((provider, index) => index === providerIndex
        ? { ...provider, keys: [...provider.keys, newKey(provider.keys.length)] }
        : provider),
    }))
  }

  function removeKey(providerIndex: number, keyIndex: number) {
    updateDraft(current => ({
      ...current,
      providers: current.providers.map((provider, index) => index === providerIndex
        ? { ...provider, keys: provider.keys.filter((_key, itemIndex) => itemIndex !== keyIndex) }
        : provider),
    }))
  }

  function moveKey(providerIndex: number, keyIndex: number, delta: number) {
    updateDraft(current => ({
      ...current,
      providers: current.providers.map((provider, index) => {
        if (index !== providerIndex) return provider
        const target = keyIndex + delta
        if (target < 0 || target >= provider.keys.length) return provider
        const keys = [...provider.keys]
        ;[keys[keyIndex], keys[target]] = [keys[target], keys[keyIndex]]
        return { ...provider, keys }
      }),
    }))
  }

  async function save() {
    if (!draft || !pool?.editable) return
    setError('')
    let payload: AiProviderPoolInput
    try {
      if (!draft.providers.length) throw new Error('至少需要一个提供商')
      payload = {
        providers: draft.providers.map((provider) => {
          const id = provider.id.trim()
          if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error(`提供商 ID「${id}」只能是小写字母、数字、下划线和连字符`)
          if (!provider.label.trim()) throw new Error(`提供商 ${id} 缺少名称`)
          if (!provider.defaultModel.trim()) throw new Error(`提供商「${provider.label || id}」缺少默认模型`)
          const models = splitModels(provider.modelsText)
          if (models.length && !models.includes(provider.defaultModel.trim())) models.unshift(provider.defaultModel.trim())
          if (!provider.keys.length) throw new Error(`提供商「${provider.label || id}」至少需要一个 API Key`)
          return {
            id,
            label: provider.label.trim(),
            baseUrl: provider.baseUrl.trim(),
            defaultModel: provider.defaultModel.trim(),
            models,
            highAvailability: provider.highAvailability,
            keys: provider.keys.map((key) => {
              if (!key.label.trim()) throw new Error(`提供商「${provider.label || id}」存在未命名的 Key`)
              if (!key.original && !key.apiKey.trim()) throw new Error(`请为提供商「${provider.label || id}」的新 Key 填写 API Key`)
              return {
                id: key.id,
                label: key.label.trim(),
                ...(key.apiKey.trim() ? { apiKey: key.apiKey.trim() } : {}),
                baseUrl: key.baseUrl.trim() || null,
                enabled: key.enabled,
              }
            }),
          }
        }),
        probeIntervalMs: Math.max(30_000, Math.round(draft.probeMinutes * 60_000)),
        maxProviderFailures: draft.maxProviderFailures,
        cooldowns: {
          quotaMs: Math.max(1_000, Math.round(draft.cooldownMinutes.quota * 60_000)),
          authMs: Math.max(1_000, Math.round(draft.cooldownMinutes.auth * 60_000)),
          rateLimitMs: Math.max(1_000, Math.round(draft.cooldownMinutes.rateLimit * 60_000)),
          transientMs: Math.max(1_000, Math.round(draft.cooldownMinutes.transient * 60_000)),
          providerMs: Math.max(1_000, Math.round(draft.cooldownMinutes.provider * 60_000)),
        },
        modelMap: draft.modelMapText.trim() ? (() => {
          let parsed: unknown
          try { parsed = JSON.parse(draft.modelMapText) } catch { throw new Error('模型等价映射不是合法 JSON') }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型等价映射必须是 JSON 对象')
          return parsed as AiProviderPoolInput['modelMap']
        })() : {},
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置格式不正确')
      return
    }
    setSaving(true)
    try {
      const result = await api.ai.saveProviders(payload)
      setPool(result.pool)
      setDraft(toDraft(result.pool))
      setDirty(false)
      const refreshed = await api.ai.gatewayStatus()
      setGateway(refreshed.gateway)
      toast.success('提供商池已保存并立即生效')
    } catch (cause) {
      setError(getErrorMessage(cause, '保存提供商配置失败'))
    } finally { setSaving(false) }
  }

  async function probeAll() {
    setProbing(true)
    setError('')
    try {
      const result = await api.ai.probeGateway()
      setGateway(result.gateway)
      const failed = result.probes.filter(item => !item.ok).length
      if (failed) toast.warning(`探活完成：${result.probes.length - failed} 个 Key 可用，${failed} 个异常`)
      else toast.success(`探活完成：${result.probes.length} 个 Key 全部可用`)
    } catch (cause) {
      setError(getErrorMessage(cause, '探活失败'))
    } finally { setProbing(false) }
  }

  async function refresh() {
    if (dirty && !window.confirm('有未保存的修改，刷新后会丢失，确定继续？')) return
    await load()
  }

  if (loading && !pool) {
    return <div className="settings-loading"><LoaderCircle size={16} className="spin" />正在读取提供商池…</div>
  }

  if (!pool || !draft) {
    return (
      <section className="settings-card">
        <p className="settings-error" role="alert">{error || '无法读取提供商池配置'}</p>
        <div className="settings-actions"><button type="button" className="btn" onClick={() => void load()}>重试</button></div>
      </section>
    )
  }

  return (
    <div className="settings-sections">
      {!pool.editable ? (
        <div className="settings-banner is-info">
          <ShieldCheck size={15} />
          <span>{pool.editableReason ?? '当前为只读模式。'}</span>
        </div>
      ) : null}
      {pool.warning ? <div className="settings-banner is-warn">{pool.warning}</div> : null}
      {error ? <p className="settings-error" role="alert">{error}</p> : null}

      <section className="settings-card">
        <header className="settings-card-head settings-card-head-actions">
          <div>
            <h2>提供商回退链</h2>
            <p>从上到下依次尝试。每个提供商可配置多个 API Key；高可用开启时按顺序轮换，关闭时只使用第一个启用的 Key。</p>
          </div>
          <div className="settings-head-buttons">
            <span className="settings-source-badge"><Server size={12} />{pool.source === 'file' ? '受保护配置文件' : pool.source === 'env' ? '环境变量' : pool.source === 'legacy' ? '旧版单 Key' : pool.source === 'none' ? '未配置' : '启动参数'}</span>
            <button type="button" className="btn btn-sm" onClick={() => void probeAll()} disabled={probing || saving}>
              {probing ? <LoaderCircle size={13} className="spin" /> : <Activity size={13} />}检测全部 Key
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void refresh()} disabled={loading || saving}>
              {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}刷新
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setGatewayOpen(true)}>
              <Clock3 size={13} />切换记录
            </button>
          </div>
        </header>

        <div className="provider-chain-hint">
          <span><strong>{draft.providers.length}</strong> 个提供商</span>
          <span><strong>{draft.providers.reduce((total, provider) => total + (provider.highAvailability ? provider.keys.filter(key => key.enabled).length : Math.min(1, provider.keys.filter(key => key.enabled).length)), 0)}</strong> 个启用中的 Key</span>
          <span>共 <strong>{draft.providers.reduce((total, provider) => total + provider.keys.length, 0)}</strong> 个 Key</span>
        </div>

        <div className="provider-editor-list">
          {draft.providers.map((provider, providerIndex) => {
            const providerRuntime = runtime.providers.get(provider.id)
            return (
              <article className="provider-editor" key={provider.id}>
                <header className="provider-editor-head">
                  <div className="provider-editor-title">
                    <span className="provider-order">#{providerIndex + 1}</span>
                    <div>
                      <strong>{provider.label || '未命名提供商'}</strong>
                      <small>{provider.id}{providerRuntime ? ` · ${providerRuntime.state === 'available' ? '运行中' : '冷却中'}` : ''}</small>
                    </div>
                  </div>
                  {pool.editable ? (
                    <div className="provider-editor-actions">
                      <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => moveProvider(providerIndex, -1)} disabled={providerIndex === 0} aria-label="上移提供商" title="上移"><ArrowUp size={14} /></button>
                      <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => moveProvider(providerIndex, 1)} disabled={providerIndex === draft.providers.length - 1} aria-label="下移提供商" title="下移"><ArrowDown size={14} /></button>
                      <button type="button" className="btn btn-ghost btn-icon btn-sm settings-danger" onClick={() => removeProvider(providerIndex)} disabled={draft.providers.length <= 1} aria-label="删除提供商" title="删除提供商"><Trash2 size={14} /></button>
                    </div>
                  ) : null}
                </header>

                <div className="provider-field-grid">
                  <label className="field">
                    <span className="label">提供商 ID</span>
                    <input className="input input-sm" value={provider.id} onChange={event => updateProvider(providerIndex, { id: event.target.value })} disabled={!pool.editable || provider.original} />
                  </label>
                  <label className="field">
                    <span className="label">名称</span>
                    <input className="input input-sm" value={provider.label} onChange={event => updateProvider(providerIndex, { label: event.target.value })} disabled={!pool.editable} />
                  </label>
                  <label className="field provider-field-wide">
                    <span className="label">接口地址</span>
                    <input className="input input-sm" type="url" value={provider.baseUrl} placeholder="https://opencode.ai/inference/go/openai/v1" onChange={event => updateProvider(providerIndex, { baseUrl: event.target.value })} disabled={!pool.editable} />
                  </label>
                  <label className="field">
                    <span className="label">默认模型</span>
                    <input className="input input-sm" value={provider.defaultModel} placeholder="deepseek-v4.1-flash" onChange={event => updateProvider(providerIndex, { defaultModel: event.target.value })} disabled={!pool.editable} />
                  </label>
                  <label className="field">
                    <span className="label">可用模型 <span className="optional">逗号分隔</span></span>
                    <input className="input input-sm" value={provider.modelsText} placeholder="deepseek-v4.1-flash, deepseek-chat" onChange={event => updateProvider(providerIndex, { modelsText: event.target.value })} disabled={!pool.editable} />
                  </label>
                  <div className="field provider-ha-field">
                    <span className="label">多 Key 高可用</span>
                    <div className="provider-ha-control">
                      <button type="button" className="switch" data-on={provider.highAvailability} role="switch" aria-checked={provider.highAvailability} aria-label={`${provider.label || provider.id} 多 Key 高可用`} onClick={() => updateProvider(providerIndex, { highAvailability: !provider.highAvailability })} disabled={!pool.editable} />
                      <span>{provider.highAvailability ? '已开启：按优先级轮换' : '已关闭：仅用第一个启用的 Key'}</span>
                    </div>
                  </div>
                </div>

                <div className="provider-keys">
                  <div className="provider-keys-head">
                    <div><KeyRound size={14} /><strong>API Key</strong><span>顺序即优先级；关闭“启用”的 Key 保留但不会被调用。</span></div>
                    {pool.editable ? <button type="button" className="btn btn-sm" onClick={() => addKey(providerIndex)}><Plus size={13} />添加 Key</button> : null}
                  </div>
                  {provider.keys.map((key, keyIndex) => {
                    const keyRuntime = runtime.keys.get(`${provider.id}/${key.id}`) ?? null
                    const inactiveByHa = !provider.highAvailability && keyIndex > 0 && key.enabled
                    return (
                      <div className={`provider-key-row ${key.enabled ? '' : 'is-disabled'}`} key={key.id}>
                        <span className="provider-key-order">{keyIndex + 1}</span>
                        <div className="provider-key-body">
                          <div className="provider-key-line">
                            <input className="input input-sm provider-key-label" value={key.label} onChange={event => updateKey(providerIndex, keyIndex, { label: event.target.value })} disabled={!pool.editable} aria-label={`Key ${keyIndex + 1} 名称`} />
                            {key.maskedKey ? <code className="provider-key-mask">{key.maskedKey}</code> : <span className="provider-key-new">新 Key</span>}
                            <span className={`settings-state ${inactiveByHa ? 'is-off' : keyStateClass(key, keyRuntime)}`} title={inactiveByHa ? '该提供商已关闭多 Key 高可用，只有第一个启用的 Key 参与轮换' : undefined}>{inactiveByHa ? '未参与轮换' : keyStateLabel(key, keyRuntime)}</span>
                            {keyRuntime?.cooldownUntil ? <span className="provider-key-cooldown">冷却至 {formatDateTime(keyRuntime.cooldownUntil)}</span> : null}
                          </div>
                          <div className="provider-key-line">
                            <input
                              className="input input-sm"
                              type="password"
                              autoComplete="off"
                              value={key.apiKey}
                              placeholder={key.original ? '已保存，留空保留原 Key' : '必填：粘贴 API Key'}
                              onChange={event => updateKey(providerIndex, keyIndex, { apiKey: event.target.value })}
                              disabled={!pool.editable}
                              aria-label={`Key ${keyIndex + 1} API Key`}
                            />
                            <input className="input input-sm" type="url" value={key.baseUrl} placeholder="可选：Key 专属接口地址" onChange={event => updateKey(providerIndex, keyIndex, { baseUrl: event.target.value })} disabled={!pool.editable} aria-label={`Key ${keyIndex + 1} 接口地址`} />
                          </div>
                        </div>
                        <div className="provider-key-actions">
                          <button
                            type="button"
                            className="switch"
                            data-on={key.enabled}
                            role="switch"
                            aria-checked={key.enabled}
                            aria-label={`启用 Key ${key.label}`}
                            onClick={() => updateKey(providerIndex, keyIndex, { enabled: !key.enabled })}
                            disabled={!pool.editable}
                          />
                          {pool.editable ? (
                            <>
                              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => moveKey(providerIndex, keyIndex, -1)} disabled={keyIndex === 0} aria-label="上移 Key" title="上移"><ArrowUp size={13} /></button>
                              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => moveKey(providerIndex, keyIndex, 1)} disabled={keyIndex === provider.keys.length - 1} aria-label="下移 Key" title="下移"><ArrowDown size={13} /></button>
                              <button type="button" className="btn btn-ghost btn-icon btn-sm settings-danger" onClick={() => removeKey(providerIndex, keyIndex)} disabled={provider.keys.length <= 1} aria-label="删除 Key" title="删除 Key"><Trash2 size={13} /></button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </article>
            )
          })}
        </div>

        {pool.editable ? (
          <div className="settings-actions provider-add-row">
            <button type="button" className="btn" onClick={addProvider}><Plus size={14} />添加提供商</button>
          </div>
        ) : null}
      </section>

      <details className="settings-card settings-advanced">
        <summary><span>高级设置</span><small>探活间隔、冷却、失败阈值与模型等价映射</small></summary>
        <div className="settings-form-grid settings-advanced-grid">
          <label className="field">
            <span className="label">探活间隔（分钟）</span>
            <input className="input input-sm" type="number" min={1} max={1440} value={draft.probeMinutes} onChange={event => updateDraft(current => ({ ...current, probeMinutes: Number(event.target.value) }))} disabled={!pool.editable} />
          </label>
          <label className="field">
            <span className="label">连续失败熔断阈值</span>
            <input className="input input-sm" type="number" min={1} max={20} value={draft.maxProviderFailures} onChange={event => updateDraft(current => ({ ...current, maxProviderFailures: Number(event.target.value) }))} disabled={!pool.editable} />
          </label>
          {COOLDOWN_FIELDS.map(field => (
            <label className="field" key={field.key}>
              <span className="label">{field.label}（分钟）</span>
              <input
                className="input input-sm"
                type="number"
                min={1}
                max={360}
                value={draft.cooldownMinutes[field.key]}
                onChange={event => updateDraft(current => ({ ...current, cooldownMinutes: { ...current.cooldownMinutes, [field.key]: Number(event.target.value) } }))}
                disabled={!pool.editable}
              />
              <span className="hint">{field.hint}</span>
            </label>
          ))}
        </div>
        <label className="field settings-model-map">
          <span className="label">模型等价映射 <span className="optional">JSON，可留空</span></span>
          <textarea
            className="textarea settings-code"
            rows={7}
            value={draft.modelMapText}
            onChange={event => updateDraft(current => ({ ...current, modelMapText: event.target.value }))}
            disabled={!pool.editable}
            placeholder={'{\n  "opencode-go/deepseek-v4.1-flash": { "deepseek": "deepseek-chat" }\n}'}
            spellCheck={false}
          />
          <span className="hint">键为「源提供商ID/模型ID」，值可为目标模型名或 {`{ "目标提供商ID": "模型ID" }`}；支持 `*` 通配。</span>
        </label>
      </details>

      <div className="settings-save-bar">
        <div>
          <strong>{dirty ? '有未保存的修改' : '配置已同步'}</strong>
          <span>保存后立即生效，无需重启服务；Key 明文只写入服务器受保护配置文件。</span>
        </div>
        <div className="settings-actions">
          <button type="button" className="btn" onClick={() => void refresh()} disabled={saving}>放弃修改</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!pool.editable || saving || !dirty}>
            {saving ? <LoaderCircle size={14} className="spin" /> : null}保存提供商池
          </button>
        </div>
      </div>

      <AiGatewayPanel open={gatewayOpen} onClose={() => setGatewayOpen(false)} />
    </div>
  )
}
