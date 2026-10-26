import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { XhsPublication } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'

export default function XhsPublishPage() {
  const navigate = useNavigate(), [params] = useSearchParams()
  const [records, setRecords] = useState<XhsPublication[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void api.xiaohongshu.listPublications().then(result => { if (!cancelled) setRecords(result.publications) })
      .catch(cause => { if (!cancelled) setError(getErrorMessage(cause)) })
    return () => { cancelled = true }
  }, [])
  return <div className="publish-page">
    <header className="publish-heading"><div><h1>小红书自动发布已停用</h1><p>系统不再自动登录、检查小红书会话、上传素材或提交笔记。</p></div></header>
    <section className="publish-panel">
      <h2>导出后手动发布</h2>
      <p className="publish-warning">为保护账号，已清除系统保存的小红书登录状态。请使用官方 App 或创作中心手动发布。</p>
      <p>卡片排版、图片和文案导出仍可使用；原文、素材与历史发布记录保留。</p>
      <button className="btn btn-primary" type="button" onClick={() => navigate(params.get('renderId') ? `/render?renderId=${encodeURIComponent(params.get('renderId')!)}` : '/render')}>去渲染工作台导出</button>
    </section>
    <section className="publish-panel publish-history"><h2>历史发布记录</h2>
      <p className="publish-muted">仅显示本地历史，不会自动访问小红书。未确认的结果请在官方 App 核实。</p>
      {error ? <p className="publish-error" role="alert">{error}</p> : null}
      {records.map(item => <article className="publish-history-item" key={item.id}><strong>{item.title}</strong><small>{formatDateTime(item.createdAt)}</small><p>{item.message}</p></article>)}
    </section>
  </div>
}
