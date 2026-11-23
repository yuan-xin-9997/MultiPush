import { describe, expect, it } from 'vitest'
import { compactEditorHtml } from '../src/publisher-html'

describe('compactEditorHtml', () => {
  it('removes formatting whitespace between blocks but keeps inline spaces', () => {
    const html = `<section>\n  <p>Hello <strong>world</strong> <em>now</em></p>\n  <figure>\n    <img src="x">\n    <figcaption>caption</figcaption>\n  </figure>\n  <p><br></p>\n</section>`
    const result = compactEditorHtml(html)
    expect(result).toContain('Hello ')
    expect(result).toContain('</strong> <em>now</em>')
    expect(result).toContain('<figcaption>caption</figcaption>')
    expect(result).not.toMatch(/>\n\s*</)
    expect(result).not.toContain('<p><br></p>')
  })

  it('preserves preformatted whitespace', () => {
    const result = compactEditorHtml('<pre><code>line 1\n\n  line 2</code></pre>')
    expect(result).toContain('line 1\n\n  line 2')
  })
})
