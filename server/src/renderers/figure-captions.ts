import { load as loadHtml, type Cheerio, type CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'
import { isBlankCaptionContainerText, isFigureCaptionText } from '../../../shared/figure-caption'

const MEDIA_SELECTOR = 'img,video,audio,iframe,svg,table,hr,figure'
const BLANK_SPACER_TAGS = new Set(['p', 'div', 'section', 'br'])

function tagName(node: AnyNode): string {
  return ((node as unknown as { name?: string }).name ?? '').toLowerCase()
}

function isCaptionBlock($: CheerioAPI, node: AnyNode | undefined): boolean {
  if (!node) return false
  const tag = tagName(node)
  if (tag !== 'p' && tag !== 'div') return false
  const $node = $(node)
  if ($node.find('img,video,audio,iframe,svg,table,hr,figure').length > 0) return false
  return isFigureCaptionText($node.text())
}

function isBlankSpacer($: CheerioAPI, node: AnyNode): boolean {
  const $node = $(node)
  if (tagName(node) === 'br') return true
  const tag = tagName(node)
  if (!BLANK_SPACER_TAGS.has(tag)) return false
  if (!isBlankCaptionContainerText($node.text())) return false
  return $node.find(MEDIA_SELECTOR).length === 0
}

/** Move a bare image / image-only paragraph into a new figure. */
function wrapImage($: CheerioAPI, image: AnyNode, block: AnyNode): void {
  const $figure = $('<figure></figure>')
  if (block === image) {
    $(image).replaceWith($figure)
    $figure.append($(image))
  } else {
    $(block).replaceWith($figure)
    $figure.append($(image))
  }
}

/** Move inline caption content (em/strong/a/plain text) into a figcaption. */
function appendCaption($: CheerioAPI, $figure: Cheerio<AnyNode>, caption: AnyNode): void {
  const $caption = $(caption)
  const $figcaption = $('<figcaption></figcaption>')
  // Preserve a source paragraph's alignment/color when normalizing an old
  // rendered record (fresh renders get platform styles immediately after).
  const sourceStyle = $caption.attr('style')
  if (sourceStyle) $figcaption.attr('style', sourceStyle)
  // A caption that was italicised as a whole becomes plain figcaption text;
  // figcaption itself is the semantic emphasis. Mixed inline formatting inside
  // the caption (strong/link/em on part of the text) is preserved.
  const children = $caption.contents().toArray().filter((child) => !(child.type === 'text' && !child.data.trim()))
  const only = children.length === 1 && (tagName(children[0]) === 'em' || tagName(children[0]) === 'i')
  if (only) $figcaption.append($(children[0]).contents())
  else $figcaption.append($caption.contents())
  $figure.append($figcaption)
  $caption.remove()
}

function previousBlockHasImage($: CheerioAPI, node: AnyNode): boolean {
  let previous = $(node).prev()
  while (previous.length && isBlankSpacer($, previous.get(0)!)) previous = previous.prev()
  if (!previous.length) return false
  const $previous = $(previous)
  if (tagName(previous.get(0)!) === 'img') return true
  const tag = tagName(previous.get(0)!)
  return (tag === 'p' || tag === 'div' || tag === 'section')
    && $previous.find('img').length > 0
    && isBlankCaptionContainerText($previous.text())
}

function imageOnlyBlock($: CheerioAPI, image: AnyNode): AnyNode {
  const $image = $(image)
  const parent = $image.parent()
  if (!parent.length || parent.is('figure')) return image
  const tag = tagName(parent.get(0)!)
  if (tag !== 'p' && tag !== 'div' && tag !== 'section') return image
  if (parent.find('img').length !== 1) return image
  if (!isBlankCaptionContainerText(parent.text())) return image
  if (parent.find('video,audio,iframe,svg,table,hr,figure').length > 0) return image
  return parent.get(0)!
}

/**
 * Normalize both legacy structures into the canonical figure:
 *
 *   <p><img></p><p>图：说明</p>  ->  <figure><img><figcaption>图：说明</figcaption></figure>
 *   <figure><img></figure><p>图：说明</p>  ->  a figure with a figcaption
 *
 * Only an immediately following paragraph is considered. Blank spacer
 * paragraphs/brs are removed only when a real caption follows, so ordinary
 * article spacing is untouched. A paragraph that merely *contains* the text
 * “图：” later in the sentence is never treated as a caption.
 */
export function normalizeFigureCaptions($: CheerioAPI): number {
  let changed = 0

  // Existing figures may lack a figcaption because earlier editors flattened it.
  for (const node of $('figure').toArray()) {
    const $figure = $(node)
    if ($figure.find('figcaption').length > 0) continue
    const images = $figure.find('img')
    if (images.length !== 1) continue
    if ($figure.children('p').length > 0) {
      $figure.children('p').each((_, paragraph) => {
        const $paragraph = $(paragraph)
        if ($paragraph.find('img').length === 1 && isBlankCaptionContainerText($paragraph.text())) {
          $paragraph.replaceWith($paragraph.contents())
        }
      })
    }
    let next = $figure.next()
    const spacers: AnyNode[] = []
    while (next.length && isBlankSpacer($, next.get(0)!)) {
      spacers.push(next.get(0)!)
      next = next.next()
    }
    if (!next.length || !isCaptionBlock($, next.get(0)!)) continue
    for (const spacer of spacers) $(spacer).remove()
    appendCaption($, $figure, next.get(0)!)
    changed += 1
  }

  // Bare image blocks: <p><img></p>, <div><img></div>, or an unwrapped <img>.
  for (const node of $('img').toArray()) {
    const $image = $(node)
    if ($image.closest('figure').length > 0) continue
    const block = imageOnlyBlock($, node)
    // Two images sharing one caption are intentionally left untouched.
    if (previousBlockHasImage($, block)) continue
    let next = $(block).next()
    const spacers: AnyNode[] = []
    while (next.length && isBlankSpacer($, next.get(0)!)) {
      spacers.push(next.get(0)!)
      next = next.next()
    }
    if (!next.length || !isCaptionBlock($, next.get(0)!)) continue
    for (const spacer of spacers) $(spacer).remove()
    const caption = next.get(0)!
    wrapImage($, node, block)
    const $figure = $image.closest('figure')
    appendCaption($, $figure, caption)
    changed += 1
  }

  return changed
}

/** HTML-string wrapper used by migrations and tests. */
export function normalizeFigureCaptionsHtml(html: string): string {
  const $ = loadHtml(`<div data-mp-figure-root="1">${html}</div>`, null, false)
  const root = $('[data-mp-figure-root="1"]').first()
  normalizeFigureCaptions($)
  return root.html() ?? ''
}
