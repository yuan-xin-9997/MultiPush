import { useState, type FormEvent } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  BookOpen,
  Ellipsis,
  Folder,
  Inbox,
  Layers,
  LoaderCircle,
  PenLine,
  Plus,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Book } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import ConfirmDialog from '@/components/ConfirmDialog'
import Dropdown from '@/components/Dropdown'
import Modal from '@/components/Modal'
import { BOOK_COLORS, UNFILED_BOOK_ID, type LibraryCounts, type LibraryMode } from './types'

interface BookSidebarProps {
  books: Book[]
  counts: LibraryCounts
  loading: boolean
  mode: LibraryMode
  activeBookId: string | null
  open: boolean
  onClose: () => void
  onChanged: () => void
}

type BookDialogState = { type: 'create' } | { type: 'edit'; book: Book } | null

function navClassName(base: string) {
  return ({ isActive }: { isActive: boolean }) => cn(base, isActive && 'active')
}

export default function BookSidebar({
  books,
  counts,
  loading,
  mode,
  activeBookId,
  open,
  onClose,
  onChanged,
}: BookSidebarProps) {
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<BookDialogState>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(BOOK_COLORS[0])
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null)
  const [deleting, setDeleting] = useState(false)

  const showUnfiled = counts.unfiled > 0 || activeBookId === UNFILED_BOOK_ID

  function openCreate() {
    setName('')
    setDescription('')
    setColor(BOOK_COLORS[Math.floor(Math.random() * BOOK_COLORS.length)] ?? BOOK_COLORS[0])
    setFormError(null)
    setDialog({ type: 'create' })
  }

  function openEdit(book: Book) {
    setName(book.name)
    setDescription(book.description)
    setColor(book.color || BOOK_COLORS[0])
    setFormError(null)
    setDialog({ type: 'edit', book })
  }

  function closeDialog() {
    if (saving) return
    setDialog(null)
    setFormError(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!dialog || saving) return

    const trimmed = name.trim()
    if (!trimmed) {
      setFormError('请输入知识库名称')
      return
    }
    if (trimmed.length > 40) {
      setFormError('知识库名称最多 40 个字符')
      return
    }

    setSaving(true)
    setFormError(null)
    try {
      if (dialog.type === 'create') {
        const result = await api.books.create({
          name: trimmed,
          description: description.trim() || undefined,
          color,
        })
        setDialog(null)
        toast.success('知识库已创建')
        onChanged()
        onClose()
        navigate(`/library/book/${result.book.id}`)
      } else {
        await api.books.update(dialog.book.id, {
          name: trimmed,
          description: description.trim(),
          color,
        })
        setDialog(null)
        toast.success('知识库已更新')
        onChanged()
      }
    } catch (error) {
      const message = getErrorMessage(error, '保存知识库失败')
      setFormError(message)
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await api.books.remove(deleteTarget.id)
      const wasActive = activeBookId === deleteTarget.id
      toast.success('知识库已删除，文档已移至未分组')
      setDeleteTarget(null)
      onChanged()
      if (wasActive) navigate('/library', { replace: true })
    } catch (error) {
      toast.error(getErrorMessage(error, '删除知识库失败'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <aside className={cn('library-subnav', open && 'is-open')} aria-label="内容库导航">
        <div className="book-sidebar-mobile-head">
          <span>内容库</span>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="关闭内容库导航">
            <X size={17} />
          </button>
        </div>

        <div className="book-sidebar-inner">
          <nav className="book-nav" aria-label="内容筛选">
            <NavLink to="/library" end className={navClassName('book-nav-item')} onClick={onClose}>
              <Layers size={16} />
              <span className="book-nav-text">全部内容</span>
              <span className="book-nav-count">{formatNumber(counts.all)}</span>
            </NavLink>
            <NavLink to="/library/favorites" className={navClassName('book-nav-item')} onClick={onClose}>
              <Star size={16} />
              <span className="book-nav-text">我的收藏</span>
              <span className="book-nav-count">{formatNumber(counts.favorites)}</span>
            </NavLink>
            <NavLink to="/library/trash" className={navClassName('book-nav-item')} onClick={onClose}>
              <Trash2 size={16} />
              <span className="book-nav-text">回收站</span>
              <span className="book-nav-count">{formatNumber(counts.trash)}</span>
            </NavLink>
          </nav>

          <div className="book-divider" />

          <div className="book-section-head">
            <span>知识库</span>
            <button
              type="button"
              className="book-add"
              onClick={openCreate}
              aria-label="新建知识库"
              title="新建知识库"
            >
              <Plus size={15} />
            </button>
          </div>

          <div className="book-list">
            {loading
              ? Array.from({ length: 3 }).map((_, index) => (
                  <div className="book-row-skeleton" key={index}>
                    <span className="skeleton book-skeleton-dot" />
                    <span className="skeleton book-skeleton-name" />
                  </div>
                ))
              : null}

            {!loading &&
              books.map((book) => {
                const active = mode === 'book' && activeBookId === book.id
                return (
                  <div className={cn('book-row', active && 'active')} key={book.id}>
                    <NavLink
                      to={`/library/book/${book.id}`}
                      className="book-row-link"
                      onClick={onClose}
                      title={book.name}
                    >
                      <span className="book-color" style={{ backgroundColor: book.color || '#00b96b' }} />
                      <span className="book-name">{book.name}</span>
                      <span className="book-count">{formatNumber(book.docCount)}</span>
                    </NavLink>
                    <Dropdown
                      align="end"
                      minWidth={160}
                      className="book-row-menu"
                      trigger={
                        <button
                          type="button"
                          className="book-menu-trigger"
                          aria-label={`${book.name} 操作`}
                          title="知识库操作"
                        >
                          <Ellipsis size={15} />
                        </button>
                      }
                      items={[
                        {
                          key: 'edit',
                          label: '重命名',
                          icon: <PenLine size={15} />,
                          onSelect: () => openEdit(book),
                        },
                        'separator',
                        {
                          key: 'delete',
                          label: '删除知识库',
                          icon: <Trash2 size={15} />,
                          danger: true,
                          onSelect: () => setDeleteTarget(book),
                        },
                      ]}
                    />
                  </div>
                )
              })}

            {!loading && showUnfiled ? (
              <div className={cn('book-row book-row-unfiled', mode === 'book' && activeBookId === UNFILED_BOOK_ID && 'active')}>
                <NavLink
                  to={`/library/book/${UNFILED_BOOK_ID}`}
                  className="book-row-link"
                  onClick={onClose}
                >
                  <Inbox size={15} className="book-unfiled-icon" />
                  <span className="book-name">未分组</span>
                  <span className="book-count">{formatNumber(counts.unfiled)}</span>
                </NavLink>
              </div>
            ) : null}

            {!loading && books.length === 0 ? (
              <div className="book-sidebar-empty">
                <BookOpen size={20} />
                <p>还没有知识库</p>
                <button type="button" className="btn btn-sm btn-secondary" onClick={openCreate}>
                  <Plus size={14} />
                  新建知识库
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      {open ? <button type="button" className="library-sidebar-scrim" aria-label="关闭内容库导航" onClick={onClose} /> : null}

      <Modal
        open={dialog !== null}
        onClose={closeDialog}
        title={dialog?.type === 'edit' ? '编辑知识库' : '新建知识库'}
        subtitle={dialog?.type === 'edit' ? '修改名称、描述或标识颜色。' : '用知识库把相关文档归在一起。'}
        closeOnBackdrop={!saving}
        showClose={!saving}
        footer={
          <>
            <button type="button" className="btn" onClick={closeDialog} disabled={saving}>
              取消
            </button>
            <button type="submit" form="book-form" className="btn btn-primary" disabled={saving}>
              {saving ? <LoaderCircle size={16} className="spin" /> : null}
              {saving ? '保存中…' : dialog?.type === 'edit' ? '保存修改' : '创建知识库'}
            </button>
          </>
        }
      >
        <form id="book-form" className="book-form" onSubmit={handleSubmit}>
          {formError ? <div className="form-error-banner">{formError}</div> : null}
          <div className="field">
            <label className="label" htmlFor="book-name">
              知识库名称
            </label>
            <input
              id="book-name"
              className={cn('input', formError && !name.trim() && 'error')}
              type="text"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setFormError(null)
              }}
              placeholder="例如：产品笔记"
              maxLength={40}
              autoFocus
            />
            <p className="hint">最多 40 个字符</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="book-description">
              描述 <span className="optional">选填</span>
            </label>
            <textarea
              id="book-description"
              className="textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个知识库用来收集什么内容？"
              maxLength={160}
              rows={3}
            />
          </div>

          <div className="field">
            <span className="label">标识颜色</span>
            <div className="book-color-picker" role="group" aria-label="选择知识库颜色">
              {BOOK_COLORS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cn('book-color-option', color === option && 'is-active')}
                  style={{ backgroundColor: option }}
                  onClick={() => setColor(option)}
                  aria-label={`选择颜色 ${option}`}
                  aria-pressed={color === option}
                >
                  {color === option ? <Folder size={13} /> : null}
                </button>
              ))}
            </div>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除知识库"
        loading={deleting}
        confirmLabel="删除知识库"
        onClose={() => {
          if (!deleting) setDeleteTarget(null)
        }}
        onConfirm={handleDelete}
        description={
          deleteTarget ? (
            <>
              确定要删除知识库 <strong>「{deleteTarget.name}」</strong> 吗？
              <br />
              其中的 <strong>{formatNumber(deleteTarget.docCount)} 篇文档</strong> 将移动到「未分组」，不会被删除。
            </>
          ) : null
        }
      />
    </>
  )
}
