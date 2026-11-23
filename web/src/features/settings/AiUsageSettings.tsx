import { useCallback, useEffect, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import type { AiUsageReport } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'

const RANGE_OPTIONS = [1, 7, 30, 90]

export default function AiUsageSettings() {
  const [days, setDays] = useState(7)
  const [report, setReport] = useState<AiUsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (range: number) => {
    setLoading(true)
    setError('')
    try {
      const result = await api.admin.aiUsage(range)
      setReport(result.report)
    } catch (cause) {
      setError(getErrorMessage(cause, '读取 AI 用量失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(days) }, [days, load])

  return (
    <div className="settings-sections">
      <section className="settings-card">
        <header className="settings-card-head">
          <div><h2>AI 请求用量</h2><p>按账号统计大模型请求与 Token 消耗（含账号自定义 Key），用于发现额度滥用。</p></div>
          <Activity size={18} />
        </header>
        <div className="settings-actions" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {RANGE_OPTIONS.map(option => (
              <button key={option} type="button" className={`btn ${days === option ? 'btn-primary' : ''}`} onClick={() => setDays(option)}>
                近 {option} 天
              </button>
            ))}
          </div>
          <button type="button" className="btn" onClick={() => void load(days)} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : undefined} />刷新
          </button>
        </div>
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
        {report ? (
          <>
            <dl className="settings-facts" style={{ marginTop: 12 }}>
              <div><dt>请求总数</dt><dd>{report.totals.requests}</dd></div>
              <div><dt>成功 / 失败</dt><dd>{report.totals.success} / {report.totals.failed}</dd></div>
              <div><dt>输入 / 输出 Token</dt><dd>{report.totals.tokensIn.toLocaleString()} / {report.totals.tokensOut.toLocaleString()}</dd></div>
              <div><dt>服务器池 Token</dt><dd>{report.totals.poolTokens.toLocaleString()}</dd></div>
            </dl>
            {report.users.length ? (
              <div style={{ overflowX: 'auto', marginTop: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--text-muted, #78716c)' }}>
                      <th style={{ padding: '8px 10px' }}>账号</th>
                      <th style={{ padding: '8px 10px' }}>请求（池）</th>
                      <th style={{ padding: '8px 10px' }}>失败</th>
                      <th style={{ padding: '8px 10px' }}>Token（池）</th>
                      <th style={{ padding: '8px 10px' }}>最近使用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.users.map(user => (
                      <tr key={user.userId} style={{ borderTop: '1px solid var(--border, #e7e5e4)' }}>
                        <td style={{ padding: '8px 10px' }}><strong>@{user.username}</strong><div style={{ color: 'var(--text-muted, #78716c)' }}>{user.displayName}</div></td>
                        <td style={{ padding: '8px 10px' }}>{user.requests}{user.poolRequests !== user.requests ? `（${user.poolRequests}）` : ''}</td>
                        <td style={{ padding: '8px 10px' }}>{user.failed}</td>
                        <td style={{ padding: '8px 10px' }}>{(user.tokensIn + user.tokensOut).toLocaleString()}{user.poolTokensIn + user.poolTokensOut ? `（${(user.poolTokensIn + user.poolTokensOut).toLocaleString()}）` : ''}</td>
                        <td style={{ padding: '8px 10px' }}>{user.lastAt ? formatDateTime(user.lastAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="hint" style={{ marginTop: 12 }}>所选区间内没有大模型请求。</p>}
            <p className="hint" style={{ marginTop: 8 }}>统计区间：{formatDateTime(report.since)} 至 {formatDateTime(report.until)}。统计包含账号自定义 Key 与服务器池请求；服务器池的使用范围与额度由 AI_POOL_ACCESS / AI_POOL_DAILY_LIMIT 控制。</p>
          </>
        ) : loading ? <p className="hint">正在读取…</p> : null}
      </section>
    </div>
  )
}
