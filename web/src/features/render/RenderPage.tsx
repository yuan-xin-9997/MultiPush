import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toPng } from 'html-to-image'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  FileJson,
  FileText,
  Heart,
  History,
  Image as ImageIcon,
  Layers,
  LoaderCircle,
  MessageCircle,
  Music2,
  Package,
  Palette,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Share2,
  Sparkles,
  Trash2,
  TriangleAlert,
  Video,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  PLATFORMS,
  PLATFORM_ORDER,
  getPlatformInfo,
  type ContentSummary,
  type PlatformId,
  type PlatformRender,
  type RenderListItem,
  type RenderOptions,
  type RenderRecord,
  type XhsCard,
  type PlatformAdjustment,
} from '@shared/types'
import { getCaptionBody, parsePreferences, publishChecks } from '@shared/render-workbench'
import { absoluteUrl, api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { getErrorMessage } from '@/lib/errors'
import { formatNumber } from '@/lib/format'
import { formatDate, formatDateTime, relativeTime, safeFilename, copyRichHtml, copyText, downloadBlob } from '@/lib/utils'
import {
  buildAllZip,
  buildXhsZip,
  cardImageFilename,
  dateStamp,
  downloadsFor,
  downloadRenderFile,
  htmlForClipboard,
  plainTextFromHtml,
  xhsBodyFromText,
  type ExportedCardImage,
  type ExportReport,
} from './downloads'
import {
  CARD_STYLE_OPTIONS,
  resolveCardStyle,
  type CardStyle,
} from './types'
import { useElementWidth } from './hooks'
import PlatformGlyph from './platform-glyph'
import XhsCardView from './XhsCardView'
import PlatformEditor from './PlatformEditor'
import { layoutCards, overflowingText, verifyCardImages } from './card-layout'
import ConfirmDialog from '@/components/ConfirmDialog'
import Modal from '@/components/Modal'
import EmptyState from '@/components/EmptyState'
import './render.css'

const DEFAULT_PLATFORMS: PlatformId[] = ['wechat', 'xiaohongshu', 'zhihu', 'douyin']

const DOWNLOAD_LABELS = {
  html: 'HTML 页面',
  markdown: 'Markdown',
  text: '纯文本 / 文案',
  json: 'JSON 数据',
} as const

const DOWNLOAD_ICONS = {
  html: FileCode2,
  markdown: FileText,
  text: FileText,
  json: FileJson,
} as const

function renderSignature(contentId: string | null | undefined, platforms: PlatformId[], options: RenderOptions): string {
  return JSON.stringify({
    contentId: contentId ?? '',
    platforms: [...platforms].sort(),
    cardStyle: resolveCardStyle(options.cardStyle),
    includeTags: options.includeTags !== false,
    includeToc: options.includeToc === true,
    authorName: (options.authorName ?? '').trim(),
  })
}

const IMAGE_WAIT_TIMEOUT_MS = 15_000
const FONT_WAIT_TIMEOUT_MS = 4_000
const CARD_CAPTURE_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function waitForImages(node: HTMLElement): Promise<void> {
  const images = Array.from(node.querySelectorAll('img'))
  return Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve()
            return
          }
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            window.clearTimeout(timer)
            image.removeEventListener('load', finish)
            image.removeEventListener('error', finish)
            resolve()
          }
          // A broken or stalled image must not block the whole export.
          const timer = window.setTimeout(finish, IMAGE_WAIT_TIMEOUT_MS)
          image.addEventListener('load', finish, { once: true })
          image.addEventListener('error', finish, { once: true })
        }),
    ),
  ).then(() => new Promise<void>((resolve) => window.setTimeout(resolve, 0)))
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl)
  return response.blob()
}

interface ScaledCardProps {
  card: XhsCard
  style: CardStyle
  tags: string[]
}

function ScaledCard({ card, style, tags }: ScaledCardProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const scale = width > 0 ? width / 540 : 0
  return (
    <div ref={ref} className="xhs-card-stage">
      <div
        className="xhs-card-scale"
        style={{ transform: `scale(${scale})`, visibility: scale > 0 ? 'visible' : 'hidden' }}
      >
        <XhsCardView card={card} style={style} tags={tags} />
      </div>
    </div>
  )
}

interface DouyinSceneProps {
  render: PlatformRender
  author: string
  exporting: boolean
  onCopy: () => void
}

function hasOnlyTags(line: string): boolean {
  return /^#\S+(?:\s+#\S+)*$/.test(line)
}

/** 9:16 vertical feed mockup for Douyin captions and media. */
function DouyinScene({ render, author, exporting, onCopy }: DouyinSceneProps) {
  const video = render.videos[0]
  const cover = render.assets.find((asset) => asset.kind === 'image')?.url
  const tags = render.meta.tags.slice(0, 5)
  const body = (render.text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== render.title.trim() && !hasOnlyTags(line))
    .join('\n')

  return (
    <div className="douyin-scene">
      <div className="douyin-phone-shell">
        <div className="douyin-media">
          {video ? (
            <video
              className="douyin-media-video"
              controls
              playsInline
              poster={cover ? absoluteUrl(cover) : undefined}
              src={absoluteUrl(video)}
            />
          ) : cover ? (
            <img className="douyin-media-image" src={absoluteUrl(cover)} alt="" />
          ) : (
            <div className="douyin-media-placeholder">
              <Music2 size={34} />
              <span>竖屏封面预览</span>
              <small>补充图片或视频素材后可获得更好的封面效果</small>
            </div>
          )}

          <div className="douyin-topbar">
            <span className="douyin-topbar-back">‹</span>
            <span className="douyin-topbar-tabs">
              <em>关注</em>
              <strong>推荐</strong>
            </span>
            <span className="douyin-topbar-search">⌕</span>
          </div>

          <div className="douyin-rail">
            <span className="douyin-rail-avatar">{author.slice(0, 1)}</span>
            <span>
              <Heart size={18} />
              <small>2.8w</small>
            </span>
            <span>
              <MessageCircle size={18} />
              <small>3286</small>
            </span>
            <span>
              <Bookmark size={18} />
              <small>1.2w</small>
            </span>
            <span>
              <Share2 size={18} />
              <small>分享</small>
            </span>
            <span className="douyin-rail-disc">
              <Music2 size={15} />
            </span>
          </div>

          <div className="douyin-caption">
            <span className="douyin-author">@{author}</span>
            <h3>{render.title}</h3>
            <p>{body || '正文内容会整理为作品文案显示在这里。'}</p>
            {tags.length > 0 ? (
              <div className="douyin-tags">
                {tags.map((tag) => (
                  <span key={tag}>#{tag}</span>
                ))}
              </div>
            ) : null}
            <span className="douyin-music">
              <Music2 size={11} />
              原声 · {author}
            </span>
          </div>
        </div>

        <div className="douyin-bottom-nav">
          <span>首页</span>
          <span>朋友</span>
          <span className="douyin-publish">+</span>
          <span>消息</span>
          <span>我</span>
        </div>
      </div>

      <div className="douyin-side-note">
        <span className="douyin-side-icon">
          <PlatformGlyph platform="douyin" size={18} />
        </span>
        <h3>竖屏文案与素材</h3>
        <p>抖音以 9:16 竖屏呈现，标题、正文与话题会自动整理为可直接粘贴的作品文案。</p>
        <button type="button" className="btn btn-sm btn-primary" onClick={onCopy} disabled={exporting}>
          <Copy size={14} />
          复制抖音文案
        </button>
      </div>
    </div>
  )
}

interface ToggleProps {
  checked: boolean
  onChange: () => void
  label: string
  hint?: string
  disabled?: boolean
}

function Toggle({ checked, onChange, label, hint, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      className="render-toggle-row"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
    >
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
      <span className={`render-switch${checked ? ' is-on' : ''}`} aria-hidden="true">
        <span />
      </span>
    </button>
  )
}

export default function RenderPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const preferenceKey = `multipush:render-defaults:${user?.id ?? ''}`
  const defaults = useMemo(() => {
    try { return parsePreferences(JSON.parse(localStorage.getItem(preferenceKey) ?? 'null')) }
    catch { return null }
  }, [preferenceKey])

  const [selectedContent, setSelectedContent] = useState<ContentSummary | null>(null)
  const [platforms, setPlatforms] = useState<PlatformId[]>(defaults?.platforms ?? DEFAULT_PLATFORMS)
  const [options, setOptions] = useState<RenderOptions>(defaults?.options ?? { cardStyle: 'clean', includeTags: true, includeToc: false })
  const [authorName, setAuthorName] = useState(defaults?.options.authorName ?? '')
  const [generatedOptions, setGeneratedOptions] = useState<RenderOptions>({})
  const [editorOpen, setEditorOpen] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'reset' | 'regenerate' | null>(null)
  const [layoutBusy, setLayoutBusy] = useState(false)
  const [layoutErrors, setLayoutErrors] = useState<string[]>([])
  const [report, setReport] = useState<ExportReport | null>(null)
  const [captureFailures, setCaptureFailures] = useState<string[]>([])
  const [lastExport, setLastExport] = useState<'all' | 'xhs'>('xhs')
  const [assetChecks, setAssetChecks] = useState<{ url: string; error: string | null }[]>([])
  const [checkingAssets, setCheckingAssets] = useState(false)
  const captureCache = useRef({ key: '', images: new Map<string, ExportedCardImage>() })
  const captureFailureRef = useRef(new Map<string, string>())
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [results, setResults] = useState<PlatformRender[] | null>(null)
  const [renderId, setRenderId] = useState<string | null>(null)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [activePlatform, setActivePlatform] = useState<PlatformId>('wechat')
  const [lastRequestKey, setLastRequestKey] = useState('')
  const [renderError, setRenderError] = useState<string | null>(null)
  const [cardIndex, setCardIndex] = useState(0)
  const [xhsView, setXhsView] = useState<'cards' | 'video'>('cards')
  const [loadingPage, setLoadingPage] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [exporting, setExporting] = useState<{ label: string; percent: number } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerContents, setPickerContents] = useState<ContentSummary[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<RenderListItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null)
  const autoPendingRef = useRef(false)
  const autoHandledRef = useRef<string | null>(null)
  const cardNodeRefs = useRef(new Map<string, HTMLDivElement>())

  const cardStyle = resolveCardStyle(generatedOptions.cardStyle)
  const xhsRender = results?.find((render) => render.platform === 'xiaohongshu') ?? null
  const activeRender = results?.find((render) => render.platform === activePlatform) ?? results?.[0] ?? null
  const activeInfo = activeRender ? getPlatformInfo(activeRender.platform) : null
  const currentKey = renderSignature(selectedContent?.id, platforms, { ...options, authorName })
  const sourceStale = Boolean(results?.some((result) => result.sourceUpdatedAt && result.sourceUpdatedAt !== selectedContent?.updatedAt))
  const stale = sourceStale || Boolean(results) && Boolean(lastRequestKey) && currentKey !== lastRequestKey
  const cards = activeRender?.platform === 'xiaohongshu' ? activeRender.cards : []
  const safeCardIndex = cards.length === 0 ? 0 : Math.min(cardIndex, cards.length - 1)

  useEffect(() => {
    const id = selectedContent?.id
    if (!id) return
    let cancelled = false
    const refresh = () => { if (!document.hidden) void api.contents.get(id).then(({ content }) => {
      if (!cancelled) setSelectedContent(content)
    }).catch(() => {}) }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { cancelled = true; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [selectedContent?.id])

  useLayoutEffect(() => {
    if (!xhsRender) { setLayoutErrors([]); return }
    let cancelled = false
    setLayoutBusy(true)
    setLayoutErrors([])
    void withTimeout(document.fonts.ready.then(() => undefined), FONT_WAIT_TIMEOUT_MS, '字体未就绪，请重试排版')
      .then(() => {
        if (cancelled) return
        const next = layoutCards(xhsRender.cards, cardNodeRefs.current)
        if (JSON.stringify(next) !== JSON.stringify(xhsRender.cards)) {
          setResults((current) => current?.map((result) => result === xhsRender ? { ...result, cards: next } : result) ?? null)
        } else {
          setLayoutErrors(next.filter((card) => {
            const node = cardNodeRefs.current.get(card.id)
            return !node || overflowingText(node)
          }).map((card) => `第 ${card.index} 张文字超出区域，请调整标题或卡片文字`))
        }
      }).catch((error) => { if (!cancelled) setLayoutErrors([getErrorMessage(error, '自动分页失败')]) })
      .finally(() => { if (!cancelled) setLayoutBusy(false) })
    return () => { cancelled = true }
  }, [xhsRender, cardStyle])

  useEffect(() => { setReport(null); setCaptureFailures([]); setAssetChecks([]) }, [results, cardStyle])

  const refreshHistory = useCallback(async () => {
    try {
      const result = await api.renders.list()
      setHistory(result.renders)
    } catch {
      // History is secondary; the workbench remains usable without it.
    }
  }, [])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  const applyContent = useCallback((content: ContentSummary) => {
    setSelectedContent(content)
    setResults(null)
    setRenderId(null)
    setGeneratedAt(null)
    setLastRequestKey('')
    setRenderError(null)
    setCardIndex(0)
  }, [])

  const applyRecord = useCallback((record: RenderRecord, content: ContentSummary | null) => {
    setResults(record.results)
    setRenderId(record.id)
    setGeneratedAt(record.createdAt)
    setPlatforms(record.platforms)
    setOptions(record.options)
    setGeneratedOptions(record.options)
    setAuthorName(record.options.authorName ?? '')
    setLastRequestKey(
      renderSignature(content?.id ?? record.contentId, record.platforms, record.options),
    )
    setRenderError(null)
    setCardIndex(0)
    const first = record.results[0]?.platform
    setActivePlatform(first ?? record.platforms[0] ?? 'wechat')
    const xhs = record.results.find((render) => render.platform === 'xiaohongshu')
    setXhsView(xhs?.previewMode === 'video' ? 'video' : 'cards')
  }, [])

  const runRender = useCallback(
    async (content: ContentSummary | null, targetPlatforms: PlatformId[], targetOptions: RenderOptions, confirmed = false) => {
      if (!content || targetPlatforms.length === 0 || rendering || exporting || adjusting || layoutBusy) return
      if (!confirmed && results?.some((result) => result.editedAt)) { setConfirmAction('regenerate'); return }
      setRendering(true)
      setRenderError(null)
      try {
        const { render } = await api.renders.create({
          contentId: content.id,
          platforms: targetPlatforms,
          options: { ...targetOptions, authorName: (targetOptions.authorName ?? '').trim() || undefined },
        })
        setResults(render.results)
        setRenderId(render.id)
        setGeneratedAt(render.createdAt)
        setGeneratedOptions(render.options)
        const sourceUpdatedAt = render.results[0]?.sourceUpdatedAt
        if (sourceUpdatedAt) setSelectedContent((current) => current?.id === content.id ? { ...current, updatedAt: sourceUpdatedAt } : current)
        setLastRequestKey(
          renderSignature(content.id, render.platforms, { ...targetOptions, authorName: (targetOptions.authorName ?? '').trim() }),
        )
        setActivePlatform((current) =>
          render.results.some((result) => result.platform === current)
            ? current
            : render.results[0]?.platform ?? targetPlatforms[0],
        )
        setCardIndex(0)
        const xhs = render.results.find((result) => result.platform === 'xiaohongshu')
        setXhsView(xhs?.previewMode === 'video' ? 'video' : 'cards')
        window.history.replaceState(null, '', `/render?renderId=${encodeURIComponent(render.id)}`)
        toast.success('渲染完成，可以预览和下载了')
        void refreshHistory()
      } catch (error) {
        setRenderError(getErrorMessage(error, '渲染失败，请稍后重试'))
        toast.error(getErrorMessage(error, '渲染失败，请稍后重试'))
      } finally {
        setRendering(false)
      }
    },
    [refreshHistory, rendering, exporting, adjusting, layoutBusy, results],
  )

  const loadRecord = useCallback(
    async (id: string) => {
      setHistoryLoadingId(id)
      try {
        const { render } = await api.renders.get(id)
        let content: ContentSummary | null = null
        try {
          const result = await api.contents.get(render.contentId)
          content = result.content
        } catch {
          content = null
        }
        if (content) setSelectedContent(content)
        applyRecord(render, content)
        setHistoryOpen(false)
        window.history.replaceState(null, '', `/render?renderId=${encodeURIComponent(render.id)}`)
      } catch (error) {
        toast.error(getErrorMessage(error, '加载渲染记录失败'))
      } finally {
        setHistoryLoadingId(null)
      }
    },
    [applyRecord],
  )

  // Initial route state: a saved render, a content id from the editor, or the
  // most recently updated document so the workbench is immediately useful.
  useEffect(() => {
    let cancelled = false
    const renderIdParam = searchParams.get('renderId')
    const contentIdParam = searchParams.get('contentId')

    const boot = async () => {
      try {
        if (renderIdParam) {
          const { render } = await api.renders.get(renderIdParam)
          let content: ContentSummary | null = null
          try {
            content = (await api.contents.get(render.contentId)).content
          } catch {
            content = null
          }
          if (cancelled) return
          if (content) setSelectedContent(content)
          applyRecord(render, content)
          return
        }

        if (contentIdParam) {
          const { content } = await api.contents.get(contentIdParam)
          if (cancelled) return
          setSelectedContent(content)
          autoPendingRef.current = true
          return
        }

        const list = await api.contents.list({ pageSize: 1, sort: 'updated_desc' })
        if (!cancelled && list.items[0]) setSelectedContent(list.items[0])
      } catch (error) {
        if (!cancelled) {
          setRenderError(getErrorMessage(error, '加载内容失败'))
        }
      } finally {
        if (!cancelled) setLoadingPage(false)
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
    // Intentionally run once for the initial route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-render content that arrived from the editor's "渲染" action.
  useEffect(() => {
    if (!selectedContent || !autoPendingRef.current || rendering) return
    if (autoHandledRef.current === selectedContent.id) return
    autoPendingRef.current = false
    autoHandledRef.current = selectedContent.id
    void runRender(selectedContent, platforms, { ...options, authorName })
  }, [selectedContent, rendering, runRender, options])

  useEffect(() => {
    if (!pickerOpen) return
    let cancelled = false
    setPickerLoading(true)
    const timer = window.setTimeout(() => {
      api.contents
        .list({ pageSize: 50, q: pickerQuery.trim() || undefined, sort: 'updated_desc' })
        .then((result) => {
          if (!cancelled) setPickerContents(result.items)
        })
        .catch((error) => {
          if (!cancelled) toast.error(getErrorMessage(error, '加载内容失败'))
        })
        .finally(() => {
          if (!cancelled) setPickerLoading(false)
        })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [pickerOpen, pickerQuery])

  useEffect(() => {
    if (!xhsRender) return
    setXhsView(xhsRender.previewMode === 'video' ? 'video' : 'cards')
    setCardIndex(0)
  }, [xhsRender?.platform, renderId])

  const selectContent = useCallback(
    (content: ContentSummary) => {
      applyContent(content)
      setPickerOpen(false)
      window.history.replaceState(null, '', `/render?contentId=${encodeURIComponent(content.id)}`)
    },
    [applyContent],
  )

  const togglePlatform = useCallback(
    (platform: PlatformId) => {
      setPlatforms((current) => {
        if (current.includes(platform)) {
          if (current.length === 1) {
            toast.error('至少选择一个平台')
            return current
          }
          return current.filter((item) => item !== platform)
        }
        return PLATFORM_ORDER.filter((item) => current.includes(item) || item === platform)
      })
    },
    [],
  )

  const setCardStyle = useCallback((style: CardStyle) => {
    setOptions((current) => ({ ...current, cardStyle: style }))
  }, [])

  const captureCard = useCallback(
    async (card: XhsCard, index: number): Promise<ExportedCardImage | null> => {
      const node = cardNodeRefs.current.get(card.id)
      if (!node) { captureFailureRef.current.set(card.id, '卡片尚未就绪'); return null }
      try {
        await withTimeout(document.fonts.ready.then(() => undefined), FONT_WAIT_TIMEOUT_MS, '字体加载超时')
        await waitForImages(node)
        await verifyCardImages(card.images.map(absoluteUrl))
        if (overflowingText(node)) throw new Error('文字超出卡片区域，请先调整分页')
        const dataUrl = await withTimeout(
          toPng(node, {
            width: 540,
            height: 720,
            pixelRatio: 2,
            // Uploads are immutable and served with a one-year cache. Busting
            // the cache here re-downloaded every photo once per card.
            backgroundColor: cardStyle === 'bold' ? '#17191f' : cardStyle === 'warm' ? '#fff7ec' : '#f4faf6',
          }),
          CARD_CAPTURE_TIMEOUT_MS,
          '卡片渲染超时',
        )
        const blob = await dataUrlToBlob(dataUrl)
        return { card, filename: cardImageFilename(card, index), blob }
      } catch (error) {
        console.error('[multipush] card export failed', error)
        captureFailureRef.current.set(card.id, getErrorMessage(error, '生成失败'))
        setCaptureFailures((current) => [...current, `第 ${index + 1} 张：${getErrorMessage(error, '生成失败')}`])
        return null
      }
    },
    [cardStyle],
  )

  const captureCards = useCallback(
    async (render: PlatformRender): Promise<ExportedCardImage[]> => {
      const key = JSON.stringify([render.cards, render.meta.tags, cardStyle])
      if (captureCache.current.key !== key) captureCache.current = { key, images: new Map() }
      setCaptureFailures([])
      captureFailureRef.current.clear()
      const exported: ExportedCardImage[] = []
      for (let index = 0; index < render.cards.length; index += 1) {
        const card = render.cards[index]
        setExporting({ label: `正在生成第 ${index + 1} / ${render.cards.length} 张卡片…`, percent: Math.round((index / render.cards.length) * 60) })
        const image = captureCache.current.images.get(card.id) ?? await captureCard(card, index)
        if (image) { exported.push(image); captureCache.current.images.set(card.id, image) }
      }
      return exported
    },
    [captureCard, cardStyle],
  )

  async function handleDownloadXhsZip() {
    if (!xhsRender || exporting || rendering || layoutBusy || adjusting) return
    setLastExport('xhs')
    setExporting({ label: '正在生成卡片…', percent: 0 })
    try {
      const exported = await captureCards(xhsRender)
      const { blob, skippedAssets, report: exportResult } = await buildXhsZip(xhsRender, exported, (label, percent) =>
        setExporting({ label, percent: Math.max(60, Math.round(percent ?? 0)) }), Object.fromEntries(captureFailureRef.current),
      )
      setExporting({ label: '正在保存 ZIP…', percent: 99 })
      downloadBlob(`${safeFilename(xhsRender.title, 'multipush')}-小红书素材-${dateStamp()}.zip`, blob)
      setReport(exportResult)
      if (exportResult.failedCards.length || skippedAssets) toast.warning('导出不完整，缺失清单已写入 ZIP；请查看导出报告并重试')
      else toast.success('小红书卡片与文案 ZIP 已完整导出')
    } catch (error) {
      toast.error(getErrorMessage(error, '导出小红书素材失败'))
    } finally {
      setExporting(null)
    }
  }

  async function handleDownloadAllZip() {
    if (!results || results.length === 0 || exporting || rendering || layoutBusy || adjusting) return
    setLastExport('all')
    setExporting({ label: '正在准备全部平台素材…', percent: 0 })
    try {
      const exported = xhsRender ? await captureCards(xhsRender) : []
      const { blob, skippedAssets, report: exportResult } = await buildAllZip(results, exported, (label, percent) =>
        setExporting({ label, percent: Math.max(58, Math.round(percent ?? 0)) }), Object.fromEntries(captureFailureRef.current),
      )
      setExporting({ label: '正在保存 ZIP…', percent: 99 })
      downloadBlob(`MultiPush-全部平台-${dateStamp()}.zip`, blob)
      setReport(exportResult)
      if (exportResult.failedCards.length || skippedAssets) toast.warning('导出不完整，缺失清单已写入 ZIP；请查看导出报告并重试')
      else toast.success('全部平台素材 ZIP 已完整导出')
    } catch (error) {
      toast.error(getErrorMessage(error, '导出全部平台失败'))
    } finally {
      setExporting(null)
    }
  }

  async function handleDownloadSingleCard() {
    if (activeRender?.platform !== 'xiaohongshu' || exporting) return
    const card = activeRender.cards[safeCardIndex]
    if (!card) return
    setExporting({ label: '正在生成当前卡片…', percent: 30 })
    try {
      const image = await captureCard(card, safeCardIndex)
      if (!image) {
        toast.error('当前卡片生成失败')
        return
      }
      downloadBlob(image.filename, image.blob)
      toast.success('当前卡片已开始下载')
    } finally {
      setExporting(null)
    }
  }

  async function copyCurrent() {
    if (!activeRender) return
    try {
      if (activeRender.platform === 'wechat') {
        const format = await copyRichHtml(
          htmlForClipboard(activeRender.html),
          plainTextFromHtml(activeRender.html),
        )
        if (format === 'html') toast.success('公众号富文本已复制，可粘贴到公众号后台')
        else toast.warning('浏览器仅复制了纯文本；如需保留排版，请下载 HTML')
        return
      }
      if (activeRender.platform === 'zhihu') {
        await copyText(activeRender.markdown || activeRender.text || '')
        toast.success('知乎 Markdown 已复制')
        return
      }
      if (activeRender.platform === 'douyin') {
        await copyText(activeRender.text || activeRender.html)
        toast.success('抖音文案已复制')
        return
      }
      const note = activeRender.text || activeRender.cards.flatMap((card) => card.body).join('\n')
      await copyText(note)
      toast.success('小红书文案已复制')
    } catch (error) {
      toast.error(getErrorMessage(error, '复制失败，请检查浏览器权限'))
    }
  }

  async function deleteHistoryItem(id: string) {
    try {
      await api.renders.remove(id)
      setHistory((current) => current.filter((item) => item.id !== id))
      if (renderId === id) {
        setResults(null)
        setRenderId(null)
        setGeneratedAt(null)
      }
      toast.success('渲染记录已删除')
    } catch (error) {
      toast.error(getErrorMessage(error, '删除渲染记录失败'))
    }
  }

  const downloads = activeRender ? downloadsFor(activeRender) : []
  const authorLabel = activeRender?.authorName || generatedOptions.authorName?.trim() || user?.displayName || user?.username || 'MultiPush'
  const xhsNoteBody = activeRender?.platform === 'xiaohongshu' ? xhsBodyFromText(activeRender) : ''

  async function saveAdjustment(input: PlatformAdjustment) {
    if (!renderId || !activeRender) throw new Error('请先生成渲染记录')
    const platform = activeRender.platform
    setAdjusting(true)
    try {
      const { result } = await api.renders.adjust(renderId, platform, input)
      setResults((current) => current?.map((item) => item.platform === platform ? result : item) ?? null)
      toast.success('当前平台调整已保存，原文保持不变')
    } finally { setAdjusting(false) }
  }

  async function resetAdjustment() {
    if (!renderId || !activeRender) return
    setAdjusting(true)
    try {
      const { result } = await api.renders.reset(renderId, activeRender.platform)
      setResults((current) => current?.map((item) => item.platform === result.platform ? result : item) ?? null)
      setConfirmAction(null)
      toast.success('已恢复该平台最初生成的结果')
    } catch (error) { toast.error(getErrorMessage(error, '恢复失败')) }
    finally { setAdjusting(false) }
  }

  async function checkAssets() {
    if (!activeRender || checkingAssets) return
    setCheckingAssets(true)
    setAssetChecks([])
    const assets = [...activeRender.assets, ...activeRender.cards.flatMap((card) => card.images.map((url) => ({ url, kind: 'image' as const })))]
    const unique = assets.filter((asset, index) => assets.findIndex((other) => other.url === asset.url) === index)
    const checks: { url: string; error: string | null }[] = []
    // Limit simultaneous downloads so checking a photo-heavy post stays usable.
    let cursor = 0
    try {
      await Promise.all(Array.from({ length: Math.min(3, unique.length) }, async () => {
        while (cursor < unique.length) {
          const asset = unique[cursor++]
          try {
            if (asset.kind === 'image') await verifyCardImages([absoluteUrl(asset.url)])
            else {
              const response = await fetch(absoluteUrl(asset.url), { method: 'HEAD', signal: AbortSignal.timeout(15_000) })
              if (!response.ok || !response.headers.get('content-type')?.startsWith('video/')) throw new Error('视频无法读取，请检查地址')
            }
            checks.push({ url: asset.url, error: null })
          } catch (error) { checks.push({ url: asset.url, error: getErrorMessage(error, '素材无法读取') }) }
          setAssetChecks([...checks])
        }
      }))
      setAssetChecks(checks)
    } finally { setCheckingAssets(false) }
  }

  async function copyPart(part: 'title' | 'body' | 'tags' | 'rich') {
    if (!activeRender) return
    try {
      if (part === 'rich') {
        const format = await copyRichHtml(htmlForClipboard(activeRender.html), plainTextFromHtml(activeRender.html))
        if (format === 'text') { toast.warning('仅复制了纯文本，请下载 HTML 保留排版'); return }
      } else await copyText(part === 'title' ? activeRender.title : part === 'tags' ? activeRender.meta.tags.map((tag) => `#${tag}`).join(' ') : getCaptionBody(activeRender))
      toast.success('已复制')
    } catch (error) { toast.error(getErrorMessage(error, '复制失败')) }
  }

  function saveDefaults() {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify({ platforms, options: { ...options, authorName } }))
      toast.success('已记住当前账号的默认平台、风格、署名与开关')
    } catch { toast.error('浏览器无法保存默认设置') }
  }

  const checks = activeRender ? publishChecks(activeRender, stale) : []
  const failedAssets = assetChecks.filter((item) => item.error)

  return (
    <div className="render-page">
      <fieldset className="render-controls" disabled={rendering || Boolean(exporting) || layoutBusy || adjusting || checkingAssets}>
      <header className="render-head">
        <div className="render-head-copy">
          <span className="render-eyebrow">
            <Wand2 size={13} />
            Render Studio
          </span>
          <h1>智能渲染</h1>
          <p>一次创作，生成公众号排版、小红书卡片、知乎长文与抖音竖屏文案，预览确认后下载发布。</p>
        </div>
        <div className="render-head-actions">
          <button type="button" className="btn" onClick={() => setHistoryOpen(true)}>
            <History size={16} />
            渲染历史
            {history.length > 0 ? <span className="render-history-count">{history.length}</span> : null}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void runRender(selectedContent, platforms, { ...options, authorName })}
            disabled={!selectedContent || platforms.length === 0 || rendering}
          >
            {rendering ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}
            {rendering ? '正在渲染…' : results ? '重新生成' : '生成渲染'}
          </button>
        </div>
      </header>

      <section className="render-sourcebar">
        <button
          type="button"
          className="render-source"
          onClick={() => {
            setPickerOpen(true)
            setPickerQuery('')
          }}
        >
          {selectedContent?.coverImage ? (
            <img className="render-source-cover" src={absoluteUrl(selectedContent.coverImage)} alt="" />
          ) : (
            <span className="render-source-cover is-placeholder">
              <BookOpen size={18} />
            </span>
          )}
          <span className="render-source-copy">
            <span className="render-source-label">当前内容</span>
            <strong>{selectedContent?.title || '选择一篇内容开始渲染'}</strong>
            <small>
              {selectedContent
                ? `${selectedContent.bookName || '未分组'} · ${formatNumber(selectedContent.wordCount)} 字 · ${relativeTime(selectedContent.updatedAt)}更新`
                : '从内容库中选择，或先在编辑器中创作'}
            </small>
          </span>
          <span className="render-source-change">
            更换内容
            <ChevronDown size={14} />
          </span>
        </button>

        <div className="render-platform-select" role="group" aria-label="选择发布平台">
          {PLATFORMS.map((platform) => {
            const selected = platforms.includes(platform.id)
            return (
              <button
                key={platform.id}
                type="button"
                className={`render-platform-chip${selected ? ' is-selected' : ''}`}
                style={{ '--platform-color': platform.color, '--platform-soft': platform.softColor } as CSSProperties}
                onClick={() => togglePlatform(platform.id)}
                aria-pressed={selected}
              >
                <span className="render-platform-chip-icon">
                  <PlatformGlyph platform={platform.id} size={16} />
                </span>
                <span>
                  <strong>{platform.shortName}</strong>
                  <small>{platform.contentTypes.includes('video') ? '图文 / 视频' : '图文'}</small>
                </span>
                <span className="render-platform-check">{selected ? <Check size={12} /> : null}</span>
              </button>
            )
          })}
        </div>

        <button
          type="button"
          className={`btn render-options-trigger${optionsOpen ? ' is-active' : ''}`}
          onClick={() => setOptionsOpen((value) => !value)}
        >
          <Settings2 size={16} />
          渲染设置
        </button>
      </section>

      {optionsOpen ? (
        <section className="render-options">
          <div className="render-option-group render-option-styles">
            <span className="render-option-label">
              <Palette size={14} />
              小红书卡片风格
            </span>
            <div className="render-style-options">
              {CARD_STYLE_OPTIONS.map((style) => (
                <button
                  key={style.id}
                  type="button"
                  className={`render-style-option${resolveCardStyle(options.cardStyle) === style.id ? ' is-active' : ''}`}
                  onClick={() => setCardStyle(style.id)}
                >
                  <span className="render-style-swatches">
                    {style.swatches.map((swatch) => (
                      <i key={swatch} style={{ background: swatch }} />
                    ))}
                  </span>
                  <span>
                    <strong>{style.name}</strong>
                    <small>{style.hint}</small>
                  </span>
                  {resolveCardStyle(options.cardStyle) === style.id ? <Check size={13} /> : null}
                </button>
              ))}
            </div>
          </div>

          <div className="render-option-group render-option-toggles">
            <Toggle
              checked={options.includeTags !== false}
              onChange={() => setOptions((current) => ({ ...current, includeTags: current.includeTags === false }))}
              label="带话题标签"
              hint="小红书生成 #话题"
            />
            <Toggle
              checked={options.includeToc === true}
              onChange={() => setOptions((current) => ({ ...current, includeToc: !current.includeToc }))}
              label="文章自动目录"
              hint="公众号和知乎根据标题生成目录"
            />
            <label className="render-author-field">
              <span>作者署名</span>
              <input
                className="input"
                value={authorName}
                onChange={(event) => setAuthorName(event.target.value)}
                placeholder={user?.displayName || '默认使用账号昵称'}
                maxLength={40}
              />
            </label>
            <button className="btn btn-sm" type="button" title="在当前浏览器记忆设置，按账号区分" onClick={saveDefaults}>保存为我的默认设置</button>
          </div>
        </section>
      ) : null}

      {stale ? (
        <div className="render-stale">
          <CircleAlert size={14} />
          <span>{sourceStale ? '原文已修改，当前结果尚未更新。' : '渲染设置已变化；预览与导出仍使用上一次生成的设置。'}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void runRender(selectedContent, platforms, { ...options, authorName })}
            disabled={rendering}
          >
            应用设置并重新生成
          </button>
        </div>
      ) : null}
      {layoutBusy ? <div className="render-stale" role="status">正在按实际字体和图片高度检查分页…</div> : null}
      {renderError && results ? <div className="render-stale" role="alert">本次生成失败：{renderError}。当前仍展示上一次结果。</div> : null}

      <div className="render-work">
        <main className="render-preview">
          {loadingPage ? (
            <div className="render-preview-loading">
              <LoaderCircle size={22} className="spin" />
              正在准备渲染工作台…
            </div>
          ) : renderError && !results ? (
            <div className="render-preview-error">
              <span className="render-preview-error-icon">
                <CircleAlert size={22} />
              </span>
              <h2>渲染没有完成</h2>
              <p>{renderError}</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void runRender(selectedContent, platforms, { ...options, authorName })}
                disabled={!selectedContent || rendering}
              >
                <RefreshCw size={15} />
                重试
              </button>
            </div>
          ) : !results || !activeRender ? (
            <div className="render-empty">
              <div className="render-empty-art" aria-hidden="true">
                <div className="render-empty-phone">
                  <span className="render-empty-phone-bar" />
                  <span className="render-empty-phone-line is-lg" />
                  <span className="render-empty-phone-line" />
                  <span className="render-empty-phone-line is-sm" />
                  <span className="render-empty-card is-green" />
                </div>
                <div className="render-empty-sheet">
                  <span className="render-empty-sheet-dot" />
                  <span className="render-empty-sheet-line is-lg" />
                  <span className="render-empty-sheet-line" />
                  <span className="render-empty-sheet-line is-sm" />
                  <span className="render-empty-sheet-block" />
                </div>
                <span className="render-empty-spark render-empty-spark-one">✦</span>
                <span className="render-empty-spark render-empty-spark-two">✦</span>
              </div>
              <span className="render-empty-eyebrow">ONE SOURCE · FOUR FORMATS</span>
              <h2>把一篇内容，变成四种发布形态</h2>
              <p>选择内容与平台，MultiPush 会按照每个平台的阅读习惯重新排版，生成可直接交付的素材。</p>
              <div className="render-empty-actions">
                {selectedContent ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void runRender(selectedContent, platforms, { ...options, authorName })}
                    disabled={platforms.length === 0 || rendering}
                  >
                    <Sparkles size={16} />
                    生成渲染
                  </button>
                ) : null}
                <button type="button" className="btn" onClick={() => setPickerOpen(true)}>
                  <BookOpen size={16} />
                  {selectedContent ? '更换内容' : '选择内容'}
                </button>
              </div>
              <div className="render-empty-features">
                <span>
                  <PlatformGlyph platform="wechat" size={14} />
                  公众号内联排版
                </span>
                <span>
                  <PlatformGlyph platform="xiaohongshu" size={14} />
                  小红书 3:4 卡片
                </span>
                <span>
                  <PlatformGlyph platform="zhihu" size={14} />
                  知乎 Markdown 长文
                </span>
                <span>
                  <PlatformGlyph platform="douyin" size={14} />
                  抖音竖屏文案
                </span>
              </div>
            </div>
          ) : (
            <>
              <div className="render-preview-toolbar">
                <div className="render-tabs" role="tablist" aria-label="平台预览">
                  {PLATFORM_ORDER.filter((platform) => results?.some((render) => render.platform === platform)).map(
                    (platform) => {
                      const result = results?.find((item) => item.platform === platform)
                      const info = getPlatformInfo(platform)
                      return (
                        <button
                          key={platform}
                          type="button"
                          role="tab"
                          aria-selected={activeRender.platform === platform}
                          className={`render-tab${activeRender.platform === platform ? ' is-active' : ''}`}
                          style={{ '--tab-color': info.color } as CSSProperties}
                          onClick={() => {
                            setActivePlatform(platform)
                            setCardIndex(0)
                            if (platform === 'xiaohongshu' && result) {
                              setXhsView(result.previewMode === 'video' ? 'video' : 'cards')
                            }
                          }}
                        >
                          <PlatformGlyph platform={platform} size={15} />
                          {info.shortName}
                          {result?.warnings.length ? <span className="render-tab-warning">{result.warnings.length}</span> : null}
                        </button>
                      )
                    },
                  )}
                </div>

                <div className="render-preview-tools">
                  {activeRender.platform === 'xiaohongshu' ? (
                    activeRender.videos.length > 0 ? (
                      <div className="segmented render-view-toggle">
                        <button
                          type="button"
                          className={xhsView === 'cards' ? 'active' : ''}
                          onClick={() => setXhsView('cards')}
                        >
                          <ImageIcon size={13} />
                          图文卡片
                        </button>
                        <button
                          type="button"
                          className={xhsView === 'video' ? 'active' : ''}
                          onClick={() => setXhsView('video')}
                        >
                          <Play size={13} />
                          视频笔记
                        </button>
                      </div>
                    ) : (
                      <span className="render-preview-mode">
                        <ImageIcon size={13} />
                        图文卡片
                      </span>
                    )
                  ) : (
                    <span className="render-preview-mode">
                      {activeRender.previewMode === 'article' ? <FileText size={13} /> : <Video size={13} />}
                      {activeRender.platform === 'wechat'
                        ? '公众号图文'
                        : activeRender.platform === 'douyin'
                          ? activeRender.videos.length > 0
                            ? '抖音视频'
                            : '抖音图文'
                          : '知乎专栏文章'}
                    </span>
                  )}
                  <span className="render-preview-date">
                    <Clock3 size={12} />
                    {formatDateTime(activeRender.generatedAt)}
                  </span>
                </div>
              </div>

              <div className="render-stage">
                {rendering ? (
                  <div className="render-stage-loading">
                    <LoaderCircle size={22} className="spin" />
                    <strong>正在重新渲染…</strong>
                    <span>排版、卡片和下载文件会一起更新</span>
                  </div>
                ) : null}

                {activeRender.platform === 'douyin' ? (
                  <DouyinScene
                    render={activeRender}
                    author={authorLabel}
                    exporting={Boolean(exporting)}
                    onCopy={() => void copyCurrent()}
                  />
                ) : activeRender.platform === 'wechat' ? (
                  <div className="wechat-scene">
                    <div className="phone-shell">
                      <div className="phone-statusbar">
                        <span>9:41</span>
                        <span className="phone-status-icons">
                          <i />
                          <i />
                          <i />
                        </span>
                      </div>
                      <div className="wechat-phone-nav">
                        <span className="wechat-nav-dots">···</span>
                        <span>公众号</span>
                        <span className="wechat-nav-more">⊙</span>
                      </div>
                      <div className="wechat-phone-scroll">
                        <div className="wechat-article-head">
                          <h1>{activeRender.title}</h1>
                          <div className="wechat-meta-line">
                            <span>{authorLabel}</span>
                            <span>今天</span>
                          </div>
                          <div className="wechat-account-row">
                            <span className="wechat-account-avatar">{authorLabel.slice(0, 1)}</span>
                            <span>
                              <strong>{authorLabel}</strong>
                              <small>多平台智能发布</small>
                            </span>
                            <span className="wechat-follow">关注</span>
                          </div>
                        </div>
                        <div
                          className="wechat-preview-body"
                          dangerouslySetInnerHTML={{ __html: activeRender.html }}
                        />
                        <div className="wechat-article-foot">阅读 1.2 万 · 在看 328 · 分享 96</div>
                      </div>
                      <div className="wechat-phone-bottom">
                        <span>写留言</span>
                        <span>♡ 328</span>
                        <span>↗ 96</span>
                      </div>
                    </div>
                    <div className="wechat-side-note">
                      <span className="wechat-side-icon">
                        <PlatformGlyph platform="wechat" size={18} />
                      </span>
                      <h3>复制到公众号后台</h3>
                      <p>正文使用内联样式，复制后可保留字体、颜色、引用和代码块格式。</p>
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => void copyCurrent()}>
                        <Copy size={14} />
                        复制富文本
                      </button>
                    </div>
                  </div>
                ) : activeRender.platform === 'zhihu' ? (
                  <div className="zhihu-scene">
                    <div className="browser-shell">
                      <div className="browser-bar">
                        <span className="browser-dots">
                          <i />
                          <i />
                          <i />
                        </span>
                        <span className="browser-url">
                          <BookOpen size={12} />
                          zhuanlan.zhihu.com/p/{activeRender.title.slice(0, 8)}
                        </span>
                        <span className="browser-action">
                          <ExternalLink size={13} />
                        </span>
                      </div>
                      <div className="browser-scroll">
                        <div className="zhihu-article">
                          <h1>{activeRender.title}</h1>
                          <div className="zhihu-author-row">
                            <span className="zhihu-avatar">{authorLabel.slice(0, 1)}</span>
                            <span>
                              <strong>{authorLabel}</strong>
                              <small>发布于 {formatDate(activeRender.generatedAt)}</small>
                            </span>
                            <span className="zhihu-follow">关注</span>
                          </div>
                          <div className="zhihu-body" dangerouslySetInnerHTML={{ __html: activeRender.html }} />
                          <div className="zhihu-foot">
                            <span>赞同 1.2 万</span>
                            <span>添加评论</span>
                            <span>收藏</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="zhihu-side-note">
                      <span className="zhihu-side-icon">
                        <PlatformGlyph platform="zhihu" size={18} />
                      </span>
                      <h3>Markdown 与富文本</h3>
                      <p>知乎排版偏向长文阅读，代码块、引用和表格都保留了清晰层级。</p>
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => void copyCurrent()}>
                        <Copy size={14} />
                        复制 Markdown
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="xhs-scene">
                    {xhsView === 'cards' ? (
                      <div className="xhs-phone-shell">
                        <div className="phone-statusbar">
                          <span>9:41</span>
                          <span className="phone-status-icons">
                            <i />
                            <i />
                            <i />
                          </span>
                        </div>
                        <div className="xhs-phone-head">
                          <span>‹</span>
                          <span className="xhs-head-avatar">{authorLabel.slice(0, 1)}</span>
                          <span>{authorLabel}</span>
                          <span className="xhs-head-more">···</span>
                        </div>
                        <div className="xhs-phone-scroll">
                          <div className="xhs-carousel">
                            {safeCardIndex > 0 ? (
                              <button
                                type="button"
                                className="xhs-carousel-arrow is-left"
                                onClick={() => setCardIndex((value) => Math.max(0, value - 1))}
                                aria-label="上一张卡片"
                              >
                                <ChevronLeft size={18} />
                              </button>
                            ) : null}
                            {cards[safeCardIndex] ? (
                              <ScaledCard
                                card={cards[safeCardIndex]}
                                style={cardStyle}
                                tags={activeRender.meta.tags}
                              />
                            ) : null}
                            {safeCardIndex < cards.length - 1 ? (
                              <button
                                type="button"
                                className="xhs-carousel-arrow is-right"
                                onClick={() => setCardIndex((value) => Math.min(cards.length - 1, value + 1))}
                                aria-label="下一张卡片"
                              >
                                <ChevronRight size={18} />
                              </button>
                            ) : null}
                            <span className="xhs-card-counter">
                              {safeCardIndex + 1} / {cards.length}
                            </span>
                          </div>
                          <div className="xhs-dots" role="tablist" aria-label="卡片切换">
                            {cards.map((card, index) => (
                              <button
                                key={card.id}
                                type="button"
                                className={index === safeCardIndex ? 'is-active' : ''}
                                onClick={() => setCardIndex(index)}
                                aria-label={`第 ${index + 1} 张`}
                              />
                            ))}
                          </div>

                          <div className="xhs-note">
                            <h1>{activeRender.title}</h1>
                            <p className="xhs-note-body">{xhsNoteBody || '正文内容已排版为上方卡片。'}</p>
                            <div className="xhs-note-tags">
                              {activeRender.meta.tags.slice(0, 6).map((tag) => (
                                <span key={tag}>#{tag}</span>
                              ))}
                            </div>
                            <div className="xhs-note-meta">
                              <span>{formatDate(activeRender.generatedAt)}</span>
                              <span>♡ 2.6k</span>
                              <span>☆ 1.1k</span>
                              <span>💬 186</span>
                            </div>
                          </div>
                        </div>
                        <div className="xhs-phone-bottom">
                          <span>说点什么…</span>
                          <span>♡ 2.6k</span>
                          <span>☆ 1.1k</span>
                        </div>
                      </div>
                    ) : (
                      <div className="xhs-video-scene">
                        <div className="xhs-video-player">
                          {activeRender.videos[0] ? (
                            <video
                              controls
                              playsInline
                              poster={activeRender.assets.find((asset) => asset.kind === 'image')?.url}
                              src={absoluteUrl(activeRender.videos[0])}
                            />
                          ) : (
                            <div className="xhs-video-placeholder">
                              <Play size={26} />
                              <span>视频笔记预览</span>
                              <small>内容中没有视频素材，可继续使用图文卡片模式。</small>
                            </div>
                          )}
                        </div>
                        <div className="xhs-video-copy">
                          <span className="xhs-video-kicker">视频笔记 · 预览</span>
                          <h2>{activeRender.title}</h2>
                          <p>{xhsNoteBody || '视频笔记文案将显示在这里。'}</p>
                          <div className="xhs-video-tags">
                            {activeRender.meta.tags.slice(0, 6).map((tag) => (
                              <span key={tag}>#{tag}</span>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="xhs-side-stack">
                      <div className="xhs-side-note">
                        <span className="xhs-side-icon">
                          <PlatformGlyph platform="xiaohongshu" size={18} />
                        </span>
                        <h3>3:4 高清卡片</h3>
                        <p>每张卡片按 1080×1440 导出，携带标题、正文、图片与话题，直接上传小红书。</p>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => void handleDownloadXhsZip()}
                          disabled={Boolean(exporting) || cards.length === 0}
                        >
                          {exporting ? <LoaderCircle size={14} className="spin" /> : <Package size={14} />}
                          下载卡片 ZIP
                        </button>
                      </div>
                      <div className="xhs-card-strip">
                        {cards.map((card, index) => (
                          <button
                            key={card.id}
                            type="button"
                            className={index === safeCardIndex ? 'is-active' : ''}
                            onClick={() => setCardIndex(index)}
                            title={`第 ${index + 1} 张`}
                          >
                            <span>{String(index + 1).padStart(2, '0')}</span>
                            <small>{card.type === 'cover' ? '封面' : card.type === 'end' ? '结尾' : '内容'}</small>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </main>

        <aside className="render-side">
          {rendering && !results ? (
            <div className="render-side-loading">
              <span className="skeleton render-side-skeleton is-title" />
              <span className="skeleton render-side-skeleton" />
              <span className="skeleton render-side-skeleton" />
              <span className="skeleton render-side-skeleton is-block" />
              <span className="skeleton render-side-skeleton" />
            </div>
          ) : !activeRender ? (
            <div className="render-side-guide">
              <span className="render-side-guide-icon">
                <Layers size={20} />
              </span>
              <h2>渲染后在这里交付</h2>
              <p>生成结果后，可以下载各平台文件、复制富文本或打包全部素材。</p>
              <ol>
                <li>
                  <span>01</span>
                  选择内容与平台
                </li>
                <li>
                  <span>02</span>
                  调整渲染设置
                </li>
                <li>
                  <span>03</span>
                  预览、复制或下载
                </li>
              </ol>
            </div>
          ) : (
            <>
              <div className="render-side-head">
                <div>
                  <span className="render-side-eyebrow">
                    <span className="render-side-dot" style={{ background: activeInfo?.color }} />
                    {activeInfo?.name}
                  </span>
                  <h2>交付与发布</h2>
                  {activeRender.platform === 'wechat' && renderId ? <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={() => navigate(`/publish?renderId=${encodeURIComponent(renderId)}`)}><Share2 size={14} />发布到公众号</button> : null}
                  {activeRender.platform === 'xiaohongshu' && renderId ? <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={() => navigate(`/publish?platform=xiaohongshu&renderId=${encodeURIComponent(renderId)}`)}><Share2 size={14} />发布到小红书</button> : null}
                  {activeRender.platform === 'zhihu' && renderId ? <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={() => navigate(`/publish?platform=zhihu&renderId=${encodeURIComponent(renderId)}`)}><Share2 size={14} />发布到知乎</button> : null}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => void runRender(selectedContent, platforms, { ...options, authorName })}
                  title="重新渲染"
                  aria-label="重新渲染"
                  disabled={rendering}
                >
                  <RefreshCw size={15} className={rendering ? 'spin' : undefined} />
                </button>
              </div>

              <section className="render-side-section render-publish-checks" aria-label="发布前检查">
                <div className="render-side-section-head"><h3>发布前检查</h3><small>平台上限仅供参考</small></div>
                {checks.map((check) => <div className={`render-check ${check.ok ? 'is-ok' : 'is-warning'}`} key={check.label}>
                  <span>{check.ok ? '✓' : '!'}</span><div><strong>{check.label}</strong><small>{check.detail}</small></div>
                  {!check.ok ? <button className="btn btn-sm" onClick={() => {
                    if (check.action === 'render') void runRender(selectedContent, platforms, { ...options, authorName })
                    else if (check.action === 'assets') void checkAssets()
                    else setEditorOpen(true)
                  }}>{check.action === 'render' ? '重新生成' : check.action === 'assets' ? '检查' : '调整'}</button> : null}
                </div>)}
                {activeRender.platform === 'xiaohongshu' ? <div className={`render-check ${layoutErrors.length ? 'is-warning' : 'is-ok'}`}>
                  <span>{layoutErrors.length ? '!' : '✓'}</span><div><strong>卡片文字溢出</strong><small>{layoutErrors.length ? layoutErrors.join('；') : '未发现溢出'}</small></div>
                  {layoutErrors.length ? <><button className="btn btn-sm" onClick={() => setEditorOpen(true)}>调整</button><button className="btn btn-sm" onClick={() => setResults((current) => current?.map((item) => item.platform === 'xiaohongshu' ? { ...item } : item) ?? null)}>重试排版</button></> : null}
                </div> : null}
                <div className="render-check"><div><strong>素材可读取性</strong><small>{assetChecks.length ? `${assetChecks.length - failedAssets.length} / ${assetChecks.length} 个通过` : '尚未检查，导出时还会再次验证'}</small></div><button className="btn btn-sm" onClick={() => void checkAssets()}>{checkingAssets ? '检查中…' : '检查素材'}</button></div>
                {failedAssets.map((asset) => <p className="render-check-error" key={asset.url}>{asset.error}<a href={absoluteUrl(asset.url)} target="_blank" rel="noreferrer">打开素材</a></p>)}
                <div className="render-edit-toolbar">
                  <button className="btn btn-sm btn-primary" onClick={() => setEditorOpen(true)}>调整当前平台</button>
                  <button className="btn btn-sm" disabled={!activeRender.editedAt} onClick={() => setConfirmAction('reset')}>恢复生成结果</button>
                </div>
                {activeRender.editedAt ? <small>当前平台已调整，保存于 {formatDateTime(activeRender.editedAt)}</small> : null}
              </section>

              <div className="render-stats">
                <span>
                  <strong>{formatNumber(activeRender.meta.wordCount)}</strong>
                  <small>字数</small>
                </span>
                <span>
                  <strong>{activeRender.meta.imageCount}</strong>
                  <small>图片</small>
                </span>
                <span>
                  <strong>{activeRender.meta.videoCount}</strong>
                  <small>视频</small>
                </span>
                <span>
                  <strong>{activeRender.meta.readMinutes}</strong>
                  <small>分钟阅读</small>
                </span>
              </div>

              {activeRender.warnings.length > 0 ? (
                <div className="render-warnings">
                  <span className="render-warnings-head">
                    <TriangleAlert size={14} />
                    发布前注意
                  </span>
                  <ul>
                    {activeRender.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <section className="render-side-section">
                <div className="render-side-section-head">
                  <h3>下载文件</h3>
                  <span>{downloads.length} 个</span>
                </div>
                <div className="render-download-list">
                  {downloads.map((download, index) => {
                    const Icon = DOWNLOAD_ICONS[download.kind]
                    return (
                      <button
                        type="button"
                        key={`${download.filename}-${index}`}
                        className="render-download"
                        onClick={() => downloadRenderFile(download)}
                      >
                        <span className={`render-download-icon is-${download.kind}`}>
                          <Icon size={16} />
                        </span>
                        <span>
                          <strong>{download.filename}</strong>
                          <small>{DOWNLOAD_LABELS[download.kind]}</small>
                        </span>
                        <Download size={15} />
                      </button>
                    )
                  })}
                </div>
              </section>

              <section className="render-side-section">
                <div className="render-side-section-head">
                  <h3>快速交付</h3>
                </div>
                <div className="render-quick-actions">
                  <button className="btn btn-sm" onClick={() => void copyPart('title')}>复制标题</button>
                  {activeRender.platform === 'xiaohongshu' || activeRender.platform === 'douyin' ? <>
                    <button className="btn btn-sm" onClick={() => void copyPart('body')}>复制正文</button>
                    <button className="btn btn-sm" onClick={() => void copyPart('tags')}>复制话题</button>
                  </> : null}
                  {activeRender.platform === 'zhihu' ? <button className="btn btn-sm" onClick={() => void copyPart('rich')}>复制富文本</button> : null}
                  <button type="button" className="btn btn-sm" onClick={() => void copyCurrent()}>
                    <Copy size={14} />
                    {activeRender.platform === 'wechat'
                      ? '复制富文本'
                      : activeRender.platform === 'zhihu'
                        ? '复制 Markdown'
                        : activeRender.platform === 'douyin'
                          ? '复制抖音文案'
                          : '复制文案'}
                  </button>
                  {activeRender.platform === 'xiaohongshu' ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void handleDownloadSingleCard()}
                        disabled={Boolean(exporting) || cards.length === 0}
                      >
                        <ImageIcon size={14} />
                        当前卡片 PNG
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => void handleDownloadXhsZip()}
                        disabled={Boolean(exporting) || cards.length === 0}
                      >
                        <Package size={14} />
                        小红书 ZIP
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void handleDownloadAllZip()}
                    disabled={Boolean(exporting)}
                  >
                    <Package size={14} />
                    全部平台 ZIP
                  </button>
                </div>
                {exporting ? (
                  <div className="render-export-progress" role="status" aria-live="polite">
                    <div>
                      <span>{exporting.label}</span>
                      <strong>{Math.min(100, Math.round(exporting.percent))}%</strong>
                    </div>
                    <span className="render-export-track">
                      <i style={{ width: `${Math.min(100, Math.round(exporting.percent))}%` }} />
                    </span>
                  </div>
                ) : null}
                {report ? <div className="render-export-report" role="status">
                  <strong>{report.failedCards.length || report.failedAssets.length ? '导出不完整' : '导出完整'}</strong>
                  <p>卡片应有 {report.expectedCards} 张，成功 {report.successfulCards} 张；素材失败 {report.failedAssets.length} 个。</p>
                  <ul>{report.failedCards.map((item) => <li key={item}>{item}</li>)}{report.failedAssets.map((item, i) => <li key={i}>{item}</li>)}</ul>
                  {captureFailures.length ? <details><summary>卡片失败原因</summary>{captureFailures.map((item) => <p key={item}>{item}</p>)}</details> : null}
                  {report.failedCards.length || report.failedAssets.length ? <button className="btn btn-sm" onClick={() => void (lastExport === 'all' ? handleDownloadAllZip() : handleDownloadXhsZip())}>重试失败项并重新导出</button> : null}
                  <small>ZIP 内含完整导出报告。已成功的卡片会复用。</small>
                </div> : null}
              </section>

              {activeRender.assets.length > 0 ? (
                <section className="render-side-section">
                  <div className="render-side-section-head">
                    <h3>素材</h3>
                    <span>{activeRender.assets.length} 个</span>
                  </div>
                  <div className="render-asset-list">
                    {activeRender.assets.slice(0, 6).map((asset, index) => (
                      <a
                        key={`${asset.url}-${index}`}
                        href={absoluteUrl(asset.url)}
                        target="_blank"
                        rel="noreferrer"
                        className="render-asset"
                      >
                        {asset.kind === 'image' ? (
                          <img src={absoluteUrl(asset.url)} alt="" />
                        ) : (
                          <span className="render-asset-video">
                            <Video size={15} />
                          </span>
                        )}
                        <span>
                          <strong>{asset.filename}</strong>
                          <small>{asset.kind === 'image' ? '图片素材' : '视频素材'}</small>
                        </span>
                        <ExternalLink size={13} />
                      </a>
                    ))}
                    {activeRender.assets.length > 6 ? (
                      <span className="render-asset-more">还有 {activeRender.assets.length - 6} 个素材，已包含在 ZIP 中</span>
                    ) : null}
                  </div>
                </section>
              ) : null}

              <div className="render-record-meta">
                <span>
                  <Clock3 size={12} />
                  {formatDateTime(activeRender.generatedAt)}
                </span>
                {renderId ? <span className="render-record-id">记录 {renderId.slice(0, 8)}</span> : null}
                <button
                  type="button"
                  className="render-open-editor"
                  onClick={() => selectedContent && navigate(`/editor/${selectedContent.id}`)}
                  disabled={!selectedContent}
                >
                  打开原文档
                  <ArrowRight size={12} />
                </button>
              </div>
            </>
          )}
        </aside>
      </div>

      {/* Hidden full-size cards used for deterministic PNG export. */}
      {xhsRender ? (
        <div className="xhs-export-holder" aria-hidden="true">
          {xhsRender.cards.map((card) => (
            <div
              className="xhs-export-card"
              key={card.id}
              ref={(node) => {
                if (node) cardNodeRefs.current.set(card.id, node)
                else cardNodeRefs.current.delete(card.id)
              }}
            >
              <XhsCardView card={card} style={cardStyle} tags={xhsRender.meta.tags} />
            </div>
          ))}
        </div>
      ) : null}
      </fieldset>

      {editorOpen && activeRender ? <PlatformEditor render={activeRender} style={cardStyle} onClose={() => setEditorOpen(false)} onSave={saveAdjustment} /> : null}
      <ConfirmDialog open={confirmAction !== null} title={confirmAction === 'reset' ? '恢复生成结果？' : '生成新的渲染版本？'} tone="primary"
        description={confirmAction === 'reset' ? '将移除当前平台的专属调整，恢复此记录最初生成的内容。原文和其他平台保持不变。' : '新结果会根据原文生成，不会带入平台专属调整；旧记录及其调整仍可从历史中打开。'}
        loading={adjusting || rendering} onClose={() => setConfirmAction(null)} onConfirm={async () => {
          if (confirmAction === 'reset') await resetAdjustment()
          else { setConfirmAction(null); await runRender(selectedContent, platforms, { ...options, authorName }, true) }
        }} />

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="选择内容"
        subtitle="从内容库中选择一篇文档，渲染为四个平台的发布格式"
        size="wide"
      >
        <div className="render-picker-search">
          <Search size={16} />
          <input
            className="input"
            value={pickerQuery}
            onChange={(event) => setPickerQuery(event.target.value)}
            placeholder="搜索标题、摘要或标签…"
            autoFocus
          />
          {pickerLoading ? <LoaderCircle size={15} className="spin" /> : null}
        </div>
        <div className="render-picker-list">
          {pickerContents.length === 0 && !pickerLoading ? (
            <EmptyState
              icon={<BookOpen size={20} />}
              title="没有找到内容"
              description="换个关键词试试，或先去内容库创建一篇文档。"
              action={
                <button type="button" className="btn btn-primary" onClick={() => navigate('/library')}>
                  去内容库
                </button>
              }
            />
          ) : (
            pickerContents.map((content) => (
              <button
                type="button"
                key={content.id}
                className={`render-picker-item${content.id === selectedContent?.id ? ' is-active' : ''}`}
                onClick={() => selectContent(content)}
              >
                {content.coverImage ? (
                  <img src={absoluteUrl(content.coverImage)} alt="" />
                ) : (
                  <span className="render-picker-cover">
                    <FileText size={17} />
                  </span>
                )}
                <span className="render-picker-copy">
                  <span className="render-picker-title">
                    {content.title}
                    {content.status === 'ready' ? <em>待渲染</em> : null}
                  </span>
                  <small>
                    {content.bookName || '未分组'} · {formatNumber(content.wordCount)} 字 · {relativeTime(content.updatedAt)}更新
                  </small>
                  {content.excerpt ? <p>{content.excerpt}</p> : null}
                </span>
                {content.id === selectedContent?.id ? <Check size={16} /> : <ChevronRight size={15} />}
              </button>
            ))
          )}
        </div>
      </Modal>

      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="渲染历史"
        subtitle="最近生成的渲染结果，可随时重新打开或删除"
        size="wide"
      >
        {history.length === 0 ? (
          <EmptyState
            icon={<History size={20} />}
            title="还没有渲染记录"
            description="选择一篇内容完成首次渲染后，记录会出现在这里。"
          />
        ) : (
          <div className="render-history-list">
            {history.map((item) => (
              <div className={`render-history-item${renderId === item.id ? ' is-active' : ''}`} key={item.id}>
                <button
                  type="button"
                  className="render-history-main"
                  onClick={() => void loadRecord(item.id)}
                  disabled={historyLoadingId !== null}
                >
                  <span className="render-history-icons">
                    {item.platforms.map((platform) => {
                      const info = getPlatformInfo(platform)
                      return (
                        <span
                          key={platform}
                          className="render-history-platform"
                          style={{ color: info.color, background: info.softColor }}
                          title={info.name}
                        >
                          <PlatformGlyph platform={platform} size={13} />
                        </span>
                      )
                    })}
                  </span>
                  <span className="render-history-copy">
                    <strong>{item.contentTitle}</strong>
                    <small>
                      {item.platforms.map((platform) => getPlatformInfo(platform).shortName).join(' · ')} ·{' '}
                      {formatDateTime(item.createdAt)}
                    </small>
                  </span>
                  {historyLoadingId === item.id ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : renderId === item.id ? (
                    <span className="render-history-current">当前</span>
                  ) : (
                    <ArrowRight size={15} />
                  )}
                </button>
                <button
                  type="button"
                  className="render-history-delete"
                  onClick={() => void deleteHistoryItem(item.id)}
                  title="删除记录"
                  aria-label="删除记录"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  )
}
