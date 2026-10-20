import { useEffect, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileText,
  LockKeyhole,
  Music2,
  Rocket,
  Send,
  ShieldCheck,
  Sparkles,
  Video,
} from 'lucide-react'
import { PLATFORMS } from '@shared/types'
import type { RenderListItem } from '@shared/types'
import { api } from '@/lib/api'
import { relativeTime } from '@/lib/utils'
import './publish.css'

const PLATFORM_ICONS = {
  wechat: FileText,
  xiaohongshu: Sparkles,
  zhihu: Send,
  douyin: Music2,
} as const

const PLATFORM_CAPABILITIES: Record<string, string[]> = {
  wechat: ['图文消息', '富文本复制', '视频嵌入'],
  xiaohongshu: ['图文卡片', '视频笔记', '话题文案'],
  zhihu: ['专栏文章', 'Markdown', '视频内容'],
  douyin: ['竖屏图文', '视频笔记', '话题文案'],
}

export default function PublishPage() {
  const navigate = useNavigate()
  const [recent, setRecent] = useState<RenderListItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    api.renders
      .list()
      .then((result) => {
        if (!cancelled) setRecent(result.renders.slice(0, 5))
      })
      .catch(() => {
        if (!cancelled) setRecent([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="publish-page">
      <header className="publish-hero">
        <div className="publish-hero-copy">
          <span className="publish-eyebrow">
            <Rocket size={14} />
            发布中心
            <span className="publish-soon">即将上线</span>
          </span>
          <h1>让好内容，抵达每一个平台</h1>
          <p>
            第一版聚焦「智能渲染 + 预览 + 下载」。你可以在渲染工作台把内容适配成公众号、小红书、知乎与抖音格式，
            下载后手动发布。平台账号连接与一键发布将在下一阶段开放。
          </p>
          <div className="publish-hero-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => navigate('/render')}>
              <Sparkles size={17} />
              去渲染内容
              <ArrowRight size={16} />
            </button>
            <span className="publish-hero-hint">
              <ShieldCheck size={15} />
              不保存平台密码，不代发布
            </span>
          </div>
        </div>
        <div className="publish-hero-art" aria-hidden="true">
          <div className="publish-orbit publish-orbit-one" />
          <div className="publish-orbit publish-orbit-two" />
          <div className="publish-hero-plane">
            <Send size={42} />
          </div>
          <div className="publish-chip publish-chip-one">
            <FileText size={15} />
            公众号排版
          </div>
          <div className="publish-chip publish-chip-two">
            <Sparkles size={15} />
            小红书卡片
          </div>
          <div className="publish-chip publish-chip-three">
            <CheckCircle2 size={15} />
            知乎 Markdown
          </div>
          <div className="publish-chip publish-chip-four">
            <Music2 size={15} />
            抖音竖屏文案
          </div>
        </div>
      </header>

      <section className="publish-platforms" aria-labelledby="publish-platforms-title">
        <div className="publish-section-head">
          <div>
            <h2 id="publish-platforms-title">规划中的发布通道</h2>
            <p>未来可以直接连接平台账号，把渲染结果一键送达。</p>
          </div>
          <span className="publish-roadmap">
            <Clock3 size={14} />
            Roadmap
          </span>
        </div>
        <div className="publish-platform-grid">
          {PLATFORMS.map((platform) => {
            const Icon = PLATFORM_ICONS[platform.id]
            return (
              <article
                key={platform.id}
                className="publish-platform-card"
                style={{ '--platform-color': platform.color, '--platform-soft': platform.softColor } as CSSProperties}
              >
                <div className="publish-platform-top">
                  <span className="publish-platform-icon">
                    <Icon size={20} />
                  </span>
                  <span className="publish-platform-status">规划中</span>
                </div>
                <h3>{platform.name}</h3>
                <p>{platform.description}</p>
                <div className="publish-platform-caps">
                  {PLATFORM_CAPABILITIES[platform.id].map((capability) => (
                    <span key={capability}>
                      <CheckCircle2 size={13} />
                      {capability}
                    </span>
                  ))}
                </div>
                <div className="publish-platform-foot">
                  <LockKeyhole size={13} />
                  账号连接未开放
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <section className="publish-workflow" aria-labelledby="publish-workflow-title">
        <div className="publish-section-head">
          <div>
            <h2 id="publish-workflow-title">当前可用的发布流程</h2>
            <p>保持简单可控：内容由你最终确认，平台由你亲手发布。</p>
          </div>
        </div>
        <div className="publish-steps">
          <div className="publish-step">
            <span className="publish-step-num">01</span>
            <div>
              <h3>创作与整理</h3>
              <p>在类语雀编辑器中完成内容，按知识库归档，支持 Markdown / HTML 导入。</p>
            </div>
          </div>
          <span className="publish-step-line" aria-hidden="true" />
          <div className="publish-step">
            <span className="publish-step-num">02</span>
            <div>
              <h3>智能渲染</h3>
              <p>选择平台，一键生成公众号内联排版、小红书 3:4 卡片、知乎 Markdown 与抖音竖屏文案。</p>
            </div>
          </div>
          <span className="publish-step-line" aria-hidden="true" />
          <div className="publish-step">
            <span className="publish-step-num">03</span>
            <div>
              <h3>预览与下载</h3>
              <p>在模拟手机或文章页中检查效果，下载 HTML、Markdown、PNG 与素材。</p>
            </div>
          </div>
          <span className="publish-step-line" aria-hidden="true" />
          <div className="publish-step">
            <span className="publish-step-num">04</span>
            <div>
              <h3>手动发布</h3>
              <p>粘贴到平台编辑器或上传卡片，发布前做最后一次人工确认。</p>
            </div>
          </div>
        </div>
      </section>

      <div className="publish-lower">
        <section className="publish-recent" aria-labelledby="publish-recent-title">
          <div className="publish-section-head">
            <div>
              <h2 id="publish-recent-title">最近渲染</h2>
              <p>从这里继续上次的发布准备。</p>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => navigate('/render')}>
              打开渲染工作台
              <ArrowRight size={14} />
            </button>
          </div>
          {loading ? (
            <div className="publish-recent-loading">
              {Array.from({ length: 3 }).map((_, index) => (
                <span className="skeleton publish-recent-skeleton" key={index} />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <div className="publish-recent-empty">
              <Sparkles size={20} />
              <p>还没有渲染记录</p>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => navigate('/render')}>
                去渲染第一篇内容
              </button>
            </div>
          ) : (
            <div className="publish-recent-list">
              {recent.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="publish-recent-item"
                  onClick={() => navigate(`/render?renderId=${item.id}`)}
                >
                  <span className="publish-recent-icon">
                    <Video size={16} />
                  </span>
                  <span className="publish-recent-copy">
                    <strong>{item.contentTitle}</strong>
                    <small>
                      {item.platforms.map((platform) => PLATFORMS.find((entry) => entry.id === platform)?.shortName).filter(Boolean).join(' · ')}
                    </small>
                  </span>
                  <span className="publish-recent-time">{relativeTime(item.createdAt)}</span>
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="publish-note">
          <span className="publish-note-icon">
            <ShieldCheck size={18} />
          </span>
          <h3>关于自动发布</h3>
          <p>
            平台接口、账号授权和发布审核策略差异很大。为了保证账号安全与内容质量，第一版不接入真实发布，
            所有下载内容请在平台官方后台手动发布。
          </p>
          <ul>
            <li>不收集平台账号密码</li>
            <li>不代替用户点击发布</li>
            <li>渲染结果可随时重新生成</li>
          </ul>
        </aside>
      </div>
    </div>
  )
}
