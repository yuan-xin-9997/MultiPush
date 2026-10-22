import JSZip from 'jszip'
import type { PlatformRender, RenderDownload, XhsCard } from '@shared/types'
import { getPlatformInfo, PLATFORM_ORDER } from '@shared/types'
import { absoluteUrl } from '@/lib/api'
import { downloadText, escapeHtml, safeFilename } from '@/lib/utils'

export type ProgressReporter = (message: string, percent?: number) => void

export interface ExportedCardImage {
  card: XhsCard
  filename: string
  blob: Blob
}

export interface ZipBuildResult {
  blob: Blob
  skippedAssets: number
  report: ExportReport
}

export interface ExportReport {
  expectedCards: number
  successfulCards: number
  failedCards: string[]
  failedAssets: string[]
}

export function exportReport(renders: PlatformRender[], cards: ExportedCardImage[], failedAssets: string[], cardFailures: Record<string, string> = {}): ExportReport {
  const expected = renders.find((render) => render.platform === 'xiaohongshu')?.cards ?? []
  const ids = new Set(cards.map((image) => image.card.id))
  return { expectedCards: expected.length, successfulCards: expected.filter((card) => ids.has(card.id)).length,
    failedCards: expected.filter((card) => !ids.has(card.id)).map((card) => `第 ${card.index} 张（${card.id}）${cardFailures[card.id] ? `：${cardFailures[card.id]}` : ''}`), failedAssets }
}

function addExportReport(zip: JSZip, report: ExportReport): void {
  zip.file('导出报告.json', JSON.stringify(report, null, 2))
  zip.file('导出报告.txt', [
    `卡片：应有 ${report.expectedCards} 张，成功 ${report.successfulCards} 张`,
    report.failedCards.length || report.failedAssets.length ? '本次导出不完整，请在工作台重试失败项。' : '卡片及素材已完整导出。',
    '缺失卡片：', ...report.failedCards, '缺失素材（地址与原因）：', ...report.failedAssets,
  ].join('\n'))
}

const CARD_TYPE_LABELS: Record<XhsCard['type'], string> = {
  cover: '封面',
  content: '内容',
  quote: '金句',
  end: '结尾',
}

const DEFAULT_MIME: Record<RenderDownload['kind'], string> = {
  html: 'text/html;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
  text: 'text/plain;charset=utf-8',
  json: 'application/json;charset=utf-8',
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv'])
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

interface AssetRef {
  url: string
  kind: 'image' | 'video'
  filename: string
}

export function cardImageFilename(card: XhsCard, index: number): string {
  return `${String(index + 1).padStart(2, '0')}-${CARD_TYPE_LABELS[card.type] ?? '卡片'}.png`
}

export function dateStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** Removes a full document wrapper before writing rich HTML to the clipboard. */
export function htmlForClipboard(html: string): string {
  if (!/<html[\s>]/i.test(html)) return html
  const documentNode = new DOMParser().parseFromString(html, 'text/html')
  return documentNode.body.innerHTML || html
}

export function plainTextFromHtml(html: string): string {
  if (!html) return ''
  const documentNode = new DOMParser().parseFromString(html, 'text/html')
  return (documentNode.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

export function fullHtmlDocument(render: PlatformRender): string {
  if (/<html[\s>]/i.test(render.html)) return render.html
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(render.title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px; background: #ffffff; color: #1f2329; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", Arial, sans-serif; line-height: 1.8; }
  .multipush-article { max-width: 700px; margin: 0 auto; font-size: 16px; }
  .multipush-article img, .multipush-article video { max-width: 100%; height: auto; border-radius: 8px; }
  .multipush-article table { width: 100%; border-collapse: collapse; }
  .multipush-article th, .multipush-article td { border: 1px solid #e5e6eb; padding: 8px 10px; }
  .multipush-article pre { overflow-x: auto; padding: 14px; border-radius: 8px; background: #f6f7f9; }
  .multipush-article blockquote { margin: 18px 0; padding: 4px 16px; border-left: 3px solid #00b96b; color: #646a73; }
</style>
</head>
<body>
<div class="multipush-article">${render.html}</div>
</body>
</html>`
}

export function buildHtmlDownload(render: PlatformRender): RenderDownload {
  const info = getPlatformInfo(render.platform)
  return {
    filename: `${safeFilename(render.title, info.shortName)}-${info.shortName}.html`,
    mimeType: 'text/html;charset=utf-8',
    kind: 'html',
    content: fullHtmlDocument(render),
  }
}

/** Backend downloads plus safe client-side fallbacks for every platform. */
export function downloadsFor(render: PlatformRender): RenderDownload[] {
  const info = getPlatformInfo(render.platform)
  const downloads = render.downloads.map((download) => {
    if (download.kind === 'json' && render.platform === 'xiaohongshu') {
      return { ...download, content: xhsNoteJson(render) }
    }
    return download
  })
  const baseName = safeFilename(render.title, info.shortName)

  if (render.html && !downloads.some((download) => download.kind === 'html')) {
    downloads.unshift(buildHtmlDownload(render))
  }
  if (render.markdown && !downloads.some((download) => download.kind === 'markdown')) {
    downloads.push({
      filename: `${baseName}.md`,
      mimeType: 'text/markdown;charset=utf-8',
      kind: 'markdown',
      content: render.markdown,
    })
  }
  if (render.text && !downloads.some((download) => download.kind === 'text')) {
    downloads.push({
      filename: `${baseName}-文案.txt`,
      mimeType: 'text/plain;charset=utf-8',
      kind: 'text',
      content: render.text,
    })
  }
  return downloads
}

export function downloadRenderFile(download: RenderDownload): void {
  downloadText(
    safeFilename(download.filename, 'multipush-file'),
    download.content,
    download.mimeType || DEFAULT_MIME[download.kind],
  )
}

function isOnlyHashtags(line: string): boolean {
  return /^#\S+(?:\s+#\S+)*$/.test(line)
}

/** Text for the phone mockup, with title and hashtag lines removed. */
export function xhsBodyFromText(render: PlatformRender): string {
  const lines = (render.text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== render.title.trim() && !isOnlyHashtags(line))
  if (lines.length > 0) return lines.join('\n')
  return render.cards.flatMap((card) => card.body).filter(Boolean).join('\n')
}

export function xhsNoteText(render: PlatformRender): string {
  if (render.text && render.text.trim()) return render.text.trim()
  const tags = render.meta.tags.map((tag) => `#${tag}`).join(' ')
  const body = render.cards.flatMap((card) => card.body).filter(Boolean).join('\n\n')
  return [render.title, body, tags].filter(Boolean).join('\n\n')
}

export function xhsNoteJson(render: PlatformRender): string {
  const note = {
    platform: 'xiaohongshu',
    title: render.title,
    text: xhsNoteText(render),
    tags: render.meta.tags,
    images: render.assets.filter((asset) => asset.kind === 'image').map((asset) => asset.url),
    videos: render.videos,
    cards: render.cards,
    generatedAt: render.generatedAt,
  }
  return JSON.stringify(note, null, 2)
}

function assetRefs(render: PlatformRender): AssetRef[] {
  const refs: AssetRef[] = []
  for (const asset of render.assets) {
    refs.push({ url: asset.url, kind: asset.kind, filename: asset.filename })
  }
  for (const video of render.videos) {
    if (!refs.some((ref) => ref.url === video)) {
      refs.push({ url: video, kind: 'video', filename: '' })
    }
  }
  const seen = new Set<string>()
  return refs.filter((ref) => {
    if (!ref.url || seen.has(ref.url)) return false
    seen.add(ref.url)
    return true
  })
}

function extensionFromUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin)
    const match = /\.([a-zA-Z0-9]{1,5})$/.exec(parsed.pathname)
    return match?.[1]?.toLowerCase() ?? ''
  } catch {
    return ''
  }
}

function baseNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin)
    const name = parsed.pathname.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(name)
  } catch {
    return ''
  }
}

function assetExtension(blob: Blob, url: string, kind: AssetRef['kind']): string {
  const fromUrl = extensionFromUrl(url)
  const allowed = kind === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS
  if (allowed.has(fromUrl)) return fromUrl

  const mime = (blob.type || '').split(';')[0]?.trim().toLowerCase() ?? ''
  const fromMime = MIME_EXTENSIONS[mime]
  if (fromMime) return fromMime

  if (mime.startsWith('image/')) return 'jpg'
  if (mime.startsWith('video/')) return 'mp4'
  return kind === 'video' ? 'mp4' : 'jpg'
}

function assetFilename(asset: AssetRef, index: number, blob: Blob, url: string): string {
  const raw = asset.filename || baseNameFromUrl(url) || 'asset'
  const withoutExtension = raw.replace(/\.[^.]+$/, '')
  const base = safeFilename(withoutExtension, 'asset')
  const number = String(index + 1).padStart(2, '0')
  return `${number}-${base}.${assetExtension(blob, url, asset.kind)}`
}

const ASSET_FETCH_TIMEOUT_MS = 20_000
const ASSET_FETCH_CONCURRENCY = 3

async function fetchAssetBlob(url: string, kind: AssetRef['kind']): Promise<Blob> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ASSET_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`素材请求失败：${response.status}`)
    const blob = await response.blob()
    if (!blob.size || !blob.type.startsWith(`${kind}/`)) throw new Error('素材为空或返回了错误的文件类型')
    return blob
  } finally {
    clearTimeout(timer)
  }
}

async function addAssetsToZip(
  zip: JSZip,
  assets: AssetRef[],
  folder: string,
  onProgress?: ProgressReporter,
): Promise<string[]> {
  const total = assets.length
  if (total === 0) return []

  const failures: string[] = []
  let completed = 0
  let cursor = 0
  onProgress?.(`正在获取素材 0/${total}…`)

  // Fetch a few assets at a time and always settle: a stalled remote file must
  // never leave the ZIP download hanging forever.
  const worker = async (): Promise<void> => {
    while (cursor < total) {
      const index = cursor
      cursor += 1
      const asset = assets[index]
      if (!asset) continue
      try {
        const url = absoluteUrl(asset.url)
        const blob = await fetchAssetBlob(url, asset.kind)
        const typeFolder = asset.kind === 'video' ? '视频' : '图片'
        // Images and videos are already compressed; storing them avoids a
        // slow, pointless DEFLATE pass over tens of megabytes.
        zip.file(`${folder}/${typeFolder}/${assetFilename(asset, index, blob, url)}`, blob, {
          compression: 'STORE',
        })
      } catch (error) {
        // Assets are best-effort: the archive must still be downloadable.
        failures.push(`${asset.url}：${error instanceof Error ? error.message : '下载失败'}`)
      } finally {
        completed += 1
        onProgress?.(`正在获取素材 ${completed}/${total}…`)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(ASSET_FETCH_CONCURRENCY, total) }, () => worker()),
  )
  return failures
}

function uniqueZipPath(zip: JSZip, path: string): string {
  if (!zip.file(path)) return path
  const slash = path.lastIndexOf('/')
  const directory = slash >= 0 ? path.slice(0, slash + 1) : ''
  const filename = slash >= 0 ? path.slice(slash + 1) : path
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const extension = dot > 0 ? filename.slice(dot) : ''
  for (let counter = 2; counter < 1000; counter += 1) {
    const candidate = `${directory}${stem}-${counter}${extension}`
    if (!zip.file(candidate)) return candidate
  }
  return `${directory}${stem}-${Date.now()}${extension}`
}

async function generateZip(zip: JSZip, onProgress?: ProgressReporter): Promise<Blob> {
  return zip.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      platform: 'DOS',
    },
    (metadata) => {
      onProgress?.('正在压缩 ZIP…', metadata.percent)
    },
  )
}

/**
 * Single-platform Xiaohongshu archive:
 * 小红书/卡片/*.png + 文案.txt + 笔记.json + 原图/视频 + backend downloads.
 */
export async function buildXhsZip(
  render: PlatformRender,
  cards: ExportedCardImage[],
  onProgress?: ProgressReporter,
  cardFailures: Record<string, string> = {},
): Promise<ZipBuildResult> {
  const zip = new JSZip()
  const folder = '小红书'

  for (const image of cards) {
    zip.file(`${folder}/卡片/${image.filename}`, image.blob, { compression: 'STORE' })
  }
  zip.file(`${folder}/文案.txt`, xhsNoteText(render))
  zip.file(`${folder}/笔记.json`, xhsNoteJson(render))

  for (const download of downloadsFor(render)) {
    if (download.kind === 'text') continue
    zip.file(
      uniqueZipPath(zip, `${folder}/发布文件/${safeFilename(download.filename, 'file')}`),
      download.content,
    )
  }

  onProgress?.('正在整理原图与视频素材…', 22)
  const failures = await addAssetsToZip(zip, assetRefs(render), `${folder}/素材`, onProgress)
  const report = exportReport([render], cards, failures, cardFailures)
  addExportReport(zip, report)
  onProgress?.('正在压缩小红书素材…', 88)
  const blob = await generateZip(zip, onProgress)
  return { blob, skippedAssets: failures.length, report }
}

/**
 * All-platform archive. Each platform gets its own directory containing
 * backend downloads, client fallbacks, assets and (for Xiaohongshu) PNG cards.
 */
export async function buildAllZip(
  renders: PlatformRender[],
  xhsCards: ExportedCardImage[],
  onProgress?: ProgressReporter,
  cardFailures: Record<string, string> = {},
): Promise<ZipBuildResult> {
  const zip = new JSZip()
  const ordered = [...renders].sort(
    (left, right) => PLATFORM_ORDER.indexOf(left.platform) - PLATFORM_ORDER.indexOf(right.platform),
  )
  const failures: string[] = []

  for (let index = 0; index < ordered.length; index += 1) {
    const render = ordered[index]
    if (!render) continue
    const info = getPlatformInfo(render.platform)
    const folder = safeFilename(info.name, info.id)
    const basePercent = Math.round((index / Math.max(ordered.length, 1)) * 78)
    onProgress?.(`正在整理「${info.name}」…`, basePercent)

    if (render.platform === 'xiaohongshu' && xhsCards.length > 0) {
      for (const image of xhsCards) {
        zip.file(`${folder}/卡片/${image.filename}`, image.blob, { compression: 'STORE' })
      }
    }

    for (const download of downloadsFor(render)) {
      zip.file(
        uniqueZipPath(zip, `${folder}/${safeFilename(download.filename, 'file')}`),
        download.content,
      )
    }

    if (render.platform === 'xiaohongshu') {
      zip.file(uniqueZipPath(zip, `${folder}/文案.txt`), xhsNoteText(render))
      zip.file(uniqueZipPath(zip, `${folder}/笔记.json`), xhsNoteJson(render))
    }

    failures.push(...await addAssetsToZip(
      zip,
      assetRefs(render),
      `${folder}/素材`,
      (message) => onProgress?.(`「${info.shortName}」${message}`, basePercent),
    ))
  }

  onProgress?.('正在压缩全部素材…', 88)
  const report = exportReport(renders, xhsCards, failures, cardFailures)
  addExportReport(zip, report)
  const blob = await generateZip(zip, onProgress)
  return { blob, skippedAssets: failures.length, report }
}
