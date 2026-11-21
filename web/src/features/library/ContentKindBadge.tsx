import { Clapperboard, FileText, Images } from 'lucide-react'
import type { ContentKind } from '@shared/types'
import { cn } from '@/lib/utils'

const KIND_META = {
  article: { label: '文章', title: '普通文章', Icon: FileText },
  gallery: { label: '图文', title: '图文内容', Icon: Images },
  video: { label: '视频', title: '视频内容', Icon: Clapperboard },
} satisfies Record<ContentKind, { label: string; title: string; Icon: typeof FileText }>

interface ContentKindBadgeProps {
  kind: ContentKind
  size?: number
  className?: string
}

export default function ContentKindBadge({ kind, size = 13, className }: ContentKindBadgeProps) {
  const { label, title, Icon } = KIND_META[kind]

  return (
    <span className={cn('document-kind-badge', `is-${kind}`, className)} title={title}>
      <Icon size={size} aria-hidden="true" />
      {label}
    </span>
  )
}
