export const WEIBO_THREAD_LIMIT = 2000

export function weiboLength(value: string): number {
  return Array.from(value).length
}

function splitOversize(block: string, limit: number): string[] {
  const sentences = block
    .split(/(?<=[。！？!?；;])\s*/u)
    .flatMap((sentence) => sentence.split(/\n+/))
    .map((part) => part.trim())
    .filter(Boolean)
  const pieces: string[] = []
  for (const sentence of sentences) {
    if (weiboLength(sentence) <= limit) {
      pieces.push(sentence)
      continue
    }
    const chars = Array.from(sentence)
    for (let index = 0; index < chars.length; index += limit) {
      const piece = chars.slice(index, index + limit).join('').trim()
      if (piece) pieces.push(piece)
    }
  }
  return pieces.length ? pieces : [block]
}

/**
 * Split a Weibo caption into <= limit character posts. The first post carries
 * the title, later posts carry the remaining paragraphs, and the topics are
 * appended to the last post (or their own post when the last one is full).
 * No content is truncated: paragraphs are split at sentence/newline boundaries
 * first, with a hard character split only for a single oversized paragraph.
 */
export function splitWeiboThread(title: string, body: string, topics: string[], limit = WEIBO_THREAD_LIMIT): string[] {
  const titleText = title.trim()
  const topicText = topics.filter(Boolean).join(' ').trim()
  const segments: string[] = []
  let current = titleText

  const flush = () => {
    if (current.trim()) segments.push(current.trim())
    current = ''
  }
  const pushBlock = (block: string) => {
    const value = block.trim()
    if (!value) return
    const candidate = current ? `${current}\n\n${value}` : value
    if (weiboLength(candidate) <= limit) {
      current = candidate
      return
    }
    flush()
    if (weiboLength(value) <= limit) {
      current = value
      return
    }
    for (const piece of splitOversize(value, limit)) {
      const next = current ? `${current}\n\n${piece}` : piece
      if (weiboLength(next) <= limit) {
        current = next
      } else {
        flush()
        current = piece
      }
      if (weiboLength(current) >= limit) flush()
    }
  }

  for (const paragraph of body.split(/\n{2,}/)) pushBlock(paragraph)
  flush()

  if (topicText) {
    const last = segments[segments.length - 1]
    if (last && weiboLength(`${last}\n\n${topicText}`) <= limit) {
      segments[segments.length - 1] = `${last}\n\n${topicText}`
    } else if (weiboLength(topicText) <= limit) {
      segments.push(topicText)
    } else {
      const pieces = splitOversize(topicText, limit)
      segments.push(...pieces)
    }
  }

  if (segments.length === 0) segments.push(titleText || topicText || '（正文为空）')
  return segments
}
