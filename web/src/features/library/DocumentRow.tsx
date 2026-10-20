import type { KeyboardEvent, MouseEvent } from 'react'
import { Folder, Star } from 'lucide-react'
import type { ContentSummary } from '@shared/types'
import { cn, formatDateTime, relativeTime } from '@/lib/utils'
import { formatNumber } from '@/lib/format'
import DocumentCover from './DocumentCover'
import DocumentMenu, { type DocumentActions } from './DocumentMenu'
import type { LibraryMode } from './types'

interface DocumentRowProps {
  item: ContentSummary
  mode: LibraryMode
  selected: boolean
  actions: DocumentActions
  onToggleSelected: (id: string, checked: boolean) => void
}

export default function DocumentRow({ item, mode, selected, actions, onToggleSelected }: DocumentRowProps) {
  const title = item.title || '无标题文档'
  const isTrash = mode === 'trash'

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      actions.open(item)
    }
  }

  function toggleFavorite(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation()
    actions.toggleFavorite(item)
  }

  return (
    <div
      className={cn('document-row', selected && 'is-selected', isTrash && 'is-trash')}
      tabIndex={0}
      role="button"
      aria-label={`打开文档「${title}」`}
      onClick={() => actions.open(item)}
      onKeyDown={handleKeyDown}
    >
      <label className="document-row-check" onClick={(event) => event.stopPropagation()} title="选择文档">
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onToggleSelected(item.id, event.target.checked)}
          aria-label={`选择「${title}」`}
        />
      </label>

      <div className="document-row-main">
        <div className="document-row-cover">
          <DocumentCover image={item.coverImage} title={title} variant="mini" />
        </div>
        <div className="document-row-copy">
          <div className="document-row-title" title={title}>
            {title}
          </div>
          <div className="document-row-excerpt">{item.excerpt || '暂无摘要'}</div>
        </div>
      </div>

      <div className="document-row-cell document-row-book" title={item.bookName ?? '未分组'}>
        <Folder size={13} />
        <span>{item.bookName ?? '未分组'}</span>
      </div>

      <div className="document-row-tags">
        {item.tags.slice(0, 2).map((tag) => (
          <span className="tag" key={tag} title={tag}>
            {tag}
          </span>
        ))}
        {item.tags.length > 2 ? <span className="tag document-tag-more">+{item.tags.length - 2}</span> : null}
      </div>

      <div className="document-row-cell document-row-words">{formatNumber(item.wordCount)} 字</div>

      <div className="document-row-cell document-row-time" title={formatDateTime(isTrash ? item.deletedAt : item.updatedAt)}>
        {isTrash ? relativeTime(item.deletedAt) : relativeTime(item.updatedAt)}
      </div>

      <div className="document-row-actions">
        {!isTrash ? (
          <button
            type="button"
            className={cn('document-row-star', item.favorite && 'is-active')}
            onClick={toggleFavorite}
            aria-label={item.favorite ? '取消收藏' : '收藏文档'}
            title={item.favorite ? '取消收藏' : '收藏文档'}
          >
            <Star size={15} fill={item.favorite ? 'currentColor' : 'none'} />
          </button>
        ) : null}
        <DocumentMenu item={item} mode={mode} actions={actions} />
      </div>
    </div>
  )
}
