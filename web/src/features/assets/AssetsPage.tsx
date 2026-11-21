import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Film,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Inbox,
  Layers,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { marked } from 'marked'
import { toast } from 'sonner'
import type { MediaAsset, MediaFolder, MediaKind, MediaStats } from '@shared/types'
import { absoluteUrl, api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { cn, copyText, formatBytes, formatDateTime, relativeTime } from '@/lib/utils'
import ConfirmDialog from '@/components/ConfirmDialog'
import Dropdown, { type DropdownEntry } from '@/components/Dropdown'
import EmptyState from '@/components/EmptyState'
import Modal from '@/components/Modal'
import './assets.css'

type AssetFilter = 'all' | MediaKind
type ActiveFolder = string | 'unfiled' | null
type FolderDialog = { mode: 'create' } | { mode: 'rename'; folder: MediaFolder }

interface UploadTask {
  name: string
  percent: number
  done: number
  total: number
}

const PAGE_SIZE = 30
const MAX_UPLOAD_FILES = 20
const IMAGE_LIMIT = 20 * 1024 * 1024
const VIDEO_LIMIT = 200 * 1024 * 1024
const DOCUMENT_LIMIT = 50 * 1024 * 1024
const TEXT_PREVIEW_LIMIT = 1024 * 1024
const TEXT_PREVIEW_CHARS = 200_000

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov'])
const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml', 'yml', 'yaml', 'rtf',
])
const TEXT_PREVIEW_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml', 'yml', 'yaml',
])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
const BLOCKED_PREVIEW_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM'])
const UPLOAD_ACCEPT = [
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
].map((extension) => `.${extension}`).join(',')

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name)
  return match ? match[1].toLowerCase() : ''
}

function kindForExtension(extension: string): MediaKind | null {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  return null
}

function limitForKind(kind: MediaKind): number {
  if (kind === 'image') return IMAGE_LIMIT
  if (kind === 'video') return VIDEO_LIMIT
  return DOCUMENT_LIMIT
}

function kindLabel(kind: MediaKind): string {
  if (kind === 'image') return '图片'
  if (kind === 'video') return '视频'
  return '文档'
}

function docTone(extension: string): string {
  if (extension === 'pdf') return 'pdf'
  if (['doc', 'docx', 'rtf'].includes(extension)) return 'word'
  if (['xls', 'xlsx', 'csv'].includes(extension)) return 'sheet'
  if (['ppt', 'pptx'].includes(extension)) return 'slides'
  if (['json', 'xml', 'yml', 'yaml', 'html', 'htm'].includes(extension)) return 'code'
  return 'text'
}

function kindIcon(kind: MediaKind) {
  if (kind === 'image') return <ImageIcon size={15} />
  if (kind === 'video') return <Film size={15} />
  return <FileText size={15} />
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return ''
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${rest < 10 ? `0${rest}` : rest}`
}

function downloadMedia(media: MediaAsset): void {
  const anchor = document.createElement('a')
  anchor.href = absoluteUrl(media.url)
  anchor.download = media.originalName || media.filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function openMedia(media: MediaAsset): void {
  window.open(absoluteUrl(media.url), '_blank', 'noopener,noreferrer')
}

function copyMediaLink(media: MediaAsset): void {
  void copyText(absoluteUrl(media.url))
    .then(() => toast.success('素材链接已复制'))
    .catch(() => toast.error('复制链接失败'))
}

function stemOf(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

function renderMarkdownHtml(markdown: string, images: MediaAsset[]): string {
  if (!markdown.trim()) return ''
  const rendered = marked.parse(markdown, { gfm: true, breaks: false, async: false }) as string
  const document = new DOMParser().parseFromString(rendered, 'text/html')
  const byName = new Map(images.map((image) => [image.originalName.toLowerCase(), image]))
  const byStem = new Map(images.map((image) => [stemOf(image.originalName).toLowerCase(), image]))

  // Yuque exports keep relative asset paths such as
  // "构建个人数字生活蓝图.assets/xxx.heic". Resolve them to uploaded assets in
  // the same folder; HEIC exports map to the converted JPEG by file stem.
  document.body.querySelectorAll('img').forEach((image) => {
    const source = image.getAttribute('src') ?? ''
    if (!source || /^(?:https?:|data:|blob:)/i.test(source)) return
    let name = source.split(/[?#]/)[0].split('/').pop() ?? ''
    try {
      name = decodeURIComponent(name)
    } catch {
      // Keep the raw name when it is not valid percent-encoding.
    }
    const asset = byName.get(name.toLowerCase()) ?? byStem.get(stemOf(name).toLowerCase())
    if (asset) {
      image.setAttribute('src', absoluteUrl(asset.url))
      image.setAttribute('loading', 'lazy')
    } else {
      image.removeAttribute('src')
    }
  })

  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    if (BLOCKED_PREVIEW_TAGS.has(element.tagName)) {
      element.remove()
      continue
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc' || name === 'style' || name === 'class') {
        element.removeAttribute(attribute.name)
        continue
      }
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attribute.value)) {
        element.removeAttribute(attribute.name)
      }
    }
    if (element.tagName === 'A') {
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noopener noreferrer')
    }
  }
  return document.body.innerHTML
}

export default function AssetsPage() {
  const [items, setItems] = useState<MediaAsset[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState<AssetFilter>('all')
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [stats, setStats] = useState<MediaStats>({ total: 0, images: 0, videos: 0, documents: 0, bytes: 0 })
  const [libraryStats, setLibraryStats] = useState<MediaStats>({ total: 0, images: 0, videos: 0, documents: 0, bytes: 0 })
  const [statsLoading, setStatsLoading] = useState(true)
  const [folders, setFolders] = useState<MediaFolder[]>([])
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [activeFolderId, setActiveFolderId] = useState<ActiveFolder>(null)
  const [folderDialog, setFolderDialog] = useState<FolderDialog | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderError, setFolderError] = useState('')
  const [folderSaving, setFolderSaving] = useState(false)
  const [moveTarget, setMoveTarget] = useState<MediaAsset | null>(null)
  const [moveFolderId, setMoveFolderId] = useState<string>('unfiled')
  const [moving, setMoving] = useState(false)
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<MediaFolder | null>(null)
  const [deletingFolder, setDeletingFolder] = useState(false)
  const [uploadTask, setUploadTask] = useState<UploadTask | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [selected, setSelected] = useState<MediaAsset | null>(null)
  const [previewText, setPreviewText] = useState('')
  const [previewTextLoading, setPreviewTextLoading] = useState(false)
  const [previewTextError, setPreviewTextError] = useState('')
  const [previewImages, setPreviewImages] = useState<MediaAsset[]>([])
  const [deleteTarget, setDeleteTarget] = useState<MediaAsset | null>(null)
  const [deleting, setDeleting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  const refreshStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const [global, scoped] = await Promise.all([
        api.media.stats(),
        activeFolderId === null
          ? Promise.resolve(null)
          : api.media.stats({ folderId: activeFolderId }),
      ])
      setLibraryStats(global.stats)
      setStats(scoped?.stats ?? global.stats)
    } catch {
      // The list is still usable when the summary request fails.
    } finally {
      setStatsLoading(false)
    }
  }, [activeFolderId])

  const refreshFolders = useCallback(async () => {
    setFoldersLoading(true)
    try {
      const { folders: next } = await api.media.folders()
      setFolders(next)
    } catch {
      // Folders are an organizational aid; keep the asset list usable.
    } finally {
      setFoldersLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshStats()
    void refreshFolders()
  }, [refreshStats, refreshFolders])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    api.media
      .list({
        kind: filter === 'all' ? undefined : filter,
        q: query || undefined,
        folderId: activeFolderId === null ? undefined : activeFolderId,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((result) => {
        if (cancelled) return
        setItems((current) => (page === 1 ? result.media : [...current, ...result.media]))
        setTotal(result.total)
      })
      .catch((error) => {
        if (cancelled) return
        setLoadError(getErrorMessage(error, '加载素材失败'))
        if (page === 1) {
          setItems([])
          setTotal(0)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filter, query, activeFolderId, page, reloadKey])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(searchInput.trim())
      setPage(1)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    setPreviewText('')
    setPreviewTextError('')
    setPreviewTextLoading(false)
    setPreviewImages([])
    if (!selected || selected.kind !== 'document') return
    const extension = extensionOf(selected.originalName)
    if (!TEXT_PREVIEW_EXTENSIONS.has(extension) || selected.size > TEXT_PREVIEW_LIMIT) return
    let cancelled = false
    setPreviewTextLoading(true)
    const textRequest = fetch(absoluteUrl(selected.url)).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.text()
    })
    const imageRequest = MARKDOWN_EXTENSIONS.has(extension)
      ? api.media
          .list({
            kind: 'image',
            folderId: selected.folderId ?? 'unfiled',
            pageSize: 100,
          })
          .then((result) => result.media)
          .catch(() => [])
      : Promise.resolve([])
    Promise.all([textRequest, imageRequest])
      .then(([text, images]) => {
        if (cancelled) return
        setPreviewText(text.slice(0, TEXT_PREVIEW_CHARS))
        setPreviewImages(images)
      })
      .catch((error) => {
        if (!cancelled) setPreviewTextError(getErrorMessage(error, '读取文档失败'))
      })
      .finally(() => {
        if (!cancelled) setPreviewTextLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const refreshAll = useCallback(() => {
    setPage(1)
    setReloadKey((value) => value + 1)
    void refreshStats()
    void refreshFolders()
  }, [refreshStats, refreshFolders])

  function selectFilter(next: AssetFilter) {
    if (next === filter) return
    setFilter(next)
    setPage(1)
  }

  function selectFolder(next: ActiveFolder) {
    if (next === activeFolderId) return
    setActiveFolderId(next)
    setPage(1)
    setItems([])
  }

  function openCreateFolder() {
    setFolderName('')
    setFolderError('')
    setFolderDialog({ mode: 'create' })
  }

  function openRenameFolder(folder: MediaFolder) {
    setFolderName(folder.name)
    setFolderError('')
    setFolderDialog({ mode: 'rename', folder })
  }

  async function submitFolder() {
    if (!folderDialog || folderSaving) return
    const name = folderName.trim()
    if (!name) {
      setFolderError('请输入文件夹名称')
      return
    }
    setFolderSaving(true)
    setFolderError('')
    try {
      if (folderDialog.mode === 'create') {
        const { folder } = await api.media.createFolder(name)
        setFolderDialog(null)
        await refreshFolders()
        setActiveFolderId(folder.id)
        setPage(1)
        setItems([])
        toast.success('文件夹已创建')
      } else {
        await api.media.renameFolder(folderDialog.folder.id, name)
        setFolderDialog(null)
        await refreshFolders()
        toast.success('文件夹已重命名')
      }
    } catch (error) {
      setFolderError(getErrorMessage(error, '保存文件夹失败'))
    } finally {
      setFolderSaving(false)
    }
  }

  async function removeFolder() {
    if (!deleteFolderTarget || deletingFolder) return
    setDeletingFolder(true)
    try {
      const result = await api.media.removeFolder(deleteFolderTarget.id)
      toast.success(
        result.moved > 0
          ? `文件夹已删除，${result.moved} 个素材已移到未分组`
          : '文件夹已删除',
      )
      if (activeFolderId === deleteFolderTarget.id) setActiveFolderId(null)
      setDeleteFolderTarget(null)
      setPage(1)
      setReloadKey((value) => value + 1)
      void refreshFolders()
      void refreshStats()
    } catch (error) {
      toast.error(getErrorMessage(error, '删除文件夹失败'))
    } finally {
      setDeletingFolder(false)
    }
  }

  function openMove(media: MediaAsset) {
    setSelected(null)
    setMoveTarget(media)
    setMoveFolderId(media.folderId ?? 'unfiled')
  }

  function askDeleteFolder(folder: MediaFolder) {
    setDeleteFolderTarget(folder)
  }

  async function moveMaterial() {
    if (!moveTarget || moving) return
    setMoving(true)
    try {
      await api.media.move(moveTarget.id, moveFolderId === 'unfiled' ? null : moveFolderId)
      toast.success('素材已移动')
      setMoveTarget(null)
      setPage(1)
      setReloadKey((value) => value + 1)
      void refreshFolders()
      void refreshStats()
    } catch (error) {
      toast.error(getErrorMessage(error, '移动素材失败'))
    } finally {
      setMoving(false)
    }
  }

  async function handleFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    if (files.length === 0) return
    if (uploadTask) {
      toast.error('正在上传，请稍候')
      return
    }
    if (files.length > MAX_UPLOAD_FILES) {
      toast.error(`一次最多上传 ${MAX_UPLOAD_FILES} 个素材`)
    }
    const accepted: File[] = []
    for (const file of files.slice(0, MAX_UPLOAD_FILES)) {
      const extension = extensionOf(file.name)
      const kind = kindForExtension(extension)
      if (!kind) {
        toast.error(`「${file.name}」格式不支持，请上传图片、视频或常见文档`)
        continue
      }
      if (file.size > limitForKind(kind)) {
        toast.error(`「${file.name}」超过 ${formatBytes(limitForKind(kind))}，已跳过`)
        continue
      }
      accepted.push(file)
    }
    if (accepted.length === 0) return

    const uploadFolderId = activeFolderId && activeFolderId !== 'unfiled' ? activeFolderId : null
    let uploaded = 0
    for (let index = 0; index < accepted.length; index += 1) {
      const file = accepted[index]
      setUploadTask({ name: file.name, percent: 0, done: index, total: Math.min(accepted.length, MAX_UPLOAD_FILES) })
      try {
        await api.media.upload(
          file,
          (percent) => {
            setUploadTask((current) => (current && current.name === file.name ? { ...current, percent } : current))
          },
          uploadFolderId,
        )
        uploaded += 1
      } catch (error) {
        toast.error(getErrorMessage(error, `「${file.name}」上传失败`))
      } finally {
        setUploadTask((current) => (current && current.name === file.name ? { ...current, done: index + 1 } : current))
      }
    }
    setUploadTask(null)
    if (uploaded > 0) {
      toast.success(uploaded === 1 ? '素材已上传' : `${uploaded} 个素材已上传`)
      setPage(1)
      setReloadKey((value) => value + 1)
      void refreshStats()
      void refreshFolders()
    }
  }

  async function removeMaterial() {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await api.media.remove(deleteTarget.id)
      toast.success('素材已删除')
      setDeleteTarget(null)
      setSelected((current) => (current?.id === deleteTarget.id ? null : current))
      setPage(1)
      setReloadKey((value) => value + 1)
      void refreshStats()
      void refreshFolders()
    } catch (error) {
      toast.error(getErrorMessage(error, '删除素材失败'))
    } finally {
      setDeleting(false)
    }
  }

  function askDelete(media: MediaAsset) {
    setSelected(null)
    setDeleteTarget(media)
  }

  const selectedExtension = selected ? extensionOf(selected.originalName) : ''
  const selectedIsPdf = selected?.kind === 'document' && selectedExtension === 'pdf'
  const selectedIsMarkdown = MARKDOWN_EXTENSIONS.has(selectedExtension)
  const selectedHasTextPreview = Boolean(selected) && TEXT_PREVIEW_EXTENSIONS.has(selectedExtension)
  const previewMarkdownHtml = useMemo(
    () => (selectedIsMarkdown && previewText ? renderMarkdownHtml(previewText, previewImages) : ''),
    [selectedIsMarkdown, previewText, previewImages],
  )
  const activeFolder =
    activeFolderId && activeFolderId !== 'unfiled'
      ? folders.find((folder) => folder.id === activeFolderId) ?? null
      : null
  const activeFolderName = activeFolderId === 'unfiled' ? '未分组' : activeFolder?.name ?? null
  const unfiledCount = Math.max(0, libraryStats.total - folders.reduce((sum, folder) => sum + folder.assetCount, 0))
  const activeFolderCount = activeFolderId === 'unfiled' ? unfiledCount : activeFolder?.assetCount ?? 0
  const emptyTitle =
    query
      ? '没有匹配的素材'
      : activeFolderName
        ? filter === 'image'
          ? `「${activeFolderName}」还没有图片`
          : filter === 'video'
            ? `「${activeFolderName}」还没有视频`
            : filter === 'document'
              ? `「${activeFolderName}」还没有文档`
              : `「${activeFolderName}」还没有素材`
        : filter === 'image'
          ? '还没有图片素材'
          : filter === 'video'
            ? '还没有视频素材'
            : filter === 'document'
              ? '还没有文档素材'
              : '素材库还是空的'
  const emptyDescription =
    query
      ? '换个关键词试试，或切换到其他素材分类。'
      : activeFolderName
        ? '上传素材，或把已有素材移动到这个文件夹。'
        : '上传图片、视频或文档后，可以在编辑器、图文工作台和 AI 创作中继续使用；这些位置上传的素材也会自动汇总到这里。'

  const tabs = useMemo(
    () => [
      { id: 'all' as const, label: '全部', count: stats.total },
      { id: 'image' as const, label: '图片', count: stats.images },
      { id: 'video' as const, label: '视频', count: stats.videos },
      { id: 'document' as const, label: '文档', count: stats.documents },
    ],
    [stats],
  )

  return (
    <div
      className="assets-page"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepth.current += 1
        setDragActive(true)
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragActive(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files?.length) return
        event.preventDefault()
        dragDepth.current = 0
        setDragActive(false)
        void handleFiles(event.dataTransfer.files)
      }}
    >
      <header className="assets-head">
        <div>
          <span className="assets-eyebrow">
            <FolderOpen size={14} />
            ASSET LIBRARY
          </span>
          <h1>素材库</h1>
          <p>集中管理图片、视频和文档。编辑器、图文工作台和 AI 创作上传的素材会自动汇总到这里。</p>
        </div>
        <div className="assets-head-actions">
          <button type="button" className="btn" onClick={() => refreshAll()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : undefined} />
            刷新
          </button>
          <button type="button" className="btn" onClick={openCreateFolder}>
            <FolderPlus size={15} />
            新建文件夹
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={Boolean(uploadTask)}
          >
            <Upload size={16} />
            上传素材
          </button>
        </div>
      </header>

      <section className="assets-folders" aria-label="素材文件夹">
        <div className="assets-folders-head">
          <h2>文件夹</h2>
          <span>{foldersLoading && folders.length === 0 ? '加载中…' : `${folders.length} 个文件夹`}</span>
        </div>
        <div className="assets-folder-strip">
          <button
            type="button"
            className={cn('assets-folder-card', 'is-all', activeFolderId === null && 'is-active')}
            onClick={() => selectFolder(null)}
          >
            <span className="assets-folder-icon"><Layers size={17} /></span>
            <span className="assets-folder-copy"><strong>全部素材</strong><small>{libraryStats.total} 个素材</small></span>
          </button>
          <button
            type="button"
            className={cn('assets-folder-card', activeFolderId === 'unfiled' && 'is-active')}
            onClick={() => selectFolder('unfiled')}
          >
            <span className="assets-folder-icon"><Inbox size={17} /></span>
            <span className="assets-folder-copy"><strong>未分组</strong><small>{unfiledCount} 个素材</small></span>
          </button>
          {folders.map((folder) => (
            <div className={cn('assets-folder-wrap', activeFolderId === folder.id && 'is-active')} key={folder.id}>
              <button type="button" className="assets-folder-card" onClick={() => selectFolder(folder.id)}>
                <span className="assets-folder-icon"><Folder size={17} /></span>
                <span className="assets-folder-copy"><strong>{folder.name}</strong><small>{folder.assetCount} 个素材</small></span>
              </button>
              <Dropdown
                align="end"
                minWidth={160}
                trigger={
                  <button type="button" className="assets-folder-more" aria-label={`「${folder.name}」文件夹操作`} title="文件夹操作">
                    <MoreHorizontal size={15} />
                  </button>
                }
                items={[
                  { key: 'rename', label: '重命名', icon: <Pencil size={14} />, onSelect: () => openRenameFolder(folder) },
                  { key: 'delete', label: '删除文件夹', icon: <Trash2 size={14} />, danger: true, onSelect: () => askDeleteFolder(folder) },
                ]}
              />
            </div>
          ))}
          <button type="button" className="assets-folder-add" onClick={openCreateFolder}>
            <FolderPlus size={18} />
            <span>新建文件夹</span>
          </button>
        </div>
      </section>

      {activeFolderName ? (
        <div className="assets-current-folder">
          <button type="button" className="assets-current-back" onClick={() => selectFolder(null)}>
            <ArrowLeft size={14} />
            全部素材
          </button>
          <span className="assets-current-sep">/</span>
          {activeFolderId === 'unfiled' ? <Inbox size={15} /> : <Folder size={15} />}
          <strong>{activeFolderName}</strong>
          <small>{activeFolderCount} 个素材</small>
        </div>
      ) : null}

      <section className="assets-stats" aria-label="素材统计">
        <div className="assets-stat">
          <span className="assets-stat-icon is-all"><Layers size={17} /></span>
          <div><strong>{statsLoading ? '—' : stats.total}</strong><small>{activeFolderId === null ? '全部素材' : '当前文件夹'}</small></div>
          <em>{formatBytes(stats.bytes)}</em>
        </div>
        <div className="assets-stat">
          <span className="assets-stat-icon is-image"><ImageIcon size={17} /></span>
          <div><strong>{statsLoading ? '—' : stats.images}</strong><small>图片</small></div>
        </div>
        <div className="assets-stat">
          <span className="assets-stat-icon is-video"><Film size={17} /></span>
          <div><strong>{statsLoading ? '—' : stats.videos}</strong><small>视频</small></div>
        </div>
        <div className="assets-stat">
          <span className="assets-stat-icon is-document"><FileText size={17} /></span>
          <div><strong>{statsLoading ? '—' : stats.documents}</strong><small>文档</small></div>
        </div>
      </section>

      <div className="assets-toolbar">
        <div className="assets-tabs" role="tablist" aria-label="素材类型">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filter === tab.id}
              className={cn('assets-tab', filter === tab.id && 'is-active')}
              onClick={() => selectFilter(tab.id)}
            >
              {tab.label}
              <span>{tab.count}</span>
            </button>
          ))}
        </div>
        <div className="assets-search">
          <Search size={15} />
          <input
            className="input"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索文件名或类型…"
            aria-label="搜索素材"
          />
          {searchInput ? (
            <button type="button" className="assets-search-clear" onClick={() => setSearchInput('')} aria-label="清空搜索">
              <X size={14} />
            </button>
          ) : null}
        </div>
      </div>

      {uploadTask ? (
        <div className="assets-upload" role="status" aria-live="polite">
          <div className="assets-upload-copy">
            <LoaderCircle size={15} className="spin" />
            <span>
              正在上传 {uploadTask.name}
              {uploadTask.total > 1 ? `（${uploadTask.done + 1}/${uploadTask.total}）` : ''}
            </span>
            <strong>{uploadTask.percent}%</strong>
          </div>
          <div className="assets-upload-track">
            <span style={{ width: `${uploadTask.percent}%` }} />
          </div>
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <div className="assets-grid">
          {Array.from({ length: 8 }).map((_, index) => (
            <div className="asset-card asset-card-skeleton" key={index}>
              <span className="skeleton skeleton-cover" />
              <span className="skeleton skeleton-line skeleton-line-lg" />
              <span className="skeleton skeleton-line skeleton-line-sm" />
            </div>
          ))}
        </div>
      ) : loadError ? (
        <EmptyState
          icon={<RefreshCw size={22} />}
          title="素材加载失败"
          description={loadError}
          action={
            <button type="button" className="btn" onClick={() => refreshAll()}>
              <RefreshCw size={15} />
              重试
            </button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={22} />}
          title={emptyTitle}
          description={emptyDescription}
          action={
            <button type="button" className="btn btn-primary" onClick={() => fileInputRef.current?.click()} disabled={Boolean(uploadTask)}>
              <Upload size={16} />
              上传素材
            </button>
          }
        />
      ) : (
        <>
          <div className="assets-grid">
            <button
              type="button"
              className="assets-upload-tile"
              onClick={() => fileInputRef.current?.click()}
              disabled={Boolean(uploadTask)}
            >
              <span className="assets-upload-tile-icon">
                <CloudUpload size={24} />
              </span>
              <strong>上传素材</strong>
              <span>{activeFolderName ? `到「${activeFolderName}」` : '图片 / 视频 / 文档'}</span>
              <small>
                图片 ≤20MB · 视频 ≤200MB · 文档 ≤50MB
              </small>
            </button>
            {items.map((media) => {
              const extension = extensionOf(media.originalName)
              const duration = formatDuration(media.duration)
              return (
                <article className="asset-card" key={media.id}>
                  <button
                    type="button"
                    className={cn('asset-thumb', `is-${media.kind}`)}
                    onClick={() => setSelected(media)}
                    aria-label={`打开预览 ${media.originalName}`}
                  >
                    {media.kind === 'image' ? (
                      <img src={absoluteUrl(media.url)} alt={media.originalName} loading="lazy" />
                    ) : media.kind === 'video' ? (
                      <>
                        <video src={absoluteUrl(media.url)} muted playsInline preload="metadata" />
                        <span className="asset-video-play"><Play size={18} fill="currentColor" /></span>
                      </>
                    ) : (
                      <span className={cn('asset-doc-thumb', `is-${docTone(extension)}`)}>
                        <FileText size={30} />
                        <strong>{extension ? extension.toUpperCase() : 'DOC'}</strong>
                      </span>
                    )}
                    <span className={cn('asset-kind-chip', `is-${media.kind}`)}>
                      {kindIcon(media.kind)}
                      {kindLabel(media.kind)}
                    </span>
                    {duration ? <span className="asset-duration">{duration}</span> : null}
                  </button>
                  <div className="asset-card-body">
                    <button type="button" className="asset-name" onClick={() => setSelected(media)} title={media.originalName}>
                      {media.originalName}
                    </button>
                    <p>
                      {formatBytes(media.size)}
                      <span>·</span>
                      {relativeTime(media.createdAt)}
                    </p>
                  </div>
                  <div className="asset-card-actions">
                    <button type="button" onClick={() => setSelected(media)} aria-label={`预览 ${media.originalName}`} title="预览">
                      <Play size={14} />
                      预览
                    </button>
                    <button type="button" onClick={() => downloadMedia(media)} aria-label={`下载 ${media.originalName}`} title="下载">
                      <Download size={14} />
                    </button>
                    <Dropdown
                      align="end"
                      minWidth={190}
                      trigger={
                        <button type="button" className="asset-more" aria-label={`「${media.originalName}」更多操作`} title="更多操作">
                          <MoreHorizontal size={17} />
                        </button>
                      }
                      items={[
                        { key: 'preview', label: '预览', icon: <Play size={15} />, onSelect: () => setSelected(media) },
                        { key: 'move', label: '移动到文件夹', icon: <FolderInput size={15} />, onSelect: () => openMove(media) },
                        { key: 'copy', label: '复制链接', icon: <Copy size={15} />, onSelect: () => copyMediaLink(media) },
                        { key: 'open', label: '在新标签打开', icon: <ExternalLink size={15} />, onSelect: () => openMedia(media) },
                        { key: 'download', label: '下载', icon: <Download size={15} />, onSelect: () => downloadMedia(media) },
                        'separator',
                        { key: 'delete', label: '删除素材', icon: <Trash2 size={15} />, danger: true, onSelect: () => askDelete(media) },
                      ] satisfies DropdownEntry[]}
                    />
                  </div>
                </article>
              )
            })}
          </div>
          {items.length < total ? (
            <div className="assets-load-more">
              <button type="button" className="btn" onClick={() => setPage((value) => value + 1)} disabled={loading}>
                {loading ? <LoaderCircle size={15} className="spin" /> : null}
                {loading ? '加载中…' : `加载更多（${items.length}/${total}）`}
              </button>
            </div>
          ) : null}
        </>
      )}

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          void handleFiles(files)
        }}
      />

      {dragActive ? (
        <div className="assets-drop-overlay">
          <div>
            <CloudUpload size={30} />
            <strong>松开即可上传素材</strong>
            <span>支持图片、视频、PDF、Word、Excel、PPT、Markdown 等文档</span>
          </div>
        </div>
      ) : null}

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.originalName}
        subtitle={
          selected
            ? `${kindLabel(selected.kind)} · ${formatBytes(selected.size)} · ${formatDateTime(selected.createdAt)}`
            : undefined
        }
        size="wide"
        footer={
          selected ? (
            <div className="assets-preview-footer">
              <button type="button" className="btn" onClick={() => copyMediaLink(selected)}>
                <Copy size={15} />
                复制链接
              </button>
              <button type="button" className="btn" onClick={() => downloadMedia(selected)}>
                <Download size={15} />
                下载
              </button>
              <button type="button" className="btn btn-danger" onClick={() => askDelete(selected)}>
                <Trash2 size={15} />
                删除
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setSelected(null)}>
                关闭
              </button>
            </div>
          ) : undefined
        }
      >
        {selected ? (
          <div className="asset-preview">
            {selected.kind === 'image' ? (
              <img className="asset-preview-media" src={absoluteUrl(selected.url)} alt={selected.originalName} />
            ) : selected.kind === 'video' ? (
              <video className="asset-preview-media" src={absoluteUrl(selected.url)} controls autoPlay playsInline />
            ) : selectedIsPdf ? (
              <iframe className="asset-preview-frame" src={absoluteUrl(selected.url)} title={selected.originalName} />
            ) : selectedHasTextPreview ? (
              previewTextLoading ? (
                <div className="asset-preview-loading"><LoaderCircle size={18} className="spin" />正在读取文档…</div>
              ) : previewTextError ? (
                <div className="asset-preview-loading is-error">{previewTextError}</div>
              ) : previewText ? (
                selectedIsMarkdown ? (
                  <div className="asset-markdown-preview">
                    <div className="asset-markdown-label">Markdown 预览</div>
                    <article
                      className="asset-markdown"
                      dangerouslySetInnerHTML={{ __html: previewMarkdownHtml }}
                    />
                  </div>
                ) : (
                  <pre className="asset-preview-text">{previewText}</pre>
                )
              ) : (
                <div className="asset-preview-doc">
                  <FileText size={38} />
                  <strong>{selectedExtension.toUpperCase()}</strong>
                  <p>文档为空，或体积超过 1MB 无法在线预览。</p>
                </div>
              )
            ) : (
              <div className="asset-preview-doc">
                <FileText size={38} />
                <strong>{selectedExtension.toUpperCase() || '文档'}</strong>
                <p>该格式暂不支持在线预览，请下载后查看。</p>
              </div>
            )}
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除素材"
        description={
          <>
            确定要删除 <strong>「{deleteTarget?.originalName}」</strong> 吗？删除后，引用该素材的内容、图文或排版可能无法显示，且不可恢复。
          </>
        }
        confirmLabel="删除"
        loading={deleting}
        onConfirm={() => void removeMaterial()}
        onClose={() => {
          if (!deleting) setDeleteTarget(null)
        }}
      />

      <Modal
        open={folderDialog !== null}
        onClose={() => {
          if (!folderSaving) setFolderDialog(null)
        }}
        title={folderDialog?.mode === 'rename' ? '重命名文件夹' : '新建文件夹'}
        subtitle="用文件夹整理图片、视频和文档。"
        size="compact"
        closeOnBackdrop={!folderSaving}
        showClose={!folderSaving}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setFolderDialog(null)} disabled={folderSaving}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void submitFolder()}
              disabled={folderSaving || !folderName.trim()}
            >
              {folderSaving ? <LoaderCircle size={15} className="spin" /> : null}
              {folderSaving ? '保存中…' : folderDialog?.mode === 'rename' ? '保存名称' : '创建文件夹'}
            </button>
          </>
        }
      >
        <label className="assets-folder-field">
          <span>文件夹名称</span>
          <input
            className="input"
            value={folderName}
            onChange={(event) => {
              setFolderName(event.target.value)
              setFolderError('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submitFolder()
              }
            }}
            maxLength={40}
            autoFocus
            placeholder="例如：产品图、活动视频、品牌资料"
          />
          {folderError ? <p className="assets-folder-error">{folderError}</p> : null}
        </label>
      </Modal>

      <Modal
        open={Boolean(moveTarget)}
        onClose={() => {
          if (!moving) setMoveTarget(null)
        }}
        title="移动素材"
        subtitle={moveTarget ? `将「${moveTarget.originalName}」移动到：` : undefined}
        size="compact"
        closeOnBackdrop={!moving}
        showClose={!moving}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setMoveTarget(null)} disabled={moving}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void moveMaterial()} disabled={moving}>
              {moving ? <LoaderCircle size={15} className="spin" /> : null}
              {moving ? '移动中…' : '确认移动'}
            </button>
          </>
        }
      >
        <div className="assets-move-list">
          <label className="assets-move-option">
            <input
              type="radio"
              name="asset-folder"
              value="unfiled"
              checked={moveFolderId === 'unfiled'}
              onChange={() => setMoveFolderId('unfiled')}
            />
            <span className="assets-move-icon"><Inbox size={16} /></span>
            <span>
              <strong>未分组</strong>
              <small>不放入任何文件夹</small>
            </span>
          </label>
          {folders.map((folder) => (
            <label className="assets-move-option" key={folder.id}>
              <input
                type="radio"
                name="asset-folder"
                value={folder.id}
                checked={moveFolderId === folder.id}
                onChange={() => setMoveFolderId(folder.id)}
              />
              <span className="assets-move-icon"><Folder size={16} /></span>
              <span>
                <strong>{folder.name}</strong>
                <small>{folder.assetCount} 个素材</small>
              </span>
            </label>
          ))}
        </div>
        {folders.length === 0 ? <p className="assets-move-empty">还没有文件夹，关闭后点「新建文件夹」创建一个吧。</p> : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteFolderTarget)}
        title="删除文件夹"
        description={
          <>
            确定要删除文件夹 <strong>「{deleteFolderTarget?.name}」</strong> 吗？文件夹中的{' '}
            <strong>{deleteFolderTarget?.assetCount ?? 0}</strong> 个素材会移动到「未分组」，素材本身不会被删除。
          </>
        }
        confirmLabel="删除文件夹"
        loading={deletingFolder}
        onConfirm={() => void removeFolder()}
        onClose={() => {
          if (!deletingFolder) setDeleteFolderTarget(null)
        }}
      />
    </div>
  )
}
