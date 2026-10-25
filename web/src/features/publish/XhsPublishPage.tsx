import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, ExternalLink, FileText, LoaderCircle, LogOut, QrCode, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { MediaAsset, RenderListItem, RenderRecord, PlatformRender, XhsAccount, XhsLogin, XhsPublication, XhsResolveInput } from '@shared/types'
import { layoutCards, overflowingText, verifyCardImages } from '../render/card-layout'
import { toBlob } from 'html-to-image'
import XhsCardView from '../render/XhsCardView'
import { getCaptionBody, selectXhsPublishCards } from '@shared/render-workbench'
import '../render/render.css'
import { absoluteUrl, api, ApiError } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'

const labels: Record<XhsPublication['status'], string> = { running: '处理中', draft: '已保存草稿', published: '已发布', failed: '失败', uncertain: '结果待核实' }
const safeUrl = (value: string | null) => !!value && /^https:\/\/www\.xiaohongshu\.com\/explore\/[a-f0-9]{24}$/.test(value)

export default function XhsPublishPage() {
  const navigate = useNavigate(), [params, setParams] = useSearchParams(), selectedId = params.get('renderId') || ''
  const mounted = useRef(true)
  const [account, setAccount] = useState<XhsAccount | null>(null)
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [images, setImages] = useState<MediaAsset[]>([])
  const cardsRef = useRef<HTMLDivElement>(null)
  const [layoutReadyFor, setLayoutReadyFor] = useState<PlatformRender | null>(null)
  const [layoutError, setLayoutError] = useState('')
  const [originalCardCount, setOriginalCardCount] = useState(0)
  const [omittedCards, setOmittedCards] = useState(0)
  const [publications, setPublications] = useState<XhsPublication[]>([])
  const [login, setLogin] = useState<XhsLogin | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<'publish' | 'disconnect' | null>(null)
  const [resolveItem, setResolveItem] = useState<XhsPublication | null>(null)
  const [resolveChoice, setResolveChoice] = useState<'not_published' | 'published' | null>(null)
  const [resolveUrl, setResolveUrl] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const article = record?.results.find(result => result.platform === 'xiaohongshu')
  const processing = publications.some(item => item.status === 'running')
  const busy = submitting || uploading || processing || resolveBusy
  const uncertainItems = publications.filter(item => item.status === 'uncertain')
  const uncertain = uncertainItems.length > 0
  const layoutBusy = !!article && !images.length && layoutReadyFor !== article && !layoutError
  const ready = account?.status === 'connected' && !!article && !busy && !recordLoading && !uncertain && (!!images.length || layoutReadyFor === article && !layoutError)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const results = await Promise.allSettled([api.xiaohongshu.account(), api.renders.list(), api.xiaohongshu.listPublications()])
    if (!mounted.current) return
    const [a, r, p] = results
    if (a.status === 'fulfilled') setAccount(a.value.account)
    if (r.status === 'fulfilled') setRenders(r.value.renders.filter(item => item.platforms.includes('xiaohongshu')))
    if (p.status === 'fulfilled') setPublications(p.value.publications)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') setError(getErrorMessage(failure.reason))
    setRefreshing(false)
  }, [])
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false } }, [refresh])
  useEffect(() => {
    if (!selectedId && renders.length) setParams({ platform: 'xiaohongshu', renderId: renders[0].id }, { replace: true })
  }, [selectedId, renders, setParams])
  useEffect(() => {
    let cancelled = false
    setRecord(null); setImages([]); setOmittedCards(0)
    if (!selectedId) return
    setRecordLoading(true)
    void (async () => {
      try {
        const { render } = await api.renders.get(selectedId)
        if (!render.results.some(result => result.platform === 'xiaohongshu')) throw new Error('这份记录没有小红书排版，请先在渲染工作台生成。')
        if (cancelled) return
        setOriginalCardCount(render.results.find(result => result.platform === 'xiaohongshu')!.cards.length)
        setRecord(render)
      } catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      finally { if (!cancelled) setRecordLoading(false) }
    })()
    return () => { cancelled = true }
  }, [selectedId])
  useEffect(() => {
    if (!article || images.length) return
    let cancelled = false
    setLayoutError('')
    const timer = setTimeout(() => { if (!cancelled) setLayoutError('字体加载超时，请刷新页面后重试') }, 4000)
    void document.fonts.ready.then(() => {
      clearTimeout(timer)
      if (cancelled) return
      const wrappers = Array.from(cardsRef.current?.children || []) as HTMLDivElement[]
      if (wrappers.length !== article.cards.length) throw new Error('卡片尚未就绪，请刷新后重试')
      const nodes = new Map(article.cards.map((card, index) => [card.id, wrappers[index]]))
      const cards = layoutCards(article.cards, nodes)
      if (JSON.stringify(cards) !== JSON.stringify(article.cards)) {
        setRecord(current => current ? { ...current, results: current.results.map(result => result === article ? { ...result, cards } : result) } : current)
        return
      }
      const overflow = cards.findIndex(card => overflowingText(nodes.get(card.id)!))
      if (overflow >= 0) throw new Error(`第 ${overflow + 1} 张的标题或内容无法自动放入卡片，请在渲染工作台缩短标题或调整图片`)
      if (cards.length > 18) {
        const selected = selectXhsPublishCards(cards)
        setOmittedCards(cards.length - selected.length)
        setRecord(current => current ? { ...current, results: current.results.map(result => result === article ? { ...result, cards: selected } : result) } : current)
        return
      }
      setLayoutReadyFor(article)
    }).catch(cause => { if (!cancelled) setLayoutError(getErrorMessage(cause)) })
    return () => { cancelled = true; clearTimeout(timer) }
  }, [article, images.length])
  useEffect(() => {
    if (!login || !['waiting', 'scanned'].includes(login.status)) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        if (Date.now() >= Date.parse(login.expiresAt)) {
          if (!cancelled) setLogin(current => current ? { ...current, status: 'expired', qrCode: null, message: '登录二维码已过期，请重新获取' } : null)
          return
        }
        const { login: next } = await api.xiaohongshu.loginStatus(login.id)
        if (cancelled) return
        setLoginError('')
        if (next.status === 'connected') {
          const result = await api.xiaohongshu.account()
          if (cancelled) return
          setLogin(next); setAccount(result.account); setLoginOpen(false); toast.success('小红书已连接，登录状态已保存')
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
      try { const result = await api.xiaohongshu.listPublications(); if (!cancelled) setPublications(result.publications) }
      catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processing])

  async function startLogin() {
    setLoginOpen(true); setLoginBusy(true); setLoginError(''); setLogin(null)
    try { const result = await api.xiaohongshu.startLogin(); if (mounted.current) setLogin(result.login) }
    catch (cause) { if (mounted.current) setLoginError(getErrorMessage(cause)) }
    finally { if (mounted.current) setLoginBusy(false) }
  }
  async function uploadImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    if (files.length > 18 || files.some(file => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024)) { setError('请选择 1–18 张图片，每张不超过 10 MB。'); return }
    setUploading(true)
    try {
      const uploaded: MediaAsset[] = []
      for (const file of files) uploaded.push((await api.media.upload(file)).media)
      if (mounted.current) setImages(uploaded)
    } catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setUploading(false) }
  }
  async function publish() {
    if (!record || !ready) return
    setSubmitting(true); setError('')
    try {
      let assets = images
      if (!assets.length) {
        if (!article?.cards.length || article.cards.length > 18) throw new Error('请准备 1–18 张图文卡片，或上传图片')
        await Promise.race([document.fonts.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('字体加载超时，请重试')), 4000))])
        assets = []
        const nodes = cardsRef.current?.querySelectorAll<HTMLElement>('.xhs-card')
        if (!nodes || nodes.length !== article.cards.length) throw new Error('卡片尚未就绪，请刷新后重试')
        for (const [index, node] of Array.from(nodes).entries()) {
          if (overflowingText(node.parentElement!)) throw new Error(`第 ${index + 1} 张卡片排版已变化，请刷新页面后重试`)
        }
        await verifyCardImages(article.cards.flatMap(card => card.images).map(absoluteUrl))
        for (const [index, node] of Array.from(nodes).entries()) {
          const blob = await toBlob(node, { width: 540, height: 720, pixelRatio: 2 })
          if (!blob) throw new Error(`第 ${index + 1} 张卡片生成失败`)
          assets.push((await api.media.upload(new File([blob], `card-${index + 1}.png`, { type: 'image/png' }))).media)
        }
      }
      const result = await api.xiaohongshu.publish({ renderId: record.id, mode: 'publish', imageMediaIds: assets.map(item => item.id) })
      if (!mounted.current) return
      setPublications(current => [result.publication, ...current.filter(item => item.id !== result.publication.id)])
      setConfirmation(null)
      toast.success(result.publication.status === 'running' ? '已提交小红书任务，请在下方查看进度' : result.publication.message)
    } catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setSubmitting(false) }
  }
  async function disconnect() {
    setSubmitting(true)
    try { await api.xiaohongshu.disconnect(); if (mounted.current) { setAccount({ status: 'disconnected', name: null, checkedAt: null }); setLogin(null); setConfirmation(null) } }
    catch (cause) { if (mounted.current) setError(getErrorMessage(cause)) }
    finally { if (mounted.current) setSubmitting(false) }
  }

  function openResolution(item: XhsPublication) {
    setResolveItem(item); setResolveChoice(null); setResolveUrl(''); setResolveError('')
  }
  async function resolveResult(action: XhsResolveInput['action']) {
    if (!resolveItem || resolveBusy) return
    setResolveBusy(true); setResolveError('')
    try {
      const result = await api.xiaohongshu.resolve(resolveItem.id, action === 'published' ? { action, articleUrl: resolveUrl.trim() } : { action })
      if (!mounted.current) return
      setPublications(current => current.map(item => item.id === result.publication.id ? result.publication : item))
      setResolveItem(null)
      toast.success(action === 'check' ? '正在重新核实，请查看任务进度' : result.publication.message)
    } catch (cause) { if (mounted.current) setResolveError(getErrorMessage(cause)) }
    finally { if (mounted.current) setResolveBusy(false) }
  }

  return <div className="publish-page xiaohongshu-publish-page">
    <header className="publish-heading"><div><span className="publish-eyebrow"><Send size={14} />发布中心 · 小红书</span><h1>把内容发布到小红书</h1><p>连接小红书账号，选择卡片和文案，一键发布图文笔记。</p></div><button type="button" className="btn" disabled={refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? 'spin' : undefined} />刷新状态</button></header>
    {error ? <div className="publish-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭提示</button></div> : null}
    <section className="publish-account" aria-label="小红书账号">
      <span className="publish-account-icon">红</span><div className="publish-account-copy"><h2>{account?.name || '小红书账号'}</h2><p>{account?.status === 'connected' ? '登录状态已加密保存，下次访问和服务重启后自动复用；失效时重新扫码。' : account?.status === 'expired' ? '登录状态已失效，请重新扫码连接。' : '使用小红书 App 扫描官方二维码，并在手机上确认登录。'}</p>{account?.checkedAt ? <small>最近检查：{formatDateTime(account.checkedAt)}</small> : null}</div>
      <span className={`publish-status ${account?.status === 'connected' ? 'is-success' : ''}`}>{account?.status === 'connected' ? <><CheckCircle2 size={13} />已连接</> : account?.status === 'expired' ? '已过期' : '未连接'}</span>
      <div className="publish-account-actions">{account?.status === 'connected' ? <button type="button" className="btn btn-sm" disabled={busy || loginBusy} onClick={() => setConfirmation('disconnect')}><LogOut size={14} />断开连接</button> : <button type="button" className="btn btn-primary" disabled={busy || loginBusy || refreshing} onClick={() => void startLogin()}><QrCode size={16} />扫码连接小红书</button>}{login && ['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn btn-sm" onClick={() => setLoginOpen(true)}>查看登录二维码</button> : null}</div>
    </section>
    <div className="publish-compose-grid"><section className="publish-panel">
      <div className="publish-section-head"><h2>准备发布</h2><p>使用渲染工作台中已保存的小红书排版，支持图文笔记。</p></div>
      {!renders.length && !selectedId && !refreshing ? <div className="publish-empty"><p>先生成一篇小红书排版</p><button type="button" className="btn btn-primary" onClick={() => navigate('/render')}>去渲染内容<ArrowRight size={14} /></button></div> : <label className="publish-field">选择内容<select className="input" value={selectedId} disabled={busy} onChange={event => { setError(''); setParams({ platform: 'xiaohongshu', renderId: event.target.value }) }}><option value="" disabled>选择小红书排版</option>{selectedId && !renders.some(item => item.id === selectedId) ? <option value={selectedId}>指定的排版记录</option> : null}{renders.map(item => <option key={item.id} value={item.id}>{item.contentTitle} · {formatDateTime(item.createdAt)}</option>)}</select></label>}
      {recordLoading ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在读取排版…</p> : article ? <>
        <div className="publish-article-title"><FileText size={16} /><strong>{article.title}</strong><button type="button" className="btn btn-sm" onClick={() => navigate(`/render?renderId=${encodeURIComponent(selectedId)}`)}>检查排版<ArrowRight size={13} /></button></div>
        <div className="publish-cover-field"><label className="publish-field">笔记图片<span className="publish-muted">默认自动分页，超出 18 张时精选片段，再按预览顺序发布；也可上传 1–18 张图片替换，每张不超过 10 MB。</span><input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy} onChange={event => void uploadImages(event)} /></label>{images.length ? <><p>将按所选顺序发布 {images.length} 张图片</p><button type="button" className="btn btn-sm" disabled={busy} onClick={() => setImages([])}>恢复使用卡片</button></> : null}</div>
        {!images.length ? <p className={layoutError ? 'publish-error' : 'publish-muted'} role={layoutError ? 'alert' : 'status'}>{layoutError || (layoutBusy ? '正在按实际文字高度自动分页…' : `已准备 ${article.cards.length} 张卡片${!omittedCards && article.cards.length !== originalCardCount ? `（由 ${originalCardCount} 张自动分页）` : ''}，按预览顺序发布`)}</p> : null}
        {!images.length && omittedCards > 0 ? <p className="publish-warning" role="status" aria-label="精选卡片说明">已精选 {article.cards.length} 张卡片，省略 {omittedCards} 张细节卡片。保留首尾并按原顺序选取全文片段，未包含全部内容；仅精简本次发布图片，原文与笔记文案不变，请检查右侧预览。</p> : null}
        <p className="publish-warning">遇到安全验证会停止。提交结果不确定时，请先到小红书核实，避免重复发布。</p>
        {uncertain ? <div className="publish-warning"><p>当前账号有 {uncertainItems.length} 个结果待核实的任务。核实后可在这里确认结果并继续操作。</p><button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(uncertainItems[0])}>核实并继续</button></div> : null}
        <div className="publish-submit-actions"><button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirmation('publish')}>{busy ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}正式发布到小红书</button></div>
        <p className="publish-form-hint" role="status">{account?.status !== 'connected' ? '请先扫码连接小红书。' : busy ? '任务正在处理，请在下方查看进度。' : '发布后笔记可能公开显示在你的小红书主页。'}</p>
      </> : null}
    </section><aside className="publish-panel publish-preview-panel"><div className="publish-section-head"><h2>小红书笔记预览</h2><p>以小红书实际排版和审核结果为准。</p></div>{article ? <><h3>{article.title}</h3><p style={{ whiteSpace: 'pre-wrap' }}>{getCaptionBody(article)}</p><p>{article.meta.tags.map(tag => `#${tag}`).join(' ')}</p>{images.length ? images.map(image => <img key={image.id} src={absoluteUrl(image.url)} alt={image.originalName} style={{ width: '100%' }} />) : <div ref={cardsRef} style={{ overflow: 'auto' }}>{article.cards.map(card => <div key={card.id} style={{ width: 540, height: 720, marginBottom: 12 }}><XhsCardView card={card} style={record?.options.cardStyle || 'clean'} tags={article.meta.tags} /></div>)}</div>}</> : <div className="publish-empty"><p>选择内容后预览小红书排版</p></div>}</aside></div>
    <section className="publish-panel publish-history"><div className="publish-section-head"><h2>小红书发布记录</h2><p>图文发布任务分别记录，处理中的任务会自动更新。</p></div>{!publications.length ? <div className="publish-empty"><p>还没有小红书发布记录</p></div> : <div className="publish-history-list">{publications.map(item => <article key={item.id} className="publish-history-item"><div className="publish-history-title"><strong>{item.title}</strong><span className={`publish-status ${item.status === 'published' || item.status === 'draft' ? 'is-success' : item.status === 'failed' ? 'is-error' : ''}`}>{labels[item.status]}</span></div><small>{item.mode === 'draft' ? '保存草稿' : '正式发布'} · {formatDateTime(item.createdAt)}</small><p>{item.message}</p>{safeUrl(item.url) ? <a className="btn btn-sm" href={item.url!} target="_blank" rel="noreferrer">{item.status === 'published' ? '查看小红书笔记' : '打开小红书草稿'}<ExternalLink size={13} /></a> : null}{item.status === 'uncertain' ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(item)}>核实结果</button> : null}{item.resolutions?.length ? <details className="publish-resolution-history"><summary>核实记录（{item.resolutions.length}）</summary>{item.resolutions.map(entry => <p key={entry.id}><small>{formatDateTime(entry.createdAt)}</small> · {entry.message}</p>)}</details> : null}</article>)}</div>}</section>
    <p className="publish-bottom-note"><ShieldCheck size={14} />使用小红书官方二维码登录，无需提供小红书密码。小红书要求额外安全验证时，会停止操作并显示提示。</p>
    <Modal open={loginOpen} onClose={() => setLoginOpen(false)} title="连接小红书" subtitle="使用小红书 App 扫码，并在手机上确认登录" size="compact"><div className="publish-login" aria-live="polite">{loginBusy || login?.status === 'waiting' && !login.qrCode ? <><LoaderCircle size={30} className="spin" /><p>{login?.message || '正在获取小红书官方登录二维码…'}</p></> : login ? <>{login.qrCode && ['waiting', 'scanned'].includes(login.status) ? <img className="publish-login-qr" src={login.qrCode} alt="小红书官方登录二维码" /> : <QrCode size={32} />}<p>{login.message}</p><small>有效期至 {formatDateTime(login.expiresAt)}</small>{!['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn" onClick={() => void startLogin()}>重新获取二维码</button> : null}</> : null}{loginError ? <p className="publish-failure-message" role="alert">{loginError}</p> : null}{!loginBusy && !login ? <button type="button" className="btn btn-primary" onClick={() => void startLogin()}>重新连接</button> : null}</div></Modal>
    <Modal open={!!resolveItem} onClose={() => { if (!resolveBusy) setResolveItem(null) }} title="核实小红书发布结果" subtitle={resolveItem?.title} size="compact" closeOnBackdrop={!resolveBusy}>
      <div className="publish-resolution-actions">
        {safeUrl(resolveItem?.url || null) ? <a className="btn" href={resolveItem!.url!} target="_blank" rel="noreferrer">打开小红书核对<ExternalLink size={14} /></a> : null}
        <button type="button" className={`btn ${resolveChoice === 'not_published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('not_published'); setResolveError('') }}>我已核实，未发布</button>
        <button type="button" className={`btn ${resolveChoice === 'published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('published'); setResolveError('') }}>我已核实，已发布</button>
      </div>
      {resolveChoice === 'not_published' ? <><p className="publish-warning">请确认小红书后台尚未发布这篇笔记。确认后将解除限制，允许你再次提交，重新创建笔记；此操作不会立即发布笔记。若核实有误，再次提交可能重复发布。</p><button type="button" className="btn btn-primary" disabled={resolveBusy} onClick={() => void resolveResult('not_published')}>确认未发布，解除限制</button></> : null}
      {resolveChoice === 'published' ? <><label className="publish-field">已发布笔记链接<input className="input" type="url" value={resolveUrl} maxLength={2048} disabled={resolveBusy} placeholder="https://www.xiaohongshu.com/explore/…" onChange={event => setResolveUrl(event.target.value)} /></label><p className="publish-muted">将按你的核实结果标记已发布并关联链接，不会再次发布这篇笔记。</p><button type="button" className="btn btn-primary" disabled={resolveBusy || !resolveUrl.trim()} onClick={() => void resolveResult('published')}>确认已发布并关联</button></> : null}
      {resolveBusy ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在保存核实结果…</p> : null}
      {resolveError ? <p className="publish-failure-message" role="alert">{resolveError}</p> : null}
    </Modal>
    <ConfirmDialog open={confirmation === 'publish'} title="正式发布到小红书？" description={<><strong>{article?.title}</strong><p>将发布至「{account?.name || '已连接小红书账号'}」，笔记可能对外公开。</p></>} confirmLabel="确认发布到小红书" tone="primary" loading={submitting} onConfirm={publish} onClose={() => setConfirmation(null)} />
    <ConfirmDialog open={confirmation === 'disconnect'} title="断开小红书连接？" description="删除系统保存的小红书登录状态，下次发布需要重新扫码。小红书上的草稿和笔记保持不变。" confirmLabel="断开连接" loading={submitting} onConfirm={disconnect} onClose={() => setConfirmation(null)} />
  </div>
}
