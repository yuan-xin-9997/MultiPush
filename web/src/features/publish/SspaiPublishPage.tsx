import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, ExternalLink, FileText, LoaderCircle, LogOut, Newspaper, QrCode, RefreshCw, Send, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { MediaAsset, RenderListItem, RenderRecord, SspaiAccount, SspaiLogin, SspaiPublication, SspaiResolveInput } from '@shared/types'
import { absoluteUrl, api, ApiError } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'

const labels: Record<SspaiPublication['status'], string> = { running: '处理中', draft: '已保存草稿', published: '已发布', failed: '失败', uncertain: '结果待核实' }
const safeUrl = (value: string | null) => !!value && /^https:\/\/sspai\.com\/(?:post|write)\/\d{1,20}$/.test(value)

export default function SspaiPublishPage() {
  const navigate = useNavigate(), [params, setParams] = useSearchParams(), selectedId = params.get('renderId') || ''
  const mounted = useRef(true)
  const [account, setAccount] = useState<SspaiAccount | null>(null)
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [cover, setCover] = useState<MediaAsset | null>(null)
  const [publications, setPublications] = useState<SspaiPublication[]>([])
  const [login, setLogin] = useState<SspaiLogin | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<'publish' | 'disconnect' | null>(null)
  const [resolveItem, setResolveItem] = useState<SspaiPublication | null>(null)
  const [resolveChoice, setResolveChoice] = useState<'not_published' | 'published' | null>(null)
  const [resolveUrl, setResolveUrl] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SspaiPublication | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const article = record?.results.find(result => result.platform === 'sspai')
  const processing = publications.some(item => item.status === 'running')
  const busy = submitting || uploading || processing || resolveBusy
  const uncertainItems = publications.filter(item => item.renderId === selectedId && item.status === 'uncertain')
  const uncertain = uncertainItems.length > 0
  const ready = account?.status === 'connected' && !!article && !busy && !recordLoading && !uncertain

  const refresh = useCallback(async (force = false) => {
    setRefreshing(true)
    const results = await Promise.allSettled([api.sspai.account(force ? { refresh: true } : undefined), api.renders.list(), api.sspai.listPublications()])
    if (!mounted.current) return
    const [a, r, p] = results
    if (a.status === 'fulfilled') setAccount(a.value.account)
    if (r.status === 'fulfilled') setRenders(r.value.renders.filter(item => item.platforms.includes('sspai')))
    if (p.status === 'fulfilled') setPublications(p.value.publications)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') setError(getErrorMessage(failure.reason))
    setRefreshing(false)
  }, [])
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false } }, [refresh])
  useEffect(() => {
    if (!selectedId && renders.length) setParams({ platform: 'sspai', renderId: renders[0].id }, { replace: true })
  }, [selectedId, renders, setParams])
  useEffect(() => {
    let cancelled = false
    setRecord(null); setCover(null)
    if (!selectedId) return
    setRecordLoading(true)
    void (async () => {
      try {
        const { render } = await api.renders.get(selectedId)
        if (!render.results.some(result => result.platform === 'sspai')) throw new Error('这份记录没有少数派排版，请先在渲染工作台生成。')
        const [{ content }, { media }] = await Promise.all([api.contents.get(render.contentId), api.media.list()])
        if (cancelled) return
        setRecord(render)
        setCover(media.find(item => item.kind === 'image' && content.coverImage && absoluteUrl(item.url) === absoluteUrl(content.coverImage)) || null)
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
        const { login: next } = await api.sspai.loginStatus(login.id)
        if (cancelled) return
        setLoginError('')
        if (next.status === 'connected') {
          const result = await api.sspai.account()
          if (cancelled) return
          setLogin(next); setAccount(result.account); setLoginOpen(false); toast.success('少数派已连接，登录状态已保存')
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
      try { const result = await api.sspai.listPublications(); if (!cancelled) setPublications(result.publications) }
      catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processing])

  async function startLogin() {
    setLoginOpen(true); setLoginBusy(true); setLoginError(''); setLogin(null)
    try { const result = await api.sspai.startLogin(); if (mounted.current) setLogin(result.login) }
    catch (cause) { if (mounted.current) setLoginError(getErrorMessage(cause)) }
    finally { if (mounted.current) setLoginBusy(false) }
  }
  async function uploadCover(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) { setError('封面请使用 10 MB 以内的 JPG、PNG、GIF 或 WebP。'); return }
    setUploading(true)
    try { const result = await api.media.upload(file); if (mounted.current) setCover(result.media) }
    catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setUploading(false) }
  }
  async function publish(mode: 'draft' | 'publish') {
    if (!record || !ready) return
    setSubmitting(true); setError('')
    try {
      const result = await api.sspai.publish({ renderId: record.id, mode, ...(cover ? { coverMediaId: cover.id } : {}) })
      if (!mounted.current) return
      setPublications(current => [result.publication, ...current.filter(item => item.id !== result.publication.id)])
      setConfirmation(null)
      toast.success(result.publication.status === 'running' ? '已提交少数派任务，请在下方查看进度' : result.publication.message)
    } catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setSubmitting(false) }
  }
  async function disconnect() {
    setSubmitting(true)
    try { await api.sspai.disconnect(); if (mounted.current) { setAccount({ status: 'disconnected', name: null, checkedAt: null }); setLogin(null); setConfirmation(null) } }
    catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setSubmitting(false) }
  }

  async function deletePublication() {
    if (!deleteTarget) return
    setDeleteBusy(true); setError('')
    try {
      const result = await api.sspai.deletePublication(deleteTarget.id)
      if (!mounted.current) return
      setPublications(current => current.filter(item => item.id !== deleteTarget.id))
      setDeleteTarget(null)
      toast.success(result.remoteDeleted ? '已删除少数派草稿和本地发布记录' : '已删除本地发布记录')
    } catch (cause) {
      if (mounted.current) { setError(getErrorMessage(cause)); setDeleteTarget(null) }
    } finally { if (mounted.current) setDeleteBusy(false) }
  }

  function openResolution(item: SspaiPublication) {
    setResolveItem(item); setResolveChoice(null); setResolveUrl(''); setResolveError('')
  }
  async function resolveResult(action: SspaiResolveInput['action']) {
    if (!resolveItem || resolveBusy) return
    setResolveBusy(true); setResolveError('')
    try {
      const result = await api.sspai.resolve(resolveItem.id, action === 'published' ? { action, articleUrl: resolveUrl.trim() } : { action })
      if (!mounted.current) return
      setPublications(current => current.map(item => item.id === result.publication.id ? result.publication : item))
      setResolveItem(null)
      toast.success(action === 'check' ? '正在重新核实，请查看任务进度' : result.publication.message)
    } catch (cause) { if (mounted.current) setResolveError(getErrorMessage(cause)) }
    finally { if (mounted.current) setResolveBusy(false) }
  }

  return <div className="publish-page sspai-publish-page">
    <header className="publish-heading"><div><span className="publish-eyebrow"><Newspaper size={14} />发布中心 · 少数派</span><h1>把内容发布到少数派</h1><p>用微信扫码连接少数派账号，选择 Matrix 排版，保存草稿或立即发布。</p></div><button type="button" className="btn" disabled={refreshing || busy} onClick={() => void refresh(true)}><RefreshCw size={15} className={refreshing ? 'spin' : undefined} />刷新状态</button></header>
    {error ? <div className="publish-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭提示</button></div> : null}
    <section className="publish-account" aria-label="少数派账号">
      <span className="publish-account-icon">少</span><div className="publish-account-copy"><h2>{account?.name || '少数派账号'}</h2><p>{account?.status === 'connected' ? '登录状态已加密保存，下次访问和服务重启后自动复用；失效时重新扫码。' : account?.status === 'expired' ? '登录状态已失效，请重新扫码连接。' : '使用微信扫描少数派官方登录二维码，并在手机上确认登录。'}</p>{account?.checkedAt ? <small>最近检查：{formatDateTime(account.checkedAt)}</small> : null}</div>
      <span className={`publish-status ${account?.status === 'connected' ? 'is-success' : ''}`}>{account?.status === 'connected' ? <><CheckCircle2 size={13} />已连接</> : account?.status === 'expired' ? '已过期' : '未连接'}</span>
      <div className="publish-account-actions">{account?.status === 'connected' ? <button type="button" className="btn btn-sm" disabled={busy || loginBusy} onClick={() => setConfirmation('disconnect')}><LogOut size={14} />断开连接</button> : <button type="button" className="btn btn-primary" disabled={busy || loginBusy || refreshing} onClick={() => void startLogin()}><QrCode size={16} />扫码连接少数派</button>}{login && ['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn btn-sm" onClick={() => setLoginOpen(true)}>查看登录二维码</button> : null}</div>
    </section>
    <div className="publish-compose-grid"><section className="publish-panel">
      <div className="publish-section-head"><h2>准备发布</h2><p>使用渲染工作台中已保存的少数派排版，支持 Matrix 社区文章。</p></div>
      {!renders.length && !selectedId && !refreshing ? <div className="publish-empty"><p>先生成一篇少数派排版</p><button type="button" className="btn btn-primary" onClick={() => navigate('/render')}>去渲染内容<ArrowRight size={14} /></button></div> : <label className="publish-field">选择内容<select className="input" value={selectedId} disabled={busy} onChange={event => { setError(''); setParams({ platform: 'sspai', renderId: event.target.value }) }}><option value="" disabled>选择少数派排版</option>{selectedId && !renders.some(item => item.id === selectedId) ? <option value={selectedId}>指定的排版记录</option> : null}{renders.map(item => <option key={item.id} value={item.id}>{item.contentTitle} · {formatDateTime(item.createdAt)}</option>)}</select></label>}
      {recordLoading ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在读取排版…</p> : article ? <>
        <div className="publish-article-title"><FileText size={16} /><strong>{article.title}</strong><button type="button" className="btn btn-sm" onClick={() => navigate(`/render?renderId=${encodeURIComponent(selectedId)}`)}>检查排版<ArrowRight size={13} /></button></div>
        <div className="publish-cover-field"><label className="publish-field">题图（选填）<span className="publish-muted">使用内容封面，或上传 10 MB 以内的图片。</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy} onChange={event => void uploadCover(event)} /></label>{cover ? <><img className="publish-cover-preview" src={absoluteUrl(cover.url)} alt="待发布的少数派题图" /><button type="button" className="btn btn-sm" disabled={busy} onClick={() => setCover(null)}>移除题图</button></> : null}</div>
        {article.meta.tags.length ? <p className="publish-muted">将使用原文标签：{article.meta.tags.slice(0, 5).map(tag => `#${tag}`).join(' ')}</p> : <p className="publish-muted">原文没有标签，发布时不会自动添加少数派标签。</p>}
        <p className="publish-warning">正文图片会自动上传到少数派图床，发布前会回读核对标题、正文、图片和链接；内容不一致时停止发布并保留草稿。少数派暂不支持视频。</p>
        {uncertain ? <div className="publish-warning"><p>这篇内容有 {uncertainItems.length} 个结果待核实的任务。核实后可在这里确认结果并继续操作。</p><button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(uncertainItems[0])}>核实并继续</button></div> : null}
        <div className="publish-submit-actions"><button type="button" className="btn" disabled={!ready} onClick={() => void publish('draft')}><FileText size={16} />保存到少数派草稿</button><button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirmation('publish')}>{busy ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}立即发布到少数派</button></div>
        <p className="publish-form-hint" role="status">{account?.status !== 'connected' ? '请先用微信扫码连接少数派。' : busy ? '任务正在处理，请在下方查看进度。' : '「新手上路」的前 3 篇文章可能需要人工确认；两次提交至少间隔 10 分钟，24 小时最多 5 篇。'}</p>
      </> : null}
    </section><aside className="publish-panel publish-preview-panel"><div className="publish-section-head"><h2>少数派文章预览</h2><p>以少数派实际排版和审核结果为准。</p></div>{article ? <><h3>{article.title}</h3><iframe title="待发布的少数派正文" sandbox="" srcDoc={`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{padding:18px;font-family:sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style><body>${article.html}</body></html>`} /></> : <div className="publish-empty"><p>选择内容后预览少数派排版</p></div>}</aside></div>
    <section className="publish-panel publish-history"><div className="publish-section-head"><h2>少数派发布记录</h2><p>草稿和正式发布分别记录，处理中的任务会自动更新。</p></div>{!publications.length ? <div className="publish-empty"><p>还没有少数派发布记录</p></div> : <div className="publish-history-list">{publications.map(item => <article key={item.id} className="publish-history-item"><div className="publish-history-title"><strong>{item.title}</strong><span className={`publish-status ${item.status === 'published' || item.status === 'draft' ? 'is-success' : item.status === 'failed' ? 'is-error' : ''}`}>{labels[item.status]}</span></div><small>{item.mode === 'draft' ? '保存草稿' : '立即发布'} · {formatDateTime(item.createdAt)}</small><p>{item.message}</p>{safeUrl(item.url) ? <a className="btn btn-sm" href={item.url!} target="_blank" rel="noreferrer">{item.status === 'published' ? '查看少数派文章' : '打开少数派草稿'}<ExternalLink size={13} /></a> : null}{item.status === 'uncertain' ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(item)}>核实结果</button> : null}{item.status === 'draft' || item.status === 'failed' ? <button type="button" className="btn btn-sm publish-delete-button" disabled={busy || deleteBusy} onClick={() => setDeleteTarget(item)}><Trash2 size={13} />{item.status === 'failed' ? '删除记录' : '删除草稿'}</button> : null}{item.resolutions?.length ? <details className="publish-resolution-history"><summary>核实记录（{item.resolutions.length}）</summary>{item.resolutions.map(entry => <p key={entry.id}><small>{formatDateTime(entry.createdAt)}</small> · {entry.message}</p>)}</details> : null}</article>)}</div>}</section>
    <p className="publish-bottom-note"><ShieldCheck size={14} />使用少数派官方微信扫码登录，无需提供少数派密码。少数派对自动化较敏感：两次提交至少间隔 10 分钟，24 小时最多 5 篇；超限会被系统直接拒绝。少数派要求额外安全验证时，会显示原因并保留草稿。</p>
    <Modal open={loginOpen} onClose={() => setLoginOpen(false)} title="连接少数派" subtitle="使用微信扫码，并在手机上确认登录" size="compact"><div className="publish-login" aria-live="polite">{loginBusy || login?.status === 'waiting' && !login.qrCode ? <><LoaderCircle size={30} className="spin" /><p>正在获取少数派微信登录二维码…</p></> : login ? <>{login.qrCode && ['waiting', 'scanned'].includes(login.status) ? <img className="publish-login-qr" src={login.qrCode} alt="少数派微信登录二维码" /> : <QrCode size={32} />}<p>{login.message}</p><small>有效期至 {formatDateTime(login.expiresAt)}</small>{!['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn" onClick={() => void startLogin()}>重新获取二维码</button> : null}</> : null}{loginError ? <p className="publish-failure-message" role="alert">{loginError}</p> : null}{!loginBusy && !login ? <button type="button" className="btn btn-primary" onClick={() => void startLogin()}>重新连接</button> : null}</div></Modal>
    <Modal open={!!resolveItem} onClose={() => { if (!resolveBusy) setResolveItem(null) }} title="核实少数派发布结果" subtitle={resolveItem?.title} size="compact" closeOnBackdrop={!resolveBusy}>
      <div className="publish-resolution-actions">
        {safeUrl(resolveItem?.url || null) ? <a className="btn" href={resolveItem!.url!} target="_blank" rel="noreferrer">打开少数派核对<ExternalLink size={14} /></a> : null}
        <button type="button" className="btn" disabled={resolveBusy} onClick={() => void resolveResult('check')}><RefreshCw size={14} />重新自动核实</button>
        <button type="button" className={`btn ${resolveChoice === 'not_published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('not_published'); setResolveError('') }}>我已核实，未发布</button>
        <button type="button" className={`btn ${resolveChoice === 'published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('published'); setResolveError('') }}>我已核实，已发布</button>
      </div>
      {resolveChoice === 'not_published' ? <><p className="publish-warning">请确认少数派后台尚未发布这篇文章。确认后将解除限制，允许你再次提交，并优先复用原草稿；此操作不会立即发布文章。若核实有误，再次提交可能重复发布。</p><button type="button" className="btn btn-primary" disabled={resolveBusy} onClick={() => void resolveResult('not_published')}>确认未发布，解除限制</button></> : null}
      {resolveChoice === 'published' ? <><label className="publish-field">已发布文章链接<input className="input" type="url" value={resolveUrl} maxLength={2048} disabled={resolveBusy} placeholder="https://sspai.com/post/…" onChange={event => setResolveUrl(event.target.value)} /></label><p className="publish-muted">将按你的核实结果标记已发布并关联链接，不会再次发布这篇文章。</p><button type="button" className="btn btn-primary" disabled={resolveBusy || !resolveUrl.trim()} onClick={() => void resolveResult('published')}>确认已发布并关联</button></> : null}
      {resolveBusy ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在保存核实结果…</p> : null}
      {resolveError ? <p className="publish-failure-message" role="alert">{resolveError}</p> : null}
    </Modal>
    <ConfirmDialog open={confirmation === 'publish'} title="立即发布到少数派？" description={<><strong>{article?.title}</strong><p>将发布至「{account?.name || '已连接少数派账号'}」，文章可能对外公开；新作者的前几篇内容可能需要人工确认。</p></>} confirmLabel="确认发布到少数派" tone="primary" loading={submitting} onConfirm={() => publish('publish')} onClose={() => setConfirmation(null)} />
    <ConfirmDialog open={confirmation === 'disconnect'} title="断开少数派连接？" description="删除系统保存的少数派登录状态，下次发布需要重新扫码。少数派上的草稿和文章保持不变。" confirmLabel="断开连接" loading={submitting} onConfirm={disconnect} onClose={() => setConfirmation(null)} />
    <ConfirmDialog open={!!deleteTarget} title={deleteTarget?.status === 'failed' ? '删除少数派发布记录？' : '删除少数派草稿？'} description={<><strong>{deleteTarget?.title}</strong><p>{deleteTarget?.status === 'failed' ? '将清理本系统的失败记录，不会删除少数派上已发布的内容。' : '将同时删除少数派后台的这份草稿和本系统的发布记录，删除后无法恢复。'}</p></>} confirmLabel={deleteTarget?.status === 'failed' ? '删除记录' : '删除草稿'} loading={deleteBusy} onConfirm={deletePublication} onClose={() => setDeleteTarget(null)} />
  </div>
}
