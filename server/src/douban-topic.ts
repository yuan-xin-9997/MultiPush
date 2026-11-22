import { load } from 'cheerio'

/**
 * Douban replaced the legacy `/j/note/...` diary API with the "topic" service in 2026:
 * images go to `upload.douban.com/j/group/topic/add_photo`, diaries are created through
 * `m.douban.com/rexxar/api/v2/topic/post` with `subtype: "note"` and a Draft.js body.
 */
export interface DoubanPhoto {
  id: string
  url: string
  thumb: string
  width: number
  height: number
  fileName: string
  fileSize: number
  isAnimated: boolean
  primaryColor: string
}

type Record_ = Record<string, unknown>
function record(value: unknown): Record_ { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record_ : {} }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }

export function doubanTopicUrl(remoteId: string): string {
  return `https://www.douban.com/topic/${encodeURIComponent(remoteId)}/`
}

/** Accepts the add_photo envelope: `{"r":0,"photo":{...}}`. */
export function parseDoubanUploadPhoto(value: unknown): DoubanPhoto | null {
  const root = record(value)
  const photo = record(root.photo)
  const id = text(photo.id)
  const url = text(photo.url)
  if (Number(root.r ?? 0) !== 0 || !id || !url) return null
  return {
    id,
    url,
    thumb: text(photo.thumb) || url,
    width: Number(photo.width ?? 0) || 1,
    height: Number(photo.height ?? 0) || 1,
    fileName: text(photo.file_name),
    fileSize: Number(photo.file_size ?? 0) || 0,
    isAnimated: Boolean(photo.is_animated),
    primaryColor: text(photo.primary_color),
  }
}

/**
 * Build the exact payload used by Douban's topic editor for a note.
 *
 * `image_layout` must be omitted for text-only notes (the editor sends it only
 * when images exist). Image ids must be a comma-separated `seq_id` list, and
 * every Draft entity needs a `mutability` field; these were the two fields the
 * old adapter got wrong and caused Douban to answer `invalid_parameter`.
 */
export function buildDoubanTopicPost(input: {
  title: string
  content: string
  imageIds: string
  privacy: 'public' | 'private'
  interestTags?: string
}): Record<string, unknown> {
  return {
    title: input.title,
    content: input.content,
    image_ids: input.imageIds,
    ...(input.imageIds && input.imageIds.split(',').length <= 18 ? { image_layout: 'horizontal' } : {}),
    topic_tag_ids: '',
    interest_tags: input.interestTags ?? '',
    is_event: false,
    subtype: 'note',
    accessible: input.privacy === 'private' ? 'private' : 'public',
    explanation_types: '',
    send_status: true,
    original: false,
    is_activity_rule: false,
    enable_item_tag: false,
  }
}

/** Accepts the topic/post response: `{id, url, title, create_time}`. */
export function parseDoubanTopicResult(value: unknown): { remoteId: string; url: string } | null {
  const root = record(value)
  const id = text(root.id)
  if (!/^\d{6,30}$/.test(id)) return null
  const url = text(root.url)
  return { remoteId: id, url: /douban\.com\/topic\//.test(url) ? url.split('?')[0] : doubanTopicUrl(id) }
}

interface DraftBlock {
  key: string
  text: string
  type: string
  depth: number
  inlineStyleRanges: Array<{ offset: number; length: number; style: string }>
  entityRanges: Array<{ offset: number; length: number; key: number }>
  data: Record<string, unknown>
}

interface DraftState {
  text: string
  styles: Array<{ offset: number; length: number; style: string }>
  entities: Array<{ offset: number; length: number; key: number }>
}

const STYLE_TAGS: Record<string, string> = {
  b: 'BOLD', strong: 'BOLD', i: 'ITALIC', em: 'ITALIC',
  u: 'UNDERLINE', s: 'STRIKETHROUGH', del: 'STRIKETHROUGH', code: 'CODE',
}
const BLOCK_TAGS: Record<string, string> = {
  h2: 'header-two', h3: 'header-three', h4: 'header-four', h5: 'header-five', h6: 'header-six',
  blockquote: 'blockquote', pre: 'code-block',
}

/** Convert the prepared diary HTML into the Draft.js raw state Douban expects. */
export function buildDoubanTopicContent(html: string, photos: DoubanPhoto[]): { content: string; imageIds: string } {
  const $ = load(html, null, false)
  const blocks: DraftBlock[] = []
  const entityMap: Record<string, { type: string; mutability?: 'MUTABLE' | 'IMMUTABLE'; data: Record<string, unknown> }> = {}
  let imageCursor = 0
  let imagePosition = 0
  let serial = 0
  const blockKey = (): string => `b${(serial++).toString(36)}${Math.random().toString(36).slice(2, 5)}`

  const collect = (node: unknown, styles: string[], linkKey: number | null, state: DraftState): void => {
    for (const child of $(node as never).contents().toArray()) {
      if (child.type === 'text') {
        const value = ((child as { data?: string }).data || '').replace(/\u00a0/g, ' ')
        if (!value) continue
        const offset = state.text.length
        state.text += value
        for (const style of styles) state.styles.push({ offset, length: value.length, style })
        if (linkKey !== null) state.entities.push({ offset, length: value.length, key: linkKey })
        continue
      }
      if (child.type !== 'tag') continue
      const tag = (child as { name?: string }).name || ''
      if (tag === 'br') { state.text += '\n'; continue }
      if (tag === 'a') {
        const href = ($(child as never).attr('href') || '').trim()
        let key = linkKey
        if (href) {
          key = Object.keys(entityMap).length
          entityMap[String(key)] = { type: 'LINK', mutability: 'MUTABLE', data: { href, url: href } }
        }
        collect(child, styles, key, state)
        continue
      }
      const mapped = STYLE_TAGS[tag]
      collect(child, mapped ? [...styles, mapped] : styles, linkKey, state)
    }
  }

  const pushText = (node: unknown, type: string): void => {
    const state: DraftState = { text: '', styles: [], entities: [] }
    collect(node, [], null, state)
    if (!state.text.trim()) return
    blocks.push({ key: blockKey(), text: state.text, type, depth: 0, inlineStyleRanges: state.styles, entityRanges: state.entities, data: { align: '' } })
  }

  const pushImage = (photo: DoubanPhoto): void => {
    const key = Object.keys(entityMap).length
    entityMap[String(key)] = {
      type: 'IMAGE',
      mutability: 'IMMUTABLE',
      data: {
        id: photo.id,
        src: photo.url,
        raw_src: photo.url,
        thumb: photo.thumb,
        url: photo.url,
        width: photo.width,
        height: photo.height,
        file_name: photo.fileName,
        file_size: photo.fileSize,
        position: imagePosition++,
      },
    }
    blocks.push({ key: blockKey(), text: ' ', type: 'atomic', depth: 0, inlineStyleRanges: [], entityRanges: [{ offset: 0, length: 1, key }], data: {} })
  }

  const walk = (node: unknown): void => {
    for (const child of $(node as never).children().toArray()) {
      const tag = (child as { name?: string }).name || ''
      if (tag === 'img') {
        const photo = photos[imageCursor++]
        if (photo) pushImage(photo)
        continue
      }
      if (tag === 'ul' || tag === 'ol') {
        const type = tag === 'ul' ? 'unordered-list-item' : 'ordered-list-item'
        $(child as never).children('li').each((_, item) => { pushText(item, type) })
        continue
      }
      if (BLOCK_TAGS[tag]) { pushText(child, BLOCK_TAGS[tag]); continue }
      const nested = $(child as never).find('img').length
      if (nested) {
        $(child as never).find('img').each((_, image) => {
          const photo = photos[imageCursor++]
          if (photo) pushImage(photo)
        })
        const clone = $(child as never).clone()
        clone.find('img').remove()
        if (clone.text().trim()) pushText(clone, 'unstyled')
        continue
      }
      if ($(child as never).text().trim()) pushText(child, 'unstyled')
    }
  }

  walk($.root())
  const imageIds = photos.map((photo, index) => `${index + 1}_${photo.id}`).join(',')
  return { content: JSON.stringify({ blocks, entityMap }), imageIds }
}
