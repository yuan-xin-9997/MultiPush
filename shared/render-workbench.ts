import { getPlatformInfo, PLATFORM_ORDER, type PlatformId, type PlatformRender, type RenderOptions, type XhsCard } from './types'

export function createCardId(): string {
  // Unlike randomUUID(), getRandomValues() also works on HTTP LAN origins.
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function getCaptionBody(render: PlatformRender): string {
  if (render.captionBody !== undefined) return render.captionBody
  const lines = (render.text ?? '').split('\n')
  if (lines[0]?.trim() === render.title.trim()) lines.shift()
  while (lines.length && (!lines.at(-1)?.trim() || /^#\S+(?:\s+#\S+)*$/.test(lines.at(-1)!.trim()))) lines.pop()
  return lines.join('\n').trim()
}

export function renumberCards(cards: XhsCard[]): XhsCard[] {
  return cards.map((card, index) => ({ ...card, index: index + 1, total: cards.length }))
}

/** Select ordered excerpts across the whole note, keeping its opening and ending. */
export function selectXhsPublishCards(cards: XhsCard[]): XhsCard[] {
  const limit = 18
  if (cards.length <= limit) return cards
  return renumberCards(Array.from({ length: limit }, (_, index) => cards[Math.round(index * (cards.length - 1) / (limit - 1))]))
}

/** Measure candidate paragraphs in the actual card, including paragraph spacing. */
export function fitCardBody(body: string[], fits: (body: string[]) => boolean): string[][] {
  const pages: string[][] = []
  let page: string[] = []
  for (const paragraph of body) {
    let remaining = Array.from(paragraph)
    if (!remaining.length) continue
    while (remaining.length) {
      if (fits([...page, remaining.join('')])) {
        page.push(remaining.join(''))
        break
      }
      let low = 0
      let high = remaining.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (fits([...page, remaining.slice(0, mid).join('')])) low = mid
        else high = mid - 1
      }
      if (low) { page.push(remaining.slice(0, low).join('')); remaining = remaining.slice(low) }
      if (!page.length) throw new Error('卡片可用空间不足，请缩短标题或移除图片')
      pages.push(page)
      page = []
    }
  }
  if (page.length) pages.push(page)
  return pages.length ? pages : [[]]
}

export interface PublishCheck { label: string; detail: string; ok: boolean; action?: 'edit' | 'cards' | 'assets' | 'render' }

export function publishChecks(render: PlatformRender, stale = false): PublishCheck[] {
  const limits = getPlatformInfo(render.platform).limits
  const short = render.platform === 'xiaohongshu' || render.platform === 'douyin'
  // Caption text includes the title and hashtags that are copied together.
  const bodyLength = Array.from(render.text ?? '').length
  const titleLength = Array.from(render.title).length
  const images = render.platform === 'xiaohongshu' ? render.cards.length : render.assets.filter((asset) => asset.kind === 'image').length
  return [
    { label: '标题', detail: `${titleLength}${limits.titleMax ? ` / ${limits.titleMax}` : ''} 字`, ok: titleLength > 0 && (!limits.titleMax || titleLength <= limits.titleMax), action: 'edit' },
    { label: short ? '完整发布文案（含标题与话题）' : '正文', detail: `${bodyLength}${limits.bodyMax ? ` / ${limits.bodyMax}` : ''} 字`, ok: bodyLength > 0 && (!limits.bodyMax || bodyLength <= limits.bodyMax), action: 'edit' },
    { label: render.platform === 'xiaohongshu' ? '发布卡片' : '图片', detail: `${images}${limits.imageMax ? ` / ${limits.imageMax}` : ''} 张（参考上限）`, ok: !limits.imageMax || images <= limits.imageMax, action: render.platform === 'xiaohongshu' ? 'cards' : 'assets' },
    { label: '原文与设置版本', detail: stale ? '已变化，请重新生成' : render.sourceUpdatedAt ? '与生成版本一致' : '旧记录未保存原文版本，建议重新生成', ok: !stale && Boolean(render.sourceUpdatedAt), action: 'render' },
  ]
}

export interface RenderPreferences { platforms: PlatformId[]; options: RenderOptions }
export function parsePreferences(value: unknown): RenderPreferences | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.platforms)) return null
  const platforms = PLATFORM_ORDER.filter((platform) => (input.platforms as unknown[]).includes(platform))
  if (!platforms.length) return null
  const options = input.options && typeof input.options === 'object' ? input.options as Record<string, unknown> : {}
  return { platforms, options: {
    cardStyle: options.cardStyle === 'warm' || options.cardStyle === 'bold' ? options.cardStyle : 'clean',
    includeTags: options.includeTags !== false, includeToc: options.includeToc === true,
    authorName: typeof options.authorName === 'string' ? options.authorName.slice(0, 40) : '',
  } }
}
