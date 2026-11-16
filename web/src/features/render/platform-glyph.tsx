import { AtSign, BookOpen, Globe2, Heart, MessageCircle, Music2, Newspaper, Rss, Search } from 'lucide-react'
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
  if (platform === 'weibo') {
    return <AtSign size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
  }
  if (platform === 'toutiao') {
    return <Rss size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
  }
  if (platform === 'baijiahao') {
    return <Search size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
  }
  if (platform === 'douyin') {
    return <Music2 size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
  }
  if (platform === 'sspai') {
    return <Newspaper size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
  }
  if (platform === 'blog') {
    return <Globe2 size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
  }
  return <BookOpen size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
}
