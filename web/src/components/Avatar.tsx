import { cn } from '@/lib/utils'

interface AvatarProps {
  name: string
  src?: string | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

function getInitials(name: string): string {
  const value = name.trim()
  if (!value) return 'M'
  if (/[\u3400-\u9fff]/.test(value)) return value.slice(0, 1)
  const parts = value.split(/\s+/).filter(Boolean)
  const initials = `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`
  return (initials || value[0] || 'M').toUpperCase()
}

export default function Avatar({ name, src, size = 'md', className }: AvatarProps) {
  return (
    <span className={cn('avatar', `avatar-${size}`, className)} aria-hidden="true">
      {src ? <img src={src} alt="" /> : getInitials(name)}
    </span>
  )
}
