import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, ExternalLink, FileText, LoaderCircle, LogOut, QrCode, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { MediaAsset, RenderListItem, RenderRecord, ZhihuAccount, ZhihuLogin, ZhihuPublication } from '@shared/types'
import { absoluteUrl, api, ApiError } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'

const labels: Record<ZhihuPublication['status'], string> = { running: '处理中', draft: '已保存草稿', published: '已发布', failed: '失败', uncertain: '结果待核实' }
const safeUrl = (value: string | null) => !!value && /^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+(?:\/edit)?$/.test(value)

export default function ZhihuPublishPage() {
  const navigate = useNavigate(), [params, setParams] = useSearchParams(), selectedId = params.get('renderId') || ''
  const mounted = useRef(true)
  const [account, setAccount] = useState<ZhihuAccount | null>(null)
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [cover, setCover] = useState<MediaAsset | null>(null)
  const [publications, setPublications] = useState<ZhihuPublication[]>([])
  const [login, setLogin] = useState<ZhihuLogin | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<'publish' | 'disconnect' | null>(null)
  const article = record?.results.find(result => result.platform === 'zhihu')
  const processing = publications.some(item => item.status === 'running')
  const busy = submitting || uploading || processing
  const uncertain = publications.some(item => item.renderId === selectedId && item.status === 'uncertain')
  const ready = account?.status === 'connected' && !!article && !busy && !recordLoading && !uncertain

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const results = await Promise.allSettled([api.zhihu.account(), api.renders.list(), api.zhihu.listPublications()])
    if (!mounted.current) return
    const [a, r, p] = results
    if (a.status === 'fulfilled') setAccount(a.value.account)
    if (r.status === 'fulfilled') setRenders(r.value.renders.filter(item => item.platforms.includes('zhihu')))
    if (p.status === 'fulfilled') setPublications(p.value.publications)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') setError(getErrorMessage(failure.reason))
    setRefreshing(false)
  }, [])
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false } }, [refresh])
  useEffect(() => {
    if (!selectedId && renders.length) setParams({ platform: 'zhihu', renderId: renders[0].id }, { replace: true })
  }, [selectedId, renders, setParams])
  useEffect(() => {
    let cancelled = false
    setRecord(null); setCover(null)
    if (!selectedId) return
    setRecordLoading(true)
    void (async () => {
      try {
        const { render } = await api.renders.get(selectedId)
        if (!render.results.some(result => result.platform === 'zhihu')) throw new Error('这份记录没有知乎排版，请先在渲染工作台生成。')
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
        const { login: next } = await api.zhihu.loginStatus(login.id)
        if (cancelled) return
        setLoginError('')
        if (next.status === 'connected') {
          const result = await api.zhihu.account()
          if (cancelled) return
          setLogin(next); setAccount(result.account); setLoginOpen(false); toast.success('知乎已连接，登录状态已保存')
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
      try { const result = await api.zhihu.listPublications(); if (!cancelled) setPublications(result.publications) }
      catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processing])

  async function startLogin() {
    setLoginOpen(true); setLoginBusy(true); setLoginError(''); setLogin(null)
    try { const result = await api.zhihu.startLogin(); if (mounted.current) setLogin(result.login) }
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
      const result = await api.zhihu.publish({ renderId: record.id, mode, ...(cover ? { coverMediaId: cover.id } : {}) })
      if (!mounted.current) return
      setPublications(current => [result.publication, ...current.filter(item => item.id !== result.publication.id)])
      setConfirmation(null)
      toast.success(result.publication.status === 'running' ? '已提交知乎任务，请在下方查看进度' : result.publication.message)
    } catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setSubmitting(false) }
  }
  async function disconnect() {
    setSubmitting(true)
    try { await api.zhihu.disconnect(); if (mounted.current) { setAccount({ status: 'disconnected', name: null, checkedAt: null }); setLogin(null); setConfirmation(null) } }
    catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setSubmitting(false) }
  }

  return <div className="publish-page zhihu-publish-page">
    <header className="publish-heading"><div><span className="publish-eyebrow"><Send size={14} />发布中心 · 知乎</span><h1>把内容发布到知乎</h1><p>连接知乎账号，选择排版，一键保存草稿或正式发布文章。</p></div><button type="button" className="btn" disabled={refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? 'spin' : undefined} />刷新状态</button></header>
    {error ? <div className="publish-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭提示</button></div> : null}
    <section className="publish-account" aria-label="知乎账号">
      <span className="publish-account-icon">知</span><div className="publish-account-copy"><h2>{account?.name || '知乎账号'}</h2><p>{account?.status === 'connected' ? '登录状态已加密保存，下次访问和服务重启后自动复用；失效时重新扫码。' : account?.status === 'expired' ? '登录状态已失效，请重新扫码连接。' : '使用知乎 App 扫描官方二维码，并在手机上确认登录。'}</p>{account?.checkedAt ? <small>最近检查：{formatDateTime(account.checkedAt)}</small> : null}</div>
      <span className={`publish-status ${account?.status === 'connected' ? 'is-success' : ''}`}>{account?.status === 'connected' ? <><CheckCircle2 size={13} />已连接</> : account?.status === 'expired' ? '已过期' : '未连接'}</span>
      <div className="publish-account-actions">{account?.status === 'connected' ? <button type="button" className="btn btn-sm" disabled={busy || loginBusy} onClick={() => setConfirmation('disconnect')}><LogOut size={14} />断开连接</button> : <button type="button" className="btn btn-primary" disabled={busy || loginBusy || refreshing} onClick={() => void startLogin()}><QrCode size={16} />扫码连接知乎</button>}{login && ['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn btn-sm" onClick={() => setLoginOpen(true)}>查看登录二维码</button> : null}</div>
    </section>
    <div className="publish-compose-grid"><section className="publish-panel">
      <div className="publish-section-head"><h2>准备发布</h2><p>使用渲染工作台中已保存的知乎排版，支持知乎专栏文章。</p></div>
      {!renders.length && !selectedId && !refreshing ? <div className="publish-empty"><p>先生成一篇知乎排版</p><button type="button" className="btn btn-primary" onClick={() => navigate('/render')}>去渲染内容<ArrowRight size={14} /></button></div> : <label className="publish-field">选择内容<select className="input" value={selectedId} disabled={busy} onChange={event => { setError(''); setParams({ platform: 'zhihu', renderId: event.target.value }) }}><option value="" disabled>选择知乎排版</option>{selectedId && !renders.some(item => item.id === selectedId) ? <option value={selectedId}>指定的排版记录</option> : null}{renders.map(item => <option key={item.id} value={item.id}>{item.contentTitle} · {formatDateTime(item.createdAt)}</option>)}</select></label>}
      {recordLoading ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在读取排版…</p> : article ? <>
        <div className="publish-article-title"><FileText size={16} /><strong>{article.title}</strong><button type="button" className="btn btn-sm" onClick={() => navigate(`/render?renderId=${encodeURIComponent(selectedId)}`)}>检查排版<ArrowRight size={13} /></button></div>
        <div className="publish-cover-field"><label className="publish-field">封面图片（选填）<span className="publish-muted">使用内容封面，或上传 10 MB 以内的图片。</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy} onChange={event => void uploadCover(event)} /></label>{cover ? <><img className="publish-cover-preview" src={absoluteUrl(cover.url)} alt="待发布的知乎封面" /><button type="button" className="btn btn-sm" disabled={busy} onClick={() => setCover(null)}>移除封面</button></> : null}</div>
        <p className="publish-warning">正文图片会自动上传到知乎。系统会核对知乎保存的图片、列表、图注、链接和代码；内容不一致时停止发布，并保留草稿供检查。</p>
        {uncertain ? <p className="publish-warning">这篇内容有结果待核实的任务，请先检查知乎后台，避免重复发布。</p> : null}
        <div className="publish-submit-actions"><button type="button" className="btn" disabled={!ready} onClick={() => void publish('draft')}><FileText size={16} />保存到知乎草稿</button><button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirmation('publish')}>{busy ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}正式发布到知乎</button></div>
        <p className="publish-form-hint" role="status">{account?.status !== 'connected' ? '请先扫码连接知乎。' : busy ? '任务正在处理，请在下方查看进度。' : '发布后文章可能公开显示在你的知乎主页。'}</p>
      </> : null}
    </section><aside className="publish-panel publish-preview-panel"><div className="publish-section-head"><h2>知乎文章预览</h2><p>以知乎实际排版和审核结果为准。</p></div>{article ? <><h3>{article.title}</h3><iframe title="待发布的知乎正文" sandbox="" srcDoc={`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{padding:18px;font-family:sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style><body>${article.html}</body></html>`} /></> : <div className="publish-empty"><p>选择内容后预览知乎排版</p></div>}</aside></div>
    <section className="publish-panel publish-history"><div className="publish-section-head"><h2>知乎发布记录</h2><p>草稿和正式发布分别记录，处理中的任务会自动更新。</p></div>{!publications.length ? <div className="publish-empty"><p>还没有知乎发布记录</p></div> : <div className="publish-history-list">{publications.map(item => <article key={item.id} className="publish-history-item"><div className="publish-history-title"><strong>{item.title}</strong><span className={`publish-status ${item.status === 'published' || item.status === 'draft' ? 'is-success' : item.status === 'failed' ? 'is-error' : ''}`}>{labels[item.status]}</span></div><small>{item.mode === 'draft' ? '保存草稿' : '正式发布'} · {formatDateTime(item.createdAt)}</small><p>{item.message}</p>{safeUrl(item.url) ? <a className="btn btn-sm" href={item.url!} target="_blank" rel="noreferrer">{item.status === 'published' ? '查看知乎文章' : '打开知乎草稿'}<ExternalLink size={13} /></a> : null}</article>)}</div>}</section>
    <p className="publish-bottom-note"><ShieldCheck size={14} />使用知乎官方二维码登录，无需提供知乎密码。知乎要求额外安全验证时，会显示原因并保留草稿。</p>
    <Modal open={loginOpen} onClose={() => setLoginOpen(false)} title="连接知乎" subtitle="使用知乎 App 扫码，并在手机上确认登录" size="compact"><div className="publish-login" aria-live="polite">{loginBusy ? <><LoaderCircle size={30} className="spin" /><p>正在获取知乎官方登录二维码…</p></> : login ? <>{login.qrCode && ['waiting', 'scanned'].includes(login.status) ? <img className="publish-login-qr" src={login.qrCode} alt="知乎官方登录二维码" /> : <QrCode size={32} />}<p>{login.message}</p><small>有效期至 {formatDateTime(login.expiresAt)}</small>{!['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn" onClick={() => void startLogin()}>重新获取二维码</button> : null}</> : null}{loginError ? <p className="publish-failure-message" role="alert">{loginError}</p> : null}{!loginBusy && !login ? <button type="button" className="btn btn-primary" onClick={() => void startLogin()}>重新连接</button> : null}</div></Modal>
    <ConfirmDialog open={confirmation === 'publish'} title="正式发布到知乎？" description={<><strong>{article?.title}</strong><p>将发布至「{account?.name || '已连接知乎账号'}」，文章可能对外公开。</p></>} confirmLabel="确认发布到知乎" tone="primary" loading={submitting} onConfirm={() => publish('publish')} onClose={() => setConfirmation(null)} />
    <ConfirmDialog open={confirmation === 'disconnect'} title="断开知乎连接？" description="删除系统保存的知乎登录状态，下次发布需要重新扫码。知乎上的草稿和文章保持不变。" confirmLabel="断开连接" loading={submitting} onConfirm={disconnect} onClose={() => setConfirmation(null)} />
  </div>
}
