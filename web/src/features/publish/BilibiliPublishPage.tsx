import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileText,
  LoaderCircle,
  LogOut,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
  Tv,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  BilibiliAccount,
  BilibiliLogin,
  BilibiliPartition,
  BilibiliPublication,
  BilibiliResolveInput,
  MediaAsset,
  RenderListItem,
  RenderRecord,
} from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { copyText, formatDateTime } from '@/lib/utils'
import ConfirmDialog from '@/components/ConfirmDialog'
import Modal from '@/components/Modal'
import './publish.css'

const labels: Record<BilibiliPublication['status'], string> = {
  running: '处理中',
  draft: '已保存草稿',
  reviewing: '审核中',
  published: '已发布',
  failed: '失败',
  uncertain: '结果待核实',
}

const VIDEO_UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame'
const ARTICLE_UPLOAD_URL = 'https://member.bilibili.com/platform/upload/text'

function safeUrl(value: string | null): value is string {
  return !!value && /^https:\/\/(www\.)?bilibili\.com\//i.test(value)
}

function videoDescription(text: string | null, title: string): string {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== title.trim() && !/^#\S+/.test(line))
    .join('\n')
}

export default function BilibiliPublishPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('renderId') || ''
  const mounted = useRef(true)

  const [account, setAccount] = useState<BilibiliAccount | null>(null)
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [publications, setPublications] = useState<BilibiliPublication[]>([])
  const [partitions, setPartitions] = useState<BilibiliPartition[]>([])
  const [videos, setVideos] = useState<MediaAsset[]>([])
  const [images, setImages] = useState<MediaAsset[]>([])
  const [login, setLogin] = useState<BilibiliLogin | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [refreshing, setRefreshing] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [tags, setTags] = useState('')
  const [videoMediaId, setVideoMediaId] = useState('')
  const [coverMediaId, setCoverMediaId] = useState('')
  const [partitionId, setPartitionId] = useState('')
  const [mode, setMode] = useState<'draft' | 'publish'>('publish')

  const [confirmation, setConfirmation] = useState<'submit' | 'disconnect' | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BilibiliPublication | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [resolveItem, setResolveItem] = useState<BilibiliPublication | null>(null)
  const [resolveChoice, setResolveChoice] = useState<'not_published' | 'published' | null>(null)
  const [resolveUrl, setResolveUrl] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  const [resolveError, setResolveError] = useState('')

  const article = record?.results.find((result) => result.platform === 'bilibili')
  const type = article?.previewMode === 'video' ? 'video' : 'article'
  const processing = publications.some((item) => item.status === 'running' || item.status === 'reviewing')
  const busy = submitting || processing || resolveBusy
  const uncertain = publications.some((item) => item.renderId === selectedId && item.status === 'uncertain')
  const selectedCover = images.find((item) => item.id === coverMediaId)
  const coverRatioWarning = type === 'video' && selectedCover?.width && selectedCover?.height
    ? Math.abs(selectedCover.width / selectedCover.height - 16 / 9) > 0.06
    : false
  const contentReady = !!title.trim() && (type !== 'video' || (!!videoMediaId && !!coverMediaId && !!desc.trim() && !!tags.trim()))
  const videoReady = type !== 'video' || (!!videoMediaId && !!coverMediaId)
  const ready = account?.status === 'connected' && !!article && contentReady && videoReady && !busy && !recordLoading && !uncertain

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const results = await Promise.allSettled([
      api.bilibili.account(),
      api.renders.list(),
      api.bilibili.listPublications(),
      api.bilibili.partitions(),
      api.media.list({ kind: 'video', pageSize: 100 }),
      api.media.list({ kind: 'image', pageSize: 100 }),
    ])
    if (!mounted.current) return
    const [accountResult, rendersResult, publicationsResult, partitionsResult, videosResult, imagesResult] = results
    if (accountResult.status === 'fulfilled') setAccount(accountResult.value.account)
    if (rendersResult.status === 'fulfilled') setRenders(rendersResult.value.renders.filter((item) => item.platforms.includes('bilibili')))
    if (publicationsResult.status === 'fulfilled') setPublications(publicationsResult.value.publications)
    if (partitionsResult.status === 'fulfilled') setPartitions(partitionsResult.value.partitions)
    if (videosResult.status === 'fulfilled') setVideos(videosResult.value.media)
    if (imagesResult.status === 'fulfilled') setImages(imagesResult.value.media)
    const failure = results.find((item) => item.status === 'rejected')
    if (failure?.status === 'rejected') setError(getErrorMessage(failure.reason))
    setRefreshing(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [refresh])

  useEffect(() => {
    if (!selectedId && renders.length) setParams({ platform: 'bilibili', renderId: renders[0].id }, { replace: true })
  }, [selectedId, renders, setParams])

  useEffect(() => {
    let cancelled = false
    setRecord(null)
    setError('')
    if (!selectedId) return
    setRecordLoading(true)
    void (async () => {
      try {
        const { render } = await api.renders.get(selectedId)
        const bilibili = render.results.find((item) => item.platform === 'bilibili')
        if (!bilibili) throw new Error('这份记录没有 B 站排版，请先在渲染工作台生成。')
        if (cancelled) return
        setRecord(render)
        setTitle(bilibili.title)
        setDesc(videoDescription(bilibili.text, bilibili.title))
        setTags(bilibili.meta.tags.slice(0, 10).join(', '))
        setMode(bilibili.previewMode === 'video' ? 'publish' : 'publish')
        setPartitionId('')
        const videoUrl = bilibili.videos[0] ?? ''
        const coverUrl = bilibili.assets.find((asset) => asset.kind === 'image')?.url ?? ''
        const match = (assets: MediaAsset[], url: string) => assets.find((asset) => {
          if (!url) return false
          const clean = url.split('?')[0]
          return clean.endsWith(`/${asset.filename}`) || clean.endsWith(asset.url)
        })
        setVideoMediaId(match(videos, videoUrl)?.id ?? '')
        setCoverMediaId(match(images, coverUrl)?.id ?? '')
      } catch (cause) {
        if (!cancelled) setError(getErrorMessage(cause))
      } finally {
        if (!cancelled) setRecordLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedId, images, videos])

  useEffect(() => {
    if (!login || !['waiting', 'scanned'].includes(login.status)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const { login: next } = await api.bilibili.loginStatus(login.id)
        if (cancelled) return
        setLoginError('')
        if (next.status === 'connected') {
          const result = await api.bilibili.account()
          if (cancelled) return
          setAccount(result.account)
          setLoginOpen(false)
          toast.success('B 站账号已连接，登录状态已加密保存')
          return
        }
        setLogin(next)
      } catch (cause) {
        if (!cancelled) setLoginError(getErrorMessage(cause))
      }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [login?.id, login?.status])

  useEffect(() => {
    if (!processing) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await api.bilibili.listPublications()
        if (!cancelled) setPublications(result.publications)
      } catch (cause) {
        if (!cancelled) setError(getErrorMessage(cause))
      }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processing])

  async function startLogin() {
    setLoginOpen(true)
    setLoginBusy(true)
    setLoginError('')
    setLogin(null)
    try {
      const result = await api.bilibili.startLogin()
      if (mounted.current) setLogin(result.login)
    } catch (cause) {
      if (mounted.current) setLoginError(getErrorMessage(cause))
    } finally {
      if (mounted.current) setLoginBusy(false)
    }
  }

  async function submit() {
    if (!record || !article || !ready) return
    setSubmitting(true)
    setError('')
    try {
      const result = await api.bilibili.publish({
        renderId: record.id,
        type,
        mode: type === 'video' ? 'publish' : mode,
        videoMediaId: type === 'video' ? videoMediaId : undefined,
        coverMediaId: type === 'video' ? coverMediaId : undefined,
        title: title.trim(),
        desc: type === 'video' ? desc.trim() : undefined,
        tags,
        partitionId: type === 'video' && partitionId ? Number(partitionId) : undefined,
      })
      if (!mounted.current) return
      setPublications((current) => [result.publication, ...current.filter((item) => item.id !== result.publication.id)])
      setConfirmation(null)
      toast.success(type === 'video' ? '已提交 B 站视频投稿，请等待审核' : '已提交 B 站图文任务，请在下方查看进度')
    } catch (cause) {
      if (mounted.current) { setConfirmation(null); setError(getErrorMessage(cause)) }
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  async function disconnect() {
    setSubmitting(true)
    try {
      await api.bilibili.disconnect()
      if (!mounted.current) return
      setAccount({ status: 'disconnected', name: null, checkedAt: null })
      setLogin(null)
      setConfirmation(null)
      toast.success('已断开 B 站连接')
    } catch (cause) {
      if (mounted.current) setError(getErrorMessage(cause))
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  async function deletePublication() {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      await api.bilibili.removePublication(deleteTarget.id)
      if (!mounted.current) return
      setPublications((current) => current.filter((item) => item.id !== deleteTarget.id))
      setDeleteTarget(null)
      toast.success('B 站发布记录已删除')
    } catch (cause) {
      if (mounted.current) { setDeleteTarget(null); setError(getErrorMessage(cause)) }
    } finally {
      if (mounted.current) setDeleteBusy(false)
    }
  }

  function openResolution(item: BilibiliPublication) {
    setResolveItem(item)
    setResolveChoice(null)
    setResolveUrl(item.url ?? '')
    setResolveError('')
  }

  async function resolveResult(action: BilibiliResolveInput['action']) {
    if (!resolveItem || resolveBusy) return
    setResolveBusy(true)
    setResolveError('')
    try {
      const result = await api.bilibili.resolve(resolveItem.id, action === 'published'
        ? { action, videoUrl: resolveUrl.trim() }
        : { action })
      if (!mounted.current) return
      setPublications((current) => current.map((item) => item.id === result.publication.id ? result.publication : item))
      setResolveItem(null)
      toast.success(result.publication.message)
    } catch (cause) {
      if (mounted.current) setResolveError(getErrorMessage(cause))
    } finally {
      if (mounted.current) setResolveBusy(false)
    }
  }

  return (
    <div className="publish-page bilibili-publish-page">
      <header className="publish-heading">
        <div>
          <span className="publish-eyebrow"><Send size={14} />发布中心 · B 站</span>
          <h1>把内容发布到哔哩哔哩</h1>
          <p>B 站视频投稿与专栏/opus 图文分开处理；扫码登录后自动上传或写入编辑器，失败时提供手动兜底。</p>
        </div>
        <button type="button" className="btn" disabled={refreshing || busy} onClick={() => void refresh()}>
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} />
          刷新状态
        </button>
      </header>

      {error ? <div className="publish-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭提示</button></div> : null}

      <section className="publish-account" aria-label="B 站账号">
        <span className="publish-account-icon"><Tv size={25} /></span>
        <div className="publish-account-copy">
          <h2>{account?.name || 'B 站账号'}</h2>
          <p>{account?.status === 'connected' ? '登录状态已加密保存，下次发布和服务重启后自动复用；失效时重新扫码。' : account?.status === 'expired' ? '登录状态已失效，请重新扫码连接。' : '使用哔哩哔哩 App 扫码登录后，可自动上传视频或发布专栏图文。'}</p>
          {account?.checkedAt ? <small>最近检查：{formatDateTime(account.checkedAt)}</small> : null}
        </div>
        <span className={`publish-status ${account?.status === 'connected' ? 'is-success' : ''}`}>
          {account?.status === 'connected' ? <><CheckCircle2 size={13} />已连接</> : account?.status === 'expired' ? '已过期' : '未连接'}
        </span>
        <div className="publish-account-actions">
          {account?.status === 'connected' ? (
            <button type="button" className="btn btn-sm" disabled={busy || loginBusy} onClick={() => setConfirmation('disconnect')}><LogOut size={14} />断开连接</button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy || loginBusy || refreshing} onClick={() => void startLogin()}><QrCode size={16} />扫码连接 B 站</button>
          )}
          {login && ['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn btn-sm" onClick={() => setLoginOpen(true)}>查看登录二维码</button> : null}
        </div>
      </section>

      <div className="publish-compose-grid">
        <section className="publish-panel">
          <div className="publish-section-head"><h2>准备发布</h2><p>使用渲染工作台已保存的 B 站排版。</p></div>
          {!renders.length && !selectedId && !refreshing ? (
            <div className="publish-empty"><p>先生成一篇 B 站排版</p><button type="button" className="btn btn-primary" onClick={() => navigate('/render')}>去渲染内容<ArrowRight size={14} /></button></div>
          ) : (
            <label className="publish-field">选择内容
              <select className="input" value={selectedId} disabled={busy} onChange={(event) => { setError(''); setParams({ platform: 'bilibili', renderId: event.target.value }) }}>
                <option value="" disabled>选择 B 站排版</option>
                {selectedId && !renders.some((item) => item.id === selectedId) ? <option value={selectedId}>指定的排版记录</option> : null}
                {renders.map((item) => <option key={item.id} value={item.id}>{item.contentTitle} · {formatDateTime(item.createdAt)}</option>)}
              </select>
            </label>
          )}

          {recordLoading ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在读取排版…</p> : article ? (
            <>
              <div className="publish-article-title">
                <FileText size={16} />
                <strong>{article.title}</strong>
                <span className={`publish-status ${type === 'video' ? '' : 'is-success'}`}>{type === 'video' ? 'B 站视频' : 'B 站专栏图文'}</span>
                <button type="button" className="btn btn-sm" onClick={() => navigate(`/render?renderId=${encodeURIComponent(selectedId)}`)}>检查排版<ArrowRight size={13} /></button>
              </div>

              <label className="publish-field">标题
                <input className="input" value={title} maxLength={type === 'video' ? 80 : 40} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
                <small>{Array.from(title).length} / {type === 'video' ? 80 : 40} 字</small>
              </label>

              {type === 'video' ? (
                <>
                  <label className="publish-field">视频成片
                    <select className="input" value={videoMediaId} disabled={busy} onChange={(event) => setVideoMediaId(event.target.value)}>
                      <option value="">选择视频素材（需 MP4 / MOV）</option>
                      {videos.map((item) => <option key={item.id} value={item.id}>{item.originalName} · {item.duration ? `${Math.round(item.duration)}s` : '时长未知'}</option>)}
                    </select>
                  </label>
                  <label className="publish-field">16:9 封面
                    <select className="input" value={coverMediaId} disabled={busy} onChange={(event) => setCoverMediaId(event.target.value)}>
                      <option value="">选择封面图片</option>
                      {images.map((item) => <option key={item.id} value={item.id}>{item.originalName} · {item.width && item.height ? `${item.width}×${item.height}` : '尺寸未知'}</option>)}
                    </select>
                  </label>
                  {coverRatioWarning ? <p className="publish-warning">当前封面比例不是 16:9（{selectedCover?.width}×{selectedCover?.height}），B 站可能会裁切；建议上传 1920×1080 或 1280×720 的封面。</p> : null}
                  <label className="publish-field">视频简介
                    <textarea className="input publish-textarea" value={desc} maxLength={2000} disabled={busy} onChange={(event) => setDesc(event.target.value)} rows={5} />
                    <small>{Array.from(desc).length} / 2000 字</small>
                  </label>
                  <div className="publish-grid-two">
                    <label className="publish-field">分区
                      <select className="input" value={partitionId} disabled={busy} onChange={(event) => setPartitionId(event.target.value)}>
                        <option value="">自动匹配分区</option>
                        {partitions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                    <label className="publish-field">标签（逗号分隔，最多 10 个）
                      <input className="input" value={tags} maxLength={500} disabled={busy} onChange={(event) => setTags(event.target.value)} />
                    </label>
                  </div>
                  <p className="publish-warning"><ShieldCheck size={14} /> B 站视频投稿会先进入审核，审核通过后公开；需要 16:9 封面和 MP4 成片。分类不选时由 B 站按标题自动匹配。</p>
                </>
              ) : (
                <>
                  <p className="publish-form-hint">B 站图文的标签/分类请在发布前于 B 站编辑器补充；当前自动流程只填写标题、正文和正文图片。</p>
                  <div className="publish-mode-switch" role="group" aria-label="发布方式">
                    <button type="button" className={`btn ${mode === 'draft' ? 'btn-primary' : ''}`} disabled={busy} onClick={() => setMode('draft')}>保存草稿</button>
                    <button type="button" className={`btn ${mode === 'publish' ? 'btn-primary' : ''}`} disabled={busy} onClick={() => setMode('publish')}>公开发布</button>
                  </div>
                  <p className="publish-warning"><ShieldCheck size={14} /> 图文使用 B 站新版专栏/opus 编辑器写入。图片会从素材库读取并由编辑器上传到 B 站；发布结果不明确时会标为待核实，避免重复发布。</p>
                </>
              )}

              {uncertain ? (
                <div className="publish-warning">
                  <p>这篇内容有结果待核实的 B 站任务。请先核实发布结果，再决定是否重新提交。</p>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(publications.find((item) => item.renderId === selectedId && item.status === 'uncertain')!)}>核实结果</button>
                </div>
              ) : null}

              <div className="publish-submit-actions">
                <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirmation('submit')}>
                  {submitting || processing ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}
                  {type === 'video' ? '提交 B 站视频投稿' : mode === 'draft' ? '保存 B 站图文草稿' : '发布 B 站图文'}
                </button>
                <a className="btn" href={type === 'video' ? VIDEO_UPLOAD_URL : ARTICLE_UPLOAD_URL} target="_blank" rel="noreferrer"><ExternalLink size={15} />打开发布页</a>
              </div>
              <p className="publish-form-hint" role="status">
                {account?.status !== 'connected' ? '请先扫码连接 B 站账号。' : !title.trim() ? '请填写标题。' : !videoReady ? '请选择视频成片和 16:9 封面。' : type === 'video' && (!desc.trim() || !tags.trim()) ? '请填写视频简介和至少一个标签。' : busy ? '任务正在处理，请在下方查看进度。' : type === 'video' ? '提交后进入 B 站审核，审核通过后公开。' : mode === 'draft' ? '草稿会保存到 B 站创作中心，不会公开。' : '图文会直接提交发布，图片会先转存到 B 站。'}
              </p>
            </>
          ) : null}
        </section>

        <aside className="publish-panel publish-preview-panel">
          <div className="publish-section-head"><h2>B 站预览</h2><p>以 B 站实际页面和审核结果为准。</p></div>
          {article ? (
            <div className="bilibili-publish-preview">
              <h3>{article.title}</h3>
              <iframe title="B 站预览" srcDoc={article.html} sandbox="" />
            </div>
          ) : <div className="publish-empty"><p>选择内容后预览 B 站页面</p></div>}
        </aside>
      </div>

      <section className="publish-panel publish-history">
        <div className="publish-section-head"><h2>B 站发布记录</h2><p>视频审核和图文发布结果会在这里更新。</p></div>
        {!publications.length ? <div className="publish-empty"><p>还没有 B 站发布记录</p></div> : (
          <div className="publish-history-list">
            {publications.map((item) => (
              <article key={item.id} className="publish-history-item">
                <div className="publish-history-title">
                  <strong>{item.title}</strong>
                  <span className={`publish-status ${['published', 'draft'].includes(item.status) ? 'is-success' : ['failed'].includes(item.status) ? 'is-error' : item.status === 'uncertain' ? 'is-warning' : ''}`}>{labels[item.status]}</span>
                </div>
                <small>{item.type === 'video' ? '视频投稿' : '专栏图文'} · {formatDateTime(item.createdAt)}</small>
                <p>{item.message}</p>
                {safeUrl(item.url) ? <a className="btn btn-sm" href={item.url} target="_blank" rel="noreferrer">打开 B 站<ExternalLink size={13} /></a> : null}
                {item.status === 'uncertain' ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => openResolution(item)}>核实结果</button> : null}
                {['draft', 'failed', 'uncertain'].includes(item.status) ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setDeleteTarget(item)}>删除记录</button> : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <p className="publish-bottom-note"><ShieldCheck size={14} />B 站 Web 创作中心接口可能调整；遇到扫码失效、风控或结果不明确时会停止自动操作，请到创作中心人工核实，系统不会自动重复发布。</p>

      <Modal open={loginOpen} onClose={() => setLoginOpen(false)} title="连接 B 站账号" subtitle="使用哔哩哔哩 App 扫码登录" size="compact">
        <div className="publish-login" aria-live="polite">
          {loginBusy || (login?.status === 'waiting' && !login.qrCode) ? <><LoaderCircle size={30} className="spin" /><p>正在获取 B 站官方登录二维码…</p></> : login ? (
            <>
              {login.qrCode && ['waiting', 'scanned'].includes(login.status) ? <img className="publish-login-qr" src={login.qrCode} alt="B 站官方登录二维码" /> : <QrCode size={32} />}
              <p>{login.message}</p>
              <small>有效期至 {formatDateTime(login.expiresAt)}</small>
              {!['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn" onClick={() => void startLogin()}>重新获取二维码</button> : null}
            </>
          ) : null}
          {loginError ? <p className="publish-failure-message" role="alert">{loginError}</p> : null}
          {!loginBusy && !login ? <button type="button" className="btn btn-primary" onClick={() => void startLogin()}>重新连接</button> : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmation === 'submit' || confirmation === 'disconnect'}
        title={confirmation === 'disconnect' ? '断开 B 站连接？' : type === 'video' ? '提交 B 站视频投稿？' : mode === 'draft' ? '保存 B 站图文草稿？' : '公开发布 B 站图文？'}
        description={confirmation === 'disconnect' ? '删除系统保存的 B 站登录状态，下次发布需要重新扫码。B 站上的内容保持不变。' : <><strong>{title}</strong><p>{type === 'video' ? '视频将上传到 B 站并进入审核，审核通过后公开。' : mode === 'draft' ? '草稿会保存到 B 站创作中心，不会公开。' : '图文会提交发布，发布后可在 B 站创作中心查看。'}</p></>}
        confirmLabel={confirmation === 'disconnect' ? '断开连接' : type === 'video' ? '确认提交投稿' : mode === 'draft' ? '确认保存草稿' : '确认公开发布'}
        tone="primary"
        loading={submitting}
        onConfirm={confirmation === 'disconnect' ? disconnect : submit}
        onClose={() => setConfirmation(null)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除 B 站发布记录？"
        description={<><strong>{deleteTarget?.title}</strong><p>只删除本系统记录，不会删除 B 站上已提交/已发布的视频或图文。</p></>}
        confirmLabel="删除记录"
        loading={deleteBusy}
        onConfirm={deletePublication}
        onClose={() => setDeleteTarget(null)}
      />

      <Modal open={!!resolveItem} onClose={() => { if (!resolveBusy) setResolveItem(null) }} title="核实 B 站发布结果" subtitle={resolveItem?.title} size="compact" closeOnBackdrop={!resolveBusy}>
        <div className="publish-resolution-actions">
          {resolveItem?.type === 'video' ? <button type="button" className="btn" disabled={resolveBusy} onClick={() => void resolveResult('check')}><RefreshCw size={14} />检查视频状态</button> : null}
          <button type="button" className={`btn ${resolveChoice === 'not_published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('not_published'); setResolveError('') }}>我已核实，未发布</button>
          <button type="button" className={`btn ${resolveChoice === 'published' ? 'btn-primary' : ''}`} disabled={resolveBusy} onClick={() => { setResolveChoice('published'); setResolveError('') }}>我已核实，已发布</button>
        </div>
        {resolveChoice === 'not_published' ? <><p className="publish-warning">请确认 B 站创作中心/稿件管理中确实没有这篇内容，确认后允许再次提交。</p><button type="button" className="btn btn-primary" disabled={resolveBusy} onClick={() => void resolveResult('not_published')}>确认未发布，解除限制</button></> : null}
        {resolveChoice === 'published' ? <><label className="publish-field">B 站公开链接<input className="input" type="url" value={resolveUrl} maxLength={2048} disabled={resolveBusy} placeholder="https://www.bilibili.com/video/BV... 或 /opus/..." onChange={(event) => setResolveUrl(event.target.value)} /></label><button type="button" className="btn btn-primary" disabled={resolveBusy || !resolveUrl.trim()} onClick={() => void resolveResult('published')}>确认已发布并关联</button></> : null}
        {resolveBusy ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在保存核实结果…</p> : null}
        {resolveError ? <p className="publish-failure-message" role="alert">{resolveError}</p> : null}
      </Modal>
    </div>
  )
}
