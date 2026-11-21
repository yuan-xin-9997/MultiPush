import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  Search,
} from 'lucide-react'
import type { MediaAsset, MediaFolder, MediaKind } from '@shared/types'
import { absoluteUrl, api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { cn, formatBytes } from '@/lib/utils'
import EmptyState from './EmptyState'
import Modal from './Modal'
import './media-picker.css'

interface MediaPickerProps {
  open: boolean
  onClose: () => void
  onSelect: (media: MediaAsset[]) => void
  /** Allowed asset kinds in tab order; the first one is selected initially. */
  kinds?: MediaKind[]
  title?: string
  multiple?: boolean
}

const PAGE_SIZE = 24

const KIND_LABEL: Record<MediaKind, string> = {
  image: '图片',
  video: '视频',
  document: '文档',
}

const KIND_ICON: Record<MediaKind, typeof ImageIcon> = {
  image: ImageIcon,
  video: Film,
  document: FileText,
}

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name)
  return match ? match[1].toLowerCase() : ''
}

function docTone(extension: string): string {
  if (extension === 'pdf') return 'pdf'
  if (['doc', 'docx', 'rtf'].includes(extension)) return 'word'
  if (['xls', 'xlsx', 'csv'].includes(extension)) return 'sheet'
  if (['ppt', 'pptx'].includes(extension)) return 'slides'
  if (['json', 'xml', 'yml', 'yaml', 'html', 'htm'].includes(extension)) return 'code'
  return 'text'
}

export default function MediaPicker({
  open,
  onClose,
  onSelect,
  kinds = ['image', 'video', 'document'],
  title = '从素材库添加',
  multiple = true,
}: MediaPickerProps) {
  const allowedKinds = useMemo(
    () => (kinds.length > 0 ? kinds : (['image'] as MediaKind[])),
    [kinds],
  )
  const kindKey = allowedKinds.join(',')
  const [items, setItems] = useState<MediaAsset[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [kind, setKind] = useState<MediaKind>(allowedKinds[0])
  const [folderId, setFolderId] = useState<string | null>(null)
  const [folders, setFolders] = useState<MediaFolder[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [selected, setSelected] = useState<Map<string, MediaAsset>>(new Map())
  const requestRef = useRef(0)

  useEffect(() => {
    if (!open) return
    setItems([])
    setTotal(0)
    setPage(1)
    setKind(allowedKinds[0])
    setFolderId(null)
    setSearchInput('')
    setQuery('')
    setLoadError(null)
    setReloadKey(0)
    setSelected(new Map())
    let cancelled = false
    api.media.folders()
      .then(({ folders: next }) => {
        if (!cancelled) setFolders(next)
      })
      .catch(() => {
        if (!cancelled) setFolders([])
      })
    return () => {
      cancelled = true
    }
  }, [open, kindKey])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      setQuery(searchInput.trim())
      setPage(1)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [open, searchInput])

  useEffect(() => {
    if (!open) return
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setLoading(true)
    setLoadError(null)
    api.media
      .list({
        kind,
        folderId: folderId ?? undefined,
        q: query || undefined,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((result) => {
        if (requestRef.current !== requestId) return
        setItems((current) => (page === 1 ? result.media : [...current, ...result.media]))
        setTotal(result.total)
      })
      .catch((error) => {
        if (requestRef.current !== requestId) return
        setLoadError(getErrorMessage(error, '加载素材失败'))
        if (page === 1) {
          setItems([])
          setTotal(0)
        }
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false)
      })
  }, [open, kind, folderId, query, page, reloadKey])

  function toggleSelected(media: MediaAsset) {
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(media.id)) {
        next.delete(media.id)
      } else {
        if (multiple) {
          next.set(media.id, media)
        } else {
          next.clear()
          next.set(media.id, media)
        }
      }
      return next
    })
  }

  function changeKind(next: MediaKind) {
    if (next === kind) return
    setKind(next)
    setPage(1)
  }

  function changeFolder(next: string) {
    setFolderId(next ? next : null)
    setPage(1)
  }

  const selectedList = useMemo(() => Array.from(selected.values()), [selected])
  const emptyTitle = query ? '没有匹配的素材' : `还没有${KIND_LABEL[kind]}素材`
  const emptyDescription = query
    ? '换个关键词，或切换到其他素材类型。'
    : '先在素材库上传素材，再回到这里添加。'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle="选择素材库中已有的文件，不会重新上传。"
      size="wide"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={selectedList.length === 0}
            onClick={() => {
              onSelect(selectedList)
              onClose()
            }}
          >
            {selectedList.length > 0 ? `添加 ${selectedList.length} 个素材` : '添加素材'}
          </button>
        </>
      }
    >
      <div className="media-picker">
        <div className="media-picker-toolbar">
          {allowedKinds.length > 1 ? (
            <div className="media-picker-tabs" role="tablist" aria-label="素材类型">
              {allowedKinds.map((value) => {
                const Icon = KIND_ICON[value]
                return (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={kind === value}
                    className={cn('media-picker-tab', kind === value && 'is-active')}
                    onClick={() => changeKind(value)}
                  >
                    <Icon size={14} />
                    {KIND_LABEL[value]}
                  </button>
                )
              })}
            </div>
          ) : (
            <span className="media-picker-kind">
              {KIND_LABEL[kind]}
            </span>
          )}
          <label className="media-picker-folder">
            <FolderOpen size={14} />
            <select className="select" value={folderId ?? ''} onChange={(event) => changeFolder(event.target.value)} aria-label="选择素材文件夹">
              <option value="">全部文件夹</option>
              <option value="unfiled">未分组</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>{folder.name}</option>
              ))}
            </select>
          </label>
          <label className="media-picker-search">
            <Search size={14} />
            <input
              className="input"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索文件名…"
              aria-label="搜索素材库"
            />
          </label>
        </div>

        {loading && items.length === 0 ? (
          <div className="media-picker-grid">
            {Array.from({ length: 6 }).map((_, index) => (
              <span className="media-picker-skeleton skeleton" key={index} />
            ))}
          </div>
        ) : loadError ? (
          <EmptyState
            compact
            title="素材加载失败"
            description={loadError}
            action={
              <button type="button" className="btn" onClick={() => setReloadKey((value) => value + 1)}>
                重试
              </button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState compact icon={<Folder size={20} />} title={emptyTitle} description={emptyDescription} />
        ) : (
          <>
            <div className="media-picker-grid">
              {items.map((media) => {
                const isSelected = selected.has(media.id)
                const extension = extensionOf(media.originalName)
                const KindIcon = KIND_ICON[media.kind]
                return (
                  <button
                    type="button"
                    className={cn('media-picker-card', isSelected && 'is-selected')}
                    key={media.id}
                    onClick={() => toggleSelected(media)}
                    aria-pressed={isSelected}
                    aria-label={`${isSelected ? '取消选择' : '选择'} ${media.originalName}`}
                  >
                    <span className="media-picker-thumb">
                      {media.kind === 'image' ? (
                        <img src={absoluteUrl(media.url)} alt={media.originalName} loading="lazy" />
                      ) : media.kind === 'video' ? (
                        <>
                          <video src={absoluteUrl(media.url)} muted playsInline preload="metadata" />
                          <span className="media-picker-play"><Play size={16} fill="currentColor" /></span>
                        </>
                      ) : (
                        <span className={cn('media-picker-doc', `is-${docTone(extension)}`)}>
                          <FileText size={24} />
                          <strong>{extension ? extension.toUpperCase() : 'DOC'}</strong>
                        </span>
                      )}
                      <span className="media-picker-kind-chip"><KindIcon size={11} />{KIND_LABEL[media.kind]}</span>
                      <span className={cn('media-picker-check', isSelected && 'is-checked')}>
                        {isSelected ? <Check size={13} /> : null}
                      </span>
                    </span>
                    <span className="media-picker-name" title={media.originalName}>{media.originalName}</span>
                    <span className="media-picker-meta">{formatBytes(media.size)}</span>
                  </button>
                )
              })}
            </div>
            {items.length < total ? (
              <div className="media-picker-more">
                <button type="button" className="btn btn-sm" disabled={loading} onClick={() => setPage((value) => value + 1)}>
                  {loading ? <LoaderCircle size={14} className="spin" /> : null}
                  {loading ? '加载中…' : `加载更多（${items.length}/${total}）`}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  )
}
