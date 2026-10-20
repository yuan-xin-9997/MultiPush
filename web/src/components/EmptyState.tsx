import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  compact?: boolean
  className?: string
}

export default function EmptyState({ icon, title, description, action, compact, className }: EmptyStateProps) {
  return (
    <div className={cn('empty-state', compact && 'empty-state-compact', className)}>
      <div className="empty-icon">{icon ?? <Inbox size={22} />}</div>
      <p className="empty-title">{title}</p>
      {description ? <div className="empty-desc">{description}</div> : null}
      {action ? <div className="empty-actions">{action}</div> : null}
    </div>
  )
}
