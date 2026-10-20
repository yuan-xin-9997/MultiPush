import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { EditorContent, Node, mergeAttributes, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import TextAlign from '@tiptap/extension-text-align'
import Image from '@tiptap/extension-image'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import Highlight from '@tiptap/extension-highlight'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import CharacterCount from '@tiptap/extension-character-count'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  Bold,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  CloudUpload,
  Code2,
  Copy,
  Eraser,
  FileDown,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  LoaderCircle,
  Minus,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Palette,
  Pilcrow,
  Plus,
  Quote,
  Redo2,
  RotateCcw,
  Strikethrough,
  Table2,
  Trash2,
  Type,
  Underline as UnderlineIcon,
  Undo2,
  Video,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Book, ContentDetail, ContentStatus, RichTextJson } from '@shared/types'
import { api, absoluteUrl } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { exportContentFile, type ExportFormat } from '@/lib/content-io'
import { cn, formatDateTime, safeFilename } from '@/lib/utils'
import ConfirmDialog from '@/components/ConfirmDialog'
import Dropdown from '@/components/Dropdown'
import Logo from '@/components/Logo'
import Modal from '@/components/Modal'
import './editor.css'

const TEXT_COLORS = [
  { label: '默认', value: '#1f2329' },
  { label: '灰色', value: '#8f959e' },
  { label: '红色', value: '#f54a45' },
  { label: '橙色', value: '#ff8f1f' },
  { label: '黄色', value: '#d4a000' },
  { label: '绿色', value: '#00a05c' },
  { label: '蓝色', value: '#3370ff' },
  { label: '紫色', value: '#7b61ff' },
]

const HIGHLIGHT_COLORS = [
  { label: '浅黄', value: '#fff3bf' },
  { label: '浅绿', value: '#d3f9d8' },
  { label: '浅蓝', value: '#d0ebff' },
  { label: '浅粉', value: '#ffdeeb' },
  { label: '浅紫', value: '#e5dbff' },
  { label: '浅橙', value: '#ffe8cc' },
]

const VideoNode = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      src: { default: null },
      poster: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'video[src]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'video',
      mergeAttributes(HTMLAttributes, {
        controls: 'controls',
        style: 'display:block;width:100%;max-width:100%;border-radius:10px;margin:22px 0;background:#000;',
      }),
    ]
  },
})

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'

interface OutlineItem {
  level: number
  text: string
  pos: number
}

function jsonHasContent(value: RichTextJson | null | undefined): boolean {
  if (!value || typeof value !== 'object') return false
  const content = (value as { content?: unknown }).content
  return Array.isArray(content) && content.length > 0
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^(https?:|mailto:|tel:|#)/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function buildOutline(editor: Editor): OutlineItem[] {
  const items: OutlineItem[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const level = Number(node.attrs.level) || 1
      const text = node.textContent.trim()
      if (text && level <= 3) items.push({ level, text, pos })
    }
  })
  return items
}

interface ToolbarButtonProps {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}

function ToolbarButton({ label, active, disabled, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={cn('editor-tool', active && 'is-active')}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export default function EditorPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const editorRef = useRef<Editor | null>(null)

  const [content, setContent] = useState<ContentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [title, setTitle] = useState('')
  const [bookId, setBookId] = useState<string>('')
  const [books, setBooks] = useState<Book[]>([])
  const [coverImage, setCoverImage] = useState<string | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [status, setStatus] = useState<ContentStatus>('draft')
  const [favorite, setFavorite] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [revision, setRevision] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [uploading, setUploading] = useState<{ label: string; percent: number } | null>(null)
  const [coverUploading, setCoverUploading] = useState(false)

  const initializedIdRef = useRef<string | null>(null)
  const initializedContentRef = useRef(false)
  const savingRef = useRef(false)
  const pendingSaveRef = useRef(false)
  const dirtyRef = useRef(false)
  const readyRef = useRef(false)
  const revisionRef = useRef(0)
  const titleRef = useRef(title)
  const bookIdRef = useRef(bookId)
  const coverRef = useRef(coverImage)
  const tagsRef = useRef(tags)
  const statusRef = useRef(status)
  const favoriteRef = useRef(favorite)
  const idRef = useRef(id)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)

  titleRef.current = title
  bookIdRef.current = bookId
  coverRef.current = coverImage
  tagsRef.current = tags
  statusRef.current = status
  favoriteRef.current = favorite
  readyRef.current = ready
  revisionRef.current = revision
  idRef.current = id

  const markDirty = useCallback(() => {
    if (!readyRef.current) return
    dirtyRef.current = true
    setDirty(true)
    setSaveState('unsaved')
    setRevision((value) => value + 1)
  }, [])

  const syncOutline = useCallback((target: Editor) => {
    setOutline(buildOutline(target))
  }, [])

  const uploadFiles = useCallback(
    async (files: File[], kind: 'image' | 'video', position?: number) => {
      const editor = editorRef.current
      if (!editor || files.length === 0) return
      for (const file of files) {
        const valid = kind === 'image' ? file.type.startsWith('image/') : file.type.startsWith('video/')
        if (!valid) continue
        try {
          setUploading({ label: kind === 'image' ? `正在上传 ${file.name}` : `正在上传视频 ${file.name}`, percent: 0 })
          const { media } = await api.media.upload(file, (percent) => setUploading((current) => (current ? { ...current, percent } : current)))
          const activeEditor = editorRef.current
          if (!activeEditor) return
          const node = kind === 'image'
            ? { type: 'image', attrs: { src: media.url, alt: file.name } }
            : { type: 'video', attrs: { src: media.url } }
          if (position !== undefined) {
            try {
              activeEditor.chain().focus().insertContentAt(position, node).run()
            } catch {
              activeEditor.chain().focus().insertContent(node).run()
            }
          } else if (kind === 'image') {
            activeEditor.chain().focus().setImage({ src: media.url, alt: file.name }).run()
          } else {
            activeEditor.chain().focus().insertContent(node).run()
          }
          toast.success(kind === 'image' ? '图片已插入' : '视频已插入')
        } catch (error) {
          toast.error(getErrorMessage(error, '上传失败'))
        } finally {
          setUploading(null)
        }
      }
    },
    [],
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: { HTMLAttributes: { class: 'editor-code-block' } },
        dropcursor: { color: '#00b96b', width: 2 },
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Image.configure({ inline: false, allowBase64: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: '开始书写，或粘贴 Markdown / 图片…',
        emptyEditorClass: 'is-editor-empty',
      }),
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      CharacterCount,
      VideoNode,
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'tiptap editor-prose',
        spellcheck: 'false',
      },
      handlePaste(_view, event) {
        const files = Array.from(event.clipboardData?.files ?? []).filter(
          (file) => file.type.startsWith('image/') || file.type.startsWith('video/'),
        )
        if (files.length === 0) return false
        const kind = files[0].type.startsWith('video/') ? 'video' : 'image'
        void uploadFiles(files, kind)
        return true
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false
        const files = Array.from(event.dataTransfer?.files ?? []).filter(
          (file) => file.type.startsWith('image/') || file.type.startsWith('video/'),
        )
        if (files.length === 0) return false
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
        const kind = files[0].type.startsWith('video/') ? 'video' : 'image'
        void uploadFiles(files, kind, coords?.pos)
        return true
      },
    },
    onCreate({ editor: instance }) {
      editorRef.current = instance
    },
    onUpdate({ editor: instance }) {
      editorRef.current = instance
      syncOutline(instance)
      markDirty()
    },
    onSelectionUpdate({ editor: instance }) {
      editorRef.current = instance
    },
  })

  const saveNow = useCallback(async (force = false): Promise<boolean> => {
    const activeEditor = editorRef.current
    const contentId = idRef.current
    if (!activeEditor || !readyRef.current || !contentId || contentId === 'new') return false
    if (!force && !dirtyRef.current) return true
    if (savingRef.current) {
      pendingSaveRef.current = true
      return false
    }

    savingRef.current = true
    setSaveState('saving')
    const revisionAtStart = revisionRef.current
    try {
      const html = activeEditor.getHTML()
      const json = activeEditor.getJSON() as unknown as RichTextJson
      const text = activeEditor.getText().replace(/\s+/g, ' ').trim()
      const payload = {
        title: titleRef.current.trim() || '无标题文档',
        bookId: bookIdRef.current ? bookIdRef.current : null,
        contentJson: json,
        contentHtml: html,
        excerpt: text.slice(0, 160),
        coverImage: coverRef.current,
        tags: tagsRef.current,
        status: statusRef.current,
        favorite: favoriteRef.current,
      }
      const { content: updated } = await api.contents.update(contentId, payload)
      const stillDirty = revisionRef.current !== revisionAtStart
      if (!stillDirty) {
        dirtyRef.current = false
        setDirty(false)
        setSaveState('saved')
        setLastSavedAt(new Date())
      } else {
        setSaveState('unsaved')
      }
      setContent((current) => (current ? { ...current, ...updated, contentJson: current.contentJson, contentHtml: current.contentHtml } : current))
      return true
    } catch (error) {
      setSaveState('error')
      toast.error(getErrorMessage(error, '保存失败，请重试'))
      return false
    } finally {
      savingRef.current = false
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false
        if (dirtyRef.current) window.setTimeout(() => void saveNow(false), 30)
      }
    }
  }, [])

  // Load document.
  useEffect(() => {
    let cancelled = false
    initializedIdRef.current = null
    initializedContentRef.current = false
    setReady(false)
    readyRef.current = false
    setLoading(true)
    setLoadError(null)
    setSaveState('saved')
    setLastSavedAt(null)
    dirtyRef.current = false
    setDirty(false)
    setRevision(0)

    if (!id) {
      setLoading(false)
      setLoadError('缺少文档参数')
      return
    }

    if (id === 'new') {
      const createId = async () => {
        try {
          const queryBookId = new URLSearchParams(window.location.search).get('bookId')
          const { content: created } = await api.contents.create(
            queryBookId ? { title: '无标题文档', bookId: queryBookId } : { title: '无标题文档' },
          )
          if (!cancelled) navigate(`/editor/${created.id}`, { replace: true })
        } catch (error) {
          if (!cancelled) {
            setLoading(false)
            setLoadError(getErrorMessage(error, '创建文档失败'))
          }
        }
      }
      void createId()
      return () => {
        cancelled = true
      }
    }

    api.contents
      .get(id)
      .then(({ content: detail }) => {
        if (cancelled) return
        setContent(detail)
        setTitle(detail.title)
        setBookId(detail.bookId ?? '')
        setCoverImage(detail.coverImage)
        setTags(detail.tags)
        setStatus(detail.status)
        setFavorite(detail.favorite)
        setLoading(false)
        setReady(true)
        readyRef.current = true
        setLastSavedAt(new Date(detail.updatedAt))
      })
      .catch((error) => {
        if (cancelled) return
        setLoading(false)
        setLoadError(getErrorMessage(error, '加载文档失败'))
      })

    return () => {
      cancelled = true
    }
  }, [id, navigate])

  // Initialize the Tiptap document once it is loaded. Imported documents can
  // legitimately have an empty JSON doc while their HTML carries the content.
  useEffect(() => {
    if (!editor || !content || content.id !== id) return
    if (initializedIdRef.current === content.id) return
    const canUseJson = jsonHasContent(content.contentJson)
    const initial = canUseJson ? content.contentJson : content.contentHtml || '<p></p>'
    editor.commands.setContent(initial, false)
    initializedIdRef.current = content.id
    initializedContentRef.current = true
    syncOutline(editor)
    setRevision(0)
    setDirty(false)
    dirtyRef.current = false
    setSaveState('saved')
  }, [editor, content, id, syncOutline])

  useEffect(() => {
    void api.books
      .list()
      .then((result) => setBooks(result.books))
      .catch(() => setBooks([]))
  }, [])

  // Debounced auto-save.
  useEffect(() => {
    if (!ready || !dirty || !initializedContentRef.current) return
    const timer = window.setTimeout(() => {
      void saveNow(false)
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [revision, ready, dirty, saveNow])

  // Ctrl/Cmd + S.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveNow(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveNow])

  // Warn before closing with unsaved changes.
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const text = editor?.getText() ?? ''
  const characters = useMemo(() => text.replace(/\s/g, '').length, [text])
  const readMinutes = Math.max(1, Math.ceil(characters / 350))

  const currentDetail = useMemo((): ContentDetail | null => {
    if (!content) return null
    const activeEditor = editorRef.current
    return {
      ...content,
      title: title.trim() || '无标题文档',
      bookId: bookId || null,
      coverImage,
      tags,
      status,
      favorite,
      contentJson: (activeEditor?.getJSON() as unknown as RichTextJson) ?? content.contentJson,
      contentHtml: activeEditor?.getHTML() ?? content.contentHtml,
      excerpt: (activeEditor?.getText() ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    }
  }, [content, title, bookId, coverImage, tags, status, favorite, revision])

  const saveLabel =
    saveState === 'saving'
      ? '保存中…'
      : saveState === 'error'
        ? '保存失败'
        : saveState === 'unsaved'
          ? '有未保存更改'
          : lastSavedAt
            ? `已保存 ${lastSavedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
            : '已保存'

  async function goBack() {
    if (dirtyRef.current) await saveNow(false)
    navigate('/library')
  }

  async function handleRender() {
    const ok = await saveNow(true)
    if (!ok && dirtyRef.current) {
      toast.error('请先成功保存后再渲染')
      return
    }
    navigate(`/render?contentId=${id}`)
  }

  async function handleExport(format: ExportFormat) {
    const ok = await saveNow(true)
    if (!ok && dirtyRef.current) {
      toast.error('保存失败，暂不能导出')
      return
    }
    if (!currentDetail) return
    exportContentFile(currentDetail, format)
    toast.success('导出文件已开始下载')
  }

  async function handleDuplicate() {
    if (!id || id === 'new') return
    const ok = await saveNow(true)
    if (!ok && dirtyRef.current) {
      toast.error('保存失败，暂不能复制')
      return
    }
    try {
      const { content: copy } = await api.contents.duplicate(id)
      toast.success('文档已复制')
      navigate(`/editor/${copy.id}`)
    } catch (error) {
      toast.error(getErrorMessage(error, '复制文档失败'))
    }
  }

  async function handleDelete() {
    if (!id || id === 'new' || deleting) return
    setDeleting(true)
    try {
      await api.contents.remove(id)
      toast.success('文档已移入回收站')
      navigate('/library')
    } catch (error) {
      toast.error(getErrorMessage(error, '删除失败'))
    } finally {
      setDeleting(false)
    }
  }

  async function handleRestore() {
    if (!content) return
    try {
      await api.contents.restore(content.id)
      setContent((current) => (current ? { ...current, deletedAt: null } : current))
      toast.success('文档已恢复')
    } catch (error) {
      toast.error(getErrorMessage(error, '恢复失败'))
    }
  }

  async function handleCoverFile(file: File) {
    if (coverUploading) return
    setCoverUploading(true)
    try {
      const { media } = await api.media.upload(file)
      setCoverImage(media.url)
      markDirty()
      toast.success('封面已更新')
    } catch (error) {
      toast.error(getErrorMessage(error, '封面上传失败'))
    } finally {
      setCoverUploading(false)
    }
  }

  function addTag() {
    const value = tagInput.trim().replace(/^#/, '')
    if (!value) return
    if (tags.length >= 10) {
      toast.error('最多添加 10 个标签')
      return
    }
    if (value.length > 24) {
      toast.error('单个标签最多 24 个字')
      return
    }
    if (tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setTagInput('')
      return
    }
    setTags((current) => [...current, value])
    setTagInput('')
    markDirty()
  }

  function removeTag(tag: string) {
    setTags((current) => current.filter((item) => item !== tag))
    markDirty()
  }

  function openLinkDialog() {
    const href = editor?.getAttributes('link').href
    setLinkUrl(typeof href === 'string' ? href : '')
    setLinkOpen(true)
  }

  function applyLink() {
    if (!editor) return
    const normalized = normalizeUrl(linkUrl)
    if (!normalized) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      setLinkOpen(false)
      return
    }
    if (editor.state.selection.empty) {
      editor
        .chain()
        .focus()
        .insertContent({ type: 'text', text: normalized, marks: [{ type: 'link', attrs: { href: normalized } }] })
        .run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: normalized }).run()
    }
    setLinkOpen(false)
  }

  function scrollToHeading(item: OutlineItem) {
    if (!editor) return
    editor.chain().focus().setTextSelection(item.pos + 1).scrollIntoView().run()
  }

  if (loading) {
    return (
      <div className="editor-state-page">
        <Logo size={42} subtitle />
        <div className="editor-state-loading">
          <LoaderCircle size={18} className="spin" />
          正在打开文档…
        </div>
      </div>
    )
  }

  if (loadError || !content) {
    return (
      <div className="editor-state-page">
        <div className="editor-state-card">
          <span className="editor-state-icon">
            <CircleAlert size={22} />
          </span>
          <h1>文档无法打开</h1>
          <p>{loadError || '文档不存在或已被删除。'}</p>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/library')}>
            返回内容库
          </button>
        </div>
      </div>
    )
  }

  const inTrash = Boolean(content.deletedAt)

  return (
    <div className="editor-page">
      <header className="editor-topbar">
        <div className="editor-topbar-left">
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => void goBack()} title="返回内容库" aria-label="返回内容库">
            <ArrowLeft size={18} />
          </button>
          <Logo size={28} subtitle={false} />
          <span className="editor-topbar-divider" />
          <button type="button" className="editor-crumb" onClick={() => navigate('/library')}>
            <BookOpen size={14} />
            {content.bookName || '未分组'}
          </button>
        </div>

        <div className="editor-topbar-center">
          <span className={cn('editor-save-state', `is-${saveState}`)}>
            {saveState === 'saving' ? <LoaderCircle size={14} className="spin" /> : null}
            {saveState === 'saved' ? <Check size={14} /> : null}
            {saveState === 'unsaved' ? <CloudUpload size={14} /> : null}
            {saveState === 'error' ? <CircleAlert size={14} /> : null}
            {saveLabel}
          </span>
        </div>

        <div className="editor-topbar-right">
          <button
            type="button"
            className={cn('btn btn-ghost btn-icon', favorite && 'editor-star-active')}
            onClick={() => {
              setFavorite((value) => !value)
              markDirty()
            }}
            title={favorite ? '取消收藏' : '收藏文档'}
            aria-label={favorite ? '取消收藏' : '收藏文档'}
          >
            <span className="editor-star">★</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleRender()}>
            <CloudUpload size={16} />
            渲染
          </button>
          <Dropdown
            align="end"
            minWidth={210}
            trigger={
              <button type="button" className="btn btn-ghost btn-icon" title="更多操作" aria-label="更多操作">
                <MoreHorizontal size={18} />
              </button>
            }
            items={[
              {
                key: 'export-md',
                label: '导出 Markdown',
                icon: <FileDown size={16} />,
                onSelect: () => void handleExport('markdown'),
              },
              {
                key: 'export-html',
                label: '导出 HTML',
                icon: <FileDown size={16} />,
                onSelect: () => void handleExport('html'),
              },
              {
                key: 'export-json',
                label: '导出 MultiPush JSON',
                icon: <FileDown size={16} />,
                onSelect: () => void handleExport('json'),
              },
              'separator',
              {
                key: 'duplicate',
                label: '复制文档',
                icon: <Copy size={16} />,
                onSelect: () => void handleDuplicate(),
              },
              'separator',
              {
                key: 'delete',
                label: '移入回收站',
                icon: <Trash2 size={16} />,
                danger: true,
                onSelect: () => setDeleteOpen(true),
              },
            ]}
          />
        </div>
      </header>

      {inTrash ? (
        <div className="editor-trash-banner">
          <CircleAlert size={15} />
          <span>这篇文档在回收站中，恢复后才能继续编辑和渲染。</span>
          <button type="button" className="btn btn-sm" onClick={() => void handleRestore()}>
            <RotateCcw size={14} />
            恢复文档
          </button>
        </div>
      ) : null}

      <div className={cn('editor-body', !leftOpen && 'left-closed', !rightOpen && 'right-closed')}>
        {leftOpen ? (
          <aside className="editor-left">
            <div className="editor-panel-head">
              <span>文档信息</span>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setLeftOpen(false)} title="收起信息面板">
                <PanelLeft size={15} />
              </button>
            </div>

            <div className="editor-info-section">
              <span className="editor-info-label">所属知识库</span>
              <select
                className="select editor-book-select"
                value={bookId}
                onChange={(event) => {
                  setBookId(event.target.value)
                  markDirty()
                }}
              >
                <option value="">未分组</option>
                {books.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="editor-info-section">
              <span className="editor-info-label">封面</span>
              {coverImage ? (
                <div className="editor-cover-preview">
                  <img src={absoluteUrl(coverImage)} alt="文档封面" />
                  <button
                    type="button"
                    className="editor-cover-remove"
                    onClick={() => {
                      setCoverImage(null)
                      markDirty()
                    }}
                    title="移除封面"
                    aria-label="移除封面"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="editor-cover-empty"
                  onClick={() => coverInputRef.current?.click()}
                  disabled={coverUploading}
                >
                  {coverUploading ? <LoaderCircle size={17} className="spin" /> : <ImagePlus size={17} />}
                  {coverUploading ? '上传中…' : '添加封面'}
                </button>
              )}
              <input
                ref={coverInputRef}
                type="file"
                accept="image/*"
                className="visually-hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void handleCoverFile(file)
                  event.target.value = ''
                }}
              />
            </div>

            <div className="editor-info-section">
              <span className="editor-info-label">标签</span>
              <div className="editor-tags">
                {tags.map((tag) => (
                  <span className="tag" key={tag}>
                    {tag}
                    <button type="button" onClick={() => removeTag(tag)} aria-label={`移除标签 ${tag}`}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="editor-tag-input">
                <input
                  className="input"
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ',') {
                      event.preventDefault()
                      addTag()
                    }
                  }}
                  placeholder="回车添加标签"
                  maxLength={24}
                />
                <button type="button" className="btn btn-sm" onClick={addTag} disabled={!tagInput.trim()}>
                  <Plus size={13} />
                </button>
              </div>
            </div>

            <div className="editor-info-section">
              <span className="editor-info-label">状态</span>
              <div className="editor-status-toggle">
                <button
                  type="button"
                  className={cn(status === 'draft' && 'is-active')}
                  onClick={() => {
                    setStatus('draft')
                    markDirty()
                  }}
                >
                  草稿
                </button>
                <button
                  type="button"
                  className={cn(status === 'ready' && 'is-active')}
                  onClick={() => {
                    setStatus('ready')
                    markDirty()
                  }}
                >
                  待渲染
                </button>
              </div>
            </div>

            <div className="editor-info-meta">
              <span>创建于 {formatDateTime(content.createdAt)}</span>
              <span>更新于 {formatDateTime(lastSavedAt ?? content.updatedAt)}</span>
            </div>
          </aside>
        ) : null}

        <main className="editor-main">
          <div className="editor-toolbar-wrap">
            {!leftOpen ? (
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setLeftOpen(true)} title="展开信息面板">
                <PanelLeft size={15} />
              </button>
            ) : null}
            {editor ? (
              <div className="editor-toolbar" role="toolbar" aria-label="编辑工具栏">
                <div className="editor-tool-group">
                  <ToolbarButton label="撤销" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>
                    <Undo2 size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="重做" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>
                    <Redo2 size={16} />
                  </ToolbarButton>
                </div>
                <span className="editor-tool-divider" />
                <div className="editor-tool-group">
                  <ToolbarButton label="正文" active={editor.isActive('paragraph')} onClick={() => editor.chain().focus().setParagraph().run()}>
                    <Pilcrow size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="一级标题" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
                    <Heading1 size={17} />
                  </ToolbarButton>
                  <ToolbarButton label="二级标题" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
                    <Heading2 size={17} />
                  </ToolbarButton>
                  <ToolbarButton label="三级标题" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
                    <Heading3 size={17} />
                  </ToolbarButton>
                </div>
                <span className="editor-tool-divider" />
                <div className="editor-tool-group">
                  <ToolbarButton label="加粗" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
                    <Bold size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="斜体" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
                    <Italic size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="下划线" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
                    <UnderlineIcon size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="删除线" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
                    <Strikethrough size={16} />
                  </ToolbarButton>
                  <Dropdown
                    align="start"
                    minWidth={150}
                    trigger={
                      <button type="button" className="editor-tool" title="文字颜色" aria-label="文字颜色" onMouseDown={(event) => event.preventDefault()}>
                        <Palette size={16} />
                      </button>
                    }
                    items={[
                      ...TEXT_COLORS.map((color) => ({
                        key: color.value,
                        label: color.label,
                        icon: <span className="editor-color-dot" style={{ background: color.value }} />,
                        onSelect: () => {
                          if (color.label === '默认') editor.chain().focus().unsetColor().run()
                          else editor.chain().focus().setColor(color.value).run()
                        },
                      })),
                    ]}
                  />
                  <Dropdown
                    align="start"
                    minWidth={150}
                    trigger={
                      <button type="button" className="editor-tool" title="高亮" aria-label="高亮" onMouseDown={(event) => event.preventDefault()}>
                        <Highlighter size={16} />
                      </button>
                    }
                    items={[
                      {
                        key: 'none',
                        label: '取消高亮',
                        icon: <Eraser size={14} />,
                        onSelect: () => editor.chain().focus().unsetHighlight().run(),
                      },
                      ...HIGHLIGHT_COLORS.map((color) => ({
                        key: color.value,
                        label: color.label,
                        icon: <span className="editor-color-dot" style={{ background: color.value }} />,
                        onSelect: () => editor.chain().focus().toggleHighlight({ color: color.value }).run(),
                      })),
                    ]}
                  />
                </div>
                <span className="editor-tool-divider" />
                <div className="editor-tool-group">
                  <ToolbarButton label="无序列表" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
                    <span className="editor-glyph">•≡</span>
                  </ToolbarButton>
                  <ToolbarButton label="有序列表" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
                    <span className="editor-glyph">1≡</span>
                  </ToolbarButton>
                  <ToolbarButton label="任务列表" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}>
                    <span className="editor-glyph">☑</span>
                  </ToolbarButton>
                  <ToolbarButton label="引用" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
                    <Quote size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="代码块" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
                    <Code2 size={16} />
                  </ToolbarButton>
                  <Dropdown
                    align="start"
                    minWidth={190}
                    trigger={
                      <button type="button" className="editor-tool" title="表格" aria-label="表格" onMouseDown={(event) => event.preventDefault()}>
                        <Table2 size={16} />
                      </button>
                    }
                    items={[
                      {
                        key: 'insert',
                        label: '插入 3×3 表格',
                        icon: <Table2 size={15} />,
                        onSelect: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
                      },
                      'separator',
                      { key: 'row-before', label: '上方插入行', onSelect: () => editor.chain().focus().addRowBefore().run() },
                      { key: 'row-after', label: '下方插入行', onSelect: () => editor.chain().focus().addRowAfter().run() },
                      { key: 'col-before', label: '左侧插入列', onSelect: () => editor.chain().focus().addColumnBefore().run() },
                      { key: 'col-after', label: '右侧插入列', onSelect: () => editor.chain().focus().addColumnAfter().run() },
                      'separator',
                      { key: 'delete-row', label: '删除当前行', onSelect: () => editor.chain().focus().deleteRow().run() },
                      { key: 'delete-col', label: '删除当前列', onSelect: () => editor.chain().focus().deleteColumn().run() },
                      { key: 'delete-table', label: '删除表格', danger: true, onSelect: () => editor.chain().focus().deleteTable().run() },
                    ]}
                  />
                  <ToolbarButton label="分割线" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
                    <Minus size={16} />
                  </ToolbarButton>
                </div>
                <span className="editor-tool-divider" />
                <div className="editor-tool-group">
                  <ToolbarButton label="链接" active={editor.isActive('link')} onClick={openLinkDialog}>
                    <Link2 size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="插入图片" onClick={() => imageInputRef.current?.click()}>
                    <ImagePlus size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="插入视频" onClick={() => videoInputRef.current?.click()}>
                    <Video size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="左对齐" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}>
                    <AlignLeft size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="居中" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}>
                    <AlignCenter size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="右对齐" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}>
                    <AlignRight size={16} />
                  </ToolbarButton>
                  <ToolbarButton label="清除格式" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
                    <Eraser size={16} />
                  </ToolbarButton>
                </div>
                {uploading ? (
                  <span className="editor-uploading">
                    <LoaderCircle size={14} className="spin" />
                    {uploading.label} {uploading.percent}%
                  </span>
                ) : null}
              </div>
            ) : null}
            {!rightOpen ? (
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setRightOpen(true)} title="展开大纲">
                <PanelRight size={15} />
              </button>
            ) : null}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="visually-hidden"
              onChange={(event) => {
                if (event.target.files) void uploadFiles(Array.from(event.target.files), 'image')
                event.target.value = ''
              }}
            />
            <input
              ref={videoInputRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              className="visually-hidden"
              onChange={(event) => {
                if (event.target.files) void uploadFiles(Array.from(event.target.files), 'video')
                event.target.value = ''
              }}
            />
          </div>

          <div className="editor-scroll">
            <article className="editor-canvas">
              <input
                className="editor-title-input"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value)
                  markDirty()
                }}
                placeholder="无标题文档"
                maxLength={200}
                aria-label="文档标题"
              />
              <div className="editor-doc-meta">
                <span>{content.bookName || '未分组'}</span>
                <span>·</span>
                <span>{characters} 字</span>
                <span>·</span>
                <span>约 {readMinutes} 分钟阅读</span>
                {status === 'ready' ? <span className="editor-ready-badge">待渲染</span> : null}
              </div>
              <div className={cn('editor-prose-wrap', inTrash && 'is-readonly')}>
                <EditorContent editor={editor} />
              </div>
              <footer className="editor-foot">
                <span>{characters} 字 · {readMinutes} 分钟阅读</span>
                <span className={cn('editor-save-state', `is-${saveState}`)}>{saveLabel}</span>
              </footer>
            </article>
          </div>
        </main>

        {rightOpen ? (
          <aside className="editor-right">
            <div className="editor-panel-head">
              <span>大纲</span>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setRightOpen(false)} title="收起大纲">
                <PanelRight size={15} />
              </button>
            </div>
            {outline.length === 0 ? (
              <div className="editor-outline-empty">
                <Type size={18} />
                <p>添加标题后，这里会生成文章大纲。</p>
              </div>
            ) : (
              <nav className="editor-outline" aria-label="文章大纲">
                {outline.map((item, index) => (
                  <button
                    type="button"
                    key={`${item.pos}-${index}`}
                    className={cn('editor-outline-item', `level-${item.level}`)}
                    onClick={() => scrollToHeading(item)}
                    title={item.text}
                  >
                    {item.text}
                  </button>
                ))}
              </nav>
            )}
          </aside>
        ) : null}
      </div>

      <Modal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="插入链接"
        subtitle="输入链接地址，选中文字时会转换为链接"
        size="compact"
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (!editor) return
                editor.chain().focus().extendMarkRange('link').unsetLink().run()
                setLinkOpen(false)
              }}
            >
              移除链接
            </button>
            <button type="button" className="btn btn-primary" onClick={applyLink}>
              应用
            </button>
          </>
        }
      >
        <div className="field">
          <label className="label" htmlFor="editor-link-url">
            链接地址
          </label>
          <input
            id="editor-link-url"
            className="input"
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            placeholder="https://example.com"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyLink()
            }}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteOpen}
        title="移入回收站"
        description={
          <>
            确定要将 <strong>「{title || '无标题文档'}」</strong> 移入回收站吗？之后可以在回收站恢复。
          </>
        }
        confirmLabel="移入回收站"
        loading={deleting}
        onClose={() => {
          if (!deleting) setDeleteOpen(false)
        }}
        onConfirm={handleDelete}
      />
    </div>
  )
}
