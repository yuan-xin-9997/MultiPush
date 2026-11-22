import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CircleAlert, LoaderCircle, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import {
  BrowserMediaManager,
  LivePlayerProvider,
  TimelineProvider,
  TwickStudio,
  useTimelineContext,
  type ProjectJSON,
  type TrackJSON,
} from '@twick/studio'
import type { ContentDetail, VideoClipDetail, VideoClipInput, VideoStudioProject } from '@shared/types'
import { absoluteUrl, api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import './video-studio.css'
import twickStudioCssUrl from '@twick/studio/dist/studio.css?url'

type SaveState = 'saved' | 'saving' | 'error'

const MAX_COMPATIBILITY_CLIPS = 60

type EditorMediaItem = Awaited<ReturnType<BrowserMediaManager['getItems']>>[number]

/** Seed Twick's media panel with assets that already belong to this video content. */
class SeededMediaManager extends BrowserMediaManager {
  private readonly seed: EditorMediaItem[]
  private seeded = false

  constructor(dbName: string, seed: EditorMediaItem[]) {
    super({ dbName, storeName: 'mediaItems' })
    this.seed = seed
  }

  private async ensureSeeded() {
    if (this.seeded) return
    this.seeded = true
    const existing = await super.getItems()
    if (existing.length === 0 && this.seed.length > 0) {
      await super.addItems(this.seed.map(({ id: _id, ...item }) => item))
    }
  }

  override async getItems(options?: Parameters<BrowserMediaManager['getItems']>[0]) {
    await this.ensureSeeded()
    return super.getItems(options)
  }

  override async search(options: Parameters<BrowserMediaManager['search']>[0]) {
    await this.ensureSeeded()
    return super.search(options)
  }

  override async getTotalCount() {
    await this.ensureSeeded()
    return super.getTotalCount()
  }

  override async getItem(id: string) {
    await this.ensureSeeded()
    return super.getItem(id)
  }
}

function containFrame(width: number, height: number, parentWidth: number, parentHeight: number) {
  const safeWidth = width > 0 ? width : parentWidth
  const safeHeight = height > 0 ? height : parentHeight
  const scale = Math.min(parentWidth / safeWidth, parentHeight / safeHeight)
  const frameWidth = Math.max(2, Math.round(safeWidth * scale / 2) * 2)
  const frameHeight = Math.max(2, Math.round(safeHeight * scale / 2) * 2)
  return {
    x: Math.round((parentWidth - frameWidth) / 2),
    y: Math.round((parentHeight - frameHeight) / 2),
    size: [frameWidth, frameHeight] as [number, number],
  }
}

function sourceDuration(clip: VideoClipDetail): number {
  return clip.media?.duration ?? clip.duration ?? Math.max(clip.trimStart + clip.trimDuration, clip.trimDuration)
}

function buildProject(content: ContentDetail, clips: VideoClipDetail[], saved: ProjectJSON | null): ProjectJSON {
  if (saved) return saved

  const first = clips.find((clip) => clip.media)?.media
  const horizontal = (first?.width ?? 1280) >= (first?.height ?? 720)
  const videoWidth = horizontal ? 1280 : 720
  const videoHeight = horizontal ? 720 : 1280
  const assets: ProjectJSON['assets'] = {}
  const elements = []
  let cursor = 0

  for (const [index, clip] of clips.entries()) {
    const media = clip.media
    if (!media) continue
    const duration = sourceDuration(clip)
    const trimDuration = Math.max(0.05, clip.trimDuration)
    const id = `e-${clip.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || `clip${index}`}`
    assets[media.id] = {
      id: media.id,
      type: 'video',
      url: absoluteUrl(media.url),
      previewUrl: absoluteUrl(media.url),
      duration: Math.round(duration * 1000),
      width: media.width ?? videoWidth,
      height: media.height ?? videoHeight,
      source: 'user',
      origin: 'multipush',
    }
    elements.push({
      id,
      trackId: 't-main',
      type: 'video',
      name: media.originalName || `片段 ${index + 1}`,
      s: Number(cursor.toFixed(3)),
      e: Number((cursor + trimDuration).toFixed(3)),
      props: {
        src: absoluteUrl(media.url),
        time: clip.trimStart,
        playbackRate: 1,
        volume: 1,
      },
      mediaDuration: duration,
      objectFit: 'contain' as const,
      backgroundColor: '#000000',
      frame: containFrame(media.width ?? videoWidth, media.height ?? videoHeight, videoWidth, videoHeight),
      metadata: {
        mediaId: media.id,
        multipushClipId: clip.id,
        duration,
        originalName: media.originalName,
      },
    })
    cursor += trimDuration
  }

  const track: TrackJSON = {
    id: 't-main',
    name: '主视频',
    type: 'element',
    elements,
  }

  return {
    version: 1,
    backgroundColor: '#000000',
    metadata: {
      title: content.title,
      description: content.excerpt,
      tags: content.tags,
      custom: { source: 'multipush', contentId: content.id },
    },
    assets,
    tracks: [track],
  }
}

function mediaLookup(clips: VideoClipDetail[]): {
  byId: Map<string, VideoClipDetail['media']>
  byUrl: Map<string, VideoClipDetail['media']>
} {
  const byId = new Map<string, VideoClipDetail['media']>()
  const byUrl = new Map<string, VideoClipDetail['media']>()
  for (const clip of clips) {
    if (!clip.media) continue
    byId.set(clip.media.id, clip.media)
    const normalized = new URL(absoluteUrl(clip.media.url), window.location.origin)
    byUrl.set(normalized.pathname, clip.media)
  }
  return { byId, byUrl }
}

/** Turn the visual timeline back into the classic clip list the exporter and AI tools consume. */
function deriveClips(project: ProjectJSON, clips: VideoClipDetail[]): VideoClipInput[] {
  const lookup = mediaLookup(clips)
  const elements = project.tracks
    .flatMap((track) => track.elements)
    .filter((element) => element.type === 'video')
    .sort((left, right) => left.s - right.s)

  const derived: VideoClipInput[] = []
  for (const element of elements) {
    const props = (element.props ?? {}) as Record<string, unknown>
    const metadata = (element.metadata ?? {}) as Record<string, unknown>
    const src = typeof props.src === 'string' ? props.src : ''
    let mediaId = typeof metadata.mediaId === 'string' ? metadata.mediaId : null
    if (!mediaId && src) {
      try {
        const parsed = new URL(src, window.location.origin)
        mediaId = lookup.byUrl.get(parsed.pathname)?.id ?? null
      } catch {
        mediaId = null
      }
    }
    if (!mediaId) continue
    const media = lookup.byId.get(mediaId)
    const rate = Number(props.playbackRate ?? 1) || 1
    const start = Math.max(0, Number(props.time ?? 0) || 0)
    const span = Math.max(0.05, (Number(element.e) - Number(element.s)) * rate)
    const duration = (typeof metadata.duration === 'number' ? metadata.duration : null) ?? media?.duration ?? null
    const trimEnd = duration !== null && start + span >= duration - 0.05 ? null : start + span
    derived.push({
      mediaId,
      trimStart: start,
      trimEnd,
      duration,
    })
    if (derived.length >= MAX_COMPATIBILITY_CLIPS) break
  }
  return derived
}

interface StudioBridgeProps {
  contentId: string
  initialProject: ProjectJSON
  clips: VideoClipDetail[]
  onStatusChange: (state: SaveState) => void
  onSavedProject: (project: ProjectJSON) => void
}

function StudioBridge({ contentId, clips, onStatusChange, onSavedProject }: StudioBridgeProps) {
  const { present, changeLog } = useTimelineContext()
  const lastSavedRef = useRef('')
  const savingRef = useRef(false)
  const queuedRef = useRef<ProjectJSON | null>(null)
  const clipsRef = useRef(clips)
  clipsRef.current = clips

  const saveNow = useCallback(async (project: ProjectJSON) => {
    if (savingRef.current) {
      queuedRef.current = project
      return
    }
    const serialized = JSON.stringify(project)
    if (serialized === lastSavedRef.current) return
    savingRef.current = true
    onStatusChange('saving')
    try {
      const compatibilityClips = deriveClips(project, clipsRef.current)
      await api.video.saveStudio(contentId, project as unknown as Record<string, unknown>, compatibilityClips)
      lastSavedRef.current = serialized
      onStatusChange('saved')
      onSavedProject(project)
    } catch (error) {
      onStatusChange('error')
      toast.error(getErrorMessage(error, '保存剪辑项目失败'))
    } finally {
      savingRef.current = false
      const queued = queuedRef.current
      queuedRef.current = null
      if (queued) void saveNow(queued)
    }
  }, [contentId, onSavedProject, onStatusChange])

  useEffect(() => {
    if (!present) return
    const serialized = JSON.stringify(present)
    if (serialized === lastSavedRef.current) return
    const timer = window.setTimeout(() => void saveNow(present), 900)
    return () => window.clearTimeout(timer)
  }, [present, changeLog, saveNow])

  return null
}

/**
 * Twick ships a global stylesheet (body, :root, .card, ...). Loading it only
 * while the studio route is mounted prevents its dark theme from leaking into
 * the library/editor after the user leaves the studio.
 */
function useTwickStudioStyles(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false)
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = twickStudioCssUrl
    link.dataset.twickStudioStyles = 'true'
    let active = true
    const finish = () => { if (active) setReady(true) }
    link.addEventListener('load', finish, { once: true })
    link.addEventListener('error', finish, { once: true })
    document.head.appendChild(link)
    return () => {
      active = false
      link.remove()
    }
  }, [])
  return ready
}

export default function VideoStudioPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [content, setContent] = useState<ContentDetail | null>(null)
  const [studio, setStudio] = useState<VideoStudioProject | null>(null)
  const [loading, setLoading] = useState(true)
  const twickStylesReady = useTwickStudioStyles()
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const initialProjectRef = useRef<ProjectJSON | null>(null)
  const savedProjectRef = useRef<ProjectJSON | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void Promise.all([api.contents.get(id), api.video.getStudio(id)])
      .then(([contentResult, studioResult]) => {
        if (cancelled) return
        const detail = contentResult.content
        if (detail.kind !== 'video') {
          navigate(`/editor/${detail.id}`, { replace: true })
          return
        }
        const firstMedia = studioResult.project.clips.find((clip) => clip.media)?.media
        const horizontal = (firstMedia?.width ?? 1280) >= (firstMedia?.height ?? 720)
        localStorage.setItem('orientation', horizontal ? 'horizontal' : 'vertical')
        const initial = buildProject(detail, studioResult.project.clips, studioResult.project.project as unknown as ProjectJSON | null)
        setContent(detail)
        setStudio(studioResult.project)
        initialProjectRef.current = initial
        savedProjectRef.current = studioResult.project.project as unknown as ProjectJSON | null
        setLoading(false)
      })
      .catch((loadError) => {
        if (cancelled) return
        setError(getErrorMessage(loadError, '加载剪辑工作台失败'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [id, navigate])

  const project = initialProjectRef.current
  const videoProps = useMemo(() => {
    const first = studio?.clips.find((clip) => clip.media)?.media
    const horizontal = (first?.width ?? 1280) >= (first?.height ?? 720)
    return { width: horizontal ? 1280 : 720, height: horizontal ? 720 : 1280 }
  }, [studio])

  const mediaManager = useMemo(() => {
    const clips = studio?.clips ?? []
    const seen = new Set<string>()
    const seed: EditorMediaItem[] = []
    for (const clip of clips) {
      const media = clip.media
      if (!media || seen.has(media.id)) continue
      seen.add(media.id)
      seed.push({
        id: media.id,
        name: media.originalName,
        type: 'video',
        url: absoluteUrl(media.url),
        thumbnail: absoluteUrl(media.url),
        duration: Math.round((media.duration ?? clip.duration ?? 0) * 1000),
        width: media.width ?? undefined,
        height: media.height ?? undefined,
      })
    }
    return new SeededMediaManager(`multipush-twick-${content?.id ?? 'new'}`, seed)
  }, [content?.id, studio])

  const exportVideo = useCallback(async (nextProject: ProjectJSON) => {
    try {
      const clips = deriveClips(nextProject, studio?.clips ?? [])
      await api.video.saveStudio(id!, nextProject as unknown as Record<string, unknown>, clips)
      savedProjectRef.current = nextProject
      toast.info('项目已保存；成片导出仍在旧版工作台中完成（试验版暂未接入文字/特效渲染）')
      navigate(`/video/${id}`)
      return { status: true, message: '已保存并返回旧版导出' }
    } catch (exportError) {
      toast.error(getErrorMessage(exportError, '保存剪辑项目失败'))
      return { status: false, message: getErrorMessage(exportError, '保存剪辑项目失败') }
    }
  }, [id, navigate, studio?.clips])

  if (loading || !twickStylesReady) {
    return (
      <div className="video-studio-loading">
        <LoaderCircle size={22} className="spin" />
        正在准备 Twick 剪辑工作台…
      </div>
    )
  }

  if (error || !content || !project) {
    return (
      <div className="video-studio-loading">
        <CircleAlert size={22} />
        <p>{error ?? '视频内容不存在'}</p>
        <button type="button" className="btn" onClick={() => navigate('/library')}>返回内容库</button>
      </div>
    )
  }

  return (
    <div className="video-studio-page">
      <LivePlayerProvider>
        <TimelineProvider
          contextId={`multipush-video-${content.id}`}
          initialData={project}
          resolution={videoProps}
          analytics={{ enabled: false }}
        >
          <TwickStudio
            studioConfig={{
              videoProps,
              media: { manager: mediaManager },
              hiddenTools: ['generate-media'],
              saveProject: async (nextProject: ProjectJSON) => {
                try {
                  const clips = deriveClips(nextProject, studio?.clips ?? [])
                  await api.video.saveStudio(content.id, nextProject as unknown as Record<string, unknown>, clips)
                  savedProjectRef.current = nextProject
                  toast.success('剪辑项目已保存')
                  return { status: true, message: '已保存' }
                } catch (saveError) {
                  toast.error(getErrorMessage(saveError, '保存剪辑项目失败'))
                  return { status: false, message: getErrorMessage(saveError, '保存剪辑项目失败') }
                }
              },
              loadProject: async () => savedProjectRef.current ?? project,
              exportVideo: async (nextProject: ProjectJSON) => exportVideo(nextProject),
            }}
          />
          <StudioBridge
            contentId={content.id}
            initialProject={project}
            clips={studio?.clips ?? []}
            onStatusChange={setSaveState}
            onSavedProject={(nextProject) => { savedProjectRef.current = nextProject }}
          />
        </TimelineProvider>
      </LivePlayerProvider>

      <div className={`video-studio-floating is-${saveState}`}>
        {saveState === 'saving' ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}
        <span>{saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已自动保存'}</span>
        <button type="button" className="btn btn-sm" onClick={() => navigate(`/video/${content.id}`)}>
          <ArrowLeft size={13} />
          旧版工作台
        </button>
      </div>
    </div>
  )
}
