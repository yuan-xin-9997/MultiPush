import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import type { PlatformRender } from '../../shared/types'

vi.mock('../../web/src/lib/api', () => ({ absoluteUrl: (url: string) => url }))
import { buildXhsZip, downloadsFor, exportReport } from '../../web/src/features/render/downloads'

afterEach(() => vi.unstubAllGlobals())

const render = {
  platform: 'xiaohongshu', title: '测试笔记', text: '测试文案', html: '', markdown: null,
  cards: [1, 2].map((i) => ({ id: `card-${i}`, index: i, total: 2, type: 'content', title: '', body: ['正文'], images: [], footer: '' })),
  meta: { tags: [] }, assets: [], videos: [], downloads: [], generatedAt: '2026-10-22',
} as unknown as PlatformRender

describe('export integrity', () => {
  it('uses the final measured cards in every Xiaohongshu JSON download', () => {
    const download = downloadsFor({ ...render, downloads: [{ filename: 'old.json', kind: 'json', mimeType: 'application/json', content: '{"cards":[]}' }] }).find((file) => file.kind === 'json')!
    expect(JSON.parse(download.content).cards).toEqual(render.cards)
  })
  it('reports missing cards by identity rather than trusting the number of screenshots', () => {
    const images = [{ card: render.cards[0], filename: '01.png', blob: new Blob() }]
    const report = exportReport([render], images, ['https://example.com/missing.png：404'])
    expect(report.expectedCards).toBe(2)
    expect(report.successfulCards).toBe(1)
    expect(report.failedCards).toEqual(['第 2 张（card-2）'])
    expect(report.failedAssets).toHaveLength(1)
  })

  it('writes an accurate missing-file report into a downloadable ZIP even if all cards fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    const result = await buildXhsZip({ ...render, assets: [{ url: 'https://example.com/missing.png', kind: 'image', filename: 'missing.png' }] }, [])
    expect(result.skippedAssets).toBe(1)
    expect(result.report.failedCards).toHaveLength(2)
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(await zip.file('导出报告.txt')!.async('string')).toContain('本次导出不完整')
    const report = JSON.parse(await zip.file('导出报告.json')!.async('string'))
    expect(report.successfulCards).toBe(0)
    expect(report.failedAssets[0]).toContain('missing.png')
    expect(await zip.file('小红书/文案.txt')!.async('string')).toBe('测试文案')
  })
})
