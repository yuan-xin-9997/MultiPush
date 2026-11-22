import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CircleAlert,
  CloudUpload,
  Copy,
  Download,
  FileDown,
  FolderOpen,
  GripVertical,
  ImagePlus,
  Images,
  LoaderCircle,
  MoreHorizontal,
  Sparkles,
  Star,
  Trash2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ContentDetail, ContentInput, ContentStatus, MediaAsset, RichTextJson } from '@shared/types'
import { api, absoluteUrl } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { exportContentFile, type ExportFormat } from '@/lib/content-io'
import { cn, escapeHtml, formatBytes } from '@/lib/utils'
import { imageSizeFromHeaders } from './image-meta'
import ConfirmDialog from '@/components/ConfirmDialog'
import Dropdown, { type DropdownEntry } from '@/components/Dropdown'
import EmptyState from '@/components/EmptyState'
import MediaPicker from '@/components/MediaPicker'
import './gallery.css'

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'

interface GalleryImage {
  /** Client-only key so reorder/removal does not remount inputs. */
  id: string
  src: string
  alt: string
  caption: string
}

interface GalleryDraft {
  images: GalleryImage[]
  body: string
}

interface GalleryImageMeta {
  width?: number
  height?: number
  size?: number | null
  sizeLoaded?: boolean
}

const MAX_IMAGES = 35
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const SAVE_DELAY = 800
const DEFAULT_TITLE = '无标题图文'

const TARGETS = [
  { id: 'wechatpic', name: '公众号贴图', limit: 20, note: '图片消息 · 正文为纯文本' },
  { id: 'xiaohongshu', name: '小红书', limit: 18, note: '3:4 图文卡片' },
  { id: 'douyin', name: '抖音图文', limit: 35, note: '竖屏图文 · 标题 + 配文' },
]

let imageSequence = 0
function imageId(): string {
  imageSequence += 1
  return `gallery-image-${imageSequence}`
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
}

function bodyLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseTags(value: string): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  for (const raw of value.split(/[,，\n]/)) {
    const tag = raw.trim()
    if (!tag) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= 10) break
  }
  return tags
}

function nodeText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  let text = typeof record.text === 'string' ? record.text : ''
  if (record.type === 'hardBreak') text += '\n'
  if (Array.isArray(record.content)) {
    for (const child of record.content) text += nodeText(child)
  }
  return text
}

function imageFromNode(node: Record<string, unknown>): { src: string; alt: string } | null {
  const attrs = node.attrs && typeof node.attrs === 'object' ? (node.attrs as Record<string, unknown>) : {}
  const src = typeof attrs.src === 'string' ? attrs.src.trim() : ''
  if (!src) return null
  return { src, alt: typeof attrs.alt === 'string' ? attrs.alt : '' }
}

/** Read the gallery model out of the canonical Tiptap document. */
function galleryFromDoc(value: unknown): GalleryDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const doc = value as Record<string, unknown>
  if (doc.type !== 'doc' || !Array.isArray(doc.content)) return null

  const images: GalleryImage[] = []
  const body: string[] = []
  for (const raw of doc.content) {
    if (!raw || typeof raw !== 'object') continue
    const node = raw as Record<string, unknown>
    if (node.type === 'figure') {
      const children = Array.isArray(node.content) ? node.content : []
      const imageNode = children.find(
        (child): child is Record<string, unknown> =>
          Boolean(child) && typeof child === 'object' && (child as Record<string, unknown>).type === 'image',
      )
      const captionNode = children.find(
        (child): child is Record<string, unknown> =>
          Boolean(child) && typeof child === 'object' && (child as Record<string, unknown>).type === 'figcaption',
      )
      const image = imageNode ? imageFromNode(imageNode) : null
      if (image) {
        images.push({
          id: imageId(),
          src: image.src,
          alt: image.alt,
          caption: captionNode ? nodeText(captionNode).replace(/\s+/g, ' ').trim() : '',
        })
      }
      continue
    }
    if (node.type === 'image') {
      const image = imageFromNode(node)
      if (image) images.push({ id: imageId(), src: image.src, alt: image.alt, caption: '' })
      continue
    }
    const text = nodeText(node).replace(/\s+/g, ' ').trim()
    if (text) body.push(text)
  }
  return { images, body: body.join('\n') }
}

/** Fallback for older / API-only HTML edits where the JSON is stale. */
function galleryFromHtml(html: string): GalleryDraft {
  if (!html.trim()) return { images: [], body: '' }
  try {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const images: GalleryImage[] = []
    document.querySelectorAll('img').forEach((image) => {
      const src = image.getAttribute('src')?.trim() ?? ''
      if (!src) return
      const figure = image.closest('figure')
      const caption = figure?.querySelector('figcaption')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      images.push({
        id: imageId(),
        src,
        alt: image.getAttribute('alt') ?? '',
        caption,
      })
    })

    const bodyRoot = document.body.cloneNode(true) as HTMLElement
    bodyRoot.querySelectorAll('figure, img, figcaption, video, source, script, style').forEach((element) => element.remove())
    const blocks: string[] = []
    bodyRoot.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote, pre, li').forEach((element) => {
      if (element.tagName === 'LI' && element.querySelector('p')) return
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) blocks.push(text)
    })
    if (blocks.length === 0) {
      const text = (bodyRoot.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) blocks.push(text)
    }
    return { images, body: blocks.join('\n') }
  } catch {
    return { images: [], body: '' }
  }
}

function buildGalleryDoc(images: GalleryImage[], body: string): RichTextJson {
  const content: unknown[] = []
  for (const image of images) {
    const attrs: Record<string, unknown> = {
      src: image.src,
      alt: image.alt || image.caption || '',
      title: null,
    }
    const figureContent: unknown[] = [{ type: 'image', attrs }]
    const caption = image.caption.trim()
    if (caption) {
      figureContent.push({ type: 'figcaption', content: [{ type: 'text', text: caption }] })
    }
    content.push({ type: 'figure', content: figureContent })
  }
  for (const line of bodyLines(body)) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] })
  }
  return { type: 'doc', content }
}

function buildGalleryHtml(images: GalleryImage[], body: string): string {
  const figures = images
    .map((image) => {
      const caption = image.caption.trim()
      return `<figure><img src="${escapeAttribute(image.src)}" alt="${escapeAttribute(
        image.alt || image.caption || '',
      )}">${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`
    })
    .join('')
  const paragraphs = bodyLines(body)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('')
  return `${figures}${paragraphs}`
}

function excerptFor(images: GalleryImage[], body: string): string {
  const text =
    body.trim() ||
    images
      .map((image) => image.caption.trim())
      .filter(Boolean)
      .join(' ') ||
    images[0]?.alt ||
    ''
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 160).join('')
}

function effectiveCover(images: GalleryImage[], cover: string | null): string | null {
  if (cover && images.some((image) => image.src === cover)) return cover
  return images[0]?.src ?? null
}

function imageAlt(image: GalleryImage, index: number): string {
  return image.caption.trim() || image.alt.trim() || `图文图片 ${index + 1}`
}

export default function GalleryPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [content, setContent] = useState<ContentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [images, setImages] = useState<GalleryImage[]>([])
  const [imageMeta, setImageMeta] = useState<Record<string, GalleryImageMeta>>({})
  const imageSizeCache = useRef<Map<string, Promise<number | null>>>(new Map())
  const [coverImage, setCoverImage] = useState<string | null>(null)
  const [tagsInput, setTagsInput] = useState('')
  const [status, setStatus] = useState<ContentStatus>('draft')
  const [favorite, setFavorite] = useState(false)

  const [dirty, setDirty] = useState(false)
  const [revision, setRevision] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null)
  const [assetPickerOpen, setAssetPickerOpen] = useState(false)
  const [uploadTotal, setUploadTotal] = useState(0)
  const [dragActive, setDragActive] = useState(false)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [duplicating, setDuplicating] = useState(false)

  const titleRef = useRef('')
  const bodyRef = useRef('')
  const imagesRef = useRef<GalleryImage[]>([])
  const coverRef = useRef<string | null>(null)
  const tagsRef = useRef('')
  const statusRef = useRef<ContentStatus>('draft')
  const favoriteRef = useRef(false)
  const idRef = useRef(id)

  const readyRef = useRef(false)
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const pendingRef = useRef(false)
  const revisionRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  titleRef.current = title
  bodyRef.current = body
  imagesRef.current = images
  coverRef.current = coverImage
  tagsRef.current = tagsInput
  statusRef.current = status
  favoriteRef.current = favorite
  idRef.current = id

  const markDirty = useCallback(() => {
    if (!readyRef.current) return
    dirtyRef.current = true
    revisionRef.current += 1
    setDirty(true)
    setRevision(revisionRef.current)
    setSaveState('unsaved')
  }, [])

  // --------------------------------------------------------------- data load

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    readyRef.current = false
    dirtyRef.current = false
    setDirty(false)
    setSaveState('saved')
    setLastSavedAt(null)
    setContent(null)

    if (!id) {
      setLoading(false)
      setLoadError('缺少图文参数')
      return
    }

    api.contents
      .get(id)
      .then(({ content: detail }) => {
        if (cancelled) return
        if (detail.kind === 'video') {
          navigate(`/video/${detail.id}`, { replace: true })
          return
        }
        if (detail.kind !== 'gallery') {
          navigate(`/editor/${detail.id}`, { replace: true })
          return
        }

        const fromJson =
          detail.contentJsonStale === true ? null : galleryFromDoc(detail.contentJson)
        const draft =
          fromJson && (fromJson.images.length > 0 || fromJson.body.trim().length > 0)
            ? fromJson
            : galleryFromHtml(detail.contentHtml)
        const nextCover =
          detail.coverImage && draft.images.some((image) => image.src === detail.coverImage)
            ? detail.coverImage
            : draft.images[0]?.src ?? null

        setContent(detail)
        setTitle(detail.title)
        setBody(draft.body)
        setImages(draft.images)
        setImageMeta({})
        setCoverImage(nextCover)
        setTagsInput(detail.tags.join(', '))
        setStatus(detail.status)
        setFavorite(detail.favorite)
        setLastSavedAt(new Date(detail.updatedAt))

        titleRef.current = detail.title
        bodyRef.current = draft.body
        imagesRef.current = draft.images
        coverRef.current = nextCover
        tagsRef.current = detail.tags.join(', ')
        statusRef.current = detail.status
        favoriteRef.current = detail.favorite
        readyRef.current = true
        revisionRef.current = 0
        setRevision(0)
        setLoading(false)
      })
      .catch((error) => {
        if (cancelled) return
        setLoading(false)
        setLoadError(getErrorMessage(error, '加载图文失败'))
      })

    return () => {
      cancelled = true
    }
  }, [id, navigate])

  // --------------------------------------------------------------- saving

  const saveNow = useCallback(async (force = false): Promise<boolean> => {
    const contentId = idRef.current
    if (!contentId || !readyRef.current) return false
    if (!force && !dirtyRef.current) return true
    if (savingRef.current) {
      pendingRef.current = true
      return false
    }

    savingRef.current = true
    setSaveState('saving')
    const revisionAtStart = revisionRef.current
    try {
      const payload: ContentInput = {
        title: titleRef.current.trim() || DEFAULT_TITLE,
        contentJson: buildGalleryDoc(imagesRef.current, bodyRef.current),
        contentHtml: buildGalleryHtml(imagesRef.current, bodyRef.current),
        excerpt: excerptFor(imagesRef.current, bodyRef.current),
        coverImage: effectiveCover(imagesRef.current, coverRef.current),
        tags: parseTags(tagsRef.current),
        status: statusRef.current,
        favorite: favoriteRef.current,
      }
      const { content: updated } = await api.contents.update(contentId, payload)
      setContent(updated)
      const stillDirty = revisionRef.current !== revisionAtStart
      if (!stillDirty) {
        dirtyRef.current = false
        setDirty(false)
        setSaveState('saved')
        setLastSavedAt(new Date())
      } else {
        setSaveState('unsaved')
      }
      return !stillDirty
    } catch (error) {
      setSaveState('error')
      toast.error(getErrorMessage(error, '保存失败，请重试'))
      return false
    } finally {
      savingRef.current = false
      if (pendingRef.current) {
        pendingRef.current = false
        if (dirtyRef.current) window.setTimeout(() => void saveNow(false), 30)
      }
    }
  }, [])

  useEffect(() => {
    if (!dirty) return
    const timer = window.setTimeout(() => {
      void saveNow(false)
    }, SAVE_DELAY)
    return () => window.clearTimeout(timer)
  }, [dirty, revision, saveNow])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveNow(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveNow])

  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // --------------------------------------------------------------- images

  const registerImageMeta = useCallback((image: GalleryImage, element: HTMLImageElement) => {
    const width = element.naturalWidth || undefined
    const height = element.naturalHeight || undefined
    if (!width || !height) return
    setImageMeta((current) => ({
      ...current,
      [image.id]: { ...current[image.id], width, height },
    }))
    let request = imageSizeCache.current.get(image.src)
    if (!request) {
      request = fetch(absoluteUrl(image.src), { method: 'HEAD', credentials: 'same-origin' })
        .then((response) => response.ok ? imageSizeFromHeaders(response.headers) : null)
        .catch(() => null)
      imageSizeCache.current.set(image.src, request)
    }
    void request.then((size) => {
      setImageMeta((current) => ({
        ...current,
        [image.id]: { ...current[image.id], width, height, size, sizeLoaded: true },
      }))
    })
  }, [])

  const appendUploaded = useCallback(
    (entries: Array<{ src: string; alt: string }>) => {
      if (entries.length === 0) return
      const room = MAX_IMAGES - imagesRef.current.length
      const accepted = entries.slice(0, Math.max(0, room))
      if (accepted.length === 0) {
        toast.error(`最多添加 ${MAX_IMAGES} 张图片`)
        return
      }
      if (accepted.length < entries.length) {
        toast.error(`最多添加 ${MAX_IMAGES} 张图片，已忽略多余文件`)
      }
      const next = [
        ...imagesRef.current,
        ...accepted.map((entry) => ({
          id: imageId(),
          src: entry.src,
          alt: entry.alt,
          caption: '',
        })),
      ]
      imagesRef.current = next
      setImages(next)
      if (!coverRef.current) {
        const first = next[0]?.src ?? null
        coverRef.current = first
        setCoverImage(first)
      }
      markDirty()
    },
    [markDirty],
  )

  const addLibraryImages = useCallback(
    (assets: MediaAsset[]) => {
      const room = Math.max(0, MAX_IMAGES - imagesRef.current.length)
      const accepted = assets.slice(0, room)
      if (accepted.length === 0) {
        toast.error(`最多添加 ${MAX_IMAGES} 张图片`)
        return
      }
      if (accepted.length < assets.length) {
        toast.error(`最多添加 ${MAX_IMAGES} 张图片，已忽略多余图片`)
      }
      appendUploaded(
        accepted.map((media) => ({
          src: media.url,
          alt: media.originalName.replace(/\.[^.]+$/, ''),
        })),
      )
      toast.success(accepted.length === 1 ? '图片已从素材库添加' : `${accepted.length} 张图片已从素材库添加`)
    },
    [appendUploaded],
  )

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!readyRef.current || files.length === 0) return
      const imagesOnly = files.filter((file) => {
        if (!file.type.startsWith('image/')) {
          toast.error(`「${file.name}」不是图片文件`)
          return false
        }
        if (file.size > MAX_IMAGE_BYTES) {
          toast.error(`「${file.name}」超过 ${formatBytes(MAX_IMAGE_BYTES)}，已跳过`)
          return false
        }
        return true
      })
      if (imagesOnly.length === 0) return
      const room = Math.max(0, MAX_IMAGES - imagesRef.current.length)
      if (room === 0) {
        toast.error(`最多添加 ${MAX_IMAGES} 张图片`)
        return
      }
      const selected = imagesOnly.slice(0, room)
      if (selected.length < imagesOnly.length) {
        toast.error(`最多添加 ${MAX_IMAGES} 张图片，已忽略多余文件`)
      }

      setUploadTotal(selected.length)
      const uploaded: Array<{ src: string; alt: string }> = []
      for (const file of selected) {
        try {
          setUploading({ name: file.name, percent: 0 })
          const { media } = await api.media.upload(file, (percent) => {
            setUploading((current) => (current && current.name === file.name ? { ...current, percent } : current))
          })
          uploaded.push({
            src: media.url,
            alt: media.originalName.replace(/\.[^.]+$/, ''),
          })
        } catch (error) {
          toast.error(getErrorMessage(error, `「${file.name}」上传失败`))
        }
      }
      setUploading(null)
      setUploadTotal(0)
      appendUploaded(uploaded)
      if (uploaded.length > 0) {
        toast.success(uploaded.length === 1 ? '图片已添加' : `${uploaded.length} 张图片已添加`)
      }
    },
    [appendUploaded],
  )

  function updateCaption(index: number, value: string) {
    const next = imagesRef.current.map((image, current) =>
      current === index ? { ...image, caption: value } : image,
    )
    imagesRef.current = next
    setImages(next)
    markDirty()
  }

  function moveImage(from: number, to: number) {
    const current = imagesRef.current
    if (from === to || from < 0 || to < 0 || from >= current.length || to >= current.length) return
    const next = current.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    imagesRef.current = next
    setImages(next)
    markDirty()
  }

  function removeImage(index: number) {
    const current = imagesRef.current
    const removed = current[index]
    if (!removed) return
    const next = current.filter((_, currentIndex) => currentIndex !== index)
    imagesRef.current = next
    setImages(next)
    if (coverRef.current === removed.src) {
      const nextCover = next[0]?.src ?? null
      coverRef.current = nextCover
      setCoverImage(nextCover)
    }
    markDirty()
  }

  function chooseCover(src: string) {
    if (coverRef.current === src) return
    coverRef.current = src
    setCoverImage(src)
    markDirty()
  }

  // --------------------------------------------------------------- actions

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

  const currentDetail = useMemo((): ContentDetail | null => {
    if (!content) return null
    return {
      ...content,
      title: title.trim() || DEFAULT_TITLE,
      contentJson: buildGalleryDoc(images, body),
      contentHtml: buildGalleryHtml(images, body),
      excerpt: excerptFor(images, body),
      coverImage: effectiveCover(images, coverImage),
      tags: parseTags(tagsInput),
      status,
      favorite,
      imageCount: images.length,
    }
  }, [content, title, images, body, coverImage, tagsInput, status, favorite])

  async function goBack() {
    if (savingRef.current) {
      toast.error('正在保存，请稍候再离开')
      return
    }
    if (dirtyRef.current) {
      const saved = await saveNow(false)
      if (!saved && dirtyRef.current) return
    }
    navigate('/library')
  }

  async function handleRender() {
    if (savingRef.current) {
      toast.error('正在保存，请稍候再渲染')
      return
    }
    const saved = await saveNow(true)
    if (!saved && dirtyRef.current) {
      toast.error('请先成功保存后再渲染')
      return
    }
    navigate(`/render?contentId=${id}&platforms=wechatpic,xiaohongshu,douyin`)
  }

  async function handleExport(format: ExportFormat) {
    if (savingRef.current) return
    const saved = await saveNow(true)
    if (!saved && dirtyRef.current) {
      toast.error('保存失败，暂不能导出')
      return
    }
    const detail = currentDetail
    if (!detail) return
    exportContentFile(detail, format)
    toast.success('导出文件已开始下载')
  }

  async function handleDuplicate() {
    if (!id || duplicating) return
    if (savingRef.current) {
      toast.error('正在保存，请稍候再复制')
      return
    }
    const saved = await saveNow(true)
    if (!saved && dirtyRef.current) {
      toast.error('保存失败，暂不能复制')
      return
    }
    setDuplicating(true)
    try {
      const { content: copy } = await api.contents.duplicate(id)
      toast.success('图文已复制')
      navigate(`/gallery/${copy.id}`)
    } catch (error) {
      toast.error(getErrorMessage(error, '复制失败'))
    } finally {
      setDuplicating(false)
    }
  }

  async function handleDelete() {
    if (!id || deleting) return
    if (savingRef.current) {
      toast.error('正在保存，请稍候再删除')
      return
    }
    setDeleting(true)
    try {
      await api.contents.remove(id)
      toast.success('图文已移入回收站')
      navigate('/library')
    } catch (error) {
      toast.error(getErrorMessage(error, '删除失败'))
    } finally {
      setDeleting(false)
    }
  }

  function toggleFavorite() {
    const next = !favoriteRef.current
    favoriteRef.current = next
    setFavorite(next)
    markDirty()
  }

  // --------------------------------------------------------------- render

  const moreItems: DropdownEntry[] = [
    {
      key: 'duplicate',
      label: '复制图文',
      icon: <Copy size={15} />,
      onSelect: () => void handleDuplicate(),
    },
    {
      key: 'export',
      label: '导出',
      icon: <Download size={15} />,
      submenu: [
        {
          key: 'export-markdown',
          label: 'Markdown',
          icon: <FileDown size={15} />,
          hint: '.md',
          onSelect: () => void handleExport('markdown'),
        },
        {
          key: 'export-html',
          label: 'HTML',
          icon: <FileDown size={15} />,
          hint: '.html',
          onSelect: () => void handleExport('html'),
        },
        {
          key: 'export-json',
          label: 'MultiPush JSON',
          icon: <FileDown size={15} />,
          hint: '.json',
          onSelect: () => void handleExport('json'),
        },
      ],
    },
    'separator',
    {
      key: 'delete',
      label: '删除图文',
      icon: <Trash2 size={15} />,
      danger: true,
      onSelect: () => setDeleteOpen(true),
    },
  ]

  if (loading) {
    return (
      <div className="gallery-page gallery-state-page">
        <LoaderCircle size={18} className="spin" />
        正在打开图文…
      </div>
    )
  }

  if (loadError || !content) {
    return (
      <div className="gallery-page gallery-state-page">
        <EmptyState
          icon={<CircleAlert size={22} />}
          title="图文无法打开"
          description={loadError || '图文不存在或已被删除。'}
          action={
            <button type="button" className="btn" onClick={() => navigate('/library')}>
              <ArrowLeft size={15} />
              返回内容库
            </button>
          }
        />
      </div>
    )
  }

  const selectedCover = effectiveCover(images, coverImage)
  const captions = images.filter((image) => image.caption.trim()).length
  const bodyCharacters = Array.from(body.replace(/\s/g, '')).length
  const platformWarnings: string[] = []
  if (images.length === 0) platformWarnings.push('还没有图片：贴图、抖音图文和小红书都至少需要 1 张图片。')
  if (images.length > 20) platformWarnings.push('公众号贴图最多 20 张，发布时会按顺序取前 20 张。')
  if (images.length > 18) platformWarnings.push('小红书最多 18 张，建议精简图片。')
  if (bodyCharacters > 1000) platformWarnings.push('小红书和抖音正文建议控制在 1000 字以内。')

  return (
    <div className="gallery-page">
      <header className="gallery-topbar">
        <div className="gallery-topbar-left">
          <button type="button" className="gallery-icon-btn" onClick={() => void goBack()} aria-label="返回内容库">
            <ArrowLeft size={18} />
          </button>
          <span className="gallery-kind-pill">
            <Images size={14} />
            图文
          </span>
          <span className={cn('gallery-save-state', saveState === 'saving' && 'is-saving', saveState === 'error' && 'is-error')}>
            {saveState === 'saving' ? <LoaderCircle size={13} className="spin" /> : null}
            {saveState === 'saved' ? <Check size={13} /> : null}
            {saveLabel}
          </span>
        </div>
        <div className="gallery-topbar-right">
          <button
            type="button"
            className={cn('gallery-icon-btn', favorite && 'is-active')}
            onClick={toggleFavorite}
            aria-label={favorite ? '取消收藏' : '收藏图文'}
            title={favorite ? '取消收藏' : '收藏图文'}
          >
            <Star size={17} fill={favorite ? 'currentColor' : 'none'} />
          </button>
          <button type="button" className="btn btn-primary gallery-render-btn" onClick={() => void handleRender()}>
            <Sparkles size={16} />
            渲染
          </button>
          <Dropdown
            align="end"
            minWidth={190}
            trigger={
              <button type="button" className="gallery-icon-btn" aria-label="更多操作" title="更多操作">
                <MoreHorizontal size={18} />
              </button>
            }
            items={moreItems}
          />
        </div>
      </header>

      <div className="gallery-layout">
        <main className="gallery-main">
          <div className="gallery-title-wrap">
            <input
              className="gallery-title-input"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value)
                markDirty()
              }}
              placeholder={DEFAULT_TITLE}
              aria-label="图文标题"
            />
            <p className="gallery-title-hint">标题 + 图片 + 配文，可直接渲染到公众号贴图、小红书和抖音图文。</p>
          </div>

          <section
            className={cn('gallery-images-card', dragActive && 'is-drag-active')}
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
              void uploadFiles(Array.from(event.dataTransfer.files))
            }}
          >
            <div className="gallery-section-head">
              <div>
                <h2>
                  图片
                  <span className="gallery-count">{images.length}</span>
                </h2>
                <p>按顺序排好，拖动手柄或使用箭头调整；星标决定封面。</p>
              </div>
              <div className="gallery-section-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setAssetPickerOpen(true)}
                  disabled={Boolean(uploading) || images.length >= MAX_IMAGES}
                >
                  <FolderOpen size={15} />
                  从素材库添加
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={Boolean(uploading) || images.length >= MAX_IMAGES}
                >
                  <ImagePlus size={15} />
                  添加图片
                </button>
              </div>
            </div>

            {uploading ? (
              <div className="gallery-upload" role="status" aria-live="polite">
                <div className="gallery-upload-copy">
                  <Upload size={15} />
                  <span>
                    正在上传 {uploading.name}
                    {uploadTotal > 1 ? `（本批共 ${uploadTotal} 张）` : ''}
                  </span>
                  <strong>{uploading.percent}%</strong>
                </div>
                <div className="gallery-upload-track">
                  <span style={{ width: `${uploading.percent}%` }} />
                </div>
              </div>
            ) : null}

            {images.length === 0 ? (
              <button type="button" className="gallery-dropzone" onClick={() => fileInputRef.current?.click()}>
                <span className="gallery-dropzone-icon">
                  <CloudUpload size={26} />
                </span>
                <strong>拖拽图片到这里，或点击上传</strong>
                <span>支持 JPG / PNG / WebP / GIF，单张不超过 20 MB，最多 {MAX_IMAGES} 张</span>
              </button>
            ) : (
              <div className="gallery-grid">
                {images.map((image, index) => (
                  <article
                    key={image.id}
                    className={cn(
                      'gallery-image-card',
                      dropIndex === index && draggingIndex !== null && draggingIndex !== index && 'is-drop-target',
                      draggingIndex === index && 'is-dragging',
                    )}
                    onDragOver={(event) => {
                      if (draggingIndex === null) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      if (dropIndex !== index) setDropIndex(index)
                    }}
                    onDrop={(event) => {
                      if (draggingIndex === null) return
                      event.preventDefault()
                      moveImage(draggingIndex, index)
                      setDraggingIndex(null)
                      setDropIndex(null)
                    }}
                  >
                    <div className="gallery-image-frame">
                      <img
                        src={absoluteUrl(image.src)}
                        alt={imageAlt(image, index)}
                        loading="lazy"
                        onLoad={(event) => registerImageMeta(image, event.currentTarget)}
                        onError={() => setImageMeta((current) => ({
                          ...current,
                          [image.id]: { ...current[image.id], sizeLoaded: true },
                        }))}
                      />
                      <span className="gallery-image-index">{index + 1}</span>
                      {selectedCover === image.src ? (
                        <span className="gallery-cover-flag">
                          <Star size={11} fill="currentColor" />
                          封面
                        </span>
                      ) : null}
                      <div className="gallery-image-toolbar">
                        <button
                          type="button"
                          className="gallery-image-tool gallery-drag-handle"
                          draggable
                          onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData('text/plain', String(index))
                            setDraggingIndex(index)
                            setDropIndex(index)
                          }}
                          onDragEnd={() => {
                            setDraggingIndex(null)
                            setDropIndex(null)
                          }}
                          aria-label={`拖动第 ${index + 1} 张图片排序`}
                          title="拖动排序"
                        >
                          <GripVertical size={14} />
                        </button>
                        <div className="gallery-image-toolbar-group">
                          <button
                            type="button"
                            className="gallery-image-tool"
                            onClick={() => moveImage(index, index - 1)}
                            disabled={index === 0}
                            aria-label="前移一位"
                            title="前移"
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            className="gallery-image-tool"
                            onClick={() => moveImage(index, index + 1)}
                            disabled={index === images.length - 1}
                            aria-label="后移一位"
                            title="后移"
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            type="button"
                            className={cn('gallery-image-tool', selectedCover === image.src && 'is-active')}
                            onClick={() => chooseCover(image.src)}
                            aria-label="设为封面"
                            title={selectedCover === image.src ? '当前封面' : '设为封面'}
                          >
                            <Star size={14} fill={selectedCover === image.src ? 'currentColor' : 'none'} />
                          </button>
                          <button
                            type="button"
                            className="gallery-image-tool is-danger"
                            onClick={() => removeImage(index)}
                            aria-label="删除图片"
                            title="删除图片"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="gallery-image-meta" aria-label={`第 ${index + 1} 张图片信息`}>
                      <span>
                        {imageMeta[image.id]?.width && imageMeta[image.id]?.height
                          ? `${imageMeta[image.id].width} × ${imageMeta[image.id].height}`
                          : '尺寸读取中…'}
                      </span>
                      <span>
                        {imageMeta[image.id]?.size != null
                          ? formatBytes(imageMeta[image.id].size!)
                          : imageMeta[image.id]?.sizeLoaded
                            ? '大小未知'
                            : '大小读取中…'}
                      </span>
                    </div>
                    <input
                      className="gallery-caption-input"
                      value={image.caption}
                      onChange={(event) => updateCaption(index, event.target.value)}
                      placeholder="图片说明（可选）"
                      aria-label={`第 ${index + 1} 张图片说明`}
                    />
                  </article>
                ))}
                <button
                  type="button"
                  className="gallery-add-tile"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={Boolean(uploading) || images.length >= MAX_IMAGES}
                >
                  <ImagePlus size={22} />
                  <span>添加图片</span>
                  <small>
                    {images.length}/{MAX_IMAGES}
                  </small>
                </button>
              </div>
            )}

            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                void uploadFiles(files)
              }}
            />

            {dragActive ? (
              <div className="gallery-drop-overlay">
                <CloudUpload size={24} />
                松开即可添加图片
              </div>
            ) : null}
          </section>

          <section className="gallery-copy-card">
            <div className="gallery-section-head">
              <div>
                <h2>配文</h2>
                <p>标题和配文会进入小红书笔记、抖音文案与公众号贴图的正文。</p>
              </div>
              <span className="gallery-copy-count">{bodyCharacters} 字</span>
            </div>
            <textarea
              className="gallery-copy-input"
              value={body}
              onChange={(event) => {
                setBody(event.target.value)
                markDirty()
              }}
              placeholder="写下图片背后的故事、发布说明或想带的话题…"
              rows={8}
              aria-label="图文配文"
            />
          </section>
        </main>

        <aside className="gallery-side">
          <section className="gallery-side-card">
            <h2>封面</h2>
            <div className="gallery-cover-preview">
              {selectedCover ? (
                <img src={absoluteUrl(selectedCover)} alt="图文封面" />
              ) : (
                <span>
                  <Images size={22} />
                  尚未选择封面
                </span>
              )}
            </div>
            <p>默认使用第一张图片；在图片上点击星标即可更换。</p>
          </section>

          <section className="gallery-side-card">
            <h2>发布信息</h2>
            <label className="gallery-field">
              <span>标签</span>
              <input
                className="input"
                value={tagsInput}
                onChange={(event) => {
                  setTagsInput(event.target.value)
                  markDirty()
                }}
                placeholder="旅行, 城市, 摄影"
              />
              <small>用逗号分隔，最多 10 个；渲染时会转成话题。</small>
            </label>
            <label className="gallery-field">
              <span>状态</span>
              <select
                className="select"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value === 'ready' ? 'ready' : 'draft')
                  markDirty()
                }}
              >
                <option value="draft">草稿</option>
                <option value="ready">待发布</option>
              </select>
            </label>
          </section>

          <section className="gallery-side-card">
            <h2>图片平台适配</h2>
            <ul className="gallery-targets">
              {TARGETS.map((target) => (
                <li key={target.id}>
                  <span className={cn('gallery-target-dot', `is-${target.id}`)} />
                  <div>
                    <strong>{target.name}</strong>
                    <small>{target.note}</small>
                  </div>
                  <em className={cn(images.length > target.limit && 'is-over')}>
                    {images.length}/{target.limit}
                  </em>
                </li>
              ))}
            </ul>
            {platformWarnings.length > 0 ? (
              <div className="gallery-warnings">
                {platformWarnings.map((warning) => (
                  <p key={warning}>
                    <CircleAlert size={13} />
                    {warning}
                  </p>
                ))}
              </div>
            ) : (
              <p className="gallery-ok">
                <Check size={13} />
                图片数量适配当前平台。
              </p>
            )}
          </section>

          <section className="gallery-side-card gallery-side-stats">
            <div>
              <strong>{images.length}</strong>
              <span>张图片</span>
            </div>
            <div>
              <strong>{captions}</strong>
              <span>条图注</span>
            </div>
            <div>
              <strong>{bodyCharacters}</strong>
              <span>字配文</span>
            </div>
          </section>

          <button type="button" className="gallery-delete" onClick={() => setDeleteOpen(true)}>
            <Trash2 size={15} />
            删除这篇图文
          </button>
        </aside>
      </div>

      <MediaPicker
        open={assetPickerOpen}
        onClose={() => setAssetPickerOpen(false)}
        onSelect={addLibraryImages}
        kinds={['image']}
        title="从素材库添加图片"
      />

      <ConfirmDialog
        open={deleteOpen}
        title="删除图文"
        description={
          <>
            确定要删除 <strong>「{title.trim() || DEFAULT_TITLE}」</strong> 吗？图文会先进入回收站，可随时恢复。
          </>
        }
        confirmLabel="删除"
        loading={deleting}
        onConfirm={() => void handleDelete()}
        onClose={() => {
          if (!deleting) setDeleteOpen(false)
        }}
      />
    </div>
  )
}
