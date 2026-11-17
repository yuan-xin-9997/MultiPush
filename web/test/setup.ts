import { afterEach, vi } from 'vitest'

// Tiptap/ProseMirror touch these browser APIs; jsdom supplies the DOM but not
// layout observers used by some editor plugins.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!globalThis.ResizeObserver) globalThis.ResizeObserver = ResizeObserverStub

if (!globalThis.DOMRect) {
  class DOMRectStub {
    x = 0
    y = 0
    width = 0
    height = 0
    top = 0
    right = 0
    bottom = 0
    left = 0
    toJSON() {
      return this
    }
  }
  globalThis.DOMRect = DOMRectStub as unknown as typeof DOMRect
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})
