import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, ExternalLink, FileText, ImagePlus, LoaderCircle, LogOut, MessageCircle, QrCode, RefreshCw, Send, ShieldCheck, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { MediaAsset, RenderListItem, RenderRecord, WechatAccount, WechatLogin, WechatPublication } from '@shared/types'
import { absoluteUrl, api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import ConfirmDialog from '@/components/ConfirmDialog'
import Modal from '@/components/Modal'
import './publish.css'

const STATUS_LABELS: Record<WechatPublication['status'], string> = {
  running: '处理中', draft: '已保存草稿', awaiting_confirmation: '等待微信确认', published: '已发表', failed: '失败', uncertain: '结果待核实',
}

function isProcessing(item: WechatPublication) {
  return item.status === 'running' || item.status === 'awaiting_confirmation'
}

export default function PublishPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('renderId') || ''
  const mounted = useRef(true)
  const [account, setAccount] = useState<WechatAccount | null>(null)
  const [login, setLogin] = useState<WechatLogin | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [cover, setCover] = useState<MediaAsset | null>(null)
  const [author, setAuthor] = useState('')
  const [digest, setDigest] = useState('')
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [publications, setPublications] = useState<WechatPublication[]>([])
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [confirmation, setConfirmation] = useState<'publish' | 'disconnect' | null>(null)
  const article = record?.results.find((item) => item.platform === 'wechat')
  const processing = publications.some(isProcessing)
  const busy = submitting || uploading || processing
  const selectedUncertain = publications.some((item) => item.renderId === selectedId && item.status === 'uncertain')
  const canPublish = account?.status === 'connected' && !!article && !!cover && !busy && !recordLoading && !selectedUncertain

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError('')
    const results = await Promise.allSettled([api.wechat.account(), api.renders.list(), api.wechat.listPublications()])
    if (!mounted.current) return
    const [accountResult, rendersResult, publicationsResult] = results
    if (accountResult.status === 'fulfilled') setAccount(accountResult.value.account)
    else setAccount(null)
    if (rendersResult.status === 'fulfilled') setRenders(rendersResult.value.renders.filter((item) => item.platforms.includes('wechat')))
    if (publicationsResult.status === 'fulfilled') setPublications(publicationsResult.value.publications)
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') setError(getErrorMessage(failure.reason))
    setRefreshing(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [refresh])

  useEffect(() => {
    if (!selectedId && renders.length) setSearchParams({ renderId: renders[0].id }, { replace: true })
  }, [selectedId, renders, setSearchParams])

  useEffect(() => {
    let cancelled = false
    setRecord(null)
    setCover(null)
    setDigest('')
    setAuthor('')
    if (!selectedId) return
    setRecordLoading(true)
    void (async () => {
      try {
        const { render } = await api.renders.get(selectedId)
        const [contentResult, mediaResult] = await Promise.all([api.contents.get(render.contentId), api.media.list()])
        if (cancelled) return
        if (!render.results.some((item) => item.platform === 'wechat')) throw new Error('这条渲染记录不包含公众号排版，请先在渲染工作台生成。')
        setRecord(render)
        const wechat = render.results.find((item) => item.platform === 'wechat')!
        setAuthor(Array.from(wechat.authorName || render.options.authorName || '').slice(0, 8).join(''))
        setDigest(Array.from(wechat.meta.summary || contentResult.content.excerpt).slice(0, 120).join(''))
        const coverImage = contentResult.content.coverImage
        setCover(mediaResult.media.find((item) => item.kind === 'image' && !!coverImage && absoluteUrl(item.url) === absoluteUrl(coverImage)) || null)
      } catch (cause) {
        if (!cancelled) setError(getErrorMessage(cause))
      } finally {
        if (!cancelled) setRecordLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedId])

  useEffect(() => {
    if (!login || !['waiting', 'scanned'].includes(login.status)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const { login: next } = await api.wechat.loginStatus(login.id)
        if (cancelled) return
        setLoginError('')
        if (next.status === 'connected') {
          const result = await api.wechat.account()
          if (cancelled) return
          setLogin(next)
          setAccount(result.account)
          toast.success('公众号已连接，登录状态已保存')
          setLoginOpen(false)
          return
        }
        setLogin(next)
        if (next.status !== 'waiting' && next.status !== 'scanned') return
      } catch (cause) {
        if (cancelled) return
        setLoginError(getErrorMessage(cause))
      }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [login?.id, login?.status])

  const pendingIds = publications.filter(isProcessing).map((item) => item.id).join(',')
  useEffect(() => {
    if (!pendingIds) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const results = await Promise.allSettled(pendingIds.split(',').map((id) => api.wechat.getPublication(id)))
      if (cancelled) return
      const updates = results.flatMap((result) => result.status === 'fulfilled' ? [result.value.publication] : [])
      setPublications((current) => current.map((item) => updates.find((update) => update.id === item.id) || item))
      const failure = results.find((result) => result.status === 'rejected')
      setPollError(failure?.status === 'rejected' ? `${getErrorMessage(failure.reason)}。正在重试查询，请勿重复提交。` : '')
      if (!cancelled && (failure || updates.some(isProcessing))) timer = setTimeout(poll, 3000)
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [pendingIds])

  async function startLogin() {
    setLoginOpen(true)
    setLoginBusy(true)
    setLoginError('')
    setLogin(null)
    try {
      const result = await api.wechat.startLogin()
      if (mounted.current) setLogin(result.login)
    } catch (cause) {
      if (mounted.current) setLoginError(getErrorMessage(cause))
    } finally {
      if (mounted.current) setLoginBusy(false)
    }
  }

  async function uploadCover(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setError('封面请使用 10 MB 以内的 JPG 或 PNG 图片。')
      return
    }
    setUploading(true)
    setError('')
    try {
      const result = await api.media.upload(file)
      if (mounted.current) setCover(result.media)
    } catch (cause) {
      if (mounted.current) setError(getErrorMessage(cause))
    } finally {
      if (mounted.current) setUploading(false)
    }
  }

  async function publish(mode: 'draft' | 'publish') {
    if (!canPublish || !cover || !record) return
    setSubmitting(true)
    setError('')
    try {
      const result = await api.wechat.publish({ renderId: record.id, mode, coverMediaId: cover.id, author: author.trim(), digest: digest.trim() })
      if (!mounted.current) return
      setPublications((current) => [result.publication, ...current.filter((item) => item.id !== result.publication.id)])
      setConfirmation(null)
    } catch (cause) {
      if (mounted.current) { setConfirmation(null); setError(getErrorMessage(cause)) }
      // Recover a job accepted before a lost HTTP response, instead of submitting it again.
      try {
        const result = await api.wechat.listPublications()
        if (mounted.current) setPublications(result.publications)
      } catch { /* The original submission error remains visible. */ }
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  async function disconnect() {
    setSubmitting(true)
    setError('')
    try {
      await api.wechat.disconnect()
      if (!mounted.current) return
      setAccount({ status: 'disconnected', name: null, checkedAt: null })
      setLogin(null)
      setConfirmation(null)
      toast.success('已断开公众号连接')
    } catch (cause) {
      if (mounted.current) { setConfirmation(null); setError(getErrorMessage(cause)) }
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  return (
    <div className="publish-page">
      <header className="publish-heading">
        <div><span className="publish-eyebrow"><Send size={14} /> 发布中心</span><h1>把内容发布到公众号</h1><p>连接公众号，选好排版与封面，一键保存草稿或正式发表。</p></div>
        <button type="button" className="btn" onClick={() => void refresh()} disabled={refreshing || submitting}><RefreshCw size={15} className={refreshing ? 'spin' : undefined} />刷新状态</button>
      </header>

      {error ? <div className="publish-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭提示</button></div> : null}

      <section className="publish-account" aria-labelledby="wechat-account-title">
        <span className="publish-account-icon"><MessageCircle size={25} /></span>
        <div className="publish-account-copy"><h2 id="wechat-account-title">{account?.status === 'connected' ? account.name || '已连接公众号' : '微信公众号'}</h2><p>{refreshing && !account ? '正在检查连接状态…' : account?.status === 'connected' ? '登录状态已保存，下次访问自动复用；微信会话失效时需要重新扫码。' : account?.status === 'expired' ? '登录状态已失效，请重新扫码连接。' : '使用公众号管理员微信扫码登录，在手机上选择要连接的公众号。'}</p>{account?.checkedAt ? <small>最近检查：{formatDateTime(account.checkedAt)}</small> : null}</div>
        <span className={`publish-status ${account?.status === 'connected' ? 'is-success' : ''}`}>{account?.status === 'connected' ? <><CheckCircle2 size={13} />已连接</> : account?.status === 'expired' ? '已过期' : '未连接'}</span>
        <div className="publish-account-actions">
          {account?.status === 'connected' ? <button type="button" className="btn btn-sm" onClick={() => setConfirmation('disconnect')} disabled={busy || loginBusy}><LogOut size={14} />断开连接</button> : <button type="button" className="btn btn-primary" onClick={() => void startLogin()} disabled={busy || loginBusy || refreshing}><QrCode size={16} />扫码连接</button>}
          {login && ['waiting', 'scanned'].includes(login.status) ? <button type="button" className="btn btn-sm" onClick={() => setLoginOpen(true)}>查看登录二维码</button> : null}
        </div>
      </section>

      <div className="publish-compose-grid">
        <section className="publish-panel" aria-labelledby="publish-compose-title">
          <div className="publish-section-head"><div><h2 id="publish-compose-title">准备发布</h2><p>使用渲染工作台中已保存的公众号排版。</p></div></div>
          {refreshing && !renders.length ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在加载渲染记录…</p> : !renders.length && !selectedId ? <div className="publish-empty"><Sparkles size={26} /><p>先生成一篇公众号排版</p><button type="button" className="btn btn-primary" onClick={() => navigate('/render')}>去渲染内容<ArrowRight size={15} /></button></div> : <>
            <label className="publish-field">选择内容<select className="input" value={selectedId} disabled={submitting || uploading} onChange={(event) => { setError(''); setSearchParams({ renderId: event.target.value }) }}><option value="" disabled>选择公众号渲染记录</option>{selectedId && !renders.some((item) => item.id === selectedId) ? <option value={selectedId}>指定的渲染记录</option> : null}{renders.map((item) => <option key={item.id} value={item.id}>{item.contentTitle} · {formatDateTime(item.createdAt)}</option>)}</select></label>
            {recordLoading ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在读取排版…</p> : article ? <>
              <div className="publish-article-title"><FileText size={16} /><strong>{article.title}</strong><button type="button" className="btn btn-sm" onClick={() => navigate(`/render?renderId=${encodeURIComponent(selectedId)}`)}>检查排版<ArrowRight size={13} /></button></div>
              <div className="publish-cover-field"><label className="publish-field">封面图片<span className="publish-muted">使用内容封面，或上传 JPG / PNG，建议比例 2.35:1。</span><input type="file" accept="image/jpeg,image/png" onChange={(event) => void uploadCover(event)} disabled={busy} aria-label="上传公众号封面" /></label>{cover ? <img className="publish-cover-preview" src={absoluteUrl(cover.url)} alt="待发布的公众号封面" /> : <div className="publish-cover-empty"><ImagePlus size={23} /><span>请选择封面</span></div>}</div>
              {uploading ? <p className="publish-muted" role="status"><LoaderCircle size={14} className="spin" />正在上传封面…</p> : null}
              <label className="publish-field">作者（选填）<input className="input" value={author} maxLength={8} disabled={submitting} placeholder="最多 8 个字" onChange={(event) => setAuthor(event.target.value)} /></label>
              <label className="publish-field">摘要（选填）<textarea className="input" rows={3} maxLength={120} value={digest} disabled={submitting} placeholder="简短介绍文章内容" onChange={(event) => setDigest(event.target.value)} /><small>{digest.length} / 120</small></label>
              {article.warnings.length ? <div className="publish-warning"><strong>排版提醒</strong><ul>{article.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}
              {selectedUncertain ? <p className="publish-warning">这篇内容有结果待核实的提交，请先到公众号后台检查，避免重复发表。</p> : null}
              <div className="publish-submit-actions"><button type="button" className="btn" disabled={!canPublish} onClick={() => void publish('draft')}><FileText size={16} />保存到草稿箱</button><button type="button" className="btn btn-primary" disabled={!canPublish} onClick={() => setConfirmation('publish')}>{submitting || processing ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}正式发表</button></div>
              <p className="publish-form-hint">{account?.status !== 'connected' ? '请先扫码连接公众号。' : !cover ? '请选择封面后提交。' : processing ? '任务正在处理，请在下方查看进度并完成微信验证。' : '正文图片将自动上传到微信。正式发表时，微信可能要求管理员再次扫码确认。'}</p>
            </> : <p className="publish-muted">未能加载公众号排版，请重新选择内容或返回渲染工作台。</p>}
          </>}
        </section>
        <aside className="publish-panel publish-preview-panel" aria-label="公众号排版预览"><div className="publish-section-head"><div><h2>发布预览</h2><p>以公众号实际展示和审核结果为准。</p></div></div>{article ? <><h3>{article.title}</h3><iframe title="待发布的公众号正文" sandbox="" srcDoc={`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;padding:18px;font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${article.html}</body></html>`} /></> : <div className="publish-empty"><FileText size={28} /><p>选择内容后预览公众号排版</p></div>}</aside>
      </div>

      <section className="publish-panel publish-history" aria-labelledby="publish-history-title"><div className="publish-section-head"><div><h2 id="publish-history-title">发布记录</h2><p>草稿与正式发表分别记录，处理中的任务会自动更新。</p></div><a href="https://mp.weixin.qq.com/" className="btn btn-sm" target="_blank" rel="noreferrer">公众号后台<ExternalLink size={13} /></a></div>
        {pollError ? <p className="publish-warning" role="alert">{pollError}</p> : null}
        {!publications.length ? <div className="publish-empty"><Send size={23} /><p>还没有发布记录</p></div> : <div className="publish-history-list">{publications.map((item) => <article className="publish-history-item" key={item.id}><div className="publish-history-summary"><div><h3>{item.title}</h3><small>{item.mode === 'draft' ? '保存草稿' : '正式发表'} · {formatDateTime(item.createdAt)}</small></div><span className={`publish-status ${item.status === 'published' || item.status === 'draft' ? 'is-success' : item.status === 'failed' ? 'is-error' : item.status === 'uncertain' ? 'is-warning' : ''}`}>{isProcessing(item) ? <LoaderCircle size={13} className="spin" /> : null}{STATUS_LABELS[item.status]}</span></div><p className={item.status === 'failed' ? 'publish-failure-message' : ''}>{item.message}</p>{item.status === 'awaiting_confirmation' && item.qrCode ? <div className="publish-confirm-qr"><img src={item.qrCode} alt="请使用公众号管理员微信扫描此二维码确认发表" /><span>请使用公众号管理员微信扫码，并在手机上确认。验证完成后会继续处理，无需重复提交。</span></div> : null}{item.status === 'uncertain' ? <p className="publish-warning">请核对公众号后台的草稿箱与发表记录，确认结果后再操作。系统不会自动重试发表。</p> : null}{item.url && /^https:\/\/mp\.weixin\.qq\.com\//.test(item.url) ? <a href={item.url} target="_blank" rel="noreferrer" className="btn btn-sm">{item.status === 'published' ? '查看文章' : '打开公众号后台'}<ExternalLink size={13} /></a> : null}</article>)}</div>}
      </section>

      <p className="publish-bottom-note"><ShieldCheck size={14} />通过微信官方页面扫码，不需要提供公众号密码。其他平台仍可在渲染工作台预览、下载后发布。</p>

      <Modal open={loginOpen} onClose={() => setLoginOpen(false)} title="连接微信公众号" subtitle="使用公众号管理员微信扫一扫，并在手机上选择公众号" size="compact"><div className="publish-login" aria-live="polite">{loginBusy ? <><LoaderCircle size={30} className="spin" /><p>正在获取微信登录二维码…</p></> : login ? <>{login.qrCode && ['waiting', 'scanned'].includes(login.status) ? <img className="publish-login-qr" src={login.qrCode} alt="微信公众号登录二维码，请使用管理员微信扫码" /> : <QrCode size={35} />}<p>{login.message}</p>{['waiting', 'scanned'].includes(login.status) ? <small>二维码有效期至 {formatDateTime(login.expiresAt)}，请在手机上完成确认。</small> : <button type="button" className="btn btn-primary" onClick={() => void startLogin()}><RefreshCw size={15} />重新获取二维码</button>}</> : null}{loginError ? <p className="publish-failure-message" role="alert">{loginError}</p> : null}{!loginBusy && !login ? <button type="button" className="btn btn-primary" onClick={() => void startLogin()}>重试连接</button> : null}<small>关闭窗口后可继续在本页查看登录状态。</small></div></Modal>
      <ConfirmDialog open={confirmation === 'publish'} title="正式发表到微信公众号？" description={<><strong>{article?.title}</strong><p>将发表至「{account?.name || '已连接公众号'}」，内容可能对外公开。若微信要求安全验证，请使用管理员微信扫码确认。</p></>} confirmLabel="确认正式发表" tone="primary" loading={submitting} onConfirm={() => publish('publish')} onClose={() => setConfirmation(null)} />
      <ConfirmDialog open={confirmation === 'disconnect'} title="断开公众号连接？" description="将删除本系统保存的微信登录状态。下次发布需要重新扫码，已保存的草稿和已发表文章不会受影响。" confirmLabel="断开连接" loading={submitting} onConfirm={disconnect} onClose={() => setConfirmation(null)} />
    </div>
  )
}
