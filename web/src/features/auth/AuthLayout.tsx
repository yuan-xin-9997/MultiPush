import type { ReactNode } from 'react'
import { Download, PenLine, Send, Sparkles, WandSparkles } from 'lucide-react'
import { PLATFORMS } from '@shared/types'
import Logo from '@/components/Logo'
import './auth.css'

const FLOW_STEPS = [
  {
    icon: PenLine,
    title: '专注创作',
    description: '类语雀的沉浸式编辑器，留住内容本身。',
  },
  {
    icon: WandSparkles,
    title: '智能渲染',
    description: '按公众号、小红书、知乎与抖音的规则重新排版。',
  },
  {
    icon: Download,
    title: '预览下载',
    description: '多端预览，复制、下载或打包带走。',
  },
  {
    icon: Send,
    title: '从容发布',
    description: '第一版下载后手动发布，后续能力规划中。',
  },
]

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <section className="auth-brand-panel" aria-label="MultiPush 产品介绍">
        <div className="auth-brand-top">
          <Logo size={38} subtitle variant="light" />
        </div>

        <div className="auth-brand-content">
          <span className="auth-brand-pill">
            <Sparkles size={14} />
            一次创作 · 多平台适配
          </span>

          <h1 className="auth-brand-heading">
            让好内容，
            <br />
            <em>自然抵达</em>每个平台。
          </h1>

          <p className="auth-brand-desc">
            MultiPush 把内容创作、平台排版与下载整理放在一个安静的工作台里。少一些重复劳动，多一些表达时间。
          </p>

          <div className="auth-flow" aria-label="内容渲染流程">
            {FLOW_STEPS.map((step, index) => {
              const Icon = step.icon
              return (
                <div className="auth-flow-step" key={step.title}>
                  <span className="auth-flow-icon">
                    <Icon size={18} />
                  </span>
                  <div className="auth-flow-copy">
                    <span className="auth-flow-index">0{index + 1}</span>
                    <h2>{step.title}</h2>
                    <p>{step.description}</p>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="auth-platforms" aria-label="支持平台">
            {PLATFORMS.map((platform) => (
              <span className="auth-platform-chip" key={platform.id}>
                <i style={{ backgroundColor: platform.color }} aria-hidden="true" />
                {platform.name}
              </span>
            ))}
          </div>
        </div>

        <p className="auth-brand-footer">MultiPush · 为认真写作的人而作</p>
      </section>

      <section className="auth-form-panel">
        <div className="auth-form-wrap">
          <div className="auth-mobile-brand">
            <Logo size={34} subtitle />
            <p>一次创作 · 多平台适配</p>
          </div>
          {children}
        </div>
      </section>
    </div>
  )
}
