import type {
  ApiErrorBody,
  ApiHealth,
  AuthResponse,
  Book,
  BookInput,
  ContentDetail,
  ContentInput,
  ContentListQuery,
  ContentListResult,
  ContentSummary,
  LoginInput,
  MediaAsset,
  PlatformInfo,
  PlatformId,
  RegisterInput,
  RenderListItem,
  RenderRecord,
  RenderRequest,
  PlatformAdjustment,
  PlatformRender,
  User,
} from '@shared/types'

const TOKEN_KEY = 'multipush_token'
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

let memoryToken: string | null = localStorage.getItem(TOKEN_KEY)

export class ApiError extends Error {
  status: number
  code: string
  issues?: ApiErrorBody['issues']

  constructor(status: number, body: Partial<ApiErrorBody> | null) {
    super(body?.message || body?.error || `请求失败（${status}）`)
    this.name = 'ApiError'
    this.status = status
    this.code = body?.error || 'request_failed'
    this.issues = body?.issues
  }
}

export function getAuthToken(): string | null {
  return memoryToken
}

export function setAuthToken(token: string | null): void {
  memoryToken = token
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

function handleUnauthorized(): void {
  setAuthToken(null)
  window.dispatchEvent(new CustomEvent('multipush:unauthorized'))
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!(init.body instanceof FormData) && init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (memoryToken) headers.set('Authorization', `Bearer ${memoryToken}`)

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  } catch {
    throw new ApiError(0, { error: 'network_error', message: '网络连接失败，请确认服务已启动。' })
  }

  if (response.status === 204) return undefined as T

  const contentType = response.headers.get('content-type') || ''
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '')

  if (!response.ok) {
    if (response.status === 401 && memoryToken) handleUnauthorized()
    if (typeof body === 'string' && body) {
      throw new ApiError(response.status, { error: 'request_failed', message: body })
    }
    throw new ApiError(response.status, body as Partial<ApiErrorBody> | null)
  }

  return body as T
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

function uploadWithProgress<T>(path: string, file: File, onProgress?: (percent: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}${path}`)
    if (memoryToken) xhr.setRequestHeader('Authorization', `Bearer ${memoryToken}`)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onerror = () => reject(new ApiError(0, { error: 'network_error', message: '上传失败，请检查网络连接。' }))
    xhr.onload = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T)
        return
      }
      if (xhr.status === 401) handleUnauthorized()
      reject(new ApiError(xhr.status, body as Partial<ApiErrorBody> | null))
    }
    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

export const api = {
  health: () => request<ApiHealth>('/api/health'),

  auth: {
    register: (input: RegisterInput) =>
      request<AuthResponse>('/api/auth/register', { method: 'POST', body: JSON.stringify(input) }),
    login: (input: LoginInput) =>
      request<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) }),
    me: () => request<{ user: User }>('/api/auth/me'),
    updateProfile: (input: { displayName?: string; avatarUrl?: string | null }) =>
      request<{ user: User }>('/api/auth/me', { method: 'PATCH', body: JSON.stringify(input) }),
    changePassword: (input: { currentPassword: string; newPassword: string }) =>
      request<{ ok: true }>('/api/auth/password', { method: 'POST', body: JSON.stringify(input) }),
  },

  books: {
    list: () => request<{ books: Book[] }>('/api/books'),
    create: (input: BookInput) =>
      request<{ book: Book }>('/api/books', { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, input: Partial<BookInput>) =>
      request<{ book: Book }>(`/api/books/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    remove: (id: string) => request<{ ok: true }>(`/api/books/${id}`, { method: 'DELETE' }),
  },

  contents: {
    list: (query: ContentListQuery = {}) =>
      request<ContentListResult>(
        `/api/contents${qs({
          bookId: query.bookId,
          favorite: query.favorite,
          trash: query.trash,
          q: query.q,
          sort: query.sort,
          page: query.page,
          pageSize: query.pageSize,
        })}`,
      ),
    get: (id: string) => request<{ content: ContentDetail }>(`/api/contents/${id}`),
    create: (input: ContentInput = {}) =>
      request<{ content: ContentDetail }>('/api/contents', { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, input: ContentInput) =>
      request<{ content: ContentDetail }>(`/api/contents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    remove: (id: string, permanent = false) =>
      request<{ ok: true }>(`/api/contents/${id}${qs({ permanent })}`, { method: 'DELETE' }),
    restore: (id: string) =>
      request<{ content: ContentSummary }>(`/api/contents/${id}/restore`, { method: 'POST' }),
    duplicate: (id: string) =>
      request<{ content: ContentDetail }>(`/api/contents/${id}/duplicate`, { method: 'POST' }),
    setFavorite: (id: string, favorite: boolean) =>
      request<{ content: ContentSummary }>(`/api/contents/${id}/favorite`, {
        method: 'POST',
        body: JSON.stringify({ favorite }),
      }),
  },

  media: {
    upload: (file: File, onProgress?: (percent: number) => void) =>
      uploadWithProgress<{ media: MediaAsset }>('/api/media', file, onProgress),
    list: () => request<{ media: MediaAsset[] }>('/api/media'),
    remove: (id: string) => request<{ ok: true }>(`/api/media/${id}`, { method: 'DELETE' }),
  },

  platforms: {
    list: () => request<{ platforms: PlatformInfo[] }>('/api/platforms'),
  },

  renders: {
    adjust: (id: string, platform: PlatformId, input: PlatformAdjustment) => request<{ result: PlatformRender }>(`/api/renders/${id}/platforms/${platform}`, { method: 'PATCH', body: JSON.stringify(input) }),
    reset: (id: string, platform: PlatformId) => request<{ result: PlatformRender }>(`/api/renders/${id}/platforms/${platform}`, { method: 'DELETE' }),
    create: (input: RenderRequest) =>
      request<{ render: RenderRecord }>('/api/renders', { method: 'POST', body: JSON.stringify(input) }),
    list: (contentId?: string) =>
      request<{ renders: RenderListItem[] }>(`/api/renders${qs({ contentId })}`),
    get: (id: string) => request<{ render: RenderRecord }>(`/api/renders/${id}`),
    remove: (id: string) => request<{ ok: true }>(`/api/renders/${id}`, { method: 'DELETE' }),
  },
}

export function isPlatformId(value: string): value is PlatformId {
  return value === 'wechat' || value === 'xiaohongshu' || value === 'zhihu' || value === 'douyin'
}

/** Make an uploaded relative URL absolute for previews / rendering. */
export function absoluteUrl(url: string): string {
  if (!url) return url
  if (/^(https?:|data:|blob:)/i.test(url)) return url
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`
}
