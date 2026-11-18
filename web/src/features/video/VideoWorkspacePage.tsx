import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clapperboard,
  CloudUpload,
  Download,
  Film,
  LoaderCircle,
  Pause,
  Play,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  ContentDetail,
  MediaAsset,
  VideoCapability,
  VideoClipDetail,
  VideoClipInput,
  VideoExport,
} from '@shared/types'
import { api, absoluteUrl } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { cn, escapeHtml, formatBytes, formatDateTime } from '@/lib/utils'
import EmptyState from '@/components/EmptyState'
import './video.css'

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'

interface UploadTask {
  id: string
  name: string
  percent: number
}

const TIMELINE_SAVE_DELAY = 900
const META_SAVE_DELAY = 1200
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--:--'
  const total = Math.max(0, value)
  const minutes = Math.floor(total / 60)
  const seconds = total - minutes * 60
  const secondText = seconds < 10 ? `0${seconds.toFixed(1)}` : seconds.toFixed(1)
  return `${minutes}:${secondText}`
}

/** Read a video duration in the browser when the server has no ffprobe. */
function probeDurationFromUrl(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    const finish = (value: number | null) => {
      video.removeAttribute('src')
      resolve(value)
    }
    const timer = window.setTimeout(() => finish(null), 15_000)
    video.onloadedmetadata = () => {
      window.clearTimeout(timer)
      finish(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null)
    }
    video.onerror = () => {
      window.clearTimeout(timer)
      finish(null)
    }
    video.src = url
  })
}

function htmlToBodyLines(html: string): string {
  if (!html || !html.trim()) return ''
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const blocks = [...doc.querySelectorAll('p, li, h1, h2, h3, blockquote')]
    if (blocks.length === 0) return (doc.body.textContent ?? '').trim()
    return blocks
      .map((block) => (block.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  }
}

function bodyLinesToHtml(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return ''
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
}

/** Player out-point: the trim end, or the source end when untrimmed. */
function clipOutPoint(clip: VideoClipDetail): number | null {
  if (clip.trimEnd !== null) return clip.trimEnd
  return clip.duration ?? null
}

export default function VideoWorkspacePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [content, setContent] = useState<ContentDetail | null>(null)
  const [capability, setCapability] = useState<VideoCapability | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [clips, setClips] = useState<VideoClipDetail[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playAll, setPlayAll] = useState(false)

  const [titleState, setTitleState] = useState<SaveState>('saved')
  const [timelineState, setTimelineState] = useState<SaveState>('saved')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)

  const [uploads, setUploads] = useState<UploadTask[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [exports, setExports] = useState<VideoExport[]>([])
  const [exporting, setExporting] = useState(false)
  const [exportsOpen, setExportsOpen] = useState(false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const pendingSeekRef = useRef<number | null>(null)
  const pendingPlayRef = useRef(false)
  const clipsRef = useRef(clips)
  const activeIndexRef = useRef(activeIndex)
  const playAllRef = useRef(playAll)
  const contentIdRef = useRef<string | null>(null)

  const titleRevisionRef = useRef(0)
  const timelineRevisionRef = useRef(0)
  const titleDirtyRef = useRef(false)
  const timelineDirtyRef = useRef(false)
  const titleSavingRef = useRef(false)
  const timelineSavingRef = useRef(false)
  const titlePendingRef = useRef(false)
  const timelinePendingRef = useRef(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  clipsRef.current = clips
  activeIndexRef.current = activeIndex
  playAllRef.current = playAll
  contentIdRef.current = id ?? null

  // ------------------------------------------------------------- data loading

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    if (!id) {
      setLoading(false)
      setLoadError('缺少内容参数')
      return
    }
    void Promise.all([api.contents.get(id), api.video.getProject(id)])
      .then(([detailResult, projectResult]) => {
        if (cancelled) return
        const detail = detailResult.content
        if (detail.kind !== 'video') {
          navigate(`/editor/${detail.id}`, { replace: true })
          return
        }
        setContent(detail)
        setTitle(detail.title)
        setBody(htmlToBodyLines(detail.contentHtml))
        setTags(detail.tags.join(', '))
        setClips(projectResult.project.clips)
        setCapability(projectResult.capability)
        clipsRef.current = projectResult.project.clips
        timelineDirtyRef.current = false
        titleDirtyRef.current = false
        setTimelineState('saved')
        setTitleState('saved')
        setLastSavedAt(new Date(detail.updatedAt))
        setLoading(false)
      })
      .catch((error) => {
        if (cancelled) return
        setLoading(false)
        setLoadError(getErrorMessage(error, '加载视频内容失败'))
      })
    return () => {
      cancelled = true
    }
  }, [id, navigate])

  const loadExports = useCallback(async (contentId: string) => {
    try {
      const result = await api.video.listExports(contentId)
      setExports(result.exports)
    } catch {
      // Non-critical panel; ignore failures here.
    }
  }, [])

  useEffect(() => {
    if (id) void loadExports(id)
  }, [id, loadExports])

  // Poll export jobs while any of them is queued or running.
  useEffect(() => {
    const active = exports.some((item) => item.status === 'queued' || item.status === 'running')
    if (!active || !id) return
    const timer = window.setInterval(() => {
      void api.video
        .listExports(id)
        .then((result) => setExports(result.exports))
        .catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [exports, id])

  // ------------------------------------------------------------- saving

  const bumpTitleRevision = useCallback(() => {
    titleRevisionRef.current += 1
  }, [])

  const saveMeta = useCallback(async (force = false): Promise<boolean> => {
    const contentId = contentIdRef.current
    if (!contentId) return false
    if (!force && !titleDirtyRef.current) return true
    if (titleSavingRef.current) {
      titlePendingRef.current = true
      return false
    }
    titleSavingRef.current = true
    setTitleState('saving')
    const revisionAtStart = titleRevisionRef.current
    try {
      const tagList = tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
      const { content: updated } = await api.contents.update(contentId, {
        title: title.trim() || '无标题视频',
        contentHtml: bodyLinesToHtml(body),
        tags: tagList,
      })
      if (titleRevisionRef.current === revisionAtStart) {
        titleDirtyRef.current = false
        setTitleState('saved')
        setLastSavedAt(new Date())
        setContent((current) => (current ? { ...current, ...updated } : current))
      } else {
        setTitleState('unsaved')
      }
      return true
    } catch (error) {
      setTitleState('error')
      toast.error(getErrorMessage(error, '保存标题或正文失败'))
      return false
    } finally {
      titleSavingRef.current = false
      if (titlePendingRef.current) {
        titlePendingRef.current = false
        if (titleDirtyRef.current) window.setTimeout(() => void saveMeta(true), 50)
      }
    }
  }, [title, body, tags])

  const saveTimeline = useCallback(async (force = false): Promise<boolean> => {
    const contentId = contentIdRef.current
    if (!contentId) return false
    if (!force && !timelineDirtyRef.current) return true
    if (timelineSavingRef.current) {
      timelinePendingRef.current = true
      return false
    }
    timelineSavingRef.current = true
    setTimelineState('saving')
    const revisionAtStart = timelineRevisionRef.current
    try {
      const payload: VideoClipInput[] = clipsRef.current.map((clip) => ({
        mediaId: clip.mediaId,
        trimStart: clip.trimStart,
        trimEnd: clip.trimEnd,
        duration: clip.duration,
      }))
      const { project } = await api.video.saveTimeline(contentId, payload)
      if (timelineRevisionRef.current === revisionAtStart) {
        timelineDirtyRef.current = false
        setTimelineState('saved')
        setLastSavedAt(new Date())
        setClips(project.clips)
        clipsRef.current = project.clips
        setActiveIndex((index) => Math.min(index, Math.max(0, project.clips.length - 1)))
      } else {
        setTimelineState('unsaved')
      }
      return true
    } catch (error) {
      setTimelineState('error')
      toast.error(getErrorMessage(error, '保存剪辑时间线失败'))
      return false
    } finally {
      timelineSavingRef.current = false
      if (timelinePendingRef.current) {
        timelinePendingRef.current = false
        if (timelineDirtyRef.current) window.setTimeout(() => void saveTimeline(true), 50)
      }
    }
  }, [])

  // Debounced auto-saves.
  useEffect(() => {
    if (titleState !== 'unsaved') return
    const timer = window.setTimeout(() => void saveMeta(false), META_SAVE_DELAY)
    return () => window.clearTimeout(timer)
  }, [titleState, saveMeta])

  useEffect(() => {
    if (timelineState !== 'unsaved') return
    const timer = window.setTimeout(() => void saveTimeline(false), TIMELINE_SAVE_DELAY)
    return () => window.clearTimeout(timer)
  }, [timelineState, saveTimeline])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (titleDirtyRef.current) void saveMeta(true)
        if (timelineDirtyRef.current) void saveTimeline(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveMeta, saveTimeline])

  useEffect(() => {
    const dirty = titleDirtyRef.current || timelineDirtyRef.current
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [titleState, timelineState])

  // ------------------------------------------------------------- editing helpers

  const markMetaDirty = useCallback(() => {
    bumpTitleRevision()
    titleDirtyRef.current = true
    setTitleState('unsaved')
  }, [bumpTitleRevision])

  const markTimelineDirty = useCallback(() => {
    timelineRevisionRef.current += 1
    timelineDirtyRef.current = true
    setTimelineState('unsaved')
  }, [])

  const updateClip = useCallback((clipId: string, patch: Partial<VideoClipDetail>) => {
    setClips((current) => current.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)))
    markTimelineDirty()
  }, [markTimelineDirty])

  const moveClip = useCallback((index: number, direction: -1 | 1) => {
    setClips((current) => {
      const target = index + direction
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
    if (direction === -1) setActiveIndex((value) => Math.max(0, value - 1))
    else setActiveIndex((value) => Math.min(clipsRef.current.length - 1, value + 1))
    markTimelineDirty()
  }, [markTimelineDirty])

  const removeClip = useCallback((index: number) => {
    const clip = clipsRef.current[index]
    if (!clip) return
    setClips((current) => current.filter((_, i) => i !== index))
    setActiveIndex((current) => {
      if (current === index) return Math.max(0, Math.min(current, clipsRef.current.length - 2))
      if (current > index) return current - 1
      return current
    })
    markTimelineDirty()
  }, [markTimelineDirty])

  // ------------------------------------------------------------- uploading

  const appendUploadedClip = useCallback(async (media: MediaAsset, file: File) => {
    let duration: number | null = media.duration ?? null
    if (duration === null) {
      try {
        const { probe } = await api.media.probe(media.id)
        duration = probe.duration ?? null
      } catch {
        duration = null
      }
    }
    if (duration === null) {
      try {
        duration = await probeDurationFromUrl(URL.createObjectURL(file))
      } catch {
        duration = null
      }
    }
    const clip: VideoClipDetail = {
      id: `local-${media.id}`,
      mediaId: media.id,
      trimStart: 0,
      trimEnd: null,
      duration,
      trimDuration: duration ?? 0,
      media: {
        ...media,
        url: media.url || `/uploads/${media.filename}`,
      },
    }
    setClips((current) => [...current, clip])
    clipsRef.current = [...clipsRef.current, clip]
    markTimelineDirty()
    setActiveIndex(clipsRef.current.length - 1)
  }, [markTimelineDirty])

  const uploadFiles = useCallback(async (files: File[]) => {
    const videos = files.filter((file) => file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name))
    if (videos.length === 0) {
      toast.error('请选择 MP4、WebM 或 MOV 视频文件')
      return
    }
    for (const file of videos) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(`「${file.name}」超过 200MB 上限`)
        continue
      }
      const taskId = `${Date.now()}-${Math.random()}`
      setUploads((current) => [...current, { id: taskId, name: file.name, percent: 0 }])
      try {
        const { media } = await api.media.upload(file, (percent) => {
          setUploads((current) => current.map((task) => (task.id === taskId ? { ...task, percent } : task)))
        })
        await appendUploadedClip(media, file)
        toast.success(`已添加片段「${file.name}」`)
      } catch (error) {
        toast.error(getErrorMessage(error, `上传「${file.name}」失败`))
      } finally {
        setUploads((current) => current.filter((task) => task.id !== taskId))
      }
    }
  }, [appendUploadedClip])

  // ------------------------------------------------------------- player

  const activeClip = clips[activeIndex] ?? null

  useEffect(() => {
    const video = videoRef.current
    if (!video || !activeClip) return
    const url = activeClip.media ? absoluteUrl(activeClip.media.url) : ''
    if (!url) return
    if (video.dataset.activeSrc !== url) {
      video.dataset.activeSrc = url
      video.src = url
      pendingSeekRef.current = activeClip.trimStart
    } else if (Math.abs(video.currentTime - activeClip.trimStart) > 0.05 && video.paused) {
      // Re-selecting the same clip jumps back to its in-point.
      try {
        video.currentTime = activeClip.trimStart
      } catch {
        pendingSeekRef.current = activeClip.trimStart
      }
    }
  }, [activeClip, activeIndex])

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    const clip = clipsRef.current[activeIndexRef.current]
    if (!video || !clip) return
    if (pendingSeekRef.current !== null) {
      try {
        video.currentTime = pendingSeekRef.current
      } catch {
        // Ignore; the element will start from the beginning.
      }
      pendingSeekRef.current = null
    }
    // Fill in a missing duration once the browser knows it.
    if (!clip.duration && Number.isFinite(video.duration) && video.duration > 0) {
      updateClip(clip.id, { duration: video.duration })
    }
    if (pendingPlayRef.current) {
      pendingPlayRef.current = false
      void video.play().catch(() => undefined)
    }
  }, [updateClip])

  const advanceToNextClip = useCallback(() => {
    const index = activeIndexRef.current
    if (playAllRef.current && index < clipsRef.current.length - 1) {
      pendingPlayRef.current = true
      setActiveIndex(index + 1)
      return true
    }
    return false
  }, [])

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    const clip = clipsRef.current[activeIndexRef.current]
    if (!video || !clip || video.paused) return
    const out = clipOutPoint(clip)
    if (out !== null && video.currentTime >= out - 0.05) {
      if (!advanceToNextClip()) {
        video.pause()
        try {
          video.currentTime = clip.trimStart
        } catch {
          // Ignore.
        }
      }
    }
  }, [advanceToNextClip])

  const handleEnded = useCallback(() => {
    setPlaying(false)
    if (advanceToNextClip()) return
    const clip = clipsRef.current[activeIndexRef.current]
    const video = videoRef.current
    if (clip && video) {
      try {
        video.currentTime = clip.trimStart
      } catch {
        // Ignore.
      }
    }
  }, [advanceToNextClip])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video.play().catch(() => undefined)
    } else {
      video.pause()
    }
  }, [])

  const playTimeline = useCallback(() => {
    if (clips.length === 0) return
    setPlayAll(true)
    pendingPlayRef.current = true
    setActiveIndex(0)
    // Same clip already active: just start playback.
    const video = videoRef.current
    const clip = clipsRef.current[0]
    if (video && clip && video.dataset.activeSrc && clip.media && video.dataset.activeSrc === absoluteUrl(clip.media.url)) {
      try {
        video.currentTime = clip.trimStart
      } catch {
        // Ignore.
      }
      pendingPlayRef.current = false
      void video.play().catch(() => undefined)
    }
  }, [clips.length])

  const setInPoint = useCallback(() => {
    const video = videoRef.current
    const clip = clipsRef.current[activeIndexRef.current]
    if (!video || !clip) return
    const current = video.currentTime
    const out = clipOutPoint(clip)
    const next = Math.min(current, (out ?? Number.POSITIVE_INFINITY) - 0.2)
    updateClip(clip.id, { trimStart: Math.max(0, Math.round(next * 100) / 100) })
  }, [updateClip])

  const setOutPoint = useCallback(() => {
    const video = videoRef.current
    const clip = clipsRef.current[activeIndexRef.current]
    if (!video || !clip) return
    const current = video.currentTime
    const start = clip.trimStart
    const sourceEnd = clip.duration ?? null
    let next = Math.max(current, start + 0.1)
    if (sourceEnd !== null) next = Math.min(next, sourceEnd)
    const reachedEnd = sourceEnd !== null && Math.abs(next - sourceEnd) < 0.05
    updateClip(clip.id, { trimEnd: reachedEnd ? null : Math.round(next * 100) / 100 })
  }, [updateClip])

  // ------------------------------------------------------------- exporting

  const handleExport = useCallback(async () => {
    const contentId = contentIdRef.current
    if (!contentId || exporting) return
    if (timelineDirtyRef.current) await saveTimeline(true)
    setExporting(true)
    try {
      const { export: record } = await api.video.createExport(contentId)
      setExports((current) => [record, ...current])
      setExportsOpen(true)
      toast.success('导出任务已创建，正在后台剪辑合成')
    } catch (error) {
      toast.error(getErrorMessage(error, '创建导出任务失败'))
    } finally {
      setExporting(false)
    }
  }, [exporting, saveTimeline])

  const handleDeleteExport = useCallback(async (exportId: string) => {
    try {
      await api.video.deleteExport(exportId)
      setExports((current) => current.filter((item) => item.id !== exportId))
    } catch (error) {
      toast.error(getErrorMessage(error, '删除导出记录失败'))
    }
  }, [])

  // ------------------------------------------------------------- derived

  const totalDuration = useMemo(
    () => clips.reduce((sum, clip) => sum + clip.trimDuration, 0),
    [clips],
  )

  const overallState: SaveState =
    titleState === 'error' || timelineState === 'error'
      ? 'error'
      : titleState === 'saving' || timelineState === 'saving'
        ? 'saving'
        : titleState === 'unsaved' || timelineState === 'unsaved'
          ? 'unsaved'
          : 'saved'

  const saveLabel =
    overallState === 'saving'
      ? '保存中…'
      : overallState === 'error'
        ? '保存失败'
        : overallState === 'unsaved'
          ? '未保存'
          : lastSavedAt
            ? `已保存 ${formatDateTime(lastSavedAt)}`
            : '已保存'

  // ------------------------------------------------------------- render

  if (loading) {
    return (
      <div className="video-page">
        <div className="video-loading">
          <LoaderCircle size={20} className="spin" />
          正在加载视频工作台…
        </div>
      </div>
    )
  }

  if (loadError || !content) {
    return (
      <div className="video-page">
        <EmptyState
          icon={<CircleAlert size={22} />}
          title="视频内容加载失败"
          description={loadError ?? '内容不存在'}
          action={
            <button type="button" className="btn" onClick={() => navigate('/library')}>
              返回内容库
            </button>
          }
        />
      </div>
    )
  }

  return (
    <div
      className="video-page"
      onDragOver={(event) => {
        event.preventDefault()
        setDragActive(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragActive(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragActive(false)
        if (event.dataTransfer?.files?.length) void uploadFiles(Array.from(event.dataTransfer.files))
      }}
    >
      <header className="video-header">
        <button type="button" className="btn video-back" onClick={() => navigate('/library')} aria-label="返回内容库">
          <ArrowLeft size={16} />
          <span>内容库</span>
        </button>
        <div className="video-title-wrap">
          <Clapperboard size={16} className="video-title-icon" />
          <input
            className="input video-title-input"
            value={title}
            placeholder="无标题视频"
            aria-label="视频标题"
            onChange={(event) => {
              setTitle(event.target.value)
              markMetaDirty()
            }}
          />
        </div>
        <div className="video-header-actions">
          <span className={cn('video-save-state', overallState === 'error' && 'is-error', overallState === 'saving' && 'is-saving')}>
            {overallState === 'saving' ? <LoaderCircle size={13} className="spin" /> : null}
            {saveLabel}
          </span>
          <button type="button" className="btn" onClick={() => setExportsOpen(true)}>
            <Download size={15} />
            导出记录{exports.length > 0 ? ` (${exports.length})` : ''}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleExport()} disabled={exporting || clips.length === 0}>
            {exporting ? <LoaderCircle size={15} className="spin" /> : <Film size={15} />}
            导出成片
          </button>
        </div>
      </header>

      {capability && !capability.ffmpeg ? (
        <div className="video-capability-note" role="note">
          <CircleAlert size={14} />
          服务器未安装 ffmpeg：剪辑时间线可以正常保存，导出成片需要在服务器安装 ffmpeg（或设置 FFMPEG_PATH）。
        </div>
      ) : null}

      <div className="video-layout">
        <section className="video-player-col">
          <div className="video-player-card">
            {activeClip ? (
              <video
                ref={videoRef}
                className="video-player"
                controls
                preload="auto"
                playsInline
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                onEnded={handleEnded}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />
            ) : (
              <div className="video-player-placeholder">
                <Film size={34} />
                <p>上传视频后即可预览与剪辑</p>
              </div>
            )}
            {activeClip ? (
              <div className="video-player-meta">
                <span className="video-clip-name" title={activeClip.media?.originalName}>
                  片段 {activeIndex + 1}/{clips.length} · {activeClip.media?.originalName ?? '未知素材'}
                </span>
                <span className="video-clip-range">
                  {formatSeconds(activeClip.trimStart)} – {activeClip.trimEnd === null ? '结尾' : formatSeconds(activeClip.trimEnd)}
                </span>
              </div>
            ) : null}
            {activeClip ? (
              <div className="video-player-controls">
                <button type="button" className="btn btn-sm" onClick={() => setActiveIndex((value) => Math.max(0, value - 1))} disabled={activeIndex === 0}>
                  <SkipBack size={14} />
                  上一段
                </button>
                <button type="button" className="btn btn-sm btn-primary" onClick={togglePlay}>
                  {playing ? <Pause size={14} /> : <Play size={14} />}
                  {playing ? '暂停' : '播放本段'}
                </button>
                <button type="button" className="btn btn-sm" onClick={playTimeline} disabled={clips.length < 2}>
                  <Play size={14} />
                  播放整条
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setActiveIndex((value) => Math.min(clips.length - 1, value + 1))} disabled={activeIndex >= clips.length - 1}>
                  下一段
                  <SkipForward size={14} />
                </button>
                <span className="video-player-divider" />
                <button type="button" className="btn btn-sm" onClick={setInPoint} title="把当前播放位置设为片段起点">
                  <Scissors size={14} />
                  设入点
                </button>
                <button type="button" className="btn btn-sm" onClick={setOutPoint} title="把当前播放位置设为片段终点">
                  <Scissors size={14} />
                  设出点
                </button>
              </div>
            ) : null}
          </div>

          <div className="video-strip-card">
            <div className="video-strip-head">
              <span>时间线</span>
              <span className="video-strip-total">
                {clips.length} 段 · 总时长 {formatSeconds(totalDuration)}
              </span>
            </div>
            {clips.length > 0 ? (
              <div className="video-strip">
                {clips.map((clip, index) => (
                  <button
                    key={clip.id}
                    type="button"
                    className={cn('video-strip-segment', index === activeIndex && 'is-active', !clip.media && 'is-missing')}
                    style={{ flexGrow: Math.max(0.4, clip.trimDuration || 0.4) }}
                    onClick={() => setActiveIndex(index)}
                    title={`片段 ${index + 1} · ${formatSeconds(clip.trimDuration)}`}
                  >
                    <span>{index + 1}</span>
                    <span className="video-strip-duration">{formatSeconds(clip.trimDuration)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="video-strip-empty">还没有片段，先上传一段或多段视频。</p>
            )}
          </div>

          <div className="video-body-card">
            <label className="video-field-label" htmlFor="video-body">正文内容</label>
            <textarea
              id="video-body"
              className="textarea video-body-textarea"
              value={body}
              placeholder="为这条视频写正文文案：可以写视频简介、话题标签、发布文案等，每个空行分段。"
              rows={6}
              onChange={(event) => {
                setBody(event.target.value)
                markMetaDirty()
              }}
            />
            <label className="video-field-label" htmlFor="video-tags">标签</label>
            <input
              id="video-tags"
              className="input"
              value={tags}
              placeholder="用逗号分隔，例如：旅行, vlog, 城市漫步"
              onChange={(event) => {
                setTags(event.target.value)
                markMetaDirty()
              }}
            />
          </div>
        </section>

        <aside className="video-side-col">
          <div
            className={cn('video-upload-card', dragActive && 'is-drag')}
            onClick={() => uploadInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                uploadInputRef.current?.click()
              }
            }}
          >
            <CloudUpload size={20} />
            <div>
              <p className="video-upload-title">上传视频片段</p>
              <p className="video-upload-hint">支持 MP4 / WebM / MOV，单段最大 200MB，可一次选择多段</p>
            </div>
            <input
              ref={uploadInputRef}
              className="visually-hidden"
              type="file"
              multiple
              accept="video/mp4,video/webm,video/quicktime,video/*"
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                if (event.target.files) void uploadFiles(Array.from(event.target.files))
                event.target.value = ''
              }}
            />
          </div>

          {uploads.length > 0 ? (
            <div className="video-uploads">
              {uploads.map((task) => (
                <div className="video-upload-task" key={task.id}>
                  <span className="video-upload-task-name" title={task.name}>{task.name}</span>
                  <span className="video-upload-task-bar">
                    <span style={{ width: `${task.percent}%` }} />
                  </span>
                  <span className="video-upload-task-percent">{task.percent}%</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="video-clips-card">
            <div className="video-clips-head">
              <span>片段列表</span>
              <span>{clips.length} 段</span>
            </div>
            {clips.length === 0 ? (
              <p className="video-clips-empty">上传的视频会按顺序排列在这里，可修剪、调序和删除。</p>
            ) : (
              <ul className="video-clip-list">
                {clips.map((clip, index) => (
                  <li
                    key={clip.id}
                    className={cn('video-clip-item', index === activeIndex && 'is-active')}
                    onClick={() => setActiveIndex(index)}
                  >
                    <div className="video-clip-thumb">
                      {clip.media ? (
                        <video
                          src={`${absoluteUrl(clip.media.url)}#t=${Math.min(clip.trimStart + 0.2, Math.max(0, (clip.duration ?? 2) / 2))}`}
                          preload="metadata"
                          muted
                          tabIndex={-1}
                        />
                      ) : (
                        <CircleAlert size={18} />
                      )}
                      <span className="video-clip-index">{index + 1}</span>
                    </div>
                    <div className="video-clip-info">
                      <p className="video-clip-title" title={clip.media?.originalName ?? '素材已删除'}>
                        {clip.media?.originalName ?? '素材已删除'}
                      </p>
                      <div className="video-clip-trims">
                        <label>
                          入点
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            value={clip.trimStart}
                            disabled={!clip.media}
                            onChange={(event) => {
                              const next = Number(event.target.value)
                              if (!Number.isFinite(next)) return
                              const out = clipOutPoint(clip)
                              const clamped = Math.max(0, Math.min(next, (out ?? next + 1) - 0.1))
                              updateClip(clip.id, { trimStart: Math.round(clamped * 100) / 100 })
                            }}
                          />
                        </label>
                        <label>
                          出点
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            value={clip.trimEnd ?? ''}
                            placeholder="结尾"
                            disabled={!clip.media}
                            onChange={(event) => {
                              const raw = event.target.value
                              if (raw === '') {
                                updateClip(clip.id, { trimEnd: null })
                                return
                              }
                              const next = Number(raw)
                              if (!Number.isFinite(next)) return
                              const start = clip.trimStart
                              const sourceEnd = clip.duration ?? null
                              let clamped = Math.max(start + 0.1, next)
                              if (sourceEnd !== null) clamped = Math.min(clamped, sourceEnd)
                              const reachedEnd = sourceEnd !== null && Math.abs(clamped - sourceEnd) < 0.05
                              updateClip(clip.id, { trimEnd: reachedEnd ? null : Math.round(clamped * 100) / 100 })
                            }}
                          />
                        </label>
                        <span className="video-clip-duration">
                          {formatSeconds(clip.trimDuration)}
                          {clip.media ? ` / ${formatSeconds(clip.duration)}` : ''}
                        </span>
                      </div>
                    </div>
                    <div className="video-clip-actions">
                      <button type="button" className="icon-btn" onClick={(event) => { event.stopPropagation(); moveClip(index, -1) }} disabled={index === 0} aria-label="上移片段">
                        <ChevronUp size={14} />
                      </button>
                      <button type="button" className="icon-btn" onClick={(event) => { event.stopPropagation(); moveClip(index, 1) }} disabled={index === clips.length - 1} aria-label="下移片段">
                        <ChevronDown size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn is-danger"
                        onClick={(event) => { event.stopPropagation(); removeClip(index) }}
                        aria-label="删除片段"
                        title="从时间线移除（不删除素材）"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {dragActive ? (
        <div className="video-drop-overlay">
          <div className="video-drop-card">
            <CloudUpload size={26} />
            <p>松开鼠标，上传视频片段</p>
          </div>
        </div>
      ) : null}

      {exportsOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setExportsOpen(false)}>
          <div className="video-exports-panel" role="dialog" aria-modal="true" aria-label="导出记录" onClick={(event) => event.stopPropagation()}>
            <div className="video-exports-head">
              <h2>导出记录</h2>
              <button type="button" className="icon-btn" onClick={() => setExportsOpen(false)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <p className="video-exports-sub">
              按当前时间线用服务端 ffmpeg 逐段剪辑并合并；成片会自动存入素材库，可直接用于抖音等平台发布。
            </p>
            {exports.length === 0 ? (
              <EmptyState compact icon={<Film size={20} />} title="还没有导出记录" description="点击右上角「导出成片」开始第一次导出。" />
            ) : (
              <ul className="video-exports-list">
                {exports.map((item) => (
                  <li key={item.id} className="video-export-item">
                    <div className="video-export-info">
                      <div className="video-export-top">
                        <span className={cn('video-export-status', `is-${item.status}`)}>
                          {item.status === 'queued' && '排队中'}
                          {item.status === 'running' && `导出中 ${Math.round(item.progress)}%`}
                          {item.status === 'completed' && '已完成'}
                          {item.status === 'failed' && '失败'}
                        </span>
                        <span className="video-export-time">{formatDateTime(item.createdAt)}</span>
                      </div>
                      {item.status === 'running' || item.status === 'queued' ? (
                        <span className="video-export-bar">
                          <span style={{ width: `${item.progress}%` }} />
                        </span>
                      ) : null}
                      {item.message ? <p className="video-export-message">{item.message}</p> : null}
                      {item.status === 'completed' && item.outputMedia ? (
                        <div className="video-export-output">
                          <video src={absoluteUrl(item.outputMedia.url)} controls preload="metadata" />
                          <div className="video-export-output-meta">
                            <span>{formatSeconds(item.totalDuration)} · {formatBytes(item.outputMedia.size)}</span>
                            <a className="btn btn-sm" href={absoluteUrl(item.outputMedia.url)} download={item.outputMedia.originalName}>
                              <Download size={13} />
                              下载成片
                            </a>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <button type="button" className="icon-btn is-danger" onClick={() => void handleDeleteExport(item.id)} aria-label="删除导出记录">
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
