import type { KeyboardEvent, MouseEvent } from 'react'
import { Folder, Star } from 'lucide-react'
import type { ContentSummary } from '@shared/types'
import { formatDateTime, relativeTime } from '@/lib/utils'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import DocumentCover from './DocumentCover'
import DocumentMenu, { type DocumentActions } from './DocumentMenu'
import type { LibraryMode } from './types'

interface DocumentCardProps {
  item: ContentSummary
  mode: LibraryMode
  selected: boolean
  actions: DocumentActions
  onToggleSelected: (id: string, checked: boolean) => void
}

export default function DocumentCard({ item, mode, selected, actions, onToggleSelected }: DocumentCardProps) {
  const title = item.title || '无标题文档'
  const isTrash = mode === 'trash'

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
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
    <article
      className={cn('document-card', 'card', 'card-hover', selected && 'is-selected', isTrash && 'is-trash')}
      tabIndex={0}
      role="button"
      aria-label={`打开文档「${title}」`}
      onClick={() => actions.open(item)}
      onKeyDown={handleKeyDown}
    >
      <div className="document-cover">
        <DocumentCover image={item.coverImage} title={title} />
        <label
          className="document-select"
          onClick={(event) => event.stopPropagation()}
          title={selected ? '取消选择' : '选择文档'}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onToggleSelected(item.id, event.target.checked)}
            aria-label={`选择「${title}」`}
          />
        </label>
        {!isTrash ? (
          <button
            type="button"
            className={cn('document-star', item.favorite && 'is-active')}
            onClick={toggleFavorite}
            aria-label={item.favorite ? '取消收藏' : '收藏文档'}
            title={item.favorite ? '取消收藏' : '收藏文档'}
          >
            <Star size={16} fill={item.favorite ? 'currentColor' : 'none'} />
          </button>
        ) : null}
      </div>

      <div className="document-card-body">
        <h3 className="document-card-title line-clamp-1" title={title}>
          {title}
        </h3>
        <p className="document-card-excerpt line-clamp-2">
          {item.excerpt || '暂无摘要，打开文档继续创作。'}
        </p>
        {item.tags.length > 0 ? (
          <div className="document-tags">
            {item.tags.slice(0, 3).map((tag) => (
              <span className="tag" key={tag} title={tag}>
                {tag}
              </span>
            ))}
            {item.tags.length > 3 ? <span className="tag document-tag-more">+{item.tags.length - 3}</span> : null}
          </div>
        ) : null}
      </div>

      <div className="document-card-footer">
        <span className="document-book" title={item.bookName ?? '未分组'}>
          <Folder size={13} />
          {item.bookName ?? '未分组'}
        </span>
        <span className="document-footer-time" title={formatDateTime(isTrash ? item.deletedAt : item.updatedAt)}>
          {isTrash ? `删除于 ${relativeTime(item.deletedAt)}` : relativeTime(item.updatedAt)}
        </span>
        <span className="document-wordcount">{formatNumber(item.wordCount)} 字</span>
        <DocumentMenu item={item} mode={mode} actions={actions} />
      </div>
    </article>
  )
}
