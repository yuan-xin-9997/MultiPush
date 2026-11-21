import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ContentKindBadge from '@/features/library/ContentKindBadge'
import type { ContentKind } from '@shared/types'

function renderBadge(kind: ContentKind): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(createElement(ContentKindBadge, { kind }))
  const badge = container.querySelector<HTMLElement>('.document-kind-badge')
  expect(badge).not.toBeNull()
  return badge as HTMLElement
}

describe('ContentKindBadge', () => {
  it.each<[ContentKind, string, string]>([
    ['article', '文章', '普通文章'],
    ['gallery', '图文', '图文内容'],
    ['video', '视频', '视频内容'],
  ])('renders the %s badge', (kind, label, title) => {
    const badge = renderBadge(kind)
    expect(badge.classList.contains(`is-${kind}`)).toBe(true)
    expect(badge.textContent?.trim()).toBe(label)
    expect(badge.getAttribute('title')).toBe(title)
    expect(badge.querySelector('svg')).not.toBeNull()
  })
})
