import { useEffect, useState } from 'react'
import { FileText, Images } from 'lucide-react'
import type { ContentKind } from '@shared/types'
import { absoluteUrl } from '@/lib/api'
import { cn } from '@/lib/utils'

interface DocumentCoverProps {
  image: string | null
  title: string
  variant?: 'card' | 'mini'
  kind?: ContentKind
}

export default function DocumentCover({ image, title, variant = 'card', kind = 'article' }: DocumentCoverProps) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [image])

  if (image && !failed) {
    return (
      <div className={cn('doc-cover', variant === 'mini' && 'doc-cover-mini')}>
        <img
          src={absoluteUrl(image)}
          alt={title ? `${title} 封面` : ''}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'doc-cover',
        'doc-cover-placeholder',
        variant === 'mini' && 'doc-cover-mini',
      )}
      aria-hidden="true"
    >
      {kind === 'gallery' ? (
        <Images size={variant === 'mini' ? 18 : 26} />
      ) : (
        <FileText size={variant === 'mini' ? 18 : 26} />
      )}
    </div>
  )
}
