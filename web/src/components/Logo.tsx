import { cn } from '@/lib/utils'

interface LogoProps {
  size?: number
  subtitle?: boolean
  variant?: 'default' | 'light'
  className?: string
}

export default function Logo({ size = 32, subtitle = true, variant = 'default', className }: LogoProps) {
  return (
    <span className={cn('mp-logo', variant === 'light' && 'mp-logo-light', className)}>
      <span className="mp-logo-mark" style={{ width: size, height: size }}>
        <img src="/favicon.svg" alt="" width={size} height={size} aria-hidden="true" />
      </span>
      <span className="mp-logo-copy">
        <span className="mp-logo-name">MultiPush</span>
        {subtitle ? <span className="mp-logo-subtitle">多平台智能发布系统</span> : null}
      </span>
    </span>
  )
}
