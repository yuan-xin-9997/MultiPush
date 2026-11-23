import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, ExternalLink, FileText, Images, KeyRound, LoaderCircle, LogOut, RefreshCw, Send, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { RenderListItem, RenderRecord, WechatpicAccount, WechatpicPublication } from '@shared/types'
import { absoluteUrl, api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import Modal from '@/components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'

const labels: Record<WechatpicPublication['status'], string> = {
  running: '处理中',
  draft: '草稿已创建，待手动发表',
  published: '已发表',
  failed: '失败',
  uncertain: '结果待核实',
}
const APP_ID_KEY = 'multipush:wechatpic-appid'

export default function WechatpicPublishPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('renderId') || ''
  const mounted = useRef(true)
  const [account, setAccount] = useState<WechatpicAccount | null>(null)
  const [renders, setRenders] = useState<RenderListItem[]>([])
  const [record, setRecord] = useState<RenderRecord | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [publications, setPublications] = useState<WechatpicPublication[]>([])
  const [appId, setAppId] = useState(() => { try { return localStorage.getItem(APP_ID_KEY) || '' } catch { return '' } })
  const [appSecret, setAppSecret] = useState('')
  const [connectOpen, setConnectOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<'publish' | 'disconnect' | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WechatpicPublication | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const sticker = record?.results.find((item) => item.platform === 'wechatpic')
  const images = sticker?.assets.filter((asset) => asset.kind === 'image') ?? []
  const processing = publications.some((item) => item.status === 'running')
  const busy = submitting || processing || connecting
  const uncertain = publications.some((item) => item.renderId === selectedId && item.status === 'uncertain')
  const canPublish = account?.status === 'connected' && !!sticker && images.length > 0 && !busy && !recordLoading && !uncertain

  const refresh = useCallback(async (force = false) => {
    setRefreshing(true)
    setError('')
    const results = await Promise.allSettled([api.wechatpic.account(force ? { refresh: true } : undefined), api.renders.list(), api.wechatpic.listPublications()])
    if (!mounted.current) return
    const [accountResult, rendersResult, publicationsResult] = results
    if (accountResult.status === 'fulfilled') {
      setAccount(accountResult.value.account)
      if (accountResult.value.account.appId) { setAppId(accountResult.value.account.appId); try { localStorage.setItem(APP_ID_KEY, accountResult.value.account.appId) } catch { /* ignore */ } }
    }
    if (rendersResult.status === 'fulfilled') setRenders(rendersResult.value.renders.filter((item) => item.platforms.includes('wechatpic')))
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
    if (!selectedId && renders.length) setParams({ platform: 'wechatpic', renderId: renders[0].id }, { replace: true })
  }, [selectedId, renders, setParams])

  useEffect(() => {
    let cancelled = false
    setRecord(null)
    if (!selectedId) return
    setRecordLoading(true)
    void (async () => {
      try {
        const { render } = await api.renders.get(selectedId)
        if (!render.results.some((item) => item.platform === 'wechatpic')) throw new Error('这份记录没有公众号贴图排版，请先在渲染工作台生成。')
        if (!cancelled) setRecord(render)
      } catch (cause) {
        if (!cancelled) setError(getErrorMessage(cause))
      } finally {
        if (!cancelled) setRecordLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedId])

  useEffect(() => {
    if (!processing) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await api.wechatpic.listPublications()
        if (!cancelled) setPublications(result.publications)
      } catch (cause) {
        if (!cancelled) setError(getErrorMessage(cause))
      }
      if (!cancelled) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processing])

  async function connect() {
    setConnecting(true)
    setConnectError('')
    setError('')
    try {
      const result = await api.wechatpic.connect({ appId: appId.trim(), appSecret: appSecret.trim() })
      if (!mounted.current) return
      setAccount(result.account)
      setConnectOpen(false)
      setAppSecret('')
      try { localStorage.setItem(APP_ID_KEY, result.account.appId || appId.trim()) } catch { /* ignore */ }
      toast.success('公众号已连接，AppSecret 已加密保存')
    } catch (cause) {
      if (mounted.current) setConnectError(getErrorMessage(cause))
    } finally {
      if (mounted.current) setConnecting(false)
    }
  }

  async function publish() {
    if (!record || !canPublish) return
    setSubmitting(true)
    setError('')
    try {
      const result = await api.wechatpic.publish({ renderId: record.id })
      if (!mounted.current) return
      setPublications((current) => [result.publication, ...current.filter((item) => item.id !== result.publication.id)])
      setConfirmation(null)
      toast.success(result.publication.status === 'running' ? '已提交贴图任务，请在下方查看进度' : result.publication.message)
    } catch (cause) {
      if (mounted.current) { setConfirmation(null); setError(getErrorMessage(cause)) }
      // Recover a job accepted before a lost HTTP response instead of resubmitting.
      try {
        const result = await api.wechatpic.listPublications()
        if (mounted.current) setPublications(result.publications)
      } catch { /* The original submission error remains visible. */ }
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  async function disconnect() {
    setSubmitting(true)
    try {
      await api.wechatpic.disconnect()
      if (!mounted.current) return
      setAccount({ status: 'disconnected', name: null, appId: null, checkedAt: null })
      setConfirmation(null)
      setAppSecret('')
      toast.success('已断开公众号连接，已创建的草稿不受影响')
    } catch (cause) {
      if (mounted.current) { setConfirmation(null); setError(getErrorMessage(cause)) }
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  async function deletePublication() {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setError('')
    try {
      const result = await api.wechatpic.deletePublication(deleteTarget.id)
      if (!mounted.current) return
      setPublications((current) => current.filter((item) => item.id !== deleteTarget.id))
      setDeleteTarget(null)
      toast.success(result.remoteDeleted ? '已删除公众号后台贴图草稿和本地发布记录' : '已删除本地发布记录')
    } catch (cause) {
      if (mounted.current) { setError(getErrorMessage(cause)); setDeleteTarget(null) }
    } finally {
      if (mounted.current) setDeleteBusy(false)
    }
  }

  return <div className="publish-page wechatpic-publish-page">
    <header className="publish-heading"><div><span className="publish-eyebrow"><Images size={14} />发布中心 · 公众号贴图</span><h1>把内容保存为公众号贴图草稿</h1><p>通过公众号官方 API 创建图片消息（贴图）草稿；发表这最后一步请在公众号后台手动完成。</p></div><button type="button" className="btn" disabled={refreshing || busy} onClick={() => void refresh(true)}><RefreshCw size={15} className={refreshing ? 'spin' : undefined} />刷新状态</button></header>
    {error ? <div className="publish-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭提示</button></div> : null}
    <section className="publish-account" aria-label="公众号贴图账号">
      <span className="publish-account-icon">贴</span><div className="publish-account-copy"><h2>{account?.status === 'connected' ? account.name || '已连接公众号' : '尚未连接公众号'}</h2><p>{account?.status === 'connected' ? `已连接 ${account.appId || ''}，AppSecret 加密保存在本机服务中。` : account?.status === 'expired' ? '连接已失效，请重新输入 AppID 和 AppSecret。' : '使用公众号 AppID / AppSecret 连接，个人订阅号也可以创建贴图草稿。'}</p>{account?.checkedAt ? <small>最近检查：{formatDateTime(account.checkedAt)}</small> : null}</div>
      <span className={`publish-status ${account?.status === 'connected' ? 'is-success' : ''}`}>{account?.status === 'connected' ? <><CheckCircle2 size={13} />已连接</> : account?.status === 'expired' ? '已过期' : '未连接'}</span>
      <div className="publish-account-actions">{account?.status === 'connected' ? <><button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConnectOpen(true)}>更换连接</button><button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmation('disconnect')}><LogOut size={14} />断开连接</button></> : <button type="button" className="btn btn-primary" disabled={busy || refreshing} onClick={() => setConnectOpen(true)}><KeyRound size={16} />连接公众号</button>}</div>
    </section>
    <div className="publish-compose-grid"><section className="publish-panel">
      <div className="publish-section-head"><div><h2>准备发布</h2><p>使用渲染工作台中已保存的公众号贴图排版。</p></div></div>
      {!renders.length && !selectedId && !refreshing ? <div className="publish-empty"><p>先生成一篇公众号贴图排版</p><button type="button" className="btn btn-primary" onClick={() => navigate('/render')}>去渲染内容<ArrowRight size={14} /></button></div> : <label className="publish-field">选择内容<select className="input" value={selectedId} disabled={busy} onChange={event => { setError(''); setParams({ platform: 'wechatpic', renderId: event.target.value }) }}><option value="" disabled>选择贴图排版</option>{selectedId && !renders.some(item => item.id === selectedId) ? <option value={selectedId}>指定的排版记录</option> : null}{renders.map(item => <option key={item.id} value={item.id}>{item.contentTitle} · {formatDateTime(item.createdAt)}</option>)}</select></label>}
      {recordLoading ? <p className="publish-muted"><LoaderCircle size={15} className="spin" />正在读取排版…</p> : sticker ? <>
        <div className="publish-article-title"><FileText size={16} /><strong>{sticker.title}</strong><button type="button" className="btn btn-sm" onClick={() => navigate(`/render?renderId=${encodeURIComponent(selectedId)}`)}>检查排版<ArrowRight size={13} /></button></div>
        <div className="publish-cover-field">
          <label className="publish-field">贴图图片（{images.length} / 20）<span className="publish-muted">按正文顺序取前 20 张，首张即为封面；单张不超过 10 MB 的 JPG / PNG。</span></label>
          {images.length ? <div className="wechatpic-publish-images">{images.map((asset, index) => <figure key={asset.url}><img src={absoluteUrl(asset.url)} alt="" loading="lazy" /><figcaption>{index === 0 ? '封面' : `第 ${index + 1} 张`}</figcaption></figure>)}</div> : <div className="publish-cover-empty"><Images size={23} /><span>没有可用图片，请先在正文插入图片并重新生成排版</span></div>}
        </div>
        <p className="publish-muted">配文 {Array.from(sticker.captionBody || '').length} 字（图片消息正文仅支持纯文本；标题与话题会一并写入）。</p>
        {sticker.warnings.length ? <div className="publish-warning"><strong>排版提醒</strong><ul>{sticker.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div> : null}
        {uncertain ? <p className="publish-warning">这篇内容有结果待确认的任务，请先在下方处理（核对后删除记录）再提交。</p> : null}
        <div className="publish-submit-actions"><button type="button" className="btn btn-primary" disabled={!canPublish} onClick={() => setConfirmation('publish')}>{submitting || processing ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}保存为贴图草稿</button></div>
        <p className="publish-form-hint" role="status">{account?.status !== 'connected' ? '请先连接公众号（AppID / AppSecret）。' : !images.length ? '贴图至少需要 1 张正文图片。' : busy ? '任务正在处理，请在下方查看进度。' : '草稿创建后，请到公众号后台「草稿箱」检查并手动发表。'}</p>
      </> : null}
    </section><aside className="publish-panel publish-preview-panel"><div className="publish-section-head"><div><h2>贴图预览</h2><p>以公众号实际展示为准。</p></div></div>{sticker ? <><h3>{sticker.title}</h3><iframe title="待发布的公众号贴图" sandbox="" srcDoc={`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;padding:18px;font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}img{display:block;width:100%;height:auto;margin:0 0 3px}p{font-size:15px;line-height:1.85;color:#191919;margin:0 0 12px}</style><body>${sticker.html}</body></html>`} /></> : <div className="publish-empty"><Images size={28} /><p>选择内容后预览贴图排版</p></div>}</aside></div>
    <section className="publish-panel publish-history"><div className="publish-section-head"><div><h2>贴图发布记录</h2><p>贴图只创建草稿，正式发表请在公众号后台手动完成。</p></div><a href="https://mp.weixin.qq.com/" className="btn btn-sm" target="_blank" rel="noreferrer">公众号后台<ExternalLink size={13} /></a></div>
      {!publications.length ? <div className="publish-empty"><Send size={23} /><p>还没有贴图发布记录</p></div> : <div className="publish-history-list">{publications.map(item => <article key={item.id} className="publish-history-item"><div className="publish-history-summary"><div><h3>{item.title}</h3><small>保存草稿 · {formatDateTime(item.createdAt)}</small></div><span className={`publish-status ${item.status === 'draft' ? 'is-success' : item.status === 'failed' ? 'is-error' : item.status === 'uncertain' ? 'is-warning' : ''}`}>{item.status === 'running' ? <LoaderCircle size={13} className="spin" /> : null}{labels[item.status]}</span></div><p className={item.status === 'failed' ? 'publish-failure-message' : ''}>{item.message}</p>{item.status === 'uncertain' ? <p className="publish-warning">请先到公众号后台「草稿箱」核对是否已创建这份贴图草稿；确认后删除本条记录即可继续新的提交，系统不会自动重试。</p> : null}{item.status === 'draft' || item.status === 'failed' ? <button type="button" className="btn btn-sm publish-delete-button" disabled={busy || deleteBusy} onClick={() => setDeleteTarget(item)}><Trash2 size={13} />{item.status === 'failed' ? '删除记录' : '删除草稿'}</button> : null}</article>)}</div>}
    </section>
    <p className="publish-bottom-note"><ShieldCheck size={14} />AppSecret 只加密保存在本机服务，不会返回给浏览器；如提示 IP 白名单错误，请在微信开发者平台「我的业务 → 公众号/服务号 → 基础信息 → 开发密钥 → API IP 白名单」添加本机出口 IP。</p>
    <Modal open={connectOpen} onClose={() => { if (!connecting) setConnectOpen(false) }} title="连接公众号（贴图）" subtitle="微信开发者平台「我的业务 → 公众号/服务号 → 基础信息」中的 AppID 与 AppSecret" size="compact" closeOnBackdrop={!connecting}>
      <div className="wechatpic-connect-form">
        <label className="publish-field">AppID<input className="input" value={appId} maxLength={32} disabled={connecting} autoComplete="off" placeholder="wx…" onChange={event => setAppId(event.target.value)} /></label>
        <label className="publish-field">AppSecret<input className="input" type="password" value={appSecret} maxLength={64} disabled={connecting} autoComplete="off" placeholder="32 位字母或数字" onChange={event => setAppSecret(event.target.value)} /></label>
        <p className="publish-muted"><ExternalLink size={13} /><span>公众平台后台已无「基本配置」：在 <a href="https://developers.weixin.qq.com/platform/" target="_blank" rel="noreferrer">微信开发者平台</a>「我的业务 → 公众号/服务号 → 基础信息」查看 AppID，同一页面「开发密钥」中查看 AppSecret。</span></p>
        <p className="publish-muted"><KeyRound size={13} /><span>需要在「开发密钥 → API IP 白名单」加入本机出口 IP；重置 AppSecret 会使旧连接失效。</span></p>
        {connectError ? <p className="publish-failure-message" role="alert">{connectError}</p> : null}
        <button type="button" className="btn btn-primary" disabled={connecting || !appId.trim() || !appSecret.trim()} onClick={() => void connect()}>{connecting ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}{connecting ? '正在验证连接…' : '连接并验证'}</button>
      </div>
    </Modal>
    <ConfirmDialog open={confirmation === 'publish'} title="创建公众号贴图草稿？" description={<><strong>{sticker?.title}</strong><p>将通过公众号官方 API 上传 {images.length} 张图片并创建图片消息草稿；正式发表需要你在公众号后台手动完成。</p></>} confirmLabel="确认创建草稿" tone="primary" loading={submitting} onConfirm={() => publish()} onClose={() => setConfirmation(null)} />
    <ConfirmDialog open={confirmation === 'disconnect'} title="断开公众号连接？" description="删除系统保存的 AppID 和 AppSecret，下次发布需要重新连接。公众号后台已创建的贴图草稿保持不变。" confirmLabel="断开连接" loading={submitting} onConfirm={disconnect} onClose={() => setConfirmation(null)} />
    <ConfirmDialog open={!!deleteTarget} title={deleteTarget?.status === 'failed' ? '删除贴图发布记录？' : '删除贴图草稿？'} description={<><strong>{deleteTarget?.title}</strong><p>{deleteTarget?.status === 'failed' ? '将清理本系统的失败记录，不会删除公众号上已发表的贴图。' : '将同时删除公众号后台的这份贴图草稿和本系统的发布记录；如果草稿已手动发表或已删除，会自动清理本地记录。删除后无法恢复。'}</p></>} confirmLabel={deleteTarget?.status === 'failed' ? '删除记录' : '删除草稿'} loading={deleteBusy} onConfirm={deletePublication} onClose={() => setDeleteTarget(null)} />
  </div>
}
