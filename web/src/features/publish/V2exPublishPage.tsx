import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileText,
  KeyRound,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import type { RenderListItem, RenderRecord, V2exAccount, V2exNode, V2exPublication, V2exResolveInput } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { copyText, formatDateTime } from '@/lib/utils'
import ConfirmDialog from '@/components/ConfirmDialog'
import Modal from '@/components/Modal'
import PublicationDeleteButton from './PublicationDeleteButton'

const labels: Record<V2exPublication['status'], string> = {
  running: '处理中',
  published: '已发布',
  failed: '失败',
  uncertain: '结果待核实',
}

const safeUrl = (value: string | null) => !!value && /^https:\/\/www\.v2ex\.com\/t\/\d+/i.test(value)

function bodyMarkdown(markdown: string | null | undefined, title: string): string {
  const lines = (markdown ?? '').split('\n')
  if (lines.length > 1 && /^#\s+/.test(lines[0]) && lines[0].replace(/^#\s+/, '').trim() === title) lines.shift()
  return lines.join('\n').trim()
}

export default function V2exPublishPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('renderId') || ''
  const mounted = useRef(true)
  const nodeNameRef = useRef('programming')

  const [account, setAccount] = useState<V2exAccount | null>(null)
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [nodes, setNodes] = useState<V2exNode[]>([])
  const [nodeName, setNodeName] = useState('programming')

  nodeNameRef.current = nodeName
  const [publications, setPublications] = useState<V2exPublication[]>([])
  const [recordLoading, setRecordLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [connectOpen, setConnectOpen] = useState(false)
  const [cookie, setCookie] = useState('')
  const [connectBusy, setConnectBusy] = useState(false)
  const [connectError, setConnectError] = useState('')
  const [confirmation, setConfirmation] = useState<'publish' | 'disconnect' | null>(null)
  const [resolveItem, setResolveItem] = useState<V2exPublication | null>(null)
  const [resolveChoice, setResolveChoice] = useState<'not_published' | 'published' | null>(null)
  const [resolveUrl, setResolveUrl] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  const [resolveError, setResolveError] = useState('')

  const article = record?.results.find(result => result.platform === 'v2ex')
  const processing = publications.some(item => item.status === 'running')
  const busy = submitting || processing || resolveBusy
  const uncertain = publications.some(item => item.renderId === selectedId && item.status === 'uncertain')
  const ready = account?.status === 'connected' && !!article && !!nodeName.trim() && !busy && !recordLoading && !uncertain

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const results = await Promise.allSettled([api.v2ex.account(), api.renders.list(), api.v2ex.listPublications(), api.v2ex.nodes()])
    if (!mounted.current) return
    const [a, r, p, n] = results
    if (a.status === 'fulfilled') setAccount(a.value.account)
    if (r.status === 'fulfilled') setRenders(r.value.renders.filter(item => item.platforms.includes('v2ex')))
    if (p.status === 'fulfilled') setPublications(p.value.publications)
    if (n.status === 'fulfilled') {
      setNodes(n.value.nodes)
      if (n.value.nodes.length && !n.value.nodes.some(node => node.name === nodeNameRef.current)) setNodeName(n.value.nodes[0].name)
    }
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') setError(getErrorMessage(failure.reason))
    setRefreshing(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [refresh])

  useEffect(() => {
    if (!selectedId && renders.length) setParams({ platform: 'v2ex', renderId: renders[0].id }, { replace: true })
  }, [selectedId, renders, setParams])

  useEffect(() => {
    let cancelled = false
    setRecord(null)
    if (!selectedId) return
    setRecordLoading(true)
    void (async () => {
      try {
        const { render } = await api.renders.get(selectedId)
        if (!render.results.some(result => result.platform === 'v2ex')) throw new Error('这份记录没有 V2EX 排版，请先在渲染工作台生成。')
        if (!cancelled) setRecord(render)
      } catch (cause) {
        if (!cancelled) setError(getErrorMessage(cause))
      } finally {
        if (!cancelled) setRecordLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedId])

  useEffect(() => {
    if (!processing) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await api.v2ex.listPublications()
        if (!cancelled) setPublications(result.publications)
      } catch (cause) {
        if (!cancelled) setError(getErrorMessage(cause))
      }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processing])

  async function connect() {
    if (!cookie.trim()) return
    setConnectBusy(true)
    setConnectError('')
    try {
      const result = await api.v2ex.connect({ cookie: cookie.trim() })
      if (!mounted.current) return
      setAccount(result.account)
      setConnectOpen(false)
      setCookie('')
      toast.success('V2EX 已连接，登录状态已加密保存')
      void refresh()
    } catch (cause) {
      if (mounted.current) setConnectError(getErrorMessage(cause))
    } finally {
      if (mounted.current) setConnectBusy(false)
    }
  }

  async function publish() {
    if (!record || !ready) return
    setSubmitting(true)
    setError('')
    try {
      const result = await api.v2ex.publish({ renderId: record.id, nodeName: nodeName.trim() })
      if (!mounted.current) return
      setPublications(current => [result.publication, ...current.filter(item => item.id !== result.publication.id)])
      setConfirmation(null)
      if (result.publication.status === 'published') toast.success('V2EX 主题已发布')
      else if (result.publication.status === 'uncertain') {
        toast.error('V2EX 发布结果待核实，请先到 V2EX 检查，避免重复发布')
        setError(result.publication.message)
      } else {
        toast.error(result.publication.message)
        setError(result.publication.message)
      }
    } catch (cause) {
      if (mounted.current) {
        setConfirmation(null)
        setError(getErrorMessage(cause))
      }
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  async function disconnect() {
    setSubmitting(true)
    try {
      await api.v2ex.disconnect()
      if (mounted.current) {
        setAccount({ status: 'disconnected', name: null, checkedAt: null })
        setConfirmation(null)
        toast.success('已断开 V2EX 连接')
      }
    } catch (cause) {
      if (mounted.current) setError(getErrorMessage(cause))
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  function openResolution(item: V2exPublication) {
    setResolveItem(item)
    setResolveChoice(null)
    setResolveUrl(item.url || '')
    setResolveError('')
  }

  async function resolveResult(action: V2exResolveInput['action']) {
    if (!resolveItem || resolveBusy) return
    setResolveBusy(true)
    setResolveError('')
    try {
      const result = await api.v2ex.resolve(resolveItem.id, action === 'published' ? { action, topicUrl: resolveUrl.trim() } : { action })
      if (!mounted.current) return
      setPublications(current => current.map(item => item.id === result.publication.id ? result.publication : item))
      setResolveItem(null)
      toast.success(action === 'check' ? '正在重新核实，请稍后刷新' : result.publication.message)
    } catch (cause) {
      if (mounted.current) setResolveError(getErrorMessage(cause))
    } finally {
      if (mounted.current) setResolveBusy(false)
    }
  }

  async function copyTitle() {
    if (!article) return
    try {
      await copyText(article.title)
      toast.success('V2EX 主题标题已复制')
    } catch {
      toast.error('复制标题失败，请手动选择标题')
    }
  }

  async function copyBody() {
    if (!article) return
    try {
      await copyText(bodyMarkdown(article.markdown, article.title))
      toast.success('V2EX Markdown 正文已复制')
    } catch {
      toast.error('复制 Markdown 失败，请下载 Markdown 文件')
    }
  }

  const markdownBody = article ? bodyMarkdown(article.markdown, article.title) : ''
  const nodeTitle = nodes.find(node => node.name === nodeName)?.title

  return (
    <div className="publish-page v2ex-publish-page">
      <header className="publish-heading">
        <div>
          <span className="publish-eyebrow"><Send size={14} />发布中心 · V2EX</span>
          <h1>把内容发布到 V2EX</h1>
          <p>生成 V2EX 主题 Markdown，选择节点后通过浏览器会话发布公开主题；也可复制内容手动发布。</p>
        </div>
        <button type="button" className="btn" disabled={refreshing || busy} onClick={() => void refresh()}>
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} />刷新状态
        </button>
      </header>
      {error ? <div className="publish-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭提示</button></div> : null}

      <section className="publish-account" aria-label="V2EX 账号">
        <span className="publish-account-icon" style={{ background: '#f2f2f2', color: '#333' }}>V</span>
        <div className="publish-account-copy">
          <h2>{account?.name || 'V2EX 账号'}</h2>
          <p>{account?.status === 'connected' ? '登录状态已加密保存。V2EX 没有官方发帖 API，发布使用浏览器会话完成。' : account?.status === 'expired' ? '登录状态已失效，请重新复制 Cookie 连接。' : '在已登录 V2EX 的浏览器中复制完整 Cookie，粘贴连接后即可发布主题。'}</p>
          {account?.checkedAt ? <small>最近检查：{formatDateTime(account.checkedAt)}</small> : null}
        </div>
        <span className={`publish-status ${account?.status === 'connected' ? 'is-success' : ''}`}>
          {account?.status === 'connected' ? <><CheckCircle2 size={13} />已连接</> : account?.status === 'expired' ? '已过期' : '未连接'}
        </span>
        <div className="publish-account-actions">
          {account?.status === 'connected'
            ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmation('disconnect')}><LogOut size={14} />断开连接</button>
            : <button type="button" className="btn btn-primary" disabled={busy || refreshing} onClick={() => { setConnectOpen(true); setConnectError('') }}><KeyRound size={16} />连接 V2EX</button>}
        </div>
      </section>

      <div className="publish-compose-grid">
        <section className="publish-panel">
          <div className="publish-section-head"><h2>准备发布</h2><p>使用渲染工作台中已保存的 V2EX 排版。</p></div>
          {!renders.length && !selectedId && !refreshing ? (
            <div className="publish-empty"><p>先生成一篇 V2EX 排版</p><button type="button" className="btn btn-primary" onClick={() => navigate('/render')}>去渲染内容<ArrowRight size={14} /></button></div>
          ) : (
            <label className="publish-field">选择内容
              <select className="input" value={selectedId} disabled={busy} onChange={event => { setError(''); setParams({ platform: 'v2ex', renderId: event.target.value }) }}>
                <option value="" disabled>选择 V2EX 排版</option>
                {selectedId && !renders.some(item => item.id === selectedId) ? <option value={selectedId}>指定的排版记录</option> : null}
                {renders.map(item => <option key={item.id} value={item.id}>{item.contentTitle} · {formatDateTime(item.createdAt)}</option>)}
              </select>
            </label>
          )}
          {recordLoading ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在读取排版…</p> : article ? (
            <>
              <div className="publish-article-title"><FileText size={16} /><strong>{article.title}</strong><button type="button" className="btn btn-sm" onClick={() => navigate(`/render?renderId=${encodeURIComponent(selectedId)}`)}>检查排版<ArrowRight size={13} /></button></div>
              <label className="publish-field">发布节点
                <select className="input" value={nodeName} disabled={busy} onChange={event => setNodeName(event.target.value)}>
                  {nodes.map(node => <option key={node.name} value={node.name}>{node.title} · {node.name}</option>)}
                </select>
              </label>
              <p className="publish-warning"><ShieldCheck size={14} /> V2EX 没有官方写 API，发布通过浏览器会话完成；主题会立即公开，没有草稿模式。标题最多 120 字、正文最多 20000 字符，不支持视频。当前节点：{nodeTitle || nodeName}。</p>
              {uncertain ? <div className="publish-warning"><p>这篇内容有结果待核实的 V2EX 任务。请先核实发布结果，再决定是否重新提交。</p><button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(publications.find(item => item.renderId === selectedId && item.status === 'uncertain')!)}>核实结果</button></div> : null}
              <div className="publish-submit-actions">
                <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirmation('publish')}>
                  {submitting || processing ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}发布到 V2EX
                </button>
                <button type="button" className="btn" disabled={!article} onClick={() => void copyTitle()}>复制标题</button>
                <button type="button" className="btn" disabled={!article} onClick={() => void copyBody()}>复制 Markdown</button>
                <a className="btn" href="https://www.v2ex.com/new" target="_blank" rel="noreferrer">打开发帖页<ExternalLink size={13} /></a>
              </div>
              <p className="publish-form-hint" role="status">
                {account?.status !== 'connected' ? '请先连接 V2EX 账号。' : busy ? '任务正在处理，请稍候…' : `将以公开主题发布，节点：${nodeTitle || nodeName}。`}
              </p>
            </>
          ) : null}
        </section>
        <aside className="publish-panel publish-preview-panel">
          <div className="publish-section-head"><h2>V2EX 预览</h2><p>以 V2EX 实际展示效果为准；发布前请检查 Markdown、图片和节点。</p></div>
          {article ? <div className="v2ex-publish-preview"><h3>{article.title}</h3><iframe title="V2EX 主题预览" srcDoc={article.html} sandbox="" /></div> : <div className="publish-empty"><p>选择内容后预览 V2EX 主题</p></div>}
        </aside>
      </div>

      <section className="publish-panel publish-history">
        <div className="publish-section-head"><h2>V2EX 发布记录</h2><p>V2EX 主题没有草稿；发布成功后会生成公开链接。</p></div>
        {!publications.length ? <div className="publish-empty"><p>还没有 V2EX 发布记录</p></div> : (
          <div className="publish-history-list">
            {publications.map(item => (
              <article key={item.id} className="publish-history-item">
                <div className="publish-history-title">
                  <strong>{item.title}</strong>
                  <span className={`publish-status ${item.status === 'published' ? 'is-success' : item.status === 'failed' ? 'is-error' : item.status === 'uncertain' ? 'is-warning' : ''}`}>{labels[item.status]}</span>
                </div>
                <small>节点 {item.nodeName} · {formatDateTime(item.createdAt)}</small>
                <p>{item.message}</p>
                {safeUrl(item.url) ? <a className="btn btn-sm" href={item.url!} target="_blank" rel="noreferrer">查看主题<ExternalLink size={13} /></a> : null}
                {item.status === 'uncertain' ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(item)}>核实结果</button> : null}
                {item.resolutions?.length ? <details className="publish-resolution-history"><summary>核实记录（{item.resolutions.length}）</summary>{item.resolutions.map(entry => <p key={entry.id}><small>{formatDateTime(entry.createdAt)}</small> · {entry.message}</p>)}</details> : null}
                {item.status === 'failed' ? <PublicationDeleteButton publication={item} remove={api.v2ex.deletePublication} onDeleted={() => setPublications(current => current.filter(entry => entry.id !== item.id))} platformName="V2EX" remote={false} disabled={busy} /> : null}
              </article>
            ))}
          </div>
        )}
      </section>
      <p className="publish-bottom-note"><ShieldCheck size={14} />V2EX 连接使用浏览器 Cookie，不保存密码；Cookie 失效后可随时断开并重新连接。发布结果以 V2EX 主题页为准，结果待核实时请先到 V2EX 核实。</p>

      <Modal open={connectOpen} onClose={() => { if (!connectBusy) setConnectOpen(false) }} title="连接 V2EX" subtitle="从已登录 V2EX 的浏览器复制 Cookie" size="compact" closeOnBackdrop={!connectBusy}>
        <div className="publish-connect-form">
          <p className="publish-muted">在浏览器打开 <code>www.v2ex.com</code> 并登录，按 F12 → Network → 任意请求 → Request Headers → Cookie，复制完整值。至少需要包含 <code>PB3_SESSION</code> 和登录态 Cookie。</p>
          <label className="publish-field">Cookie<textarea className="input" rows={6} value={cookie} disabled={connectBusy} placeholder="PB3_SESSION=...; A2=...; V2EX_LANG=..." onChange={event => setCookie(event.target.value)} /></label>
          {connectError ? <p className="publish-failure-message" role="alert">{connectError}</p> : null}
          <div className="publish-submit-actions"><button type="button" className="btn btn-primary" disabled={connectBusy || !cookie.trim()} onClick={() => void connect()}>{connectBusy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}验证并保存</button></div>
          <p className="publish-form-hint">Cookie 只会加密保存到当前账号；连接时会打开 V2EX 发帖页验证登录状态。</p>
        </div>
      </Modal>

      <Modal open={!!resolveItem} onClose={() => { if (!resolveBusy) setResolveItem(null) }} title="核实 V2EX 发布结果" subtitle={resolveItem?.title} size="compact" closeOnBackdrop={!resolveBusy}>
        <div className="publish-resolution-actions">
          <button type="button" className="btn" disabled={resolveBusy} onClick={() => void resolveResult('check')}><RefreshCw size={14} />重新自动核实</button>
          <button type="button" className={`btn ${resolveChoice === 'not_published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('not_published'); setResolveError('') }}>我已核实，未发布</button>
          <button type="button" className={`btn ${resolveChoice === 'published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('published'); setResolveError('') }}>我已核实，已发布</button>
        </div>
        {resolveChoice === 'not_published' ? <><p className="publish-warning">请确认 V2EX 上确实没有这个主题。确认后允许再次提交。</p><button type="button" className="btn btn-primary" disabled={resolveBusy} onClick={() => void resolveResult('not_published')}>确认未发布，解除限制</button></> : null}
        {resolveChoice === 'published' ? <><label className="publish-field">已发布 V2EX 主题链接<input className="input" type="url" value={resolveUrl} maxLength={2048} disabled={resolveBusy} placeholder="https://www.v2ex.com/t/123456" onChange={event => setResolveUrl(event.target.value)} /></label><button type="button" className="btn btn-primary" disabled={resolveBusy || !resolveUrl.trim()} onClick={() => void resolveResult('published')}>确认已发布并关联</button></> : null}
        {resolveBusy ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在保存核实结果…</p> : null}
        {resolveError ? <p className="publish-failure-message" role="alert">{resolveError}</p> : null}
      </Modal>

      <ConfirmDialog open={confirmation === 'publish'} title="发布到 V2EX？" description={<><strong>{article?.title}</strong><p>将以公开主题发布到节点「{nodeTitle || nodeName}」，发布后立即公开，没有草稿。请确认标题、Markdown 和图片。</p></>} confirmLabel="确认发布" tone="primary" loading={submitting} onConfirm={() => void publish()} onClose={() => setConfirmation(null)} />
      <ConfirmDialog open={confirmation === 'disconnect'} title="断开 V2EX 连接？" description="删除系统保存的 V2EX Cookie，下次发布需要重新复制。V2EX 上已发布的主题保持不变。" confirmLabel="断开连接" loading={submitting} onConfirm={() => void disconnect()} onClose={() => setConfirmation(null)} />
    </div>
  )
}
