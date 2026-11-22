import { describe, expect, it } from 'vitest'
import { imageSizeFromHeaders } from '../src/features/gallery/image-meta'

describe('imageSizeFromHeaders', () => {
  it('prefers Content-Length', () => {
    expect(imageSizeFromHeaders(new Headers({ 'content-length': '1234', etag: 'W/"c4de-1a203437dc0"' }))).toBe(1234)
  })

  it('falls back to the hexadecimal size in an Express ETag', () => {
    expect(imageSizeFromHeaders(new Headers({ etag: 'W/"c4de-1a203437dc0"' }))).toBe(50398)
    expect(imageSizeFromHeaders(new Headers({ etag: '"c4de-1a203437dc0"' }))).toBe(50398)
  })

  it('returns null when neither header is usable', () => {
    expect(imageSizeFromHeaders(new Headers())).toBeNull()
    expect(imageSizeFromHeaders(new Headers({ 'content-length': '0', etag: 'not-a-size' }))).toBeNull()
  })
})
