import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, ExternalLink, FileText, KeyRound, LoaderCircle, LogOut, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { JianshuAccount, JianshuPublication, JianshuResolveInput, RenderListItem, RenderRecord } from '@shared/types'
import { api, ApiError } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'
import PublicationDeleteButton from './PublicationDeleteButton'

const labels: Record<JianshuPublication['status'], string> = { running: '处理中', draft: '草稿', published: '已发布', failed: '失败', uncertain: '结果待核实' }
const safeUrl = (value: string | null) => !!value && /^https:\/\/www\.jianshu\.com\/(?:p\/[A-Za-z0-9_-]+|writer(?:[#/]|$))/.test(value)

export default function JianshuPublishPage() {
  const navigate = useNavigate(), [params, setParams] = useSearchParams(), selectedId = params.get('renderId') || ''
  const mounted = useRef(true)
  const [account, setAccount] = useState<JianshuAccount | null>(null)
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [publications, setPublications] = useState<JianshuPublication[]>([])
  const [connectOpen, setConnectOpen] = useState(false)
  const [cookie, setCookie] = useState('')
  const [connectBusy, setConnectBusy] = useState(false)
  const [connectError, setConnectError] = useState('')
  const [mode, setMode] = useState<'draft' | 'publish'>('draft')
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<'draft' | 'publish' | 'disconnect' | null>(null)
  const [resolveItem, setResolveItem] = useState<JianshuPublication | null>(null)
  const [resolveChoice, setResolveChoice] = useState<'not_published' | 'published' | null>(null)
  const [resolveUrl, setResolveUrl] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const article = record?.results.find(result => result.platform === 'jianshu')
  const processing = publications.some(item => item.status === 'running')
  const busy = submitting || processing || resolveBusy
  const uncertain = publications.some(item => item.renderId === selectedId && item.status === 'uncertain')
  const ready = account?.status === 'connected' && !!article && !busy && !recordLoading && !uncertain

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const results = await Promise.allSettled([api.jianshu.account(), api.renders.list(), api.jianshu.listPublications()])
    if (!mounted.current) return
    const [a, r, p] = results
    if (a.status === 'fulfilled') setAccount(a.value.account)
    if (r.status === 'fulfilled') setRenders(r.value.renders.filter(item => item.platforms.includes('jianshu')))
    if (p.status === 'fulfilled') setPublications(p.value.publications)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') setError(getErrorMessage(failure.reason))
    setRefreshing(false)
  }, [])

  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false } }, [refresh])
  useEffect(() => { if (!selectedId && renders.length) setParams({ platform: 'jianshu', renderId: renders[0].id }, { replace: true }) }, [selectedId, renders, setParams])
  useEffect(() => {
    let cancelled = false
    setRecord(null)
    if (!selectedId) return
    setRecordLoading(true)
    void (async () => {
      try {
        const { render } = await api.renders.get(selectedId)
        if (!render.results.some(result => result.platform === 'jianshu')) throw new Error('这份记录没有简书排版，请先在渲染工作台生成。')
        if (!cancelled) setRecord(render)
      } catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      finally { if (!cancelled) setRecordLoading(false) }
    })()
    return () => { cancelled = true }
  }, [selectedId])
  useEffect(() => {
    if (!processing) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const result = await api.jianshu.listPublications(); if (!cancelled) setPublications(result.publications) }
      catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processing])

  async function connect() {
    if (!cookie.trim()) return
    setConnectBusy(true); setConnectError('')
    try {
      const result = await api.jianshu.connect({ cookie: cookie.trim() })
      if (!mounted.current) return
      setAccount(result.account); setConnectOpen(false); setCookie(''); toast.success('简书已连接，登录状态已保存')
    } catch (cause) { if (mounted.current) setConnectError(getErrorMessage(cause)) }
    finally { if (mounted.current) setConnectBusy(false) }
  }
  async function submit(target: 'draft' | 'publish') {
    if (!record || !ready) return
    setSubmitting(true); setError('')
    try {
      const result = await api.jianshu.publish({ renderId: record.id, mode: target })
      if (!mounted.current) return
      setPublications(current => [result.publication, ...current.filter(item => item.id !== result.publication.id)])
      setConfirmation(null)
      toast.success(result.publication.status === 'running' ? '已提交简书任务，请在下方查看进度' : result.publication.message)
    } catch (cause) { if (mounted.current) { setConfirmation(null); setError(getErrorMessage(cause)) } }
    finally { if (mounted.current) setSubmitting(false) }
  }
  async function disconnect() {
    setSubmitting(true)
    try { await api.jianshu.disconnect(); if (mounted.current) { setAccount({ status: 'disconnected', name: null, checkedAt: null }); setConfirmation(null) } }
    catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setSubmitting(false) }
  }
  function openResolution(item: JianshuPublication) { setResolveItem(item); setResolveChoice(null); setResolveUrl(''); setResolveError('') }
  async function resolveResult(action: JianshuResolveInput['action']) {
    if (!resolveItem || resolveBusy) return
    setResolveBusy(true); setResolveError('')
    try {
      const result = await api.jianshu.resolve(resolveItem.id, action === 'published' ? { action, articleUrl: resolveUrl.trim() } : { action })
      if (!mounted.current) return
      setPublications(current => current.map(item => item.id === result.publication.id ? result.publication : item))
      setResolveItem(null)
      toast.success(action === 'check' ? '正在重新核实，请查看任务进度' : result.publication.message)
    } catch (cause) { if (mounted.current) setResolveError(getErrorMessage(cause)) }
    finally { if (mounted.current) setResolveBusy(false) }
  }

  return <div className="publish-page jianshu-publish-page">
    <header className="publish-heading"><div><span className="publish-eyebrow"><Send size={14} />发布中心 · 简书</span><h1>把内容发布到简书</h1><p>连接简书账号，选择简书排版，保存草稿或直接发布文章。</p></div><button type="button" className="btn" disabled={refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? 'spin' : undefined} />刷新状态</button></header>
    {error ? <div className="publish-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭提示</button></div> : null}
    <section className="publish-account" aria-label="简书账号"><span className="publish-account-icon">简</span><div className="publish-account-copy"><h2>{account?.name || '简书账号'}</h2><p>{account?.status === 'connected' ? '登录状态已加密保存；简书网页端没有可用的扫码登录，使用浏览器 Cookie 连接。' : account?.status === 'expired' ? '登录状态已失效，请重新复制 Cookie 连接。' : '在已登录简书的浏览器中复制 Cookie，粘贴连接（至少包含 remember_user_token）。'}</p>{account?.checkedAt ? <small>最近检查：{formatDateTime(account.checkedAt)}</small> : null}</div><span className={`publish-status ${account?.status === 'connected' ? 'is-success' : ''}`}>{account?.status === 'connected' ? <><CheckCircle2 size={13} />已连接</> : account?.status === 'expired' ? '已过期' : '未连接'}</span><div className="publish-account-actions">{account?.status === 'connected' ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmation('disconnect')}><LogOut size={14} />断开连接</button> : <button type="button" className="btn btn-primary" disabled={busy || refreshing} onClick={() => { setConnectOpen(true); setConnectError('') }}><KeyRound size={16} />连接简书</button>}</div></section>
    <div className="publish-compose-grid"><section className="publish-panel">
      <div className="publish-section-head"><h2>准备发布</h2><p>使用渲染工作台中已保存的简书排版。</p></div>
      {!renders.length && !selectedId && !refreshing ? <div className="publish-empty"><p>先生成一篇简书排版</p><button type="button" className="btn btn-primary" onClick={() => navigate('/render')}>去渲染内容<ArrowRight size={14} /></button></div> : <label className="publish-field">选择内容<select className="input" value={selectedId} disabled={busy} onChange={event => { setError(''); setParams({ platform: 'jianshu', renderId: event.target.value }) }}><option value="" disabled>选择简书排版</option>{selectedId && !renders.some(item => item.id === selectedId) ? <option value={selectedId}>指定的排版记录</option> : null}{renders.map(item => <option key={item.id} value={item.id}>{item.contentTitle} · {formatDateTime(item.createdAt)}</option>)}</select></label>}
      {recordLoading ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在读取排版…</p> : article ? <>
        <div className="publish-article-title"><FileText size={16} /><strong>{article.title}</strong><button type="button" className="btn btn-sm" onClick={() => navigate(`/render?renderId=${encodeURIComponent(selectedId)}`)}>检查排版<ArrowRight size={13} /></button></div>
        <div className="publish-mode-switch" role="group" aria-label="发布方式"><button type="button" className={`btn ${mode === 'draft' ? 'btn-primary' : ''}`} disabled={busy} onClick={() => setMode('draft')}>保存草稿</button><button type="button" className={`btn ${mode === 'publish' ? 'btn-primary' : ''}`} disabled={busy} onClick={() => setMode('publish')}>直接发布</button></div>
        <p className="publish-warning"><ShieldCheck size={14} /> 简书使用浏览器 Cookie 连接；草稿会保存到默认文集，发布前可先保存草稿检查正文格式和图片。简书非会员每天公开文章数量有限，失败时会显示平台返回的原因。</p>
        {uncertain ? <div className="publish-warning"><p>这篇内容有结果待核实的简书任务。请先核实发布结果，再决定是否重新提交。</p><button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(publications.find(item => item.renderId === selectedId && item.status === 'uncertain')!)}>核实结果</button></div> : null}
        <div className="publish-submit-actions"><button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirmation(mode)}>{submitting || processing ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}{mode === 'draft' ? '保存简书草稿' : '发布到简书'}</button><a className="btn" href="https://www.jianshu.com/writer" target="_blank" rel="noreferrer">打开简书编辑器<ExternalLink size={13} /></a></div>
        <p className="publish-form-hint" role="status">{account?.status !== 'connected' ? '请先连接简书账号。' : busy ? '任务正在处理，请在下方查看进度。' : mode === 'draft' ? '草稿会保存到简书默认文集，不会公开。' : '发布后文章会公开显示在简书。'}</p>
      </> : null}
    </section><aside className="publish-panel publish-preview-panel"><div className="publish-section-head"><h2>简书预览</h2><p>以简书实际编辑器和展示效果为准。</p></div>{article ? <div className="jianshu-publish-preview"><h3>{article.title}</h3><iframe title="简书预览" srcDoc={article.html} sandbox="" /></div> : <div className="publish-empty"><p>选择内容后预览简书文章</p></div>}</aside></div>
    <section className="publish-panel publish-history"><div className="publish-section-head"><h2>简书发布记录</h2><p>发布结果会在这里更新，结果待核实时请先到简书草稿箱核对。</p></div>{!publications.length ? <div className="publish-empty"><p>还没有简书发布记录</p></div> : <div className="publish-history-list">{publications.map(item => <article key={item.id} className="publish-history-item"><div className="publish-history-title"><strong>{item.title}</strong><span className={`publish-status ${item.status === 'published' || item.status === 'draft' ? 'is-success' : item.status === 'failed' ? 'is-error' : item.status === 'uncertain' ? 'is-warning' : ''}`}>{labels[item.status]}</span></div><small>{item.mode === 'draft' ? '草稿' : '发布'} · {formatDateTime(item.createdAt)}</small><p>{item.message}</p>{safeUrl(item.url) ? <a className="btn btn-sm" href={item.url!} target="_blank" rel="noreferrer">{item.status === 'draft' ? '打开草稿' : '查看文章'}<ExternalLink size={13} /></a> : null}{item.status === 'uncertain' ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(item)}>核实结果</button> : null}{item.resolutions?.length ? <details className="publish-resolution-history"><summary>核实记录（{item.resolutions.length}）</summary>{item.resolutions.map(entry => <p key={entry.id}><small>{formatDateTime(entry.createdAt)}</small> · {entry.message}</p>)}</details> : null}{item.status === 'draft' || item.status === 'failed' ? <PublicationDeleteButton publication={item} remove={api.jianshu.deletePublication} onDeleted={() => setPublications(current => current.filter(entry => entry.id !== item.id))} platformName="简书" remote={true} disabled={busy} /> : null}</article>)}</div>}</section>
    <p className="publish-bottom-note"><ShieldCheck size={14} />简书连接使用已登录浏览器 Cookie，不保存密码；Cookie 失效后可随时断开并重新连接。</p>
    <Modal open={connectOpen} onClose={() => { if (!connectBusy) setConnectOpen(false) }} title="连接简书" subtitle="从已登录简书的浏览器复制 Cookie" size="compact" closeOnBackdrop={!connectBusy}>
      <div className="publish-connect-form">
        <p className="publish-muted">在浏览器打开 <code>www.jianshu.com</code> 并登录，按 F12 → Network → 任意请求 → Request Headers → Cookie，复制完整值。至少需要包含 <code>remember_user_token</code>。</p>
        <label className="publish-field">Cookie<textarea className="input" rows={6} value={cookie} disabled={connectBusy} placeholder="remember_user_token=...; _m7e_session_core=..." onChange={event => setCookie(event.target.value)} /></label>
        {connectError ? <p className="publish-failure-message" role="alert">{connectError}</p> : null}
        <div className="publish-submit-actions"><button type="button" className="btn btn-primary" disabled={connectBusy || !cookie.trim()} onClick={() => void connect()}>{connectBusy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}验证并保存</button></div>
        <p className="publish-form-hint">Cookie 只会加密保存到当前账号；建议使用后退出简书网页时不要强制注销，否则 Cookie 会失效。</p>
      </div>
    </Modal>
    <Modal open={!!resolveItem} onClose={() => { if (!resolveBusy) setResolveItem(null) }} title="核实简书发布结果" subtitle={resolveItem?.title} size="compact" closeOnBackdrop={!resolveBusy}><div className="publish-resolution-actions"><button type="button" className="btn" disabled={resolveBusy} onClick={() => void resolveResult('check')}><RefreshCw size={14} />重新自动核实</button><button type="button" className={`btn ${resolveChoice === 'not_published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('not_published'); setResolveError('') }}>我已核实，未发布</button><button type="button" className={`btn ${resolveChoice === 'published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('published'); setResolveError('') }}>我已核实，已发布</button></div>{resolveChoice === 'not_published' ? <><p className="publish-warning">请确认简书草稿箱/文章中确实没有这篇内容。确认后允许再次提交。</p><button type="button" className="btn btn-primary" disabled={resolveBusy} onClick={() => void resolveResult('not_published')}>确认未发布，解除限制</button></> : null}{resolveChoice === 'published' ? <><label className="publish-field">已发布简书文章链接<input className="input" type="url" value={resolveUrl} maxLength={2048} disabled={resolveBusy} placeholder="https://www.jianshu.com/p/文章编号" onChange={event => setResolveUrl(event.target.value)} /></label><button type="button" className="btn btn-primary" disabled={resolveBusy || !resolveUrl.trim()} onClick={() => void resolveResult('published')}>确认已发布并关联</button></> : null}{resolveBusy ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在保存核实结果…</p> : null}{resolveError ? <p className="publish-failure-message" role="alert">{resolveError}</p> : null}</Modal>
    <ConfirmDialog open={confirmation === 'draft' || confirmation === 'publish'} title={confirmation === 'draft' ? '保存到简书草稿箱？' : '发布到简书？'} description={<><strong>{article?.title}</strong><p>{confirmation === 'draft' ? '草稿不会公开，可在简书编辑器继续修改。' : '文章会使用简书账号的默认文集公开发布。'}</p></>} confirmLabel={confirmation === 'draft' ? '确认保存草稿' : '确认发布到简书'} tone="primary" loading={submitting} onConfirm={() => submit(confirmation === 'draft' ? 'draft' : 'publish')} onClose={() => setConfirmation(null)} />
    <ConfirmDialog open={confirmation === 'disconnect'} title="断开简书连接？" description="删除系统保存的简书 Cookie，下次发布需要重新复制。简书上的内容保持不变。" confirmLabel="断开连接" loading={submitting} onConfirm={disconnect} onClose={() => setConfirmation(null)} />
  </div>
}
