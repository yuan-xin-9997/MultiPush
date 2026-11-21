import { useState } from 'react'
import { Check, Info, RotateCcw, Settings2, Sparkles } from 'lucide-react'
import { getPlatformInfo, type PlatformId, type PlatformOptionOverrides, type RenderOptions } from '@shared/types'
import { cn } from '@/lib/utils'
import Modal from '@/components/Modal'
import PlatformGlyph from './platform-glyph'
import { CARD_STYLE_OPTIONS, resolveCardStyle } from './types'

interface PlatformSettingsProps {
  open: boolean
  platforms: PlatformId[]
  baseOptions: RenderOptions
  baseAuthorName: string
  platformOptions: PlatformOptionOverrides
  displayName: string
  onChangeBase: (patch: Partial<RenderOptions>) => void
  onChangePlatform: (platform: PlatformId, patch: Partial<RenderOptions>) => void
  onResetPlatform: (platform: PlatformId) => void
  onResetAll: () => void
  onSaveDefaults: () => void
  onClose: () => void
}

function supportsTags(platform: PlatformId): boolean {
  return platform === 'weibo' || platform === 'douyin' || platform === 'xiaohongshu' || platform === 'wechatpic'
}

function supportsToc(platform: PlatformId): boolean {
  return platform === 'wechat' || platform === 'zhihu'
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint: string }) {
  return (
    <button type="button" className="render-toggle-row" role="switch" aria-checked={checked} onClick={onChange}>
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <span className={`render-switch${checked ? ' is-on' : ''}`} aria-hidden="true">
        <span />
      </span>
    </button>
  )
}

function hasOverride(options: RenderOptions | undefined): boolean {
  return Boolean(options && Object.keys(options).length > 0)
}

export default function PlatformSettings({
  open,
  platforms,
  baseOptions,
  baseAuthorName,
  platformOptions,
  displayName,
  onChangeBase,
  onChangePlatform,
  onResetPlatform,
  onResetAll,
  onSaveDefaults,
  onClose,
}: PlatformSettingsProps) {
  const [tab, setTab] = useState<'default' | PlatformId>('default')
  const activeTab = tab === 'default' || platforms.includes(tab) ? tab : 'default'
  const overrideCount = platforms.filter((platform) => hasOverride(platformOptions[platform])).length

  function renderCardStyles(value: RenderOptions['cardStyle'], onSelect: (style: RenderOptions['cardStyle']) => void) {
    return (
      <div className="render-option-group">
        <span className="render-option-label">小红书卡片风格</span>
        <div className="render-style-options">
          {CARD_STYLE_OPTIONS.map((style) => (
            <button
              key={style.id}
              type="button"
              className={`render-style-option${resolveCardStyle(value) === style.id ? ' is-active' : ''}`}
              onClick={() => onSelect(style.id)}
            >
              <span className="render-style-swatches">
                {style.swatches.map((swatch) => (
                  <i key={swatch} style={{ background: swatch }} />
                ))}
              </span>
              <span>
                <strong>{style.name}</strong>
                <small>{style.hint}</small>
              </span>
              {resolveCardStyle(value) === style.id ? <Check size={13} /> : null}
            </button>
          ))}
        </div>
      </div>
    )
  }

  function renderDefaultPane() {
    return (
      <div className="render-settings-pane" key="default">
        <div className="render-settings-pane-head">
          <span className="render-settings-pane-icon is-default">
            <Settings2 size={18} />
          </span>
          <div>
            <span className="render-settings-eyebrow">所有平台</span>
            <h3>默认渲染设置</h3>
            <p>未单独设置的平台都会使用这里的作者、话题和目录选项。修改后需要重新生成才会生效。</p>
          </div>
        </div>

        {renderCardStyles(baseOptions.cardStyle, (style) => onChangeBase({ cardStyle: style }))}

        <div className="render-settings-toggles">
          <Toggle
            checked={baseOptions.includeTags !== false}
            onChange={() => onChangeBase({ includeTags: baseOptions.includeTags === false })}
            label="带话题标签"
            hint="小红书、微博、抖音、公众号贴图会生成 #话题#"
          />
          <Toggle
            checked={baseOptions.includeToc === true}
            onChange={() => onChangeBase({ includeToc: baseOptions.includeToc !== true })}
            label="文章自动目录"
            hint="公众号和知乎根据 H1–H3 生成目录"
          />
          <label className="render-author-field">
            <span>默认作者署名</span>
            <input
              className="input"
              value={baseAuthorName}
              onChange={(event) => onChangeBase({ authorName: event.target.value })}
              placeholder={displayName || '默认使用账号昵称'}
              maxLength={40}
            />
          </label>
        </div>

        <div className="render-settings-tip">
          <Info size={14} />
          <span>需要给某个平台设置不同的署名、话题或目录时，在左侧选择该平台单独设置。</span>
        </div>
      </div>
    )
  }

  function renderPlatformPane(platform: PlatformId) {
    const info = getPlatformInfo(platform)
    const override = platformOptions[platform]
    const overridden = hasOverride(override)
    const effective = { ...baseOptions, authorName: baseAuthorName, ...(override ?? {}) }
    const author = effective.authorName ?? ''

    return (
      <div className="render-settings-pane" key={platform}>
        <div className="render-settings-pane-head">
          <span className="render-settings-pane-icon" style={{ color: info.color, background: info.softColor }}>
            <PlatformGlyph platform={platform} size={18} />
          </span>
          <div>
            <span className="render-settings-eyebrow">{info.name}</span>
            <div className="render-settings-title-line">
              <h3>平台独立设置</h3>
              <span className={cn('render-settings-status', overridden && 'is-custom')}>
                {overridden ? '已单独设置' : '跟随默认'}
              </span>
            </div>
            <p>{overridden ? `只影响「${info.shortName}」，其他平台仍使用默认设置。` : `当前完全沿用默认设置；修改任意选项后会单独保存到「${info.shortName}」。`}</p>
          </div>
          {overridden ? (
            <button type="button" className="btn btn-sm render-settings-reset" onClick={() => onResetPlatform(platform)}>
              <RotateCcw size={13} />
              恢复默认
            </button>
          ) : null}
        </div>

        {!overridden ? (
          <div className="render-settings-status-card">
            <Sparkles size={14} />
            <span>
              当前使用默认设置：{resolveCardStyle(effective.cardStyle) === 'warm' ? '暖阳' : resolveCardStyle(effective.cardStyle) === 'bold' ? '醒目' : '清新'}卡片风格、
              {effective.includeTags !== false ? '带话题' : '不带话题'}、{effective.includeToc === true ? '自动目录' : '不生成目录'}。
            </span>
          </div>
        ) : null}

        <div className="render-settings-form">
          <label className="render-author-field">
            <span>作者署名</span>
            <input
              className="input"
              value={author}
              onChange={(event) => onChangePlatform(platform, { authorName: event.target.value })}
              placeholder={displayName || '默认使用账号昵称'}
              maxLength={40}
            />
          </label>

          {platform === 'xiaohongshu' ? renderCardStyles(effective.cardStyle, (style) => onChangePlatform(platform, { cardStyle: style })) : null}

          <div className="render-settings-toggles">
            {supportsTags(platform) ? (
              <Toggle
                checked={effective.includeTags !== false}
                onChange={() => onChangePlatform(platform, { includeTags: effective.includeTags === false })}
                label="带话题标签"
                hint="关闭后该平台不生成 #话题# 文案"
              />
            ) : null}
            {supportsToc(platform) ? (
              <Toggle
                checked={effective.includeToc === true}
                onChange={() => onChangePlatform(platform, { includeToc: effective.includeToc !== true })}
                label="文章自动目录"
                hint="根据正文 H1–H3 生成目录"
              />
            ) : null}
            {!supportsTags(platform) && !supportsToc(platform) ? (
              <p className="render-settings-empty">该平台只使用作者署名；正文排版和下载文件由固定模板生成。</p>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="平台渲染设置"
      subtitle="默认设置作用于所有平台；也可以为每个平台单独设置作者、话题、目录和小红书卡片风格。"
      size="wide"
      footer={
        <div className="render-settings-footer">
          <button type="button" className="btn render-settings-footer-default" onClick={onSaveDefaults}>
            保存为我的默认设置
          </button>
          {overrideCount > 0 ? (
            <button type="button" className="btn btn-ghost" onClick={onResetAll}>
              清除平台单独设置
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      }
    >
      <div className="render-settings-layout">
        <nav className="render-settings-nav" aria-label="选择要设置渲染选项的平台">
          <button
            type="button"
            className={cn('render-settings-nav-item', activeTab === 'default' && 'is-active')}
            onClick={() => setTab('default')}
          >
            <span className="render-settings-nav-icon is-default">
              <Settings2 size={15} />
            </span>
            <span>
              <strong>默认设置</strong>
              <small>未单独设置的平台</small>
            </span>
          </button>
          {platforms.map((platform) => {
            const info = getPlatformInfo(platform)
            const overridden = hasOverride(platformOptions[platform])
            return (
              <button
                key={platform}
                type="button"
                className={cn('render-settings-nav-item', activeTab === platform && 'is-active')}
                onClick={() => setTab(platform)}
              >
                <span
                  className="render-settings-nav-icon"
                  style={{ color: info.color, background: info.softColor }}
                >
                  <PlatformGlyph platform={platform} size={15} />
                </span>
                <span>
                  <strong>{info.shortName}</strong>
                  <small>{overridden ? '已单独设置' : '跟随默认'}</small>
                </span>
                {overridden ? <span className="render-settings-override-dot" title="已单独设置" /> : null}
              </button>
            )
          })}
        </nav>
        {activeTab === 'default' ? renderDefaultPane() : renderPlatformPane(activeTab)}
      </div>
    </Modal>
  )
}
