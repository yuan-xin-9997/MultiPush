import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, ExternalLink, FileText, Globe2, KeyRound, Link2, LoaderCircle, LogOut, RefreshCw, Send, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { BlogAccount, BlogPublication, BlogResolveInput, MediaAsset, RenderListItem, RenderRecord } from '@shared/types'
import { absoluteUrl, api, ApiError } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'

const labels: Record<BlogPublication['status'], string> = { running: '处理中', draft: '已保存草稿', published: '已发布', failed: '失败', uncertain: '结果待核实' }
const safeUrl = (value: string | null) => !!value && /^https?:\/\//i.test(value)
const BASE_URL_KEY = 'multipush:blog-base-url'

export default function BlogPublishPage() {
  const navigate = useNavigate(), [params, setParams] = useSearchParams(), selectedId = params.get('renderId') || ''
  const mounted = useRef(true)
  const [account, setAccount] = useState<BlogAccount | null>(null)
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [cover, setCover] = useState<MediaAsset | null>(null)
  const [publications, setPublications] = useState<BlogPublication[]>([])
  const [baseUrl, setBaseUrl] = useState(() => { try { return localStorage.getItem(BASE_URL_KEY) || '' } catch { return '' } })
  const [token, setToken] = useState('')
  const [connectOpen, setConnectOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<'publish' | 'disconnect' | null>(null)
  const [resolveItem, setResolveItem] = useState<BlogPublication | null>(null)
  const [resolveChoice, setResolveChoice] = useState<'not_published' | 'published' | null>(null)
  const [resolveUrl, setResolveUrl] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<BlogPublication | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const article = record?.results.find(result => result.platform === 'blog')
  const processing = publications.some(item => item.status === 'running')
  const busy = submitting || uploading || processing || resolveBusy || connecting
  const uncertainItems = publications.filter(item => item.renderId === selectedId && item.status === 'uncertain')
  const uncertain = uncertainItems.length > 0
  const ready = account?.status === 'connected' && !!article && !busy && !recordLoading && !uncertain

  const refresh = useCallback(async (force = false) => {
    setRefreshing(true)
    const results = await Promise.allSettled([api.blog.account(force ? { refresh: true } : undefined), api.renders.list(), api.blog.listPublications()])
    if (!mounted.current) return
    const [a, r, p] = results
    if (a.status === 'fulfilled') {
      setAccount(a.value.account)
      if (a.value.account.baseUrl) { setBaseUrl(a.value.account.baseUrl); try { localStorage.setItem(BASE_URL_KEY, a.value.account.baseUrl) } catch { /* ignore */ } }
    }
    if (r.status === 'fulfilled') setRenders(r.value.renders.filter(item => item.platforms.includes('blog')))
    if (p.status === 'fulfilled') setPublications(p.value.publications)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') setError(getErrorMessage(failure.reason))
    setRefreshing(false)
  }, [])
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false } }, [refresh])
  useEffect(() => {
    if (!selectedId && renders.length) setParams({ platform: 'blog', renderId: renders[0].id }, { replace: true })
  }, [selectedId, renders, setParams])
  useEffect(() => {
    let cancelled = false
    setRecord(null); setCover(null)
    if (!selectedId) return
    setRecordLoading(true)
    void (async () => {
      try {
        const { render } = await api.renders.get(selectedId)
        if (!render.results.some(result => result.platform === 'blog')) throw new Error('这份记录没有个人博客排版，请先在渲染工作台生成。')
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
    if (!processing) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const result = await api.blog.listPublications(); if (!cancelled) setPublications(result.publications) }
      catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processing])

  async function connect() {
    setConnecting(true); setConnectError(''); setError('')
    try {
      const result = await api.blog.connect({ baseUrl: baseUrl.trim(), token: token.trim() })
      if (!mounted.current) return
      setAccount(result.account); setConnectOpen(false); setToken('')
      try { localStorage.setItem(BASE_URL_KEY, result.account.baseUrl || baseUrl.trim()) } catch { /* ignore */ }
      toast.success('个人博客已连接，令牌已加密保存')
    } catch (cause) { if (mounted.current) setConnectError(getErrorMessage(cause)) }
    finally { if (mounted.current) setConnecting(false) }
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
      const result = await api.blog.publish({ renderId: record.id, mode, ...(cover ? { coverMediaId: cover.id } : {}) })
      if (!mounted.current) return
      setPublications(current => [result.publication, ...current.filter(item => item.id !== result.publication.id)])
      setConfirmation(null)
      toast.success(result.publication.status === 'running' ? '已提交个人博客任务，请在下方查看进度' : result.publication.message)
    } catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setSubmitting(false) }
  }
  async function disconnect() {
    setSubmitting(true)
    try { await api.blog.disconnect(); if (mounted.current) { setAccount({ status: 'disconnected', name: null, baseUrl: null, checkedAt: null }); setConfirmation(null); setToken('') } }
    catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setSubmitting(false) }
  }

  async function deletePublication() {
    if (!deleteTarget) return
    setDeleteBusy(true); setError('')
    try {
      const result = await api.blog.deletePublication(deleteTarget.id)
      if (!mounted.current) return
      setPublications(current => current.filter(item => item.id !== deleteTarget.id))
      setDeleteTarget(null)
      toast.success(result.remoteDeleted ? '已删除个人博客草稿和本地发布记录' : '已删除本地发布记录')
    } catch (cause) {
      if (mounted.current) { setError(getErrorMessage(cause)); setDeleteTarget(null) }
    } finally { if (mounted.current) setDeleteBusy(false) }
  }

  function openResolution(item: BlogPublication) {
    setResolveItem(item); setResolveChoice(null); setResolveUrl(''); setResolveError('')
  }
  async function resolveResult(action: BlogResolveInput['action']) {
    if (!resolveItem || resolveBusy) return
    setResolveBusy(true); setResolveError('')
    try {
      const result = await api.blog.resolve(resolveItem.id, action === 'published' ? { action, articleUrl: resolveUrl.trim() } : { action })
      if (!mounted.current) return
      setPublications(current => current.map(item => item.id === result.publication.id ? result.publication : item))
      setResolveItem(null)
      toast.success(action === 'check' ? '正在重新核实，请查看任务进度' : result.publication.message)
    } catch (cause) { if (mounted.current) setResolveError(getErrorMessage(cause)) }
    finally { if (mounted.current) setResolveBusy(false) }
  }

  return <div className="publish-page blog-publish-page">
    <header className="publish-heading"><div><span className="publish-eyebrow"><Globe2 size={14} />发布中心 · 个人博客</span><h1>把内容发布到个人博客</h1><p>连接 Halo 个人博客，选择文章排版，保存草稿或直接公开发布。</p></div><button type="button" className="btn" disabled={refreshing || busy} onClick={() => void refresh(true)}><RefreshCw size={15} className={refreshing ? 'spin' : undefined} />刷新状态</button></header>
    {error ? <div className="publish-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭提示</button></div> : null}
    <section className="publish-account" aria-label="个人博客账号">
      <span className="publish-account-icon">博</span><div className="publish-account-copy"><h2>{account?.name || (account?.baseUrl ? '个人博客' : '尚未连接个人博客')}</h2><p>{account?.status === 'connected' ? `已连接 ${account.baseUrl}，令牌加密保存在本机服务中。` : account?.status === 'expired' ? '连接已失效，请重新输入博客地址和令牌。' : '使用 Halo 个人令牌连接，无需提供管理员密码。'}</p>{account?.checkedAt ? <small>最近检查：{formatDateTime(account.checkedAt)}</small> : null}</div>
      <span className={`publish-status ${account?.status === 'connected' ? 'is-success' : ''}`}>{account?.status === 'connected' ? <><CheckCircle2 size={13} />已连接</> : account?.status === 'expired' ? '已过期' : '未连接'}</span>
      <div className="publish-account-actions">{account?.status === 'connected' ? <><button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConnectOpen(true)}><Link2 size={14} />更换连接</button><button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmation('disconnect')}><LogOut size={14} />断开连接</button></> : <button type="button" className="btn btn-primary" disabled={busy || refreshing} onClick={() => setConnectOpen(true)}><Link2 size={16} />连接个人博客</button>}</div>
    </section>
    <div className="publish-compose-grid"><section className="publish-panel">
      <div className="publish-section-head"><h2>准备发布</h2><p>使用渲染工作台中已保存的个人博客排版，发布为 Halo 文章。</p></div>
      {!renders.length && !selectedId && !refreshing ? <div className="publish-empty"><p>先生成一篇个人博客排版</p><button type="button" className="btn btn-primary" onClick={() => navigate('/render')}>去渲染内容<ArrowRight size={14} /></button></div> : <label className="publish-field">选择内容<select className="input" value={selectedId} disabled={busy} onChange={event => { setError(''); setParams({ platform: 'blog', renderId: event.target.value }) }}><option value="" disabled>选择个人博客排版</option>{selectedId && !renders.some(item => item.id === selectedId) ? <option value={selectedId}>指定的排版记录</option> : null}{renders.map(item => <option key={item.id} value={item.id}>{item.contentTitle} · {formatDateTime(item.createdAt)}</option>)}</select></label>}
      {recordLoading ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在读取排版…</p> : article ? <>
        <div className="publish-article-title"><FileText size={16} /><strong>{article.title}</strong><button type="button" className="btn btn-sm" onClick={() => navigate(`/render?renderId=${encodeURIComponent(selectedId)}`)}>检查排版<ArrowRight size={13} /></button></div>
        <div className="publish-cover-field"><label className="publish-field">封面图片（选填）<span className="publish-muted">使用内容封面，或上传 10 MB 以内的图片。</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy} onChange={event => void uploadCover(event)} /></label>{cover ? <><img className="publish-cover-preview" src={absoluteUrl(cover.url)} alt="待发布的个人博客封面" /><button type="button" className="btn btn-sm" disabled={busy} onClick={() => setCover(null)}>移除封面</button></> : null}</div>
        {article.meta.tags.length ? <p className="publish-muted">将尝试匹配博客已有标签：{article.meta.tags.slice(0, 8).map(tag => `#${tag}`).join(' ')}</p> : <p className="publish-muted">原文没有标签，发布时不会添加博客标签。</p>}
        <p className="publish-warning">正文图片会自动转存到 Halo 附件库，发布前会回读核对标题、正文、图片和链接；内容不一致时停止发布并保留草稿。个人博客暂不支持视频、音频、SVG 和 iframe。</p>
        {uncertain ? <div className="publish-warning"><p>这篇内容有 {uncertainItems.length} 个结果待核实的任务。核实后可在这里确认结果并继续操作。</p><button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(uncertainItems[0])}>核实并继续</button></div> : null}
        <div className="publish-submit-actions"><button type="button" className="btn" disabled={!ready} onClick={() => void publish('draft')}><FileText size={16} />保存到博客草稿</button><button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirmation('publish')}>{busy ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}发布到个人博客</button></div>
        <p className="publish-form-hint" role="status">{account?.status !== 'connected' ? '请先连接个人博客。' : busy ? '任务正在处理，请在下方查看进度。' : '发布后文章会出现在个人博客文章列表中。'}</p>
      </> : null}
    </section><aside className="publish-panel publish-preview-panel"><div className="publish-section-head"><h2>个人博客文章预览</h2><p>以 Halo 主题实际渲染为准。</p></div>{article ? <><h3>{article.title}</h3><iframe title="待发布的个人博客正文" sandbox="" srcDoc={`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{padding:18px;font-family:sans-serif;overflow-wrap:anywhere;background:#fafaf9;color:#1c1917}img{max-width:100%;height:auto}</style><body>${article.html}</body></html>`} /></> : <div className="publish-empty"><p>选择内容后预览个人博客排版</p></div>}</aside></div>
    <section className="publish-panel publish-history"><div className="publish-section-head"><h2>个人博客发布记录</h2><p>草稿和正式发布分别记录，处理中的任务会自动更新。</p></div>{!publications.length ? <div className="publish-empty"><p>还没有个人博客发布记录</p></div> : <div className="publish-history-list">{publications.map(item => <article key={item.id} className="publish-history-item"><div className="publish-history-title"><strong>{item.title}</strong><span className={`publish-status ${item.status === 'published' || item.status === 'draft' ? 'is-success' : item.status === 'failed' ? 'is-error' : ''}`}>{labels[item.status]}</span></div><small>{item.mode === 'draft' ? '保存草稿' : '正式发布'} · {formatDateTime(item.createdAt)}</small><p>{item.message}</p>{safeUrl(item.url) ? <a className="btn btn-sm" href={item.url!} target="_blank" rel="noreferrer">{item.status === 'published' ? '查看博客文章' : '打开博客草稿'}<ExternalLink size={13} /></a> : null}{item.status === 'uncertain' ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(item)}>核实结果</button> : null}{item.status === 'draft' || item.status === 'failed' ? <button type="button" className="btn btn-sm publish-delete-button" disabled={busy || deleteBusy} onClick={() => setDeleteTarget(item)}><Trash2 size={13} />{item.status === 'failed' ? '删除记录' : '删除草稿'}</button> : null}{item.resolutions?.length ? <details className="publish-resolution-history"><summary>核实记录（{item.resolutions.length}）</summary>{item.resolutions.map(entry => <p key={entry.id}><small>{formatDateTime(entry.createdAt)}</small> · {entry.message}</p>)}</details> : null}</article>)}</div>}</section>
    <p className="publish-bottom-note"><ShieldCheck size={14} />个人令牌只加密保存在本机服务，不会返回给浏览器；可随时在 Halo 后台撤销令牌。</p>
    <Modal open={connectOpen} onClose={() => { if (!connecting) setConnectOpen(false) }} title="连接个人博客" subtitle="Halo 2.x 地址与个人令牌" size="compact" closeOnBackdrop={!connecting}>
      <div className="blog-connect-form">
        <label className="publish-field">博客地址<input className="input" type="url" value={baseUrl} maxLength={2048} disabled={connecting} placeholder="https://blog.example.com" onChange={event => setBaseUrl(event.target.value)} /></label>
        <label className="publish-field">个人令牌<input className="input" type="password" value={token} maxLength={4096} disabled={connecting} autoComplete="off" placeholder="pat_…" onChange={event => setToken(event.target.value)} /></label>
        <p className="publish-muted"><KeyRound size={13} /> 在 Halo 后台「个人中心 → 个人令牌」创建，需要文章与附件权限。</p>
        <p className="publish-muted">建议使用 HTTPS；HTTP 地址会在网络中明文传输令牌。</p>
        {connectError ? <p className="publish-failure-message" role="alert">{connectError}</p> : null}
        <button type="button" className="btn btn-primary" disabled={connecting || !baseUrl.trim() || !token.trim()} onClick={() => void connect()}>{connecting ? <LoaderCircle size={15} className="spin" /> : <Link2 size={15} />}{connecting ? '正在验证连接…' : '连接并验证'}</button>
      </div>
    </Modal>
    <Modal open={!!resolveItem} onClose={() => { if (!resolveBusy) setResolveItem(null) }} title="核实个人博客发布结果" subtitle={resolveItem?.title} size="compact" closeOnBackdrop={!resolveBusy}>
      <div className="publish-resolution-actions">
        {safeUrl(resolveItem?.url || null) ? <a className="btn" href={resolveItem!.url!} target="_blank" rel="noreferrer">打开博客核对<ExternalLink size={14} /></a> : null}
        <button type="button" className="btn" disabled={resolveBusy} onClick={() => void resolveResult('check')}><RefreshCw size={14} />重新自动核实</button>
        <button type="button" className={`btn ${resolveChoice === 'not_published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('not_published'); setResolveError('') }}>我已核实，未发布</button>
        <button type="button" className={`btn ${resolveChoice === 'published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('published'); setResolveError('') }}>我已核实，已发布</button>
      </div>
      {resolveChoice === 'not_published' ? <><p className="publish-warning">请确认个人博客后台尚未发布这篇文章。确认后将解除限制，允许你再次提交，并优先复用原草稿；此操作不会立即发布文章。若核实有误，再次提交可能重复发布。</p><button type="button" className="btn btn-primary" disabled={resolveBusy} onClick={() => void resolveResult('not_published')}>确认未发布，解除限制</button></> : null}
      {resolveChoice === 'published' ? <><label className="publish-field">已发布文章链接<input className="input" type="url" value={resolveUrl} maxLength={2048} disabled={resolveBusy} placeholder="https://blog.example.com/archives/…" onChange={event => setResolveUrl(event.target.value)} /></label><p className="publish-muted">将按你的核实结果标记已发布并关联链接，不会再次发布这篇文章。链接需位于当前博客域名下。</p><button type="button" className="btn btn-primary" disabled={resolveBusy || !resolveUrl.trim()} onClick={() => void resolveResult('published')}>确认已发布并关联</button></> : null}
      {resolveBusy ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在保存核实结果…</p> : null}
      {resolveError ? <p className="publish-failure-message" role="alert">{resolveError}</p> : null}
    </Modal>
    <ConfirmDialog open={confirmation === 'publish'} title="发布到个人博客？" description={<><strong>{article?.title}</strong><p>将发布至「{account?.name || '已连接个人博客'}」，文章会公开显示在博客中。</p></>} confirmLabel="确认发布到个人博客" tone="primary" loading={submitting} onConfirm={() => publish('publish')} onClose={() => setConfirmation(null)} />
    <ConfirmDialog open={confirmation === 'disconnect'} title="断开个人博客连接？" description="删除系统保存的博客地址和令牌，下次发布需要重新连接。博客上的草稿和文章保持不变。" confirmLabel="断开连接" loading={submitting} onConfirm={disconnect} onClose={() => setConfirmation(null)} />
    <ConfirmDialog open={!!deleteTarget} title={deleteTarget?.status === 'failed' ? '删除个人博客发布记录？' : '删除个人博客草稿？'} description={<><strong>{deleteTarget?.title}</strong><p>{deleteTarget?.status === 'failed' ? '将清理本系统的失败记录，不会删除个人博客上已发布的内容。' : '将同时删除个人博客后台的这份草稿和本系统的发布记录，删除后无法恢复。'}</p></>} confirmLabel={deleteTarget?.status === 'failed' ? '删除记录' : '删除草稿'} loading={deleteBusy} onConfirm={deletePublication} onClose={() => setDeleteTarget(null)} />
  </div>
}
