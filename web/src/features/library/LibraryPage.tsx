import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowDownWideNarrow,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePlus2,
  FolderInput,
  Grid2X2,
  List,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Book, ContentListResult, ContentSummary } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatNumber } from '@/lib/format'
import {
  exportContentFile,
  exportContentsZip,
  IMPORT_ACCEPT,
  IMPORT_MAX_FILES,
  parseImportFile,
  type ExportFormat,
} from '@/lib/content-io'
import { cn } from '@/lib/utils'
import ConfirmDialog from '@/components/ConfirmDialog'
import EmptyState from '@/components/EmptyState'
import Modal from '@/components/Modal'
import BookSidebar from './BookSidebar'
import DocumentCard from './DocumentCard'
import DocumentRow from './DocumentRow'
import type { DocumentActions } from './DocumentMenu'
import {
  LIBRARY_PAGE_SIZE,
  MAX_BATCH_EXPORT,
  SORT_OPTIONS,
  UNFILED_BOOK_ID,
  type LibraryCounts,
  type LibraryMode,
  type LibrarySort,
  type LibraryView,
} from './types'
import './library.css'

const VIEW_STORAGE_KEY = 'multipush_library_view'

function readStoredView(): LibraryView {
  return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'card'
}

function modeFromPath(pathname: string): { mode: LibraryMode; bookId: string | null } {
  if (pathname === '/library/favorites') return { mode: 'favorites', bookId: null }
  if (pathname === '/library/trash') return { mode: 'trash', bookId: null }
  const match = pathname.match(/^\/library\/book\/([^/]+)/)
  if (match) return { mode: 'book', bookId: decodeURIComponent(match[1]) }
  return { mode: 'all', bookId: null }
}

function emptyResult(page: number): ContentListResult {
  return { items: [], total: 0, page, pageSize: LIBRARY_PAGE_SIZE }
}

export default function LibraryPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { mode, bookId } = useMemo(() => modeFromPath(location.pathname), [location.pathname])
  const activeBookId = bookId

  const [books, setBooks] = useState<Book[]>([])
  const [booksLoading, setBooksLoading] = useState(true)
  const [counts, setCounts] = useState<LibraryCounts>({ all: 0, favorites: 0, trash: 0, unfiled: 0 })
  const [items, setItems] = useState<ContentSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<LibrarySort>('updated_desc')
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<LibraryView>(readStoredView)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [subnavOpen, setSubnavOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [deleteTargets, setDeleteTargets] = useState<ContentSummary[]>([])
  const [deletePermanent, setDeletePermanent] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [moveTargets, setMoveTargets] = useState<ContentSummary[]>([])
  const [moveBookId, setMoveBookId] = useState<string>(UNFILED_BOOK_ID)
  const [moving, setMoving] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number; label: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  const currentBook = mode === 'book' ? books.find((book) => book.id === activeBookId) : null
  const isTrash = mode === 'trash'

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(searchInput.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    setPage(1)
    setSelected(new Set())
    setSubnavOpen(false)
  }, [location.pathname])

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view)
  }, [view])

  const fetchBookData = useCallback(async () => {
    setBooksLoading(true)
    try {
      const result = await api.books.list()
      setBooks(result.books)
    } catch (error) {
      toast.error(getErrorMessage(error, '加载知识库失败'))
    } finally {
      setBooksLoading(false)
    }
  }, [])

  const fetchCounts = useCallback(async () => {
    const results = await Promise.allSettled([
      api.contents.list({ pageSize: 1 }),
      api.contents.list({ pageSize: 1, favorite: true }),
      api.contents.list({ pageSize: 1, trash: true }),
      api.contents.list({ pageSize: 1, bookId: UNFILED_BOOK_ID }),
    ])
    const totals = results.map((result) => (result.status === 'fulfilled' ? result.value.total : null))
    setCounts((current) => ({
      all: totals[0] ?? current.all,
      favorites: totals[1] ?? current.favorites,
      trash: totals[2] ?? current.trash,
      unfiled: totals[3] ?? current.unfiled,
    }))
  }, [])

  useEffect(() => {
    void fetchBookData()
    void fetchCounts()
  }, [fetchBookData, fetchCounts, reloadKey])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    const queryBookId = mode === 'book' ? activeBookId : undefined
    api.contents
      .list({
        page,
        pageSize: LIBRARY_PAGE_SIZE,
        sort,
        q: query || undefined,
        bookId: queryBookId,
        favorite: mode === 'favorites' ? true : undefined,
        trash: isTrash,
      })
      .then((result) => {
        if (cancelled) return
        setItems(result.items)
        setTotal(result.total)
        setSelected((current) => {
          const valid = new Set(result.items.map((item) => item.id))
          return new Set(Array.from(current).filter((id) => valid.has(id)))
        })
      })
      .catch((error) => {
        if (cancelled) return
        setItems([])
        setTotal(0)
        setLoadError(getErrorMessage(error, '加载内容失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [mode, activeBookId, page, sort, query, isTrash, reloadKey])

  const reload = useCallback(() => setReloadKey((value) => value + 1), [])

  const handleToggleSelected = useCallback((id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const actions: DocumentActions = useMemo(
    () => ({
      open: (item) => navigate(`/editor/${item.id}`),
      toggleFavorite: (item) => {
        void api.contents
          .setFavorite(item.id, !item.favorite)
          .then(() => {
            setItems((current) =>
              current.map((entry) => (entry.id === item.id ? { ...entry, favorite: !item.favorite } : entry)),
            )
            setCounts((current) => ({
              ...current,
              favorites: Math.max(0, current.favorites + (item.favorite ? -1 : 1)),
            }))
          })
          .catch((error) => toast.error(getErrorMessage(error, '收藏操作失败')))
      },
      exportFormat: (item, format) => {
        void api.contents
          .get(item.id)
          .then(({ content }) => {
            exportContentFile(content, format)
            toast.success('导出文件已开始下载')
          })
          .catch((error) => toast.error(getErrorMessage(error, '导出失败')))
      },
      duplicate: (item) => {
        void api.contents
          .duplicate(item.id)
          .then(() => {
            toast.success('文档已复制')
            reload()
          })
          .catch((error) => toast.error(getErrorMessage(error, '复制失败')))
      },
      move: (item) => {
        setMoveTargets([item])
        setMoveBookId(item.bookId ?? UNFILED_BOOK_ID)
      },
      remove: (item) => {
        setDeletePermanent(false)
        setDeleteTargets([item])
      },
      restore: (item) => {
        void api.contents
          .restore(item.id)
          .then(() => {
            toast.success('文档已恢复')
            reload()
          })
          .catch((error) => toast.error(getErrorMessage(error, '恢复失败')))
      },
      permanentRemove: (item) => {
        setDeletePermanent(true)
        setDeleteTargets([item])
      },
      render: (item) => navigate(`/render?contentId=${item.id}`),
    }),
    [navigate, reload],
  )

  async function createDocument() {
    try {
      const targetBookId = mode === 'book' && activeBookId !== UNFILED_BOOK_ID ? activeBookId : null
      const { content } = await api.contents.create({ title: '无标题文档', bookId: targetBookId })
      navigate(`/editor/${content.id}`)
    } catch (error) {
      toast.error(getErrorMessage(error, '创建文档失败'))
    }
  }

  async function handleDeleteConfirm() {
    if (deleteTargets.length === 0 || deleting) return
    setDeleting(true)
    const targets = deleteTargets
    try {
      for (const target of targets) {
        await api.contents.remove(target.id, deletePermanent)
      }
      toast.success(deletePermanent ? `已彻底删除 ${targets.length} 篇文档` : `已移入回收站 ${targets.length} 篇文档`)
      setDeleteTargets([])
      setSelected(new Set())
      reload()
    } catch (error) {
      toast.error(getErrorMessage(error, deletePermanent ? '彻底删除失败' : '删除失败'))
    } finally {
      setDeleting(false)
    }
  }

  async function handleMoveConfirm() {
    if (moveTargets.length === 0 || moving) return
    setMoving(true)
    const targetBook = moveBookId === UNFILED_BOOK_ID ? null : moveBookId
    try {
      for (const target of moveTargets) {
        await api.contents.update(target.id, { bookId: targetBook })
      }
      toast.success(`已移动 ${moveTargets.length} 篇文档`)
      setMoveTargets([])
      setSelected(new Set())
      reload()
    } catch (error) {
      toast.error(getErrorMessage(error, '移动失败'))
    } finally {
      setMoving(false)
    }
  }

  async function handleBatchExport(format: ExportFormat) {
    if (exporting) return
    const ids = Array.from(selected)
    if (ids.length === 0) return
    if (ids.length > MAX_BATCH_EXPORT) {
      toast.error(`一次最多导出 ${MAX_BATCH_EXPORT} 篇文档`)
      return
    }
    setExporting(true)
    try {
      const contents = []
      for (const id of ids) {
        const { content } = await api.contents.get(id)
        contents.push(content)
      }
      await exportContentsZip(contents, format)
      toast.success(`已打包导出 ${contents.length} 篇文档`)
      setExportOpen(false)
    } catch (error) {
      toast.error(getErrorMessage(error, '批量导出失败'))
    } finally {
      setExporting(false)
    }
  }

  async function handleImportFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    if (files.length === 0) return
    if (isTrash) {
      toast.error('回收站中不能导入文档')
      return
    }
    if (files.length > IMPORT_MAX_FILES) {
      toast.error(`一次最多导入 ${IMPORT_MAX_FILES} 个文件`)
      return
    }
    const targetBookId = mode === 'book' && activeBookId !== UNFILED_BOOK_ID ? activeBookId : null
    setImportProgress({ done: 0, total: files.length, label: '准备导入…' })
    let created = 0
    const errors: string[] = []
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      setImportProgress({ done: index, total: files.length, label: `正在解析 ${file.name}` })
      try {
        const docs = await parseImportFile(file)
        for (const doc of docs) {
          try {
            await api.contents.create({ ...doc, bookId: targetBookId })
            created += 1
          } catch (error) {
            errors.push(`${file.name}：${getErrorMessage(error, '创建文档失败')}`)
          }
        }
      } catch (error) {
        errors.push(getErrorMessage(error, '解析失败'))
      }
      setImportProgress({ done: index + 1, total: files.length, label: file.name })
    }
    setImportProgress(null)
    if (created > 0) {
      toast.success(`成功导入 ${created} 篇文档`)
      reload()
    }
    if (errors.length > 0) {
      toast.error(errors.length === 1 ? errors[0] : `${errors.length} 个文件导入失败，请检查格式`)
    }
    if (created === 0 && errors.length === 0) toast.error('未找到可导入的内容')
  }

  const totalPages = Math.max(1, Math.ceil(total / LIBRARY_PAGE_SIZE))
  const selectedItems = items.filter((item) => selected.has(item.id))
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id))
  const heading =
    mode === 'favorites'
      ? '我的收藏'
      : isTrash
        ? '回收站'
        : mode === 'book'
          ? activeBookId === UNFILED_BOOK_ID
            ? '未分组'
            : currentBook?.name ?? '知识库'
          : '全部内容'
  const description =
    mode === 'favorites'
      ? '星标收藏的内容，随时回到重要文档。'
      : isTrash
        ? '删除的文档会先在这里保留，可随时恢复。'
        : mode === 'book'
          ? currentBook?.description || (activeBookId === UNFILED_BOOK_ID ? '还没有归入知识库的文档。' : '这个知识库还没有描述。')
          : '所有创作集中在这里，继续写作或渲染到不同平台。'

  return (
    <div className="library-page">
      <BookSidebar
        books={books}
        counts={counts}
        loading={booksLoading}
        mode={mode}
        activeBookId={activeBookId}
        open={subnavOpen}
        onClose={() => setSubnavOpen(false)}
        onChanged={reload}
      />

      <div
        className={cn('library-content', dragActive && 'is-dragging')}
        onDragEnter={(event) => {
          event.preventDefault()
          if (!isTrash && event.dataTransfer.types.includes('Files')) {
            dragDepth.current += 1
            setDragActive(true)
          }
        }}
        onDragOver={(event) => {
          event.preventDefault()
        }}
        onDragLeave={(event) => {
          event.preventDefault()
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragActive(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          dragDepth.current = 0
          setDragActive(false)
          if (!isTrash) void handleImportFiles(event.dataTransfer.files)
        }}
      >
        <header className="library-head">
          <div className="library-head-main">
            <button
              type="button"
              className="library-subnav-toggle"
              onClick={() => setSubnavOpen(true)}
              aria-label="打开内容库导航"
            >
              <Menu size={18} />
            </button>
            <div className="library-heading">
              <div className="library-title-row">
                <h1>{heading}</h1>
                {mode === 'book' && activeBookId !== UNFILED_BOOK_ID ? (
                  <span className="library-book-dot" style={{ background: currentBook?.color ?? '#00b96b' }} />
                ) : null}
                <span className="library-count">{formatNumber(total)} 篇</span>
              </div>
              <p>{description}</p>
            </div>
          </div>

          <div className="library-head-actions">
            {!isTrash ? (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={Boolean(importProgress)}
                >
                  <Upload size={16} />
                  导入
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void createDocument()}>
                  <FilePlus2 size={16} />
                  新建文档
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={reload}>
                <RefreshCw size={16} />
                刷新
              </button>
            )}
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              multiple
              accept={IMPORT_ACCEPT}
              onChange={(event) => {
                if (event.target.files) void handleImportFiles(event.target.files)
                event.target.value = ''
              }}
            />
          </div>
        </header>

        <div className="library-toolbar">
          <div className="library-search">
            <Search size={16} />
            <input
              className="input"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索标题、摘要或标签…"
              aria-label="搜索内容"
            />
            {searchInput ? (
              <button type="button" className="library-search-clear" onClick={() => setSearchInput('')} aria-label="清空搜索">
                <X size={14} />
              </button>
            ) : null}
          </div>

          <div className="library-toolbar-right">
            <button
              type="button"
              className="library-select-all"
              onClick={() => {
                if (allSelected) setSelected(new Set())
                else setSelected(new Set(items.map((item) => item.id)))
              }}
              disabled={items.length === 0}
            >
              <span className={cn('library-checkbox', allSelected && 'is-checked')} aria-hidden="true" />
              {allSelected ? '取消全选' : '全选本页'}
            </button>

            <label className="library-sort">
              <ArrowDownWideNarrow size={15} />
              <select className="select" value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="segmented library-view-toggle" role="group" aria-label="视图切换">
              <button
                type="button"
                className={cn(view === 'card' && 'active')}
                onClick={() => setView('card')}
                aria-label="卡片视图"
                aria-pressed={view === 'card'}
              >
                <Grid2X2 size={15} />
              </button>
              <button
                type="button"
                className={cn(view === 'list' && 'active')}
                onClick={() => setView('list')}
                aria-label="列表视图"
                aria-pressed={view === 'list'}
              >
                <List size={16} />
              </button>
            </div>
          </div>
        </div>

        {selected.size > 0 ? (
          <div className="library-batch-bar">
            <span className="library-batch-count">
              已选择 <strong>{selected.size}</strong> 篇
            </span>
            <div className="library-batch-actions">
              <button type="button" className="btn btn-sm" onClick={() => setExportOpen(true)}>
                <Download size={15} />
                导出 ZIP
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setMoveTargets(selectedItems)
                  setMoveBookId('')
                }}
              >
                <FolderInput size={15} />
                移动
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => {
                  setDeletePermanent(false)
                  setDeleteTargets(selectedItems)
                }}
              >
                <Trash2 size={15} />
                删除
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
                取消选择
              </button>
            </div>
          </div>
        ) : null}

        {importProgress ? (
          <div className="library-import-progress" role="status" aria-live="polite">
            <div className="library-import-top">
              <span>
                <Upload size={15} />
                正在导入 {importProgress.done}/{importProgress.total}
              </span>
              <span className="library-import-file">{importProgress.label}</span>
            </div>
            <div className="library-import-track">
              <span
                style={{
                  width: `${importProgress.total ? Math.round((importProgress.done / importProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        ) : null}

        <div className="library-body">
          {loading ? (
            view === 'card' ? (
              <div className="document-grid">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div className="document-card-skeleton" key={index}>
                    <span className="skeleton skeleton-cover" />
                    <span className="skeleton skeleton-line skeleton-line-lg" />
                    <span className="skeleton skeleton-line" />
                    <span className="skeleton skeleton-line skeleton-line-sm" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="document-list-skeleton">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div className="document-row-skeleton" key={index}>
                    <span className="skeleton skeleton-cover-mini" />
                    <span className="skeleton skeleton-line skeleton-line-lg" />
                    <span className="skeleton skeleton-line" />
                  </div>
                ))}
              </div>
            )
          ) : loadError ? (
            <EmptyState
              icon={<RefreshCw size={22} />}
              title="内容加载失败"
              description={loadError}
              action={
                <button type="button" className="btn" onClick={reload}>
                  <RefreshCw size={15} />
                  重试
                </button>
              }
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={
                isTrash ? <Trash2 size={22} /> : mode === 'favorites' ? <ArrowDownWideNarrow size={22} /> : <FilePlus2 size={22} />
              }
              title={
                query
                  ? '没有匹配的内容'
                  : isTrash
                    ? '回收站是空的'
                    : mode === 'favorites'
                      ? '还没有收藏文档'
                      : mode === 'book'
                        ? '这个知识库还是空的'
                        : '开始你的第一篇创作'
              }
              description={
                query
                  ? '换个关键词试试，或检查是否在正确的知识库中。'
                  : isTrash
                    ? '删除的文档会先进入回收站，确认无误后再彻底删除。'
                    : mode === 'favorites'
                      ? '在文档卡片右上角点击星标，就能在这里快速找到它。'
                      : '内容会按知识库归档，也可以直接在这里导入已有文稿。'
              }
              action={
                !isTrash ? (
                  <div className="btn-group">
                    <button type="button" className="btn btn-primary" onClick={() => void createDocument()}>
                      <Plus size={16} />
                      新建文档
                    </button>
                    <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
                      <Upload size={16} />
                      导入内容
                    </button>
                  </div>
                ) : undefined
              }
            />
          ) : view === 'card' ? (
            <div className="document-grid">
              {items.map((item) => (
                <DocumentCard
                  key={item.id}
                  item={item}
                  mode={mode}
                  selected={selected.has(item.id)}
                  actions={actions}
                  onToggleSelected={handleToggleSelected}
                />
              ))}
            </div>
          ) : (
            <div className="document-list">
              <div className="document-list-head" aria-hidden="true">
                <span />
                <span>文档</span>
                <span>知识库</span>
                <span>标签</span>
                <span>字数</span>
                <span>更新时间</span>
                <span />
              </div>
              {items.map((item) => (
                <DocumentRow
                  key={item.id}
                  item={item}
                  mode={mode}
                  selected={selected.has(item.id)}
                  actions={actions}
                  onToggleSelected={handleToggleSelected}
                />
              ))}
            </div>
          )}
        </div>

        {!loading && totalPages > 1 ? (
          <footer className="library-pagination">
            <span>
              第 {page} / {totalPages} 页 · 共 {formatNumber(total)} 篇
            </span>
            <div className="library-pagination-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                disabled={page <= 1}
              >
                <ChevronLeft size={15} />
                上一页
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                disabled={page >= totalPages}
              >
                下一页
                <ChevronRight size={15} />
              </button>
            </div>
          </footer>
        ) : null}

        {dragActive ? (
          <div className="library-drop-overlay">
            <div className="library-drop-card">
              <Upload size={30} />
              <strong>松开即可导入</strong>
              <span>支持 Markdown、HTML、TXT 与 MultiPush JSON</span>
            </div>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={deleteTargets.length > 0}
        title={deletePermanent ? '彻底删除文档' : '删除文档'}
        description={
          deleteTargets.length === 1 ? (
            <>
              确定要{deletePermanent ? '彻底删除' : '删除'} <strong>「{deleteTargets[0].title}」</strong> 吗？
              {deletePermanent ? ' 此操作不可恢复。' : ' 文档会先进入回收站。'}
            </>
          ) : (
            <>
              确定要{deletePermanent ? '彻底删除' : '删除'}选中的 <strong>{deleteTargets.length}</strong> 篇文档吗？
              {deletePermanent ? ' 此操作不可恢复。' : ' 文档会先进入回收站。'}
            </>
          )
        }
        loading={deleting}
        confirmLabel={deletePermanent ? '彻底删除' : '删除'}
        onClose={() => {
          if (!deleting) setDeleteTargets([])
        }}
        onConfirm={handleDeleteConfirm}
      />

      <Modal
        open={moveTargets.length > 0}
        onClose={() => {
          if (!moving) setMoveTargets([])
        }}
        title="移动文档"
        subtitle={`将 ${moveTargets.length} 篇文档移动到指定知识库`}
        closeOnBackdrop={!moving}
        showClose={!moving}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setMoveTargets([])} disabled={moving}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleMoveConfirm()}
              disabled={moving || !moveBookId}
            >
              {moving ? '移动中…' : '确认移动'}
            </button>
          </>
        }
      >
        <div className="move-dialog-list">
          <label className="move-dialog-option">
            <input
              type="radio"
              name="move-book"
              value={UNFILED_BOOK_ID}
              checked={moveBookId === UNFILED_BOOK_ID}
              onChange={() => setMoveBookId(UNFILED_BOOK_ID)}
            />
            <span>
              <strong>未分组</strong>
              <small>不归入任何知识库</small>
            </span>
          </label>
          {books.map((book) => (
            <label className="move-dialog-option" key={book.id}>
              <input
                type="radio"
                name="move-book"
                value={book.id}
                checked={moveBookId === book.id}
                onChange={() => setMoveBookId(book.id)}
              />
              <span className="move-dialog-dot" style={{ background: book.color }} />
              <span>
                <strong>{book.name}</strong>
                <small>{formatNumber(book.docCount)} 篇文档</small>
              </span>
            </label>
          ))}
        </div>
      </Modal>

      <Modal
        open={exportOpen}
        onClose={() => {
          if (!exporting) setExportOpen(false)
        }}
        title="导出选中文档"
        subtitle={`将 ${selected.size} 篇文档打包为 ZIP，选择导出格式`}
        closeOnBackdrop={!exporting}
        showClose={!exporting}
      >
        <div className="export-format-grid">
          <button type="button" className="export-format-option" onClick={() => void handleBatchExport('markdown')} disabled={exporting}>
            <span className="export-format-icon">MD</span>
            <strong>Markdown</strong>
            <small>.md 文件，适合迁移到其他编辑器</small>
          </button>
          <button type="button" className="export-format-option" onClick={() => void handleBatchExport('html')} disabled={exporting}>
            <span className="export-format-icon">HTML</span>
            <strong>HTML</strong>
            <small>带独立样式，浏览器可直接打开</small>
          </button>
          <button type="button" className="export-format-option" onClick={() => void handleBatchExport('json')} disabled={exporting}>
            <span className="export-format-icon">{'{ }'}</span>
            <strong>MultiPush JSON</strong>
            <small>可重新导入，保留完整文档结构</small>
          </button>
        </div>
        {exporting ? <p className="export-progress">正在打包，请稍候…</p> : null}
      </Modal>
    </div>
  )
}
