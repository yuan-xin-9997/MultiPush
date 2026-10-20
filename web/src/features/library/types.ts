export type LibraryMode = 'all' | 'favorites' | 'trash' | 'book'

export type LibraryView = 'card' | 'list'

export type LibrarySort = 'updated_desc' | 'created_desc' | 'title_asc'

export interface LibraryCounts {
  all: number
  favorites: number
  trash: number
  unfiled: number
}

export const UNFILED_BOOK_ID = 'unfiled'
export const LIBRARY_PAGE_SIZE = 20
export const MAX_BATCH_EXPORT = 50

export const BOOK_COLORS = ['#00b96b', '#3370ff', '#ff8f1f', '#f54a45', '#00a6a6', '#8f959e']

export const SORT_OPTIONS: Array<{ value: LibrarySort; label: string }> = [
  { value: 'updated_desc', label: '最近更新' },
  { value: 'created_desc', label: '创建时间' },
  { value: 'title_asc', label: '标题排序' },
]
