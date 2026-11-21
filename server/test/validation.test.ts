import { describe, expect, it } from 'vitest'
import { PLATFORMS, PLATFORM_ORDER } from '../../shared/types'
import { batchRenderSchema, changePasswordSchema, loginSchema, registerSchema, renderRequestSchema } from '../src/validation'
import { DOCUMENT_MAX_BYTES, getMediaDescriptor, maxBytesFor } from '../src/upload'

describe('security input validation', () => {
  it('limits new passwords by UTF-8 bytes for registration and password changes', () => {
    for (const password of ['a'.repeat(72), '汉'.repeat(24)]) {
      expect(registerSchema.safeParse({ code: '123456', username: 'audit', email: 'audit@example.com', password }).success).toBe(true)
      expect(changePasswordSchema.safeParse({ currentPassword: 'old-password', newPassword: password }).success).toBe(true)
    }
    for (const password of ['a'.repeat(73), '汉'.repeat(25)]) {
      expect(registerSchema.safeParse({ code: '123456', username: 'audit', email: 'audit@example.com', password }).success).toBe(false)
      expect(changePasswordSchema.safeParse({ currentPassword: 'old-password', newPassword: password }).success).toBe(false)
    }
    // Existing long-password accounts must still be able to sign in and change passwords.
    expect(loginSchema.safeParse({ account: 'audit', password: 'a'.repeat(100) }).success).toBe(true)
  })

  it('accepts every supported platform in one render or batch render request', () => {
    expect(new Set(PLATFORM_ORDER)).toEqual(new Set(PLATFORMS.map((platform) => platform.id)))
    expect(renderRequestSchema.parse({ contentId: 'content-1', platforms: PLATFORM_ORDER }).platforms).toEqual(PLATFORM_ORDER)
    expect(batchRenderSchema.safeParse({ contentIds: ['content-1'], platforms: PLATFORM_ORDER }).success).toBe(true)
    expect(renderRequestSchema.safeParse({ contentId: 'content-1', platforms: ['unknown'] }).success).toBe(false)
    expect(renderRequestSchema.safeParse({ contentId: 'content-1', platforms: ['wechat'], platformOptions: { xiaohongshu: { includeTags: false } } }).success).toBe(true)
    expect(renderRequestSchema.safeParse({ contentId: 'content-1', platforms: ['wechat'], platformOptions: { unknown: { includeTags: false } } }).success).toBe(false)
  })

  it('rejects SVG uploads including uppercase extensions while allowing raster images', () => {
    expect(getMediaDescriptor('payload.svg')).toBeNull()
    expect(getMediaDescriptor('payload.SVG')).toBeNull()
    expect(getMediaDescriptor('photo.png')?.kind).toBe('image')
  })

  it('accepts common image, video and document extensions', () => {
    expect(getMediaDescriptor('clip.MP4')?.kind).toBe('video')
    for (const name of ['report.pdf', 'notes.markdown', 'sheet.XLSX', 'slides.pptx', 'archive.rtf']) {
      expect(getMediaDescriptor(name)?.kind).toBe('document')
    }
    expect(maxBytesFor(getMediaDescriptor('report.pdf')!)).toBe(DOCUMENT_MAX_BYTES)
    expect(getMediaDescriptor('archive.exe')).toBeNull()
  })
})
