import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, Send, Sparkles } from 'lucide-react'
import type { BatchJob, BatchPublishPlatform, ContentSummary, MediaAsset, PlatformId } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import Modal from '@/components/Modal'
import './batch.css'

const RENDER_PLATFORMS: PlatformId[] = ['wechat', 'zhihu', 'weibo', 'toutiao', 'baijiahao', 'douban', 'juejin', 'jianshu', 'sspai', 'blog', 'douyin', 'xiaohongshu']
const PUBLISH_PLATFORMS: Array<{ id: BatchPublishPlatform; label: string }> = [
  { id: 'wechat', label: '微信公众号（仅草稿）' },
  { id: 'zhihu', label: '知乎' },
  { id: 'weibo', label: '微博' },
  { id: 'toutiao', label: '今日头条' },
  { id: 'douban', label: '豆瓣日记' },
  { id: 'juejin', label: '掘金' },
  { id: 'jianshu', label: '简书' },
  { id: 'sspai', label: '少数派' },
  { id: 'blog', label: '个人博客' },
]

const ITEM_LABELS: Record<BatchJob['items'][number]['status'], string> = {
  pending: '等待中', running: '处理中', done: '完成', failed: '失败', skipped: '已跳过',
}

interface BatchDialogProps {
  open: boolean
  mode: 'render' | 'publish' | null
  contents: ContentSummary[]
  onClose: () => void
}

export default function BatchDialog({ open, mode, contents, onClose }: BatchDialogProps) {
  const [platforms, setPlatforms] = useState<PlatformId[]>(['wechat', 'zhihu'])
  const [publishPlatform, setPublishPlatform] = useState<BatchPublishPlatform>('zhihu')
  const [publishMode, setPublishMode] = useState<'draft' | 'publish'>('draft')
  const [coverMediaId, setCoverMediaId] = useState('')
  const [media, setMedia] = useState<MediaAsset[]>([])
  const [authorName, setAuthorName] = useState('')
  const [includeTags, setIncludeTags] = useState(true)
  const [includeToc, setIncludeToc] = useState(false)
  const [job, setJob] = useState<BatchJob | null>(null)
  const [recent, setRecent] = useState<BatchJob[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setJob(null); setError(''); setBusy(false); setCoverMediaId(''); setRecent([])
    setPublishMode('draft')
    void api.media.list().then(result => setMedia(result.media.filter(item => item.kind === 'image'))).catch(() => setMedia([]))
    void api.batch.listJobs().then(result => setRecent(result.jobs.filter(item => item.kind === mode).slice(0, 3))).catch(() => setRecent([]))
  }, [open, mode])

  useEffect(() => {
    if (!publishPlatform) return
    if (publishPlatform === 'wechat') setPublishMode('draft')
  }, [publishPlatform])

  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.batch.getJob(job.id)
        if (!cancelled) setJob(result.job)
      } catch (cause) {
        if (!cancelled) setError(getErrorMessage(cause, '读取批量任务失败'))
      }
    }, 1500)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [job])

  function togglePlatform(value: PlatformId) {
    setPlatforms(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value])
  }

  async function start() {
    setError('')
    if (!contents.length) return
    if (mode === 'render' && !platforms.length) { setError('请至少选择一个渲染平台'); return }
    setBusy(true)
    try {
      if (mode === 'render') {
        const result = await api.batch.render({
          contentIds: contents.map(item => item.id),
          platforms,
          options: { ...(authorName.trim() ? { authorName: authorName.trim() } : {}), includeTags, includeToc },
        })
        setJob(result.job)
      } else {
        const result = await api.batch.publish({
          contentIds: contents.map(item => item.id),
          platform: publishPlatform,
          mode: publishPlatform === 'wechat' ? 'draft' : publishMode,
          ...(coverMediaId ? { coverMediaId } : {}),
          options: { ...(authorName.trim() ? { authorName: authorName.trim() } : {}), includeTags, includeToc },
        })
        setJob(result.job)
      }
    } catch (cause) {
      setError(getErrorMessage(cause, '创建批量任务失败'))
    } finally { setBusy(false) }
  }

  const title = mode === 'render' ? '批量渲染' : '批量发布'
  const close = () => { if (!busy) onClose() }

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      subtitle={`已选择 ${contents.length} 篇内容${mode === 'publish' ? ` · ${PUBLISH_PLATFORMS.find(item => item.id === publishPlatform)?.label}` : ''}`}
      closeOnBackdrop={!busy}
      showClose={!busy}
      footer={job ? (
        <button type="button" className="btn" onClick={onClose} disabled={busy}>关闭</button>
      ) : (
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>取消</button>
          <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={busy || !contents.length}>
            {busy ? <LoaderCircle size={15} className="spin" /> : mode === 'render' ? <Sparkles size={15} /> : <Send size={15} />}
            {busy ? '正在创建…' : mode === 'render' ? '开始批量渲染' : '开始批量发布'}
          </button>
        </>
      )}
    >
      <div className="batch-dialog">
        {!job ? <>
          <div className="batch-selected-list">
            {contents.map(item => <span key={item.id}>{item.title}</span>)}
          </div>
          {mode === 'render' ? (
            <div className="batch-field">
              <span className="batch-label">渲染平台</span>
              <div className="batch-platform-grid">
                {RENDER_PLATFORMS.map(value => {
                  const info = PLATFORMS.find(item => item.id === value)!
                  const active = platforms.includes(value)
                  return (
                    <button key={value} type="button" className={cn('batch-platform', active && 'is-active')} onClick={() => togglePlatform(value)} aria-pressed={active}>
                      <strong>{info.shortName}</strong>
                      <small>{info.highlight}</small>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <>
              <label className="batch-field"><span className="batch-label">发布平台</span>
                <select className="input" value={publishPlatform} onChange={event => setPublishPlatform(event.target.value as BatchPublishPlatform)}>
                  {PUBLISH_PLATFORMS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <label className="batch-field"><span className="batch-label">发布方式</span>
                <select className="input" value={publishMode} onChange={event => setPublishMode(event.target.value as 'draft' | 'publish')} disabled={publishPlatform === 'wechat'}>
                  <option value="draft">保存草稿</option>
                  <option value="publish">正式发布</option>
                </select>
              </label>
              {publishPlatform === 'wechat' ? <label className="batch-field"><span className="batch-label">统一封面</span>
                <select className="input" value={coverMediaId} onChange={event => setCoverMediaId(event.target.value)}>
                  <option value="">使用每篇内容自己的封面（没有封面会失败）</option>
                  {media.map(item => <option key={item.id} value={item.id}>{item.originalName}</option>)}
                </select>
                <small className="batch-hint">公众号批量发布只支持保存草稿；正式发表请在发布管理逐篇完成安全确认。</small>
              </label> : null}
            </>
          )}
          <label className="batch-field"><span className="batch-label">作者名（可选）</span>
            <input className="input" value={authorName} maxLength={100} onChange={event => setAuthorName(event.target.value)} placeholder="默认使用账号昵称" />
          </label>
          <div className="batch-checks">
            <label><input type="checkbox" checked={includeTags} onChange={event => setIncludeTags(event.target.checked)} />包含标签</label>
            <label><input type="checkbox" checked={includeToc} onChange={event => setIncludeToc(event.target.checked)} />包含目录</label>
          </div>
          <p className="batch-hint">批量任务在服务端顺序执行；关闭此窗口后任务仍会继续，可在任务结束后重新打开批量发布查看记录。</p>
          {recent.length ? <div className="batch-recent"><span className="batch-label">最近任务</span>{recent.map(item => <button key={item.id} type="button" onClick={() => setJob(item)}><span>{item.items[0]?.title || '批量任务'}</span><small>{item.done}/{item.total} · {item.message}</small></button>)}</div> : null}
        </> : (
          <div className="batch-progress">
            <div className="batch-progress-head">
              <div><strong>{job.status === 'completed' ? '任务完成' : job.status === 'failed' ? '任务结束' : '任务进行中'}</strong><p>{job.message}</p></div>
              <span className={cn('batch-status', `is-${job.status}`)}>{job.status}</span>
            </div>
            <div className="batch-track"><span style={{ width: `${job.total ? Math.round((job.done / job.total) * 100) : 0}%` }} /></div>
            <small>{job.done} / {job.total}</small>
            <div className="batch-items">
              {job.items.map(item => (
                <div key={item.index} className={cn('batch-item', `is-${item.status}`)}>
                  <div className="batch-item-head"><strong>{item.title}</strong><span>{ITEM_LABELS[item.status]}</span></div>
                  <p>{item.message}</p>
                  <div className="batch-item-actions">
                    {item.renderId ? <a className="btn btn-sm" href={`/render?renderId=${encodeURIComponent(item.renderId)}`} target="_blank" rel="noreferrer">打开排版<ExternalLink size={12} /></a> : null}
                    {item.publicationId && mode === 'publish' ? <a className="btn btn-sm" href={`/publish?platform=${publishPlatform}&renderId=${item.renderId || ''}`} target="_blank" rel="noreferrer">打开发布记录<ExternalLink size={12} /></a> : null}
                    {item.url ? <a className="btn btn-sm" href={item.url} target="_blank" rel="noreferrer">查看结果<ExternalLink size={12} /></a> : null}
                  </div>
                </div>
              ))}
            </div>
            {job.status === 'failed' ? <p className="batch-error">任务已停止，请检查上面失败的条目后重新提交；不要直接重复发布结果待核实的内容。</p> : null}
          </div>
        )}
        {error ? <p className="batch-error" role="alert">{error}</p> : null}
      </div>
    </Modal>
  )
}
