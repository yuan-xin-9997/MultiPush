import { LoaderCircle } from 'lucide-react'
import Logo from './Logo'

interface BrandLoadingProps {
  label?: string
}

export default function BrandLoading({ label = '正在进入 MultiPush…' }: BrandLoadingProps) {
  return (
    <div className="brand-loading" role="status" aria-live="polite">
      <div className="brand-loading-inner">
        <Logo size={58} subtitle />
        <div className="brand-loading-status">
          <LoaderCircle size={16} className="spin" />
          <span>{label}</span>
        </div>
      </div>
      <p className="brand-loading-note">一次创作 · 四平台适配</p>
    </div>
  )
}
