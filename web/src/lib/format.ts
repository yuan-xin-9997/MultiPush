const numberFormatter = new Intl.NumberFormat('zh-CN')

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return numberFormatter.format(Math.max(0, Math.round(value)))
}

export function formatWordCount(value: number): string {
  return `${formatNumber(value)} 字`
}

export function formatDocumentCount(value: number): string {
  return `${formatNumber(value)} 篇`
}
