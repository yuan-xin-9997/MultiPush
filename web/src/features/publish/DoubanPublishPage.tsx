import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, ClipboardCopy, ExternalLink, FileText, LoaderCircle, LogOut, QrCode, RefreshCw, Send, ShieldAlert, Smartphone } from 'lucide-react'
import { toast } from 'sonner'
import type { DoubanAccount, DoubanLogin, DoubanPublication, DoubanResolveInput, RenderListItem, RenderRecord } from '@shared/types'
import { api, ApiError } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'
import PublicationDeleteButton from './PublicationDeleteButton'
import SmsLoginModal from './SmsLoginModal'
import { useSmsLogin } from './useSmsLogin'

const labels: Record<DoubanPublication['status'], string> = { running: '处理中', draft: '草稿', published: '已发布', failed: '失败', uncertain: '结果待核实' }
const safeUrl = (value: string | null) => !!value && /^https:\/\/www\.douban\.com\/note\/\d{6,30}\/$/.test(value)

export default function DoubanPublishPage() {
  const navigate = useNavigate(), [params, setParams] = useSearchParams(), selectedId = params.get('renderId') || ''
  const mounted = useRef(true)
  const [account, setAccount] = useState<DoubanAccount | null>(null)
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [publications, setPublications] = useState<DoubanPublication[]>([])
  const [login, setLogin] = useState<DoubanLogin | null>(null)
  const smsLogin = useSmsLogin({
    platform: 'douban',
    onConnected: (login) => {
      setAccount({ status: 'connected', name: login.name || '豆瓣账号', checkedAt: new Date().toISOString() })
      setLogin(null)
      setLoginError('')
      setLoginBusy(false)
      setLoginOpen(false)
      toast.success('豆瓣已连接，登录状态已保存')
    },
  })
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [privacy, setPrivacy] = useState<'public' | 'private'>('public')
  const [tags, setTags] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'draft' | 'publish'>('publish')
  const [confirmation, setConfirmation] = useState<'draft' | 'publish' | 'disconnect' | null>(null)
  const [resolveItem, setResolveItem] = useState<DoubanPublication | null>(null)
  const [resolveChoice, setResolveChoice] = useState<'not_published' | 'published' | null>(null)
  const [resolveUrl, setResolveUrl] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const article = record?.results.find(result => result.platform === 'douban')
  const processing = publications.some(item => item.status === 'running')
  const busy = submitting || processing || resolveBusy
  const uncertain = publications.some(item => item.renderId === selectedId && item.status === 'uncertain')
  const ready = account?.status === 'connected' && !!article && !busy && !recordLoading && !uncertain

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const results = await Promise.allSettled([api.douban.account(), api.renders.list(), api.douban.listPublications()])
    if (!mounted.current) return
    const [a, r, p] = results
    if (a.status === 'fulfilled') setAccount(a.value.account)
    if (r.status === 'fulfilled') setRenders(r.value.renders.filter(item => item.platforms.includes('douban')))
    if (p.status === 'fulfilled') setPublications(p.value.publications)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') setError(getErrorMessage(failure.reason))
    setRefreshing(false)
  }, [])

  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false } }, [refresh])
  useEffect(() => {
    if (!selectedId && renders.length) setParams({ platform: 'douban', renderId: renders[0].id }, { replace: true })
  }, [selectedId, renders, setParams])
  useEffect(() => {
    let cancelled = false
    setRecord(null)
    setTags('')
    if (!selectedId) return
    setRecordLoading(true)
    void (async () => {
      try {
        const { render } = await api.renders.get(selectedId)
        const douban = render.results.find(result => result.platform === 'douban')
        if (!douban) throw new Error('这份记录没有豆瓣排版，请先在渲染工作台生成。')
        if (!cancelled) { setRecord(render); setTags(douban.meta.tags.join(' ')) }
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
        const { login: next } = await api.douban.loginStatus(login.id)
        if (cancelled) return
        setLoginError('')
        if (next.status === 'connected') {
          const result = await api.douban.account()
          if (cancelled) return
          setLogin(next); setAccount(result.account); setLoginOpen(false); toast.success('豆瓣已连接，登录状态已保存')
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
      try { const result = await api.douban.listPublications(); if (!cancelled) setPublications(result.publications) }
      catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processing])

  async function startLogin() {
    setLoginOpen(true); setLoginBusy(true); setLoginError(''); setLogin(null)
    try { const result = await api.douban.startLogin(); if (mounted.current) setLogin(result.login) }
    catch (cause) { if (mounted.current) setLoginError(getErrorMessage(cause)) }
    finally { if (mounted.current) setLoginBusy(false) }
  }
  async function publish() {
    if (!record || !ready) return
    setSubmitting(true); setError('')
    try {
      const result = await api.douban.publish({ renderId: record.id, mode, privacy, tags: tags.split(/[\s,，#]+/).filter(Boolean) })
      if (!mounted.current) return
      setPublications(current => [result.publication, ...current.filter(item => item.id !== result.publication.id)])
      setConfirmation(null)
      toast.success(result.publication.status === 'running' ? '已提交豆瓣发布，请在下方查看进度' : result.publication.message)
    } catch (cause) { if (mounted.current) { setConfirmation(null); setError(getErrorMessage(cause)) } }
    finally { if (mounted.current) setSubmitting(false) }
  }
  async function disconnect() {
    setSubmitting(true)
    try { await api.douban.disconnect(); if (mounted.current) { setAccount({ status: 'disconnected', name: null, checkedAt: null }); setLogin(null); setConfirmation(null) } }
    catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setSubmitting(false) }
  }
  async function copyMarkdown() {
    if (!article?.markdown) return
    try { await navigator.clipboard.writeText(article.markdown); toast.success('豆瓣日记 Markdown 已复制') }
    catch { toast.error('复制失败，请检查浏览器剪贴板权限') }
  }
  function openResolution(item: DoubanPublication) {
    setResolveItem(item); setResolveChoice(null); setResolveUrl(''); setResolveError('')
  }
  async function resolveResult(action: DoubanResolveInput['action']) {
    if (!resolveItem || resolveBusy) return
    setResolveBusy(true); setResolveError('')
    try {
      const result = await api.douban.resolve(resolveItem.id, action === 'published' ? { action, articleUrl: resolveUrl.trim() } : { action })
      if (!mounted.current) return
      setPublications(current => current.map(item => item.id === result.publication.id ? result.publication : item))
      setResolveItem(null)
      toast.success(action === 'check' ? '正在重新核实，请查看任务进度' : result.publication.message)
    } catch (cause) { if (mounted.current) setResolveError(getErrorMessage(cause)) }
    finally { if (mounted.current) setResolveBusy(false) }
  }

  return <div className="publish-page douban-publish-page">
    <header className="publish-heading"><div><span className="publish-eyebrow"><Send size={14} />发布中心 · 豆瓣</span><h1>把内容发布到豆瓣日记</h1><p>连接豆瓣账号，选择豆瓣日记排版，发布长文日记；图片会自动转存到豆瓣图床。</p></div><button type="button" className="btn" disabled={refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? 'spin' : undefined} />刷新状态</button></header>
    {error ? <div className="publish-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭提示</button></div> : null}
    <section className="publish-account" aria-label="豆瓣账号">
      <span className="publish-account-icon">豆</span><div className="publish-account-copy"><h2>{account?.name || '豆瓣账号'}</h2><p>{account?.status === 'connected' ? '登录状态已加密保存；豆瓣没有官方开放写接口，发布使用已登录的浏览器会话。' : account?.status === 'expired' ? '登录状态已失效，请重新扫码或使用手机验证码连接。' : '使用豆瓣 App 扫码登录，或使用手机验证码连接。'}</p>{account?.checkedAt ? <small>最近检查：{formatDateTime(account.checkedAt)}</small> : null}</div>
      <span className={`publish-status ${account?.status === 'connected' ? 'is-success' : ''}`}>{account?.status === 'connected' ? <><CheckCircle2 size={13} />已连接</> : account?.status === 'expired' ? '已过期' : '未连接'}</span>
      <div className="publish-account-actions">{account?.status === 'connected' ? <button type="button" className="btn btn-sm" disabled={busy || loginBusy} onClick={() => setConfirmation('disconnect')}><LogOut size={14} />断开连接</button> : <><button type="button" className="btn btn-primary" disabled={busy || loginBusy || refreshing} onClick={() => void startLogin()}><QrCode size={16} />扫码连接豆瓣</button><button type="button" className="btn" disabled={busy || loginBusy || refreshing || smsLogin.busy || loginOpen} onClick={smsLogin.openModal}><Smartphone size={15} />手机验证码登录</button></>}{login && ['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn btn-sm" onClick={() => setLoginOpen(true)}>查看登录二维码</button> : null}</div>
    </section>
    <div className="publish-compose-grid"><section className="publish-panel">
      <div className="publish-section-head"><h2>准备发布</h2><p>使用渲染工作台中已保存的豆瓣排版。</p></div>
      {!renders.length && !selectedId && !refreshing ? <div className="publish-empty"><p>先生成一篇豆瓣日记排版</p><button type="button" className="btn btn-primary" onClick={() => navigate('/render')}>去渲染内容<ArrowRight size={14} /></button></div> : <label className="publish-field">选择内容<select className="input" value={selectedId} disabled={busy} onChange={event => { setError(''); setParams({ platform: 'douban', renderId: event.target.value }) }}><option value="" disabled>选择豆瓣排版</option>{selectedId && !renders.some(item => item.id === selectedId) ? <option value={selectedId}>指定的排版记录</option> : null}{renders.map(item => <option key={item.id} value={item.id}>{item.contentTitle} · {formatDateTime(item.createdAt)}</option>)}</select></label>}
      {recordLoading ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在读取排版…</p> : article ? <>
        <div className="publish-article-title"><FileText size={16} /><strong>{article.title}</strong><button type="button" className="btn btn-sm" onClick={() => navigate(`/render?renderId=${encodeURIComponent(selectedId)}`)}>检查排版<ArrowRight size={13} /></button></div>
        <div className="publish-grid-two">
          <label className="publish-field">可见范围<select className="input" value={privacy} disabled={busy} onChange={event => setPrivacy(event.target.value === 'private' ? 'private' : 'public')}><option value="public">公开</option><option value="private">仅自己可见</option></select></label>
          <label className="publish-field">标签（空格分隔，最多 10 个）<input className="input" value={tags} maxLength={240} disabled={busy} onChange={event => setTags(event.target.value)} /></label>
        </div>
        <div className="publish-mode-switch" role="group" aria-label="发布方式"><button type="button" className={`btn ${mode === 'draft' ? 'btn-primary' : ''}`} disabled={busy} onClick={() => setMode('draft')}>保存草稿</button><button type="button" className={`btn ${mode === 'publish' ? 'btn-primary' : ''}`} disabled={busy} onClick={() => setMode('publish')}>直接发布</button></div>
        <p className="publish-warning"><ShieldAlert size={14} /> 豆瓣新版编辑器有草稿箱，但自动草稿暂未接入：草稿会保存在 MultiPush 本地，可在渲染页复制正文或打开豆瓣编辑器手动发布。直接发布通过已登录浏览器会话完成，频繁发布可能触发豆瓣验证或风控。</p>
        {uncertain ? <div className="publish-warning"><p>这篇内容有结果待核实的豆瓣任务。请先核实发布结果，再决定是否重新提交。</p><button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(publications.find(item => item.renderId === selectedId && item.status === 'uncertain')!)}>核实结果</button></div> : null}
        <div className="publish-submit-actions"><button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirmation(mode)}>{submitting || processing ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}{mode === 'draft' ? '保存豆瓣草稿' : '发布到豆瓣日记'}</button><button type="button" className="btn" disabled={!article.markdown} onClick={() => void copyMarkdown()}><ClipboardCopy size={15} />复制 Markdown</button><a className="btn" href="https://www.douban.com/note/create" target="_blank" rel="noreferrer">打开豆瓣编辑器<ExternalLink size={13} /></a></div>
        <p className="publish-form-hint" role="status">{account?.status !== 'connected' ? '请先扫码连接豆瓣。' : busy ? '任务正在处理，请在下方查看进度。' : '发布后内容会显示在你的豆瓣日记中。'}</p>
      </> : null}
    </section><aside className="publish-panel publish-preview-panel"><div className="publish-section-head"><h2>豆瓣日记预览</h2><p>以豆瓣实际编辑器和展示效果为准。</p></div>{article ? <div className="douban-publish-preview"><h3>{article.title}</h3><iframe title="豆瓣日记预览" srcDoc={article.html} sandbox="" /></div> : <div className="publish-empty"><p>选择内容后预览豆瓣日记</p></div>}</aside></div>
    <section className="publish-panel publish-history"><div className="publish-section-head"><h2>豆瓣发布记录</h2><p>发布结果会在这里更新，结果待核实时请先到豆瓣日记列表核对。</p></div>{!publications.length ? <div className="publish-empty"><p>还没有豆瓣发布记录</p></div> : <div className="publish-history-list">{publications.map(item => <article key={item.id} className="publish-history-item"><div className="publish-history-title"><strong>{item.title}</strong><span className={`publish-status ${item.status === 'published' ? 'is-success' : item.status === 'failed' ? 'is-error' : item.status === 'uncertain' ? 'is-warning' : ''}`}>{labels[item.status]}</span></div><small>发布 · {formatDateTime(item.createdAt)}</small><p>{item.message}</p>{safeUrl(item.url) ? <a className="btn btn-sm" href={item.url!} target="_blank" rel="noreferrer">查看日记<ExternalLink size={13} /></a> : null}{item.status === 'uncertain' ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(item)}>核实结果</button> : null}{item.resolutions?.length ? <details className="publish-resolution-history"><summary>核实记录（{item.resolutions.length}）</summary>{item.resolutions.map(entry => <p key={entry.id}><small>{formatDateTime(entry.createdAt)}</small> · {entry.message}</p>)}</details> : null}{item.status === 'draft' || item.status === 'failed' ? <PublicationDeleteButton publication={item} remove={api.douban.deletePublication} onDeleted={() => setPublications(current => current.filter(entry => entry.id !== item.id))} platformName="豆瓣" remote={false} disabled={busy} /> : null}</article>)}</div>}</section>
    <p className="publish-bottom-note"><ShieldAlert size={14} />豆瓣自动发布属于实验性能力，不绕过登录、验证码或安全验证；可使用扫码或手机验证码登录，遇到验证会停止并保留记录。</p>
    <SmsLoginModal
      open={smsLogin.open}
      onClose={smsLogin.close}
      platformName="豆瓣"
      platformLoginUrl="https://accounts.douban.com/passport/login"
      login={smsLogin.login}
      busy={smsLogin.busy}
      error={smsLogin.error}
      onStart={smsLogin.start}
      onVerify={smsLogin.verify}
      onReset={smsLogin.reset}
    />
    <Modal open={loginOpen} onClose={() => setLoginOpen(false)} title="连接豆瓣" subtitle="使用豆瓣 App 扫码登录" size="compact"><div className="publish-login" aria-live="polite">{loginBusy || login?.status === 'waiting' && !login.qrCode ? <><LoaderCircle size={30} className="spin" /><p>正在获取豆瓣官方登录二维码…</p></> : login ? <>{login.qrCode && ['waiting', 'scanned'].includes(login.status) ? <img className="publish-login-qr" src={login.qrCode} alt="豆瓣官方登录二维码" /> : <QrCode size={32} />}<p>{login.message}</p><small>有效期至 {formatDateTime(login.expiresAt)}</small>{!['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn" onClick={() => void startLogin()}>重新获取二维码</button> : null}</> : null}{loginError ? <p className="publish-failure-message" role="alert">{loginError}</p> : null}{!loginBusy && !login ? <button type="button" className="btn btn-primary" onClick={() => void startLogin()}>重新连接</button> : null}</div></Modal>
    <Modal open={!!resolveItem} onClose={() => { if (!resolveBusy) setResolveItem(null) }} title="核实豆瓣发布结果" subtitle={resolveItem?.title} size="compact" closeOnBackdrop={!resolveBusy}>
      <div className="publish-resolution-actions">
        {safeUrl(resolveItem?.url || null) ? <a className="btn" href={resolveItem!.url!} target="_blank" rel="noreferrer">打开豆瓣核对<ExternalLink size={14} /></a> : null}
        <button type="button" className="btn" disabled={resolveBusy} onClick={() => void resolveResult('check')}><RefreshCw size={14} />重新自动核实</button>
        <button type="button" className={`btn ${resolveChoice === 'not_published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('not_published'); setResolveError('') }}>我已核实，未发布</button>
        <button type="button" className={`btn ${resolveChoice === 'published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('published'); setResolveError('') }}>我已核实，已发布</button>
      </div>
      {resolveChoice === 'not_published' ? <><p className="publish-warning">请确认豆瓣日记列表没有这篇内容。确认后将解除限制，允许你再次提交；此操作不会立即发布。</p><button type="button" className="btn btn-primary" disabled={resolveBusy} onClick={() => void resolveResult('not_published')}>确认未发布，解除限制</button></> : null}
      {resolveChoice === 'published' ? <><label className="publish-field">已发布豆瓣日记链接<input className="input" type="url" value={resolveUrl} maxLength={2048} disabled={resolveBusy} placeholder="https://www.douban.com/note/日记编号/" onChange={event => setResolveUrl(event.target.value)} /></label><p className="publish-muted">将按你的核实结果标记已发布并关联链接，不会再次发布这条豆瓣日记。</p><button type="button" className="btn btn-primary" disabled={resolveBusy || !resolveUrl.trim()} onClick={() => void resolveResult('published')}>确认已发布并关联</button></> : null}
      {resolveBusy ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在保存核实结果…</p> : null}
      {resolveError ? <p className="publish-failure-message" role="alert">{resolveError}</p> : null}
    </Modal>
    <ConfirmDialog open={confirmation === 'draft' || confirmation === 'publish'} title={confirmation === 'draft' ? '保存豆瓣草稿？' : '发布到豆瓣日记？'} description={<><strong>{article?.title}</strong><p>{confirmation === 'draft' ? '草稿只会保存在 MultiPush（豆瓣编辑器现在有草稿箱，但自动草稿尚未接入），供后续复制或导出使用。' : `将发布至「${account?.name || '已连接豆瓣账号'}」，可见范围：${privacy === 'public' ? '公开' : '仅自己可见'}。内容会直接创建为豆瓣日记。`}</p></>} confirmLabel={confirmation === 'draft' ? '保存本地草稿' : '确认发布到豆瓣'} tone="primary" loading={submitting} onConfirm={() => publish()} onClose={() => setConfirmation(null)} />
    <ConfirmDialog open={confirmation === 'disconnect'} title="断开豆瓣连接？" description="删除系统保存的豆瓣登录状态，下次发布需要重新扫码。豆瓣上的日记保持不变。" confirmLabel="断开连接" loading={submitting} onConfirm={disconnect} onClose={() => setConfirmation(null)} />
  </div>
}
