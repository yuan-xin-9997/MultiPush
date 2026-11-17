import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, ExternalLink, FileText, LoaderCircle, LogOut, QrCode, RefreshCw, Send, ShieldCheck, Smartphone } from 'lucide-react'
import { toast } from 'sonner'
import type { MediaAsset, RenderListItem, RenderRecord, BaijiahaoAccount, BaijiahaoLogin, BaijiahaoPublication, BaijiahaoResolveInput } from '@shared/types'
import { absoluteUrl, api, ApiError } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'
import SmsLoginModal from './SmsLoginModal'
import { useSmsLogin } from './useSmsLogin'

const labels: Record<BaijiahaoPublication['status'], string> = { running: '处理中', draft: '草稿', published: '已发布', failed: '失败', uncertain: '结果待核实' }
const safeUrl = (value: string | null) => !!value && (/^https:\/\/baijiahao\.baidu\.com\/s\?id=\d{10,30}$/.test(value) || value === 'https://baijiahao.baidu.com/builder/rc/edit?type=news')

export default function BaijiahaoPublishPage() {
  const navigate = useNavigate(), [params, setParams] = useSearchParams(), selectedId = params.get('renderId') || ''
  const mounted = useRef(true)
  const [account, setAccount] = useState<BaijiahaoAccount | null>(null)
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [publications, setPublications] = useState<BaijiahaoPublication[]>([])
  const [login, setLogin] = useState<BaijiahaoLogin | null>(null)
  const smsLogin = useSmsLogin({
    platform: 'baijiahao',
    onConnected: (login) => {
      setAccount({ status: 'connected', name: login.name || '百家号账号', checkedAt: new Date().toISOString() })
      setLogin(null)
      setLoginError('')
      setLoginBusy(false)
      setLoginOpen(false)
      toast.success('百家号已连接，登录状态已保存')
    },
  })
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'draft' | 'publish'>('publish')
  const [confirmation, setConfirmation] = useState<'draft' | 'publish' | 'disconnect' | null>(null)
  const [resolveItem, setResolveItem] = useState<BaijiahaoPublication | null>(null)
  const [resolveChoice, setResolveChoice] = useState<'not_published' | 'published' | null>(null)
  const [resolveUrl, setResolveUrl] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const article = record?.results.find(result => result.platform === 'baijiahao')
  const processing = publications.some(item => item.status === 'running')
  const busy = submitting || processing || resolveBusy
  const uncertain = publications.some(item => item.renderId === selectedId && item.status === 'uncertain')
  const ready = account?.status === 'connected' && !!article && !busy && !recordLoading && !uncertain

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const results = await Promise.allSettled([api.baijiahao.account(), api.renders.list(), api.baijiahao.listPublications()])
    if (!mounted.current) return
    const [a, r, p] = results
    if (a.status === 'fulfilled') setAccount(a.value.account)
    if (r.status === 'fulfilled') setRenders(r.value.renders.filter(item => item.platforms.includes('baijiahao')))
    if (p.status === 'fulfilled') setPublications(p.value.publications)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') setError(getErrorMessage(failure.reason))
    setRefreshing(false)
  }, [])

  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false } }, [refresh])
  useEffect(() => {
    if (!selectedId && renders.length) setParams({ platform: 'baijiahao', renderId: renders[0].id }, { replace: true })
  }, [selectedId, renders, setParams])
  useEffect(() => {
    let cancelled = false
    setRecord(null)
    if (!selectedId) return
    setRecordLoading(true)
    void (async () => {
      try {
        const { render } = await api.renders.get(selectedId)
        if (!render.results.some(result => result.platform === 'baijiahao')) throw new Error('这份记录没有百家号排版，请先在渲染工作台生成。')
        if (!cancelled) setRecord(render)
      } catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      finally { if (!cancelled) setRecordLoading(false) }
    })()
    return () => { cancelled = true }
  }, [selectedId])
  useEffect(() => {
    if (!login || !['waiting', 'scanned'].includes(login.status)) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const { login: next } = await api.baijiahao.loginStatus(login.id)
        if (cancelled) return
        setLoginError('')
        if (next.status === 'connected') {
          const result = await api.baijiahao.account()
          if (cancelled) return
          setLogin(next); setAccount(result.account); setLoginOpen(false); toast.success('百家号已连接，登录状态已保存')
        } else setLogin(next)
      } catch (cause) {
        if (!cancelled) {
          setLoginError(getErrorMessage(cause))
          if (cause instanceof ApiError && cause.status === 404) setLogin(current => current ? { ...current, status: 'expired', qrCode: null } : null)
        }
      }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [login?.id, login?.status])
  useEffect(() => {
    if (!processing) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const result = await api.baijiahao.listPublications(); if (!cancelled) setPublications(result.publications) }
      catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processing])

  async function startLogin() {
    setLoginOpen(true); setLoginBusy(true); setLoginError(''); setLogin(null)
    try { const result = await api.baijiahao.startLogin(); if (mounted.current) setLogin(result.login) }
    catch (cause) { if (mounted.current) setLoginError(getErrorMessage(cause)) }
    finally { if (mounted.current) setLoginBusy(false) }
  }
  async function publish() {
    if (!record || !ready) return
    setSubmitting(true); setError('')
    try {
      const result = await api.baijiahao.publish({ renderId: record.id, mode })
      if (!mounted.current) return
      setPublications(current => [result.publication, ...current.filter(item => item.id !== result.publication.id)])
      setConfirmation(null)
      toast.success(result.publication.status === 'running' ? '已提交百家号发布，请在下方查看进度' : result.publication.message)
    } catch (cause) { if (mounted.current) { setConfirmation(null); setError(getErrorMessage(cause)) } }
    finally { if (mounted.current) setSubmitting(false) }
  }
  async function disconnect() {
    setSubmitting(true)
    try { await api.baijiahao.disconnect(); if (mounted.current) { setAccount({ status: 'disconnected', name: null, checkedAt: null }); setLogin(null); setConfirmation(null) } }
    catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setSubmitting(false) }
  }
  function openResolution(item: BaijiahaoPublication) {
    setResolveItem(item); setResolveChoice(null); setResolveUrl(''); setResolveError('')
  }
  async function resolveResult(action: BaijiahaoResolveInput['action']) {
    if (!resolveItem || resolveBusy) return
    setResolveBusy(true); setResolveError('')
    try {
      const result = await api.baijiahao.resolve(resolveItem.id, action === 'published' ? { action, articleUrl: resolveUrl.trim() } : { action })
      if (!mounted.current) return
      setPublications(current => current.map(item => item.id === result.publication.id ? result.publication : item))
      setResolveItem(null)
      toast.success(action === 'check' ? '正在重新核实，请查看任务进度' : result.publication.message)
    } catch (cause) { if (mounted.current) setResolveError(getErrorMessage(cause)) }
    finally { if (mounted.current) setResolveBusy(false) }
  }

  return <div className="publish-page baijiahao-publish-page">
    <header className="publish-heading"><div><span className="publish-eyebrow"><Send size={14} />发布中心 · 百家号</span><h1>把内容发布到百家号</h1><p>连接百家号账号，选择百家号排版，一键发布图文文章。</p></div><button type="button" className="btn" disabled={refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? 'spin' : undefined} />刷新状态</button></header>
    {error ? <div className="publish-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭提示</button></div> : null}
    <section className="publish-account" aria-label="百家号账号">
      <span className="publish-account-icon">百</span><div className="publish-account-copy"><h2>{account?.name || '百家号账号'}</h2><p>{account?.status === 'connected' ? '登录状态已加密保存，下次访问和服务重启后自动复用；失效时重新扫码或使用手机验证码。' : account?.status === 'expired' ? '登录状态已失效，请重新扫码或使用手机验证码连接。' : '使用百度 App 扫码登录，或使用手机验证码连接。'}</p>{account?.checkedAt ? <small>最近检查：{formatDateTime(account.checkedAt)}</small> : null}</div>
      <span className={`publish-status ${account?.status === 'connected' ? 'is-success' : ''}`}>{account?.status === 'connected' ? <><CheckCircle2 size={13} />已连接</> : account?.status === 'expired' ? '已过期' : '未连接'}</span>
      <div className="publish-account-actions">{account?.status === 'connected' ? <button type="button" className="btn btn-sm" disabled={busy || loginBusy} onClick={() => setConfirmation('disconnect')}><LogOut size={14} />断开连接</button> : <><button type="button" className="btn btn-primary" disabled={busy || loginBusy || refreshing} onClick={() => void startLogin()}><QrCode size={16} />扫码连接百家号</button><button type="button" className="btn" disabled={busy || loginBusy || refreshing || smsLogin.busy || loginOpen} onClick={smsLogin.openModal}><Smartphone size={15} />手机验证码登录</button></>}{login && ['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn btn-sm" onClick={() => setLoginOpen(true)}>查看登录二维码</button> : null}</div>
    </section>
    <div className="publish-compose-grid"><section className="publish-panel">
      <div className="publish-section-head"><h2>准备发布</h2><p>使用渲染工作台中已保存的百家号排版。</p></div>
      {!renders.length && !selectedId && !refreshing ? <div className="publish-empty"><p>先生成一篇百家号排版</p><button type="button" className="btn btn-primary" onClick={() => navigate('/render')}>去渲染内容<ArrowRight size={14} /></button></div> : <label className="publish-field">选择内容<select className="input" value={selectedId} disabled={busy} onChange={event => { setError(''); setParams({ platform: 'baijiahao', renderId: event.target.value }) }}><option value="" disabled>选择百家号排版</option>{selectedId && !renders.some(item => item.id === selectedId) ? <option value={selectedId}>指定的排版记录</option> : null}{renders.map(item => <option key={item.id} value={item.id}>{item.contentTitle} · {formatDateTime(item.createdAt)}</option>)}</select></label>}
      {recordLoading ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在读取排版…</p> : article ? <>
        <div className="publish-article-title"><FileText size={16} /><strong>{article.title}</strong><button type="button" className="btn btn-sm" onClick={() => navigate(`/render?renderId=${encodeURIComponent(selectedId)}`)}>检查排版<ArrowRight size={13} /></button></div>
        <p className="publish-warning">百家号会以图文形式发布：标题作为首行，正文保留，标签转换为 #话题#，最多上传 9 张图片。发布前请确认内容没有超过百家号限制。</p>
        {uncertain ? <div className="publish-warning"><p>这篇内容有结果待核实的百家号任务。请先核实发布结果，再决定是否重新提交。</p><button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(publications.find(item => item.renderId === selectedId && item.status === 'uncertain')!)}>核实结果</button></div> : null}
        <div className="publish-mode-switch" role="group" aria-label="发布方式"><button type="button" className={`btn ${mode === 'draft' ? 'btn-primary' : ''}`} disabled={busy} onClick={() => setMode('draft')}>保存草稿</button><button type="button" className={`btn ${mode === 'publish' ? 'btn-primary' : ''}`} disabled={busy} onClick={() => setMode('publish')}>直接发布</button></div>
        <div className="publish-submit-actions"><button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirmation(mode)}>{submitting || processing ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}{mode === 'draft' ? '保存到百家号草稿箱' : '发布到百家号'}</button></div>
        <p className="publish-form-hint" role="status">{account?.status !== 'connected' ? '请先扫码连接百家号。' : busy ? '任务正在处理，请在下方查看进度。' : '发布后内容会公开显示在百家号。'}</p>
      </> : null}
    </section><aside className="publish-panel publish-preview-panel"><div className="publish-section-head"><h2>百家号预览</h2><p>以百家号实际展示和审核结果为准。</p></div>{article ? <div className="baijiahao-publish-preview"><h3>{article.title}</h3><iframe title="百家号预览" srcDoc={article.html} sandbox="" /></div> : <div className="publish-empty"><p>选择内容后预览百家号文章</p></div>}</aside></div>
    <section className="publish-panel publish-history"><div className="publish-section-head"><h2>百家号发布记录</h2><p>发布结果会在这里更新，结果待核实时请先到百家号创作中心核对。</p></div>{!publications.length ? <div className="publish-empty"><p>还没有百家号发布记录</p></div> : <div className="publish-history-list">{publications.map(item => <article key={item.id} className="publish-history-item"><div className="publish-history-title"><strong>{item.title}</strong><span className={`publish-status ${item.status === 'published' ? 'is-success' : item.status === 'failed' ? 'is-error' : item.status === 'uncertain' ? 'is-warning' : ''}`}>{labels[item.status]}</span></div><small>发布 · {formatDateTime(item.createdAt)}</small><p>{item.message}</p>{safeUrl(item.url) ? <a className="btn btn-sm" href={item.url!} target="_blank" rel="noreferrer">查看文章<ExternalLink size={13} /></a> : null}{item.status === 'uncertain' ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(item)}>核实结果</button> : null}{item.resolutions?.length ? <details className="publish-resolution-history"><summary>核实记录（{item.resolutions.length}）</summary>{item.resolutions.map(entry => <p key={entry.id}><small>{formatDateTime(entry.createdAt)}</small> · {entry.message}</p>)}</details> : null}</article>)}</div>}</section>
    <p className="publish-bottom-note"><ShieldCheck size={14} />使用百家号官方二维码或手机验证码登录，无需提供百家号密码。遇到安全验证时系统会停止操作并保留记录。</p>
    <SmsLoginModal
      open={smsLogin.open}
      onClose={smsLogin.close}
      platformName="百家号"
      platformLoginUrl="https://baijiahao.baidu.com/builder/theme/bjh/login"
      login={smsLogin.login}
      busy={smsLogin.busy}
      error={smsLogin.error}
      onStart={smsLogin.start}
      onVerify={smsLogin.verify}
      onReset={smsLogin.reset}
    />
    <Modal open={loginOpen} onClose={() => setLoginOpen(false)} title="连接百家号" subtitle="使用百度 App 扫码，并在手机上确认登录" size="compact"><div className="publish-login" aria-live="polite">{loginBusy || login?.status === 'waiting' && !login.qrCode ? <><LoaderCircle size={30} className="spin" /><p>正在获取百家号官方登录二维码…</p></> : login ? <>{login.qrCode && ['waiting', 'scanned'].includes(login.status) ? <img className="publish-login-qr" src={login.qrCode} alt="百家号官方登录二维码" /> : <QrCode size={32} />}<p>{login.message}</p><small>有效期至 {formatDateTime(login.expiresAt)}</small>{!['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn" onClick={() => void startLogin()}>重新获取二维码</button> : null}</> : null}{loginError ? <p className="publish-failure-message" role="alert">{loginError}</p> : null}{!loginBusy && !login ? <button type="button" className="btn btn-primary" onClick={() => void startLogin()}>重新连接</button> : null}</div></Modal>
    <Modal open={!!resolveItem} onClose={() => { if (!resolveBusy) setResolveItem(null) }} title="核实百家号发布结果" subtitle={resolveItem?.title} size="compact" closeOnBackdrop={!resolveBusy}>
      <div className="publish-resolution-actions">
        {safeUrl(resolveItem?.url || null) ? <a className="btn" href={resolveItem!.url!} target="_blank" rel="noreferrer">打开百家号核对<ExternalLink size={14} /></a> : null}
        <button type="button" className="btn" disabled={resolveBusy} onClick={() => void resolveResult('check')}><RefreshCw size={14} />重新自动核实</button>
        <button type="button" className={`btn ${resolveChoice === 'not_published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('not_published'); setResolveError('') }}>我已核实，未发布</button>
        <button type="button" className={`btn ${resolveChoice === 'published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('published'); setResolveError('') }}>我已核实，已发布</button>
      </div>
      {resolveChoice === 'not_published' ? <><p className="publish-warning">请确认百家号创作中心没有这篇内容。确认后将解除限制，允许你再次提交；此操作不会立即发布。</p><button type="button" className="btn btn-primary" disabled={resolveBusy} onClick={() => void resolveResult('not_published')}>确认未发布，解除限制</button></> : null}
      {resolveChoice === 'published' ? <><label className="publish-field">已发布百家号链接<input className="input" type="url" value={resolveUrl} maxLength={2048} disabled={resolveBusy} placeholder="https://baijiahao.baidu.com/s?id=文章编号" onChange={event => setResolveUrl(event.target.value)} /></label><p className="publish-muted">将按你的核实结果标记已发布并关联链接，不会再次发布这条百家号。</p><button type="button" className="btn btn-primary" disabled={resolveBusy || !resolveUrl.trim()} onClick={() => void resolveResult('published')}>确认已发布并关联</button></> : null}
      {resolveBusy ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在保存核实结果…</p> : null}
      {resolveError ? <p className="publish-failure-message" role="alert">{resolveError}</p> : null}
    </Modal>
    <ConfirmDialog open={confirmation === 'draft' || confirmation === 'publish'} title={confirmation === 'draft' ? '保存到百家号草稿箱？' : '发布到百家号？'} description={<><strong>{article?.title}</strong><p>{confirmation === 'draft' ? '内容会保存到百家号草稿箱，不会公开发布。' : `将发布至「${account?.name || '已连接百家号账号'}」，内容会公开显示在百家号。`}</p></>} confirmLabel={confirmation === 'draft' ? '确认保存草稿' : '确认发布到百家号'} tone="primary" loading={submitting} onConfirm={() => publish()} onClose={() => setConfirmation(null)} />
    <ConfirmDialog open={confirmation === 'disconnect'} title="断开百家号连接？" description="删除系统保存的百家号登录状态，下次发布需要重新扫码。百家号上的内容保持不变。" confirmLabel="断开连接" loading={submitting} onConfirm={disconnect} onClose={() => setConfirmation(null)} />
  </div>
}
