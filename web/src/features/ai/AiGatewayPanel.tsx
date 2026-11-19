import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, Clock3, KeyRound, LoaderCircle, RefreshCw, Server, ShieldCheck, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import type { AiFailoverEvent, AiGatewayKeyStatus, AiGatewayProviderStatus, AiGatewayStatus, AiProbeResult } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime, relativeTime } from '@/lib/utils'
import Modal from '@/components/Modal'
import './ai.css'

interface ApiPanelProps {
  open: boolean
  onClose: () => void
}

const KEY_STATE_LABEL: Record<AiGatewayKeyStatus['state'], string> = {
  available: '可用',
  cooling: '冷却中',
  exhausted: '额度不足',
  invalid: '失效',
}

const REASON_LABEL: Record<string, string> = {
  quota_exhausted: '额度不足',
  unauthorized: '认证失败',
  rate_limited: '触发限流',
  provider_error: '服务异常',
  network_error: '网络错误',
  model_unavailable: '模型不可用',
  provider_bad_request: '请求被拒绝',
  invalid_response: '响应异常',
  keys_unavailable: '全部 Key 不可用',
  consecutive_failures: '连续失败',
  probe_failed: '探活失败',
  recovered: '已恢复',
}

const EVENT_LABEL: Record<AiFailoverEvent['kind'], string> = {
  key_switch: '切换 Key',
  provider_switch: '切换提供商',
  key_cooldown: 'Key 冷却',
  provider_cooldown: '提供商冷却',
  key_recovery: 'Key 恢复',
  provider_recovery: '提供商恢复',
  rate_limited: '限流轮换',
}

const SOURCE_LABEL: Record<AiGatewayStatus['source'], string> = {
  env: '环境变量',
  file: '受保护配置文件',
  legacy: '旧版环境变量',
  override: '启动参数',
  none: '未配置',
}

function reasonLabel(reason: string | null): string {
  if (!reason) return ''
  return REASON_LABEL[reason] ?? reason
}

function stateText(state: AiGatewayKeyStatus['state'] | AiGatewayProviderStatus['state'], cooldownUntil: string | null): string {
  if (state === 'available') return '可用'
  const until = cooldownUntil ? new Date(cooldownUntil).getTime() : NaN
  if (Number.isFinite(until) && until <= Date.now()) return '待探活'
  return KEY_STATE_LABEL[state as AiGatewayKeyStatus['state']] ?? '冷却中'
}

function stateClass(state: AiGatewayKeyStatus['state'] | AiGatewayProviderStatus['state']): string {
  if (state === 'available') return 'is-ok'
  if (state === 'cooling') return 'is-warn'
  return 'is-error'
}

function cooldownLabel(value: string | null): string {
  if (!value) return ''
  const until = new Date(value).getTime()
  if (Number.isNaN(until)) return ''
  return until > Date.now() ? `冷却至 ${formatDateTime(value)}` : '冷却结束，等待探活'
}

function eventRoute(event: AiFailoverEvent): string {
  const from = event.fromProviderLabel
    ? `${event.fromProviderLabel}${event.fromKeyLabel ? ` / ${event.fromKeyLabel}` : ''}`
    : ''
  const to = event.toProviderLabel
    ? `${event.toProviderLabel}${event.toKeyLabel ? ` / ${event.toKeyLabel}` : ''}`
    : ''
  if (from && to) return `${from} → ${to}`
  return from || to || '—'
}

function eventDescription(event: AiFailoverEvent): string {
  const route = eventRoute(event)
  if (event.kind === 'provider_cooldown') return `${event.fromProviderLabel ?? '提供商'}：${reasonLabel(event.reason)}`
  if (event.kind === 'key_cooldown' || event.kind === 'rate_limited') return `${route}：${reasonLabel(event.reason)}`
  if (event.kind === 'key_recovery' || event.kind === 'provider_recovery') return `${route}：${reasonLabel(event.reason)}`
  if (event.model && event.targetModel && event.model !== event.targetModel) return `${route}（${event.model} → ${event.targetModel}）`
  return route
}

function ProbeBadge({ result }: { result: AiProbeResult }) {
  return (
    <span className={`ai-gateway-probe ${result.ok ? 'is-ok' : 'is-error'}`} title={result.message}>
      {result.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
      {result.providerLabel} / {result.keyLabel} · {result.ok ? '可用' : '不可用'} · {result.latencyMs}ms
    </span>
  )
}

export default function AiGatewayPanel({ open, onClose }: ApiPanelProps) {
  const [gateway, setGateway] = useState<AiGatewayStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeTarget, setProbeTarget] = useState('')
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'events' | 'requests'>('events')
  const [probes, setProbes] = useState<AiProbeResult[]>([])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const result = await api.ai.gatewayStatus()
      setGateway(result.gateway)
      setError('')
    } catch (cause) {
      if (!silent) setError(getErrorMessage(cause, '读取高可用状态失败'))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setProbes([])
    void load()
    const timer = window.setInterval(() => { void load(true) }, 20_000)
    return () => window.clearInterval(timer)
  }, [open, load])

  async function probe(providerId?: string) {
    setProbing(true)
    setProbeTarget(providerId ?? '')
    try {
      const result = await api.ai.probeGateway(providerId)
      setGateway(result.gateway)
      setProbes(result.probes)
      const failed = result.probes.filter(item => !item.ok).length
      if (failed) toast.warning(`探活完成：${result.probes.length - failed} 个 Key 可用，${failed} 个异常`)
      else toast.success(`探活完成：${result.probes.length} 个 Key 全部可用`)
    } catch (cause) {
      setError(getErrorMessage(cause, '探活失败'))
    } finally {
      setProbing(false)
      setProbeTarget('')
    }
  }

  const providers = gateway?.providers ?? []
  const availableKeys = providers.reduce((total, provider) => total + provider.keys.filter(key => key.state === 'available').length, 0)
  const totalKeys = providers.reduce((total, provider) => total + provider.keys.length, 0)

  return (
    <Modal open={open} onClose={onClose} title="模型高可用" subtitle="Key 轮换、提供商回退、冷却探活与切换记录" size="wide">
      <div className="ai-gateway">
        <div className="ai-gateway-summary">
          <div className="ai-gateway-summary-main">
            <span className="ai-gateway-icon"><ShieldCheck size={19} /></span>
            <div>
              <strong>{gateway?.configured ? `${providers.length} 个提供商 · ${totalKeys} 个 Key` : '尚未配置提供商池'}</strong>
              <small>
                {gateway?.configured
                  ? `${availableKeys}/${totalKeys} 个 Key 当前可用 · 探活间隔 ${Math.round((gateway.probeIntervalMs || 0) / 60_000)} 分钟 · 配置来源：${SOURCE_LABEL[gateway.source]}`
                  : '请通过 AI_PROVIDERS_JSON 或 DATA_DIR/ai-providers.json 配置服务器提供商池。'}
              </small>
            </div>
          </div>
          <div className="ai-gateway-actions">
            <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading || probing}>
              {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}刷新
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void probe()} disabled={probing || !providers.length}>
              {probing && !probeTarget ? <LoaderCircle size={13} className="spin" /> : <Activity size={13} />}检测全部 Key
            </button>
          </div>
        </div>

        {gateway?.warning ? <p className="ai-gateway-warning"><AlertTriangle size={13} />{gateway.warning}</p> : null}
        {error ? <p className="ai-gateway-error" role="alert">{error}</p> : null}
        {probes.length ? <div className="ai-gateway-probes">{probes.map(result => <ProbeBadge key={`${result.providerId}-${result.keyId}`} result={result} />)}</div> : null}

        {loading && !gateway ? <div className="ai-gateway-loading"><LoaderCircle size={16} className="spin" />正在读取提供商状态…</div> : null}

        {!loading && !providers.length ? (
          <div className="ai-gateway-empty">
            <KeyRound size={26} />
            <p>还没有服务器提供商池。配置后会在这里显示每个提供商、Key 的状态和切换记录。</p>
          </div>
        ) : null}

        <div className="ai-gateway-providers">
          {providers.map(provider => (
            <article key={provider.id} className="ai-gateway-provider">
              <header>
                <div className="ai-gateway-provider-title">
                  <Server size={15} />
                  <div>
                    <strong>{provider.label}{provider.source === 'user' ? <span className="ai-gateway-badge">优先</span> : null}</strong>
                    <small title={provider.baseUrl}>{provider.baseUrl} · 默认模型 {provider.defaultModel}</small>
                  </div>
                </div>
                <div className="ai-gateway-provider-side">
                  <span className={`ai-gateway-state ${stateClass(provider.state)}`}>{stateText(provider.state, provider.cooldownUntil)}</span>
                  <button type="button" className="btn btn-sm" onClick={() => void probe(provider.id)} disabled={probing}>
                    {probing && probeTarget === provider.id ? <LoaderCircle size={12} className="spin" /> : <Activity size={12} />}测试
                  </button>
                </div>
              </header>
              {provider.reason || provider.lastError ? (
                <p className="ai-gateway-provider-note">
                  {reasonLabel(provider.reason)}
                  {provider.cooldownUntil ? ` · ${cooldownLabel(provider.cooldownUntil)}` : ''}
                  {provider.lastError ? ` · ${provider.lastError}` : ''}
                </p>
              ) : null}
              <div className="ai-gateway-keys">
                {provider.keys.map(key => (
                  <div key={`${provider.id}-${key.keyId}`} className="ai-gateway-key">
                    <div className="ai-gateway-key-main">
                      <span className="ai-gateway-priority">#{key.priority}</span>
                      <KeyRound size={13} />
                      <strong>{key.keyLabel}</strong>
                      <code>{key.maskedKey}</code>
                      <span className={`ai-gateway-state ${stateClass(key.state)}`}>{stateText(key.state, key.cooldownUntil)}</span>
                    </div>
                    <div className="ai-gateway-key-meta">
                      {key.reason ? <span>{reasonLabel(key.reason)}</span> : null}
                      {key.cooldownUntil ? <span><Clock3 size={10} />{cooldownLabel(key.cooldownUntil)}</span> : null}
                      <span>成功 {key.successCount}</span>
                      <span>失败 {key.failureCount}</span>
                      {key.quotaFailures ? <span>额度 {key.quotaFailures}</span> : null}
                      {key.authFailures ? <span>认证 {key.authFailures}</span> : null}
                      {key.rateLimits ? <span>限流 {key.rateLimits}</span> : null}
                      {key.tokensIn || key.tokensOut ? <span>Token {key.tokensIn}/{key.tokensOut}</span> : null}
                      <span>最近使用 {relativeTime(key.lastUsedAt)}</span>
                    </div>
                    {key.lastError ? <p className="ai-gateway-key-error" title={key.lastError}>{key.lastError}</p> : null}
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>

        <div className="ai-gateway-history">
          <div className="ai-gateway-tabs" role="tablist" aria-label="高可用记录">
            <button type="button" role="tab" aria-selected={tab === 'events'} className={tab === 'events' ? 'is-active' : ''} onClick={() => setTab('events')}>切换与恢复记录</button>
            <button type="button" role="tab" aria-selected={tab === 'requests'} className={tab === 'requests' ? 'is-active' : ''} onClick={() => setTab('requests')}>最近请求</button>
          </div>
          {tab === 'events' ? (
            gateway?.events.length ? (
              <ul className="ai-gateway-events">
                {gateway.events.map(event => (
                  <li key={event.id} className={`ai-gateway-event is-${event.kind}`}>
                    <span className="ai-gateway-event-time">{formatDateTime(event.at)}</span>
                    <span className={`ai-gateway-state ${event.kind.endsWith('_recovery') ? 'is-ok' : event.kind === 'rate_limited' ? 'is-warn' : 'is-error'}`}>{EVENT_LABEL[event.kind]}</span>
                    <span className="ai-gateway-event-route">{eventDescription(event)}</span>
                    {event.detail ? <span className="ai-gateway-event-detail" title={event.detail}>{event.detail}</span> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="ai-gateway-history-empty">还没有切换记录。额度不足、认证失败、限流或探活恢复时会记录在这里。</p>
          ) : (
            gateway?.requests.length ? (
              <ul className="ai-gateway-requests">
                {gateway.requests.map(request => (
                  <li key={request.id}>
                    <span className={`ai-gateway-state ${request.status === 'success' ? 'is-ok' : 'is-error'}`}>{request.status === 'success' ? '成功' : '失败'}</span>
                    <span className="ai-gateway-request-provider">{request.providerLabel}</span>
                    <span className="ai-gateway-request-model">{request.model}</span>
                    <code>{request.keyMasked}</code>
                    <span>{request.durationMs}ms</span>
                    {request.tokensIn || request.tokensOut ? <span>{request.tokensIn}/{request.tokensOut} token</span> : null}
                    {request.errorCode ? <span className="ai-gateway-request-error">{reasonLabel(request.errorCode)}</span> : null}
                    <span className="ai-gateway-request-time">{formatDateTime(request.at)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="ai-gateway-history-empty">还没有请求记录。每次调用大模型都会记录实际使用的提供商、模型和脱敏 Key。</p>
          )}
        </div>

        <p className="ai-gateway-footnote">
          <ArrowRight size={11} />同一提供商的 Key 按优先级轮换，额度不足或失效会冷却并定期探活；某提供商全部 Key 不可用时按顺序回退到下一个提供商，并按模型映射继续当前对话。
        </p>
      </div>
    </Modal>
  )
}
