import type { CSSProperties } from 'react'
import type { XhsCard } from '@shared/types'
import { absoluteUrl } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { CardStyle } from './types'

interface XhsCardViewProps {
  card: XhsCard
  style: CardStyle
  tags?: string[]
  className?: string
}

interface StyleTokens {
  background: string
  ink: string
  muted: string
  accent: string
  accentSoft: string
  line: string
  footer: string
  serif: boolean
}

const TOKENS: Record<CardStyle, StyleTokens> = {
  clean: {
    background:
      'radial-gradient(circle at 82% 6%, rgba(14,159,110,0.18), transparent 34%), linear-gradient(155deg, #f6fbf8 0%, #e8f6ee 58%, #dff1e8 100%)',
    ink: '#12271e',
    muted: '#5f776c',
    accent: '#0e9f6e',
    accentSoft: '#d4efe2',
    line: 'rgba(18,39,30,0.1)',
    footer: 'rgba(18,39,30,0.48)',
    serif: false,
  },
  warm: {
    background:
      'radial-gradient(circle at 88% 10%, rgba(224,116,42,0.16), transparent 36%), linear-gradient(155deg, #fffaf2 0%, #fff2df 56%, #ffe7c8 100%)',
    ink: '#3a2a1a',
    muted: '#856a50',
    accent: '#d35f12',
    accentSoft: '#ffe0bf',
    line: 'rgba(58,42,26,0.11)',
    footer: 'rgba(58,42,26,0.46)',
    serif: true,
  },
  bold: {
    background:
      'radial-gradient(circle at 86% 4%, rgba(255,36,66,0.38), transparent 34%), radial-gradient(circle at 8% 94%, rgba(255,209,102,0.15), transparent 32%), linear-gradient(150deg, #1b1d24 0%, #14161c 100%)',
    ink: '#ffffff',
    muted: 'rgba(255,255,255,0.64)',
    accent: '#ff2442',
    accentSoft: '#ffd166',
    line: 'rgba(255,255,255,0.14)',
    footer: 'rgba(255,255,255,0.42)',
    serif: false,
  },
}

function imageStyle(url: string): CSSProperties {
  return { backgroundImage: `url("${absoluteUrl(url).replace(/"/g, '\\"')}")` }
}

export default function XhsCardView({ card, style, tags = [], className }: XhsCardViewProps) {
  const tokens = TOKENS[style]
  const num = String(card.index).padStart(2, '0')
  const total = String(card.total).padStart(2, '0')
  const hasImage = card.images.length > 0
  const isCover = card.type === 'cover'
  const isEnd = card.type === 'end'
  const isQuote = card.type === 'quote'
  const serifFamily = tokens.serif
    ? "'Songti SC','STSong','Noto Serif SC','SimSun',serif"
    : "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans SC',-apple-system,BlinkMacSystemFont,sans-serif"

  return (
    <article
      className={cn('xhs-card', `xhs-card-${style}`, `xhs-card-${card.type}`, hasImage && 'has-image', className)}
      style={
        {
          background: tokens.background,
          color: tokens.ink,
          fontFamily: serifFamily,
          '--xhs-ink': tokens.ink,
          '--xhs-muted': tokens.muted,
          '--xhs-accent': tokens.accent,
          '--xhs-accent-soft': tokens.accentSoft,
          '--xhs-line': tokens.line,
          '--xhs-footer': tokens.footer,
        } as CSSProperties
      }
    >
      <div className="xhs-card-grain" />
      <div className="xhs-card-orbit xhs-card-orbit-one" />
      <div className="xhs-card-orbit xhs-card-orbit-two" />

      {isCover ? (
        <>
          {hasImage ? (
            <div className="xhs-cover-photo" style={imageStyle(card.images[0])}>
              <div className="xhs-cover-photo-shade" />
            </div>
          ) : null}

          <header className="xhs-card-head">
            <span className="xhs-card-kicker">XIAOHONGSHU · 图文笔记</span>
            <span className="xhs-card-page">
              {num} / {total}
            </span>
          </header>

          <div className={cn('xhs-cover-copy', hasImage && 'on-photo')}>
            <span className="xhs-cover-rule" />
            <h1>{card.title || '无标题笔记'}</h1>
            {card.body.length > 0 ? (
              <div className="xhs-cover-summary">
                {card.body
                  .filter(Boolean)
                  .filter((line) => !line.trim().startsWith('#'))
                  .slice(0, 2)
                  .map((line, index) => (
                    <p key={`${line}-${index}`}>{line}</p>
                  ))}
              </div>
            ) : null}
          </div>

          {tags.length > 0 ? (
            <div className={cn('xhs-cover-tags', hasImage && 'on-photo')}>
              {tags.slice(0, 3).map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
          ) : null}
        </>
      ) : isEnd ? (
        <div className="xhs-end-wrap">
          <span className="xhs-end-mark">
            <span />
            <span />
            <span />
          </span>
          <span className="xhs-card-kicker">THE END</span>
          <h1>{card.title || '感谢阅读'}</h1>
          <div className="xhs-end-lines">
            {card.body.filter(Boolean).map((line, index) => (
              <p key={`${line}-${index}`}>{line}</p>
            ))}
          </div>
          {tags.length > 0 ? (
            <div className="xhs-end-tags">
              {tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <header className="xhs-card-head">
            <span className="xhs-card-kicker">{isQuote ? 'QUOTE' : 'NOTE'}</span>
            <span className="xhs-card-page">
              {num} / {total}
            </span>
          </header>

          <div className={cn('xhs-content-wrap', hasImage && 'with-image')}>
            {card.title ? <h2>{card.title}</h2> : null}
            <div className="xhs-content-lines">
              {card.body.filter(Boolean).map((line, index) => (
                <p key={`${line}-${index}`}>{line}</p>
              ))}
            </div>

            {hasImage ? (
              <div className={cn('xhs-content-media', card.images.length > 1 && 'is-multi')}>
                {card.images.slice(0, 2).map((image, index) => (
                  <div className="xhs-content-photo" style={imageStyle(image)} key={`${image}-${index}`} />
                ))}
              </div>
            ) : null}
          </div>
        </>
      )}

      <footer className="xhs-card-foot">
        <span>{card.footer || '@MultiPush'}</span>
        <span className="xhs-card-foot-brand">
          <i style={{ background: tokens.accent }} />
          MultiPush
        </span>
      </footer>
    </article>
  )
}
