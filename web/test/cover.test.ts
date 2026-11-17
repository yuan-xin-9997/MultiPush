import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import {
  collectBodyImages,
  coverFileExtension,
  coverImageNeedsUpload,
  coverImageSource,
  isSameCoverSource,
  normalizeCoverSrc,
} from '@/features/editor/cover'

const ORIGIN = 'https://multipush.example'
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lPj3WQAAAABJRU5ErkJggg=='

function makeEditor(content: string): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return new Editor({
    element,
    extensions: [StarterKit, Image.configure({ inline: false, allowBase64: true })],
    content,
  })
}

describe('normalizeCoverSrc', () => {
  it('keeps local media root-relative and leaves external URLs absolute', () => {
    expect(normalizeCoverSrc('/uploads/a.png', ORIGIN)).toBe('/uploads/a.png')
    expect(normalizeCoverSrc(`${ORIGIN}/uploads/a.png`, ORIGIN)).toBe('/uploads/a.png')
    expect(normalizeCoverSrc(`${ORIGIN}/uploads/a.png?x=1#y`, ORIGIN)).toBe('/uploads/a.png?x=1#y')
    expect(normalizeCoverSrc('./images/a.png', ORIGIN)).toBe('/images/a.png')
    expect(normalizeCoverSrc('https://cdn.example.com/a.png', ORIGIN)).toBe('https://cdn.example.com/a.png')
    expect(normalizeCoverSrc('//cdn.example.com/a.png', ORIGIN)).toBe('https://cdn.example.com/a.png')
  })

  it('leaves embedded and unsafe schemes untouched so callers can filter them', () => {
    expect(normalizeCoverSrc(TINY_PNG, ORIGIN)).toBe(TINY_PNG)
    expect(normalizeCoverSrc('blob:https://multipush.example/123', ORIGIN)).toBe(
      'blob:https://multipush.example/123',
    )
    expect(normalizeCoverSrc('javascript:alert(1)', ORIGIN)).toBe('javascript:alert(1)')
  })
})

describe('cover image classification', () => {
  it('distinguishes local, embedded and external images', () => {
    expect(coverImageSource('/uploads/a.png')).toBe('local')
    expect(coverImageSource('/legacy/a.png')).toBe('local')
    expect(coverImageSource(TINY_PNG)).toBe('embedded')
    expect(coverImageSource('https://cdn.example.com/a.png')).toBe('external')
    expect(coverImageNeedsUpload('/uploads/a.png')).toBe(false)
    expect(coverImageNeedsUpload(TINY_PNG)).toBe(true)
    expect(coverImageNeedsUpload('https://cdn.example.com/a.png')).toBe(true)
  })

  it('matches an existing cover regardless of origin or relative form', () => {
    expect(isSameCoverSource('/uploads/a.png', `${ORIGIN}/uploads/a.png`, ORIGIN)).toBe(true)
    expect(isSameCoverSource(`${ORIGIN}/uploads/a.png`, '/uploads/a.png', ORIGIN)).toBe(true)
    expect(isSameCoverSource('/uploads/a.png', '/uploads/b.png', ORIGIN)).toBe(false)
    expect(isSameCoverSource(null, '/uploads/a.png', ORIGIN)).toBe(false)
  })
})

describe('collectBodyImages', () => {
  it('collects images in document order, including figures, and deduplicates', () => {
    const editor = makeEditor(
      `<p><img src="/uploads/a.png" alt="第一张"></p>` +
        `<figure><img src="/uploads/b.png" alt="图注图"><figcaption>图：第二张</figcaption></figure>` +
        `<p><img src="/uploads/a.png"><img src="blob:${ORIGIN}/tmp"></p>`,
    )
    try {
      const images = collectBodyImages(editor, ORIGIN)
      expect(images).toEqual([
        { src: '/uploads/a.png', originalSrc: '/uploads/a.png', alt: '第一张', source: 'local' },
        { src: '/uploads/b.png', originalSrc: '/uploads/b.png', alt: '图注图', source: 'local' },
      ])
    } finally {
      editor.destroy()
    }
  })

  it('normalizes same-origin images and keeps embedded/external markers', () => {
    const editor = makeEditor(
      `<p><img src="${ORIGIN}/uploads/c.png" alt="本站"></p>` +
        `<p><img src="https://cdn.example.com/d.png" alt="外站"></p>` +
        `<p><img src="${TINY_PNG}" alt="内嵌"></p>`,
    )
    try {
      expect(collectBodyImages(editor, ORIGIN)).toEqual([
        { src: '/uploads/c.png', originalSrc: `${ORIGIN}/uploads/c.png`, alt: '本站', source: 'local' },
        {
          src: 'https://cdn.example.com/d.png',
          originalSrc: 'https://cdn.example.com/d.png',
          alt: '外站',
          source: 'external',
        },
        { src: TINY_PNG, originalSrc: TINY_PNG, alt: '内嵌', source: 'embedded' },
      ])
    } finally {
      editor.destroy()
    }
  })

  it('ignores images without a src, unsafe schemes and non-image data URIs', () => {
    const editor = makeEditor(
      '<p>纯文本</p><p><img src="javascript:alert(1)" alt="坏图"></p><p><img src="data:text/html;base64,PGgxPmhpPC9oMT4=" alt="文本"></p>',
    )
    try {
      expect(collectBodyImages(editor, ORIGIN)).toEqual([])
    } finally {
      editor.destroy()
    }
  })
})

describe('coverFileExtension', () => {
  it('prefers MIME type, then data URI header, then a supported URL extension', () => {
    expect(coverFileExtension('/uploads/a.bin', 'image/jpeg')).toBe('jpg')
    expect(coverFileExtension(TINY_PNG, '')).toBe('png')
    expect(coverFileExtension('https://cdn.example.com/a.webp', '')).toBe('webp')
    expect(coverFileExtension('https://cdn.example.com/a.jpg?x=1', '')).toBe('jpg')
  })

  it('rejects formats the upload endpoint cannot store', () => {
    expect(coverFileExtension('https://cdn.example.com/a.svg', 'image/svg+xml')).toBeNull()
    expect(coverFileExtension('/uploads/a', '')).toBeNull()
  })
})
