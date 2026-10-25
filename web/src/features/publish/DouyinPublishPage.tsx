import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import type { DouyinAccount, DouyinLogin, DouyinPublication, MediaAsset, RenderListItem, RenderRecord } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'

const labels: Record<DouyinPublication['status'], string> = { running: '处理中', draft: '草稿', published: '已提交审核', failed: '失败', uncertain: '结果待核实' }

export default function DouyinPublishPage() {
  const [params, setParams] = useSearchParams(), selectedId = params.get('renderId') || ''
  const [account, setAccount] = useState<DouyinAccount | null>(null)
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [media, setMedia] = useState<MediaAsset[]>([])
  const [publications, setPublications] = useState<DouyinPublication[]>([])
  const [login, setLogin] = useState<DouyinLogin | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const article = record?.results.find(item => item.platform === 'douyin')
  const running = publications.some(item => item.status === 'running')
  const locked = busy || running
  const uncertain = publications.some(item => item.status === 'uncertain')
  const ready = account?.status === 'connected' && !!article && !!media.length && !locked && !uncertain
  async function refresh() {
    try {
      const [a, r, p] = await Promise.all([api.douyin.account(), api.renders.list(), api.douyin.listPublications()])
      setAccount(a.account); setRenders(r.renders.filter(item => item.platforms.includes('douyin'))); setPublications(p.publications)
    } catch (cause) { setError(getErrorMessage(cause)) }
  }
  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    let cancelled = false
    setRecord(null); setMedia([])
    if (selectedId) void api.renders.get(selectedId).then(result => { if (!cancelled) setRecord(result.render) }).catch(cause => { if (!cancelled) setError(getErrorMessage(cause)) })
    return () => { cancelled = true }
  }, [selectedId])
  useEffect(() => {
    if (!login || !['waiting', 'scanned'].includes(login.status)) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        if (Date.now() >= Date.parse(login.expiresAt)) { if (!cancelled) setLogin({ ...login, status: 'expired', qrCode: null, message: '二维码已过期，请重新连接' }); return }
        const result = await api.douyin.loginStatus(login.id)
        if (cancelled) return
        setLogin(result.login)
        if (result.login.status === 'connected') { setLoginOpen(false); void refresh(); return }
      } catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [login?.id, login?.status])
  useEffect(() => {
    if (!running) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const result = await api.douyin.listPublications(); if (!cancelled) setPublications(result.publications) }
      catch (cause) { if (!cancelled) setError(getErrorMessage(cause)) }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [running])
  async function connect() {
    setBusy(true); setError(''); setLogin(null); setLoginOpen(true)
    try { setLogin((await api.douyin.startLogin()).login) }
    catch (cause) { setError(getErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function upload(files: File[]) {
    if (!files.length) return
    if (!(files.length === 1 && files[0].type === 'video/mp4') && (files.length > 35 || files.some(file => !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10 * 1024 * 1024))) { setError('请选择一个 MP4 视频或 1–35 张图片，每张图片不超过 10 MB'); return }
    if (files.some(file => file.size > 200 * 1024 * 1024)) { setError('视频不能超过 200 MB'); return }
    setBusy(true); setError(''); setMedia([])
    try { const assets: MediaAsset[] = []; for (const file of files) assets.push((await api.media.upload(file)).media); setMedia(assets) }
    catch (cause) { setError(getErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function publish() {
    if (!ready) return
    setBusy(true); setError(''); setConfirm(false)
    try {
      const input = media[0].kind === 'video' ? { videoMediaId: media[0].id } : { imageMediaIds: media.map(item => item.id) }
      const result = await api.douyin.publish({ renderId: selectedId, mode: 'publish', ...input })
      setPublications(current => [result.publication, ...current.filter(item => item.id !== result.publication.id)])
    } catch (cause) { setError(getErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function resolve(item: DouyinPublication, published: boolean) {
    const articleUrl = published ? window.prompt('请输入已发布作品的完整链接：https://www.douyin.com/video/作品编号') : undefined
    if (published && !articleUrl) return
    if (!published && !window.confirm('请确认已在抖音后台核实该任务没有发布。确认后才允许重新提交。')) return
    setBusy(true)
    try { await api.douyin.resolve(item.id, published ? { action: 'published', articleUrl: articleUrl! } : { action: 'not_published' }); await refresh() }
    catch (cause) { setError(getErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  return <div className="publish-page">
    <header className="publish-heading"><div><span className="publish-eyebrow">发布中心 · 抖音</span><h1>把内容发布到抖音</h1><p>扫码连接创作者账号，发布视频或图文作品。</p></div><button className="btn" disabled={locked} onClick={() => void refresh()}>刷新状态</button></header>
    {error ? <div className="publish-error" role="alert">{error}</div> : null}
    <section className="publish-account"><div className="publish-account-copy"><h2>{account?.name || '抖音账号'}</h2><p>{account?.status === 'connected' ? '已连接，登录会话已加密保存，服务重启后可复用。' : account?.status === 'expired' ? '登录已过期，请重新扫码。' : '使用抖音 App 扫描官方二维码并确认登录。'}</p></div><button className="btn btn-primary" disabled={locked} onClick={() => void connect()}>扫码连接抖音</button>{account?.status === 'connected' ? <button className="btn" disabled={locked} onClick={async () => { setBusy(true); try { await api.douyin.disconnect(); await refresh() } catch (cause) { setError(getErrorMessage(cause)) } finally { setBusy(false) } }}>断开连接</button> : null}</section>
    <section className="publish-panel"><h2>准备发布</h2><label className="publish-field">选择抖音排版<select className="input" disabled={locked} value={selectedId} onChange={event => setParams({ platform: 'douyin', renderId: event.target.value })}><option value="">请选择内容</option>{renders.map(item => <option key={item.id} value={item.id}>{item.contentTitle}</option>)}</select></label><Link to="/render">前往渲染工作台</Link>
      {article ? <><h3>{article.title}</h3><p className="publish-muted">标题最多 30 字；正文与话题最多 1000 字。请在渲染工作台调整后保存。</p><pre style={{ whiteSpace: 'pre-wrap' }}>{article.text}</pre><label className="publish-field">作品素材（一个 MP4 视频，或按顺序选择 1–35 张图片）<input type="file" multiple accept="video/mp4,image/png,image/jpeg,image/webp,image/gif" disabled={locked} onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = '' }} /></label><p>{media.length ? `已准备 ${media.length} 个素材` : '请选择要发布的素材'}</p>{media.length ? <ol>{media.map(item => <li key={item.id}>{item.originalName || item.id}</li>)}</ol> : null}</> : null}
      <p className="publish-warning">遇到安全验证会停止；结果待核实时请先检查抖音后台，系统不会自动重发。发布后仍需平台审核。</p>
      <button className="btn btn-primary" disabled={!ready} onClick={() => setConfirm(true)}>{locked ? '正在处理…' : '发布到抖音'}</button>
    </section>
    <section className="publish-panel"><h2>发布记录</h2>{!publications.length ? <p>暂无发布记录</p> : publications.map(item => <div key={item.id} className="publish-record"><strong>{item.title}</strong><p>{labels[item.status]} · {item.message}</p><small>{formatDateTime(item.createdAt)}</small>{item.url && /^https:\/\/www\.douyin\.com\/video\/\d{10,30}$/.test(item.url) ? <a href={item.url} target="_blank" rel="noreferrer">查看作品</a> : null}{item.status === 'uncertain' ? <div><button className="btn" disabled={locked} onClick={() => void resolve(item, true)}>已核实发布成功</button><button className="btn" disabled={locked} onClick={() => void resolve(item, false)}>已核实未发布</button></div> : null}</div>)}</section>
    <Modal open={loginOpen} onClose={() => setLoginOpen(false)} title="扫码连接抖音"><p>{login?.message || '正在获取官方二维码…'}</p>{login?.qrCode ? <img src={login.qrCode} alt="抖音官方登录二维码" style={{ width: 260, maxWidth: '100%' }} /> : null}<button className="btn" disabled={locked} onClick={() => void connect()}>重新获取二维码</button></Modal>
    <ConfirmDialog open={confirm} title="确认发布到抖音" description="将所选素材和上方文案提交到当前抖音账号，提交后进入平台审核。" confirmLabel="确认发布" tone="primary" onConfirm={() => void publish()} onClose={() => setConfirm(false)} />
  </div>
}
