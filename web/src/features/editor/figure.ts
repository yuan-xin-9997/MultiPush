import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { isFigureCaptionText } from '@shared/figure-caption'

/**
 * Tiptap representation of:
 *
 *   <figure><img src="…" alt="…"><figcaption>图：说明</figcaption></figure>
 *
 * The image stays a block node, but inside the figure it is an ordinary child,
 * so ProseMirror never has to put an image inside a paragraph.
 */
export const Figure = Node.create({
  name: 'figure',
  group: 'block',
  content: 'image? figcaption?',
  defining: true,
  isolating: true,
  selectable: true,
  draggable: true,

  parseHTML() {
    // Higher priority than the image rule. The figure parser consumes the
    // <img>, so the image is not parsed a second time at the document root.
    return [{ tag: 'figure', priority: 1000 }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes), 0]
  },
})

export const FigureCaption = Node.create({
  name: 'figcaption',
  content: 'inline*',
  defining: true,
  isolating: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'figcaption' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['figcaption', mergeAttributes(HTMLAttributes), 0]
  },
})

interface Replacement {
  from: number
  to: number
  node: ProseMirrorNode
}

function figureReplacements(doc: ProseMirrorNode): Replacement[] {
  const replacements: Replacement[] = []

  const inspect = (parent: ProseMirrorNode, parentPos: number): void => {
    if (parent.childCount < 2) return
    const children: { node: ProseMirrorNode; pos: number }[] = []
    parent.forEach((child, offset) => {
      children.push({ node: child, pos: parentPos + 1 + offset })
    })
    for (let index = 0; index < children.length - 1; index += 1) {
      const image = children[index]
      const caption = children[index + 1]
      if (image.node.type.name !== 'image') continue
      if (caption.node.type.name !== 'paragraph') continue
      if (!isFigureCaptionText(caption.node.textContent)) continue
      if (caption.node.childCount === 0) continue
      let captionHasImage = false
      caption.node.forEach((child) => { if (child.type.name === 'image') captionHasImage = true })
      if (captionHasImage) continue
      const figureType = doc.type.schema.nodes.figure
      const figcaptionType = doc.type.schema.nodes.figcaption
      if (!figureType || !figcaptionType) continue
      const figcaption = figcaptionType.create(null, caption.node.content)
      const figure = figureType.create(null, [image.node, figcaption])
      replacements.push({
        from: image.pos,
        to: caption.pos + caption.node.nodeSize,
        node: figure,
      })
      index += 1
    }
  }

  // ProseMirror's descendants() starts at the document content, so inspect the
  // root explicitly or top-level image + caption pairs are missed.
  inspect(doc, -1)
  doc.descendants((node, pos) => {
    if (node.type.name === 'figure') return false
    inspect(node, pos)
    return true
  })

  // Apply from the end so earlier positions remain valid.
  return replacements.sort((a, b) => b.from - a.from)
}

/**
 * Merge an image immediately followed by a `图：…` paragraph. This is a
 * ProseMirror plugin (not a global HTML rewrite), so it only touches adjacent
 * block nodes and is safe for normal body paragraphs that happen to mention
 * “图：” after another paragraph.
 */
export const NormalizeFigureCaptions = Extension.create({
  name: 'normalizeFigureCaptions',

  onCreate() {
    // Initial editor content is parsed before any transaction exists, so the
    // appendTransaction hook alone cannot migrate the first document.
    normalizeEditorFigures(this.editor)
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('normalizeFigureCaptions'),
        appendTransaction(transactions: readonly Transaction[], _oldState, newState) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null
          const replacements = figureReplacements(newState.doc)
          if (replacements.length === 0) return null
          const transaction = newState.tr
          for (const replacement of replacements) {
            transaction.replaceWith(replacement.from, replacement.to, replacement.node)
          }
          return transaction
        },
      }),
    ]
  },
})

/** Command form for callers that want to normalize explicitly. */
export function normalizeEditorFigures(editor: Editor): boolean {
  const replacements = figureReplacements(editor.state.doc)
  if (replacements.length === 0) return false
  const transaction = editor.state.tr
  for (const replacement of replacements) transaction.replaceWith(replacement.from, replacement.to, replacement.node)
  editor.view.dispatch(transaction)
  return true
}
