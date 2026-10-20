import { BookOpen, Heart, MessageCircle } from 'lucide-react'
import type { PlatformId } from '@shared/types'

interface PlatformGlyphProps {
  platform: PlatformId
  size?: number
  strokeWidth?: number
  className?: string
}

/** Small, dependency-free platform icon used across the render workbench. */
export default function PlatformGlyph({
  platform,
  size = 18,
  strokeWidth = 2,
  className,
}: PlatformGlyphProps) {
  if (platform === 'wechat') {
    return <MessageCircle size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
  }
  if (platform === 'xiaohongshu') {
    return <Heart size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
  }
  return <BookOpen size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
}
