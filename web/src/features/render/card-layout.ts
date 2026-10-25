import type { XhsCard } from '@shared/types'
import { createCardId, fitCardBody, renumberCards } from '@shared/render-workbench'

export const CARD_TEXT_SELECTORS = '.xhs-content-lines, .xhs-cover-copy h1, .xhs-cover-summary, .xhs-end-wrap h1, .xhs-end-lines'

export function overflowingText(node: HTMLElement): boolean {
  const card = node.querySelector<HTMLElement>('.xhs-card')
  if (!card) return true
  const bounds = card.getBoundingClientRect()
  const footerTop = node.querySelector('.xhs-card-foot')?.getBoundingClientRect().top ?? bounds.bottom
  return Array.from(node.querySelectorAll<HTMLElement>(CARD_TEXT_SELECTORS)).some((element) => {
    const style = getComputedStyle(element)
    // Font glyphs can extend beyond the line box without being clipped.
    if (style.overflowY === 'hidden' && element.scrollHeight > element.clientHeight + 1) return true
    const range = document.createRange()
    range.selectNodeContents(element)
    const text = range.getBoundingClientRect()
    return text.bottom > footerTop + 1 || text.right > bounds.right + 1 || text.left < bounds.left - 1
  })
}

export function layoutCards(cards: XhsCard[], nodes: Map<string, HTMLDivElement>): XhsCard[] {
  const output: XhsCard[] = []
  for (const card of cards) {
    if (card.images.length > 1) {
      output.push({ ...card, images: card.images.slice(0, 1) })
      card.images.slice(1).forEach((url, index) => output.push({ ...card, type: 'content', id: `${card.id.slice(0, 60)}-image-${index}-${createCardId().slice(0, 8)}`, title: '', body: [], images: [url] }))
      continue
    }
    const node = nodes.get(card.id)
    if (!node || !node.querySelector('.xhs-content-lines') || !overflowingText(node)) {
      output.push(card)
      continue
    }
    const clone = node.cloneNode(true) as HTMLElement
    node.parentElement!.appendChild(clone)
    try {
      const lines = clone.querySelector<HTMLElement>('.xhs-content-lines')!
      const pages = fitCardBody(card.body, (body) => {
        lines.replaceChildren(...body.map((text) => {
          const paragraph = document.createElement('p')
          paragraph.textContent = text
          return paragraph
        }))
        return lines.clientHeight > 0 && lines.scrollHeight <= lines.clientHeight + 1 && lines.scrollWidth <= lines.clientWidth + 1 && !overflowingText(clone)
      })
      pages.forEach((body, index) => output.push({ ...card, body,
        id: index === 0 ? card.id : `${card.id.slice(0, 60)}-flow-${index}-${createCardId().slice(0, 8)}`,
        images: index === 0 ? card.images : [],
      }))
    } finally { clone.remove() }
  }
  return renumberCards(output)
}

export async function verifyCardImages(urls: string[]): Promise<void> {
  await Promise.all([...new Set(urls)].map((url) => new Promise<void>((resolve, reject) => {
    const image = new Image()
    const finish = (error?: string) => {
      clearTimeout(timer)
      image.onload = null
      image.onerror = null
      if (error) reject(new Error(error))
      else resolve()
    }
    const timer = window.setTimeout(() => finish(`图片加载超时：${url}`), 15_000)
    image.crossOrigin = 'anonymous'
    image.onload = () => image.naturalWidth > 0 ? finish() : finish(`图片为空：${url}`)
    image.onerror = () => finish(`图片无法读取或不允许跨域导出：${url}`)
    image.src = url
  })))
}
