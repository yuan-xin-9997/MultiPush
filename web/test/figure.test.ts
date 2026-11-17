import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { Figure, FigureCaption, NormalizeFigureCaptions, normalizeEditorFigures } from '@/features/editor/figure'
import { groupImageCaptions } from '@/lib/content-io'

function makeEditor(content: string | Record<string, unknown>): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return new Editor({
    element,
    extensions: [
      StarterKit,
      Image.configure({ inline: false, allowBase64: true }),
      Link.configure({ openOnClick: false }),
      Figure,
      FigureCaption,
      NormalizeFigureCaptions,
    ],
    content,
  })
}

describe('Tiptap figure/figcaption schema', () => {
  it('parses a figure into image + figcaption and renders the same structure', () => {
    const editor = makeEditor(
      '<figure><img src="/uploads/a.png" alt="器材"><figcaption>图：我的器材：）</figcaption></figure><p>正文</p>',
    )
    try {
      expect(editor.getJSON()).toMatchObject({
        type: 'doc',
        content: [
          {
            type: 'figure',
            content: [
              { type: 'image', attrs: { src: '/uploads/a.png', alt: '器材' } },
              { type: 'figcaption', content: [{ type: 'text', text: '图：我的器材：）' }] },
            ],
          },
          { type: 'paragraph', content: [{ type: 'text', text: '正文' }] },
        ],
      })
      expect(editor.getHTML()).toBe(
        '<figure><img src="/uploads/a.png" alt="器材"><figcaption>图：我的器材：）</figcaption></figure><p>正文</p>',
      )
    } finally {
      editor.destroy()
    }
  })

  it('keeps em/strong/link marks inside figcaption', () => {
    const editor = makeEditor(
      '<figure><img src="/a.png"><figcaption>图：<strong>重点</strong>与<a href="https://example.com">链接</a></figcaption></figure>',
    )
    try {
      const figure = editor.getJSON().content?.[0] as { content?: { type: string; content?: unknown[] }[] }
      expect(figure.content?.[1]).toMatchObject({
        type: 'figcaption',
        content: [
          { type: 'text', text: '图：' },
          { type: 'text', text: '重点', marks: [{ type: 'bold' }] },
          { type: 'text', text: '与' },
          { type: 'text', text: '链接', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
        ],
      })
      expect(editor.getHTML()).toContain('<figcaption>图：<strong>重点</strong>与<a')
      expect(editor.getHTML()).toContain('>链接</a></figcaption>')
    } finally {
      editor.destroy()
    }
  })

  it('merges a legacy image + adjacent 图： paragraph on load and is idempotent', async () => {
    const editor = makeEditor('<img src="/a.png" alt="a"><p><em>图：历史图注</em></p><p>正文</p>')
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const json = editor.getJSON()
      expect(json.content?.[0]).toMatchObject({ type: 'figure' })
      expect((json.content?.[0] as { content?: unknown[] }).content).toHaveLength(2)
      expect(editor.getHTML()).toBe(
        '<figure><img src="/a.png" alt="a"><figcaption><em>图：历史图注</em></figcaption></figure><p>正文</p>',
      )
      const before = editor.getHTML()
      expect(normalizeEditorFigures(editor)).toBe(false)
      expect(editor.getHTML()).toBe(before)
    } finally {
      editor.destroy()
    }
  })

  it('opens, saves and reopens 21 figures without losing any structure', () => {
    const html = Array.from({ length: 21 }, (_, index) => (
      `<p>第 ${index + 1} 段正文。</p><figure><img src="/uploads/${index + 1}.png" alt="图 ${index + 1}"><figcaption>图：第 ${index + 1} 张：）</figcaption></figure>`
    )).join('')
    const first = makeEditor(html)
    try {
      expect(first.getJSON().content?.filter((node) => node.type === 'figure')).toHaveLength(21)
      const savedJson = first.getJSON()
      const savedHtml = first.getHTML()
      const second = makeEditor(savedHtml)
      try {
        expect(second.getJSON().content?.filter((node) => node.type === 'figure')).toHaveLength(21)
        expect(second.getJSON()).toEqual(savedJson)
        expect(second.getHTML()).toBe(savedHtml)
      } finally {
        second.destroy()
      }
    } finally {
      first.destroy()
    }
  })

  it('does not merge an image followed by normal body text or a heading', () => {
    const editor = makeEditor('<img src="/a.png"><p>这段正文提到了图：但不是图注</p><img src="/b.png"><h2>图：小标题</h2>')
    try {
      const json = editor.getJSON()
      expect(json.content?.filter((node) => node.type === 'figure')).toHaveLength(0)
      expect(json.content?.map((node) => node.type)).toEqual(['image', 'paragraph', 'image', 'heading'])
    } finally {
      editor.destroy()
    }
  })
})

describe('groupImageCaptions', () => {
  it('merges an em caption and preserves full-width punctuation / emoji', () => {
    expect(groupImageCaptions('<p><img src="/a.png" alt="a"></p>\n<p><em>图：我的器材：）</em></p>')).toBe(
      '<figure><img src="/a.png" alt="a"><figcaption>图：我的器材：）</figcaption></figure>',
    )
  })

  it('merges a plain caption without em', () => {
    expect(groupImageCaptions('<p><img src="/a.png"></p><p>图:普通图注</p>')).toBe(
      '<figure><img src="/a.png"><figcaption>图:普通图注</figcaption></figure>',
    )
    expect(groupImageCaptions('<p><img src="/a.png"></p><p>图 1：编号图注</p>')).toBe(
      '<figure><img src="/a.png"><figcaption>图 1：编号图注</figcaption></figure>',
    )
  })

  it('skips a multi-paragraph body and a non-caption paragraph', () => {
    const html = '<p><img src="/a.png"></p><p>正文第一段</p><p>图：这里只是正文</p>'
    expect(groupImageCaptions(html)).toBe(html)
  })

  it('does not merge multiple images sharing one caption', () => {
    for (const html of [
      '<p><img src="/a.png"><img src="/b.png"></p><p><em>图：两张图</em></p>',
      '<p><img src="/a.png"></p><p><img src="/b.png"></p><p><em>图：两张图</em></p>',
    ]) {
      expect(groupImageCaptions(html)).toBe(html)
    }
  })

  it('does not merge an orphan caption', () => {
    const html = '<p>正文</p><p><em>图：没有图片</em></p>'
    expect(groupImageCaptions(html)).toBe(html)
  })

  it('preserves mixed inline formatting and is idempotent', () => {
    const html = '<p><img src="/a.png"></p><p><em>图：</em><strong>重点</strong> <a href="https://example.com">链接</a></p>'
    const once = groupImageCaptions(html)
    expect(once).toBe(
      '<figure><img src="/a.png"><figcaption><em>图：</em><strong>重点</strong> <a href="https://example.com">链接</a></figcaption></figure>',
    )
    expect(groupImageCaptions(once)).toBe(once)
  })
})
