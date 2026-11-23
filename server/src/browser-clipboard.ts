// @ts-nocheck
/**
 * Functions in this file are serialized by Playwright and executed inside the
 * Bilibili editor page. They must not reference Node.js values.
 */

export async function pasteHtml({ html, plain, replace }) {
  const element = document.querySelector('.tiptap.ProseMirror[contenteditable="true"]')
  if (!element) return { ok: false }
  element.focus()
  const selection = window.getSelection()
  if (selection) {
    const range = document.createRange()
    range.selectNodeContents(element)
    if (!replace) range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const transfer = new DataTransfer()
  transfer.setData('text/html', html)
  transfer.setData('text/plain', plain)
  const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
  element.dispatchEvent(event)
  return { ok: true, prevented: event.defaultPrevented }
}

export async function writeClipboardImage({ b64, mime }) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  await navigator.clipboard.write([new ClipboardItem({ [mime]: new Blob([bytes], { type: mime }) })])
  return true
}

/**
 * Use the editor's own Tiptap command instead of simulating a paste when
 * available. This keeps the document state in sync and avoids the editor
 * turning formatting newlines into empty paragraphs.
 */
export async function setEditorContent({ html }) {
  const element = document.querySelector('.tiptap.ProseMirror[contenteditable="true"]')
  const editor = element?.editor
  if (!editor || typeof editor.setContent !== 'function') return { ok: false }
  editor.setContent(html, true)
  return { ok: true }
}
