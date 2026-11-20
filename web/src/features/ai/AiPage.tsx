import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Bot, FileText, Film, LoaderCircle, MessageSquarePlus, Paperclip, Send, Settings2, ShieldCheck, Sparkles, Trash2, Wrench, X } from 'lucide-react'
import { toast } from 'sonner'
import type { AiMessage, AiMessageAttachment, AiRoutingInfo, AiSession, AiSessionDetail, AiSettings } from '@shared/types'
import { absoluteUrl, api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import ConfirmDialog from '@/components/ConfirmDialog'
import { routeReasonLabel } from './ai-labels'
import './ai.css'

const DOCUMENT_EXTENSIONS = ['txt', 'md', 'markdown', 'json', 'csv', 'html', 'xml', 'yml', 'yaml']
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const ATTACHMENT_ACCEPT = ['image/*', 'video/*', ...DOCUMENT_EXTENSIONS.map(ext => `.${ext}`)].join(',')

const QUICK_PROMPTS = [
  '写一篇关于「用 AI 提升内容创作效率」的文章，保存到内容库，并生成公众号和知乎排版。',
  '根据我上传的文档写一篇文章，把我上传的图片插入正文，并生成公众号排版。',
  '列出我最近的内容，挑一篇最新的，生成少数派排版并保存为草稿。',
  '用我上传的视频新建一个视频内容，并把文案补充好。',
]

// 手机 / 平板等触屏输入法里 Enter 通常是换行，只有精确指针（鼠标、触控板）才用 Enter 发送。
const ENTER_SENDS = typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

function resultPreview(value: unknown): string {
  if (value === undefined) return ''
  try {
    const text = JSON.stringify(value, null, 2)
    return text.length > 4000 ? `${text.slice(0, 4000)}\n…（已截断）` : text
  } catch { return String(value) }
}

function ToolTrace({ message }: { message: AiMessage }) {
  if (message.role !== 'tool') return null
  return (
    <details className="ai-tool-trace">
      <summary><Wrench size={13} />{message.toolName || '工具调用'}</summary>
      <div className="ai-tool-body">
        {message.toolArguments !== undefined ? <><strong>参数</strong><pre>{resultPreview(message.toolArguments)}</pre></> : null}
        <strong>结果</strong>
        <pre>{resultPreview(message.toolResult)}</pre>
      </div>
    </details>
  )
}

export default function AiPage() {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [sessions, setSessions] = useState<AiSession[]>([])
  const [activeId, setActiveId] = useState('')
  const [session, setSession] = useState<AiSessionDetail | null>(null)
  const [loadingSession, setLoadingSession] = useState(false)
  const [sending, setSending] = useState(false)
  const [lastRouting, setLastRouting] = useState<AiRoutingInfo | null>(null)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AiMessageAttachment[]>([])
  const [uploadingAttachments, setUploadingAttachments] = useState(0)
  const [error, setError] = useState('')
  const [deleteSession, setDeleteSession] = useState<AiSession | null>(null)
  const [deleting, setDeleting] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  const loadSettings = useCallback(async () => {
    try {
      const result = await api.ai.settings()
      setSettings(result.settings)
    } catch (cause) { setError(getErrorMessage(cause, '读取大模型配置失败')) }
  }, [])

  const loadSessions = useCallback(async () => {
    try {
      const result = await api.ai.listSessions()
      setSessions(result.sessions)
      if (!activeId && result.sessions[0]) setActiveId(result.sessions[0].id)
    } catch (cause) { setError(getErrorMessage(cause, '读取会话失败')) }
  }, [activeId])

  useEffect(() => { void loadSettings(); void loadSessions() }, [loadSettings, loadSessions])

  useEffect(() => {
    if (!activeId) { setSession(null); return }
    let cancelled = false
    setLoadingSession(true); setError('')
    void api.ai.getSession(activeId)
      .then(result => { if (!cancelled) setSession(result.session) })
      .catch(cause => { if (!cancelled) setError(getErrorMessage(cause, '读取会话失败')) })
      .finally(() => { if (!cancelled) setLoadingSession(false) })
    return () => { cancelled = true }
  }, [activeId])

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [session?.messages.length, sending])

  async function newSession() {
    try {
      const result = await api.ai.createSession()
      setSessions(current => [result.session, ...current])
      setActiveId(result.session.id)
      setSession({ ...result.session, messages: [] })
      setError('')
    } catch (cause) { setError(getErrorMessage(cause, '创建会话失败')) }
  }

  async function removeSession() {
    if (!deleteSession) return
    setDeleting(true)
    try {
      await api.ai.deleteSession(deleteSession.id)
      setSessions(current => current.filter(item => item.id !== deleteSession.id))
      if (activeId === deleteSession.id) {
        const next = sessions.find(item => item.id !== deleteSession.id)
        setActiveId(next?.id || '')
        setSession(null)
      }
      setDeleteSession(null)
      toast.success('会话已删除')
    } catch (cause) { setError(getErrorMessage(cause, '删除会话失败')) }
    finally { setDeleting(false) }
  }

  function removeAttachment(index: number) {
    setAttachments(current => current.filter((_item, i) => i !== index))
  }

  function pushAttachment(attachment: AiMessageAttachment) {
    setAttachments(current => [...current, attachment])
  }

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length) return
    for (const file of files) {
      if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
        const limit = file.type.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES
        const label = file.type.startsWith('image/') ? '图片' : '视频'
        if (file.size > limit) { toast.error(`${label}「${file.name}」超过大小限制，请压缩后再试`); continue }
        setUploadingAttachments(current => current + 1)
        try {
          const { media } = await api.media.upload(file)
          pushAttachment({ kind: media.kind, name: media.originalName || media.filename, mimeType: media.mimeType, size: media.size, mediaId: media.id, url: media.url, width: media.width ?? null, height: media.height ?? null, duration: media.duration ?? null })
        } catch (cause) {
          toast.error(getErrorMessage(cause, `上传「${file.name}」失败`))
        } finally {
          setUploadingAttachments(current => Math.max(0, current - 1))
        }
        continue
      }
      const extension = file.name.split('.').pop?.()?.toLowerCase() ?? ''
      if (!DOCUMENT_EXTENSIONS.includes(extension)) { toast.error(`暂不支持「${file.name}」：图片和视频直接上传，文档目前仅支持纯文本类（txt/md/json/csv/html 等）`); continue }
      if (file.size > MAX_DOCUMENT_BYTES) { toast.error(`文档「${file.name}」超过 2 MB，请拆分后再上传`); continue }
      try {
        const text = await file.text()
        pushAttachment({ kind: 'document', name: file.name, mimeType: file.type || `text/${extension === 'md' ? 'markdown' : 'plain'}`, size: file.size, text })
      } catch {
        toast.error(`读取文档「${file.name}」失败`)
      }
    }
  }

  async function send() {
    const text = input.trim()
    const mediaIds = attachments.filter(item => item.mediaId).map(item => item.mediaId!) 
    const documents = attachments.filter(item => item.kind === 'document').map(item => ({ name: item.name, mimeType: item.mimeType, size: item.size, text: item.text }))
    if ((!text && !mediaIds.length && !documents.length) || sending || uploadingAttachments) return
    if (!settings?.configured) { toast.info('请先在设置中配置大模型'); navigate('/settings?tab=ai'); return }
    let target = activeId
    setError(''); setSending(true); setInput('')
    const optimisticAttachments = attachments.length ? attachments : undefined
    const optimisticContent = text || `（消息包含 ${attachments.length} 个附件）`
    setAttachments([])
    try {
      if (!target) {
        const created = await api.ai.createSession((text || optimisticAttachments?.[0]?.name || '').slice(0, 36))
        target = created.session.id
        setActiveId(target)
        setSessions(current => [created.session, ...current])
      }
      const optimistic: AiMessage = { id: `local-${Date.now()}`, role: 'user', content: optimisticContent, createdAt: new Date().toISOString(), attachments: optimisticAttachments }
      setSession(current => current ? { ...current, messages: [...current.messages, optimistic] } : current)
      const result = await api.ai.sendMessage(target, { message: text, ...(mediaIds.length ? { mediaIds } : {}), ...(documents.length ? { documents } : {}) })
      setSession(result.session)
      if (result.routing) setLastRouting(result.routing)
      setSessions(current => current.map(item => item.id === result.session.id ? { ...item, title: result.session.title, updatedAt: result.session.updatedAt } : item))
    } catch (cause) {
      setError(getErrorMessage(cause, 'AI 请求失败'))
      // Keep the composed attachments so the user can retry without re-uploading.
      if (optimisticAttachments) setAttachments(optimisticAttachments)
      if (target) {
        try {
          const result = await api.ai.getSession(target)
          setSession(result.session)
        } catch { /* keep the optimistic message */ }
      }
    } finally { setSending(false) }
  }

  const configured = settings?.configured === true
  const messages = session?.messages || []

  return (
    <div className="ai-page">
      <aside className="ai-sidebar" aria-label="AI 会话">
        <div className="ai-sidebar-head">
          <div><span className="ai-eyebrow"><Sparkles size={13} />AI 创作</span><h1>创作助手</h1></div>
          <button type="button" className="btn btn-sm" onClick={() => void newSession()} aria-label="新建会话"><MessageSquarePlus size={16} /></button>
        </div>
        <Link to="/settings?tab=ai" className={`ai-settings-chip ${configured ? 'is-ready' : ''}`}>
          <Settings2 size={15} />
          <span><strong>{configured ? settings?.label || settings?.model || '已配置模型' : '配置大模型'}</strong><small>{configured ? `${settings?.model ?? ''} · ${settings?.keys ?? 1} 个 Key${settings?.fallback ? ' · 自动回退' : ''}` : '前往设置配置接口和 Key'}</small></span>
          <Settings2 size={13} />
        </Link>
        <div className="ai-session-list">
          {sessions.length ? sessions.map(item => (
            <div key={item.id} className={`ai-session-item ${item.id === activeId ? 'is-active' : ''}`}>
              <button type="button" className="ai-session-open" onClick={() => setActiveId(item.id)}>
                <strong>{item.title}</strong>
                <small>{formatDateTime(item.updatedAt)}</small>
              </button>
              <button type="button" className="ai-session-delete" aria-label={`删除会话 ${item.title}`} onClick={() => setDeleteSession(item)}><Trash2 size={13} /></button>
            </div>
          )) : <div className="ai-empty-sessions"><Bot size={24} /><p>还没有会话</p><small>点击右上角 + 开始</small></div>}
        </div>
        <p className="ai-sidebar-note">AI 可以读取你的内容库、素材、渲染和发布记录，并在你明确要求时调用发布工具。</p>
      </aside>

      <section className="ai-main" aria-label="对话">
        <header className="ai-main-head">
          <div><h2 title={session?.title || '新的 AI 会话'}>{session?.title || '新的 AI 会话'}</h2><p>{configured ? `${settings?.label ? `${settings.label} · ` : ''}模型：${settings?.model}` : '尚未配置大模型'}</p></div>
          <Link className="btn btn-sm" to="/settings?tab=ai" aria-label="设置"><Settings2 size={14} /><span className="ai-btn-label">设置</span></Link>
        </header>
        {lastRouting ? (
          <div className={`ai-route-note ${lastRouting.fallback ? 'is-fallback' : ''}`}>
            <ShieldCheck size={12} />
            <span>本次请求：{lastRouting.providerLabel} · {lastRouting.model} · Key {lastRouting.keyLabel}（{lastRouting.keyMasked}）{lastRouting.fallback ? ` · 已自动切换（${routeReasonLabel(lastRouting.reason)}）` : ''}</span>
          </div>
        ) : null}

        {!configured ? (
          <div className="ai-config-empty">
            <Bot size={40} />
            <h3>先连接一个大模型</h3>
            <p>填写 OpenAI 兼容的接口地址、模型名称和 API Key。配置只保存在当前账号，API Key 加密存储。</p>
            <Link className="btn btn-primary" to="/settings?tab=ai"><Settings2 size={15} />前往设置配置</Link>
          </div>
        ) : (
          <>
            <div className="ai-messages" ref={scrollRef}>
              {loadingSession ? <div className="ai-loading"><LoaderCircle size={18} className="spin" />正在读取会话…</div> : null}
              {!messages.length && !loadingSession ? (
                <div className="ai-welcome">
                  <span className="ai-welcome-icon"><Sparkles size={24} /></span>
                  <h3>我可以帮你从灵感到发布</h3>
                  <p>写文章、改内容、生成多平台排版、保存平台草稿、正式发布，或者批量处理多篇内容。</p>
                  <div className="ai-quick-prompts">
                    {QUICK_PROMPTS.map(prompt => <button key={prompt} type="button" onClick={() => setInput(prompt)}>{prompt}</button>)}
                  </div>
                </div>
              ) : null}
              {messages.map(message => message.role === 'tool' ? <ToolTrace key={message.id} message={message} /> : message.role === 'user' ? (
                <div key={message.id} className="ai-message is-user"><div className="ai-bubble">{message.attachments?.length ? <div className="ai-attachments">{message.attachments.map((attachment, index) => attachment.kind === 'image' && attachment.url ? <figure key={`${attachment.name}-${index}`} className="ai-attachment is-image"><img src={absoluteUrl(attachment.url)} alt={attachment.name} /><figcaption>{attachment.name}</figcaption></figure> : <span key={`${attachment.name}-${index}`} className="ai-attachment">{attachment.kind === 'video' ? <Film size={12} /> : <FileText size={12} />}{attachment.name}</span>)}</div> : null}{message.content ? <p>{message.content}</p> : null}</div><small>{formatDateTime(message.createdAt)}</small></div>
              ) : (
                <div key={message.id} className="ai-message is-assistant">
                  <span className="ai-avatar"><Bot size={16} /></span>
                  <div className="ai-assistant-body">
                    {message.content ? <div className="ai-bubble">{message.content}</div> : message.toolCalls?.length ? null : <div className="ai-bubble">（没有返回文字内容）</div>}
                    {message.toolCalls?.length ? <div className="ai-tool-calls">{message.toolCalls.map(call => <span key={call.id}><Wrench size={11} />{call.function.name}</span>)}</div> : null}
                    <small>{formatDateTime(message.createdAt)}</small>
                  </div>
                </div>
              ))}
              {sending ? <div className="ai-message is-assistant"><span className="ai-avatar"><Bot size={16} /></span><div className="ai-bubble ai-thinking"><LoaderCircle size={14} className="spin" />AI 正在思考并执行工具，请稍候…</div></div> : null}
            </div>
            {error ? <div className="ai-error" role="alert">{error}<button type="button" className="btn btn-sm" onClick={() => setError('')}>关闭</button></div> : null}
            <div className="ai-composer">
              {attachments.length || uploadingAttachments ? (
                <div className="ai-composer-attachments" aria-label="待发送附件">
                  {attachments.map((attachment, index) => (
                    <span key={`${attachment.name}-${index}`} className="ai-attachment-chip">
                      {attachment.kind === 'image' && attachment.url ? <img src={absoluteUrl(attachment.url)} alt="" /> : attachment.kind === 'video' ? <Film size={12} /> : <FileText size={12} />}
                      <span title={attachment.name}>{attachment.name}</span>
                      <button type="button" aria-label={`移除附件 ${attachment.name}`} disabled={sending} onClick={() => removeAttachment(index)}><X size={11} /></button>
                    </span>
                  ))}
                  {uploadingAttachments ? <span className="ai-attachment-chip is-uploading"><LoaderCircle size={12} className="spin" />正在上传…</span> : null}
                </div>
              ) : null}
              <div className="ai-composer-row">
                <label className="ai-attach-button" title="上传图片、视频或文本文档">
                  <Paperclip size={16} />
                  <input type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={event => void handleFiles(event)} disabled={sending} aria-label="上传附件" />
                </label>
                <textarea
                  className="input"
                  value={input}
                  rows={3}
                  maxLength={20000}
                  placeholder="告诉 AI 你想写什么、发到哪里；可点击回形针上传图片、视频或文本文档作为素材…"
                  onChange={event => setInput(event.target.value)}
                  onKeyDown={event => { if (ENTER_SENDS && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }}
                  disabled={sending}
                />
              </div>
              <div className="ai-composer-foot">
                <span>{input.length} / 20000 · 图片视频将进入素材库，文档全文随消息发送 · Enter 发送，Shift + Enter 换行</span>
                <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={sending || uploadingAttachments > 0 || (!input.trim() && !attachments.length)}>{sending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}{sending ? '处理中…' : '发送'}</button>
              </div>
            </div>
          </>
        )}
      </section>

      <ConfirmDialog open={!!deleteSession} title="删除这个会话？" description={<><strong>{deleteSession?.title}</strong><p>会话消息会从系统中删除，不影响已创建的文章、渲染和发布记录。</p></>} confirmLabel="删除会话" loading={deleting} onConfirm={removeSession} onClose={() => setDeleteSession(null)} />
    </div>
  )
}
