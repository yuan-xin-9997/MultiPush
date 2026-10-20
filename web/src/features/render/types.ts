import type { RenderOptions } from '@shared/types'

/** Card style is defined by the shared render contract. */
export type CardStyle = NonNullable<RenderOptions['cardStyle']>

export interface CardStyleOption {
  id: CardStyle
  name: string
  hint: string
  swatches: [string, string, string]
}

export const CARD_STYLE_OPTIONS: CardStyleOption[] = [
  {
    id: 'clean',
    name: '清新',
    hint: '薄荷绿 · 留白',
    swatches: ['#f4faf6', '#0e9f6e', '#d9f1e6'],
  },
  {
    id: 'warm',
    name: '暖阳',
    hint: '奶油色 · 暖橙',
    swatches: ['#fff7ec', '#e0742a', '#ffe2c2'],
  },
  {
    id: 'bold',
    name: '醒目',
    hint: '深色 · 高对比',
    swatches: ['#17191f', '#ff2442', '#ffd166'],
  },
]

export const CARD_STYLE_BACKGROUND: Record<CardStyle, string> = {
  clean: '#f4faf6',
  warm: '#fff7ec',
  bold: '#17191f',
}

export function resolveCardStyle(value: RenderOptions['cardStyle'] | null | undefined): CardStyle {
  if (value === 'warm' || value === 'bold') return value
  return 'clean'
}
