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
  WechatAccount,
  WechatLogin,
  WechatPublication,
  WechatPublishInput,
  XhsAccount,
  DouyinAccount, DouyinLogin, DouyinPublication, DouyinPublishInput, DouyinResolveInput,
  XhsLogin,
  XhsPublication,
  XhsPublishInput,
  XhsResolveInput,
  ZhihuAccount,
  ZhihuLogin,
  ZhihuPublication,
  ZhihuPublishInput,
  ZhihuResolveInput,
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
      throw new ApiError(response.status, { error: 'gateway_error', message: `服务连接暂时异常（HTTP ${response.status}），请稍后重试。` })
    }
    throw new ApiError(response.status, body as Partial<ApiErrorBody> | null)
  }

  if (typeof body === 'string' || body === null) throw new ApiError(502, { error: 'invalid_response', message: '服务返回了无法识别的响应，请稍后重试。' })

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
    sendEmailCode: (email: string, purpose: 'register' | 'bind' | 'reset') =>
      request<{ ok: true }>('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email, purpose }) }),
    bindEmail: (email: string, code: string) =>
      request<{ user: User }>('/api/auth/bind-email', { method: 'POST', body: JSON.stringify({ email, code }) }),
    resetPassword: (email: string, code: string, newPassword: string) =>
      request<{ ok: true }>('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email, code, newPassword }) }),
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

  wechat: {
    account: () => request<{ account: WechatAccount }>('/api/wechat/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: WechatLogin }>('/api/wechat/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: WechatLogin }>(`/api/wechat/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/wechat/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: WechatPublication[] }>('/api/wechat/publications', { cache: 'no-store' }),
    publish: (input: WechatPublishInput) => request<{ publication: WechatPublication }>('/api/wechat/publications', { method: 'POST', body: JSON.stringify(input) }),
    getPublication: (id: string) => request<{ publication: WechatPublication }>(`/api/wechat/publications/${encodeURIComponent(id)}`, { cache: 'no-store' }),
  },

  zhihu: {
    resolve: (id: string, input: ZhihuResolveInput) => request<{ publication: ZhihuPublication }>(`/api/zhihu/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: ZhihuAccount }>('/api/zhihu/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: ZhihuLogin }>('/api/zhihu/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: ZhihuLogin }>(`/api/zhihu/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/zhihu/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: ZhihuPublication[] }>('/api/zhihu/publications', { cache: 'no-store' }),
    publish: (input: ZhihuPublishInput) => request<{ publication: ZhihuPublication }>('/api/zhihu/publications', { method: 'POST', body: JSON.stringify(input) }),
  },
  xiaohongshu: {
    resolve: (id: string, input: XhsResolveInput) => request<{ publication: XhsPublication }>(`/api/xiaohongshu/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: XhsAccount }>('/api/xiaohongshu/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: XhsLogin }>('/api/xiaohongshu/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: XhsLogin }>(`/api/xiaohongshu/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/xiaohongshu/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: XhsPublication[] }>('/api/xiaohongshu/publications', { cache: 'no-store' }),
    publish: (input: XhsPublishInput) => request<{ publication: XhsPublication }>('/api/xiaohongshu/publications', { method: 'POST', body: JSON.stringify(input) }),
  },
  douyin: {
    resolve: (id: string, input: DouyinResolveInput) => request<{ publication: DouyinPublication }>(`/api/douyin/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: DouyinAccount }>('/api/douyin/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: DouyinLogin }>('/api/douyin/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: DouyinLogin }>(`/api/douyin/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/douyin/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: DouyinPublication[] }>('/api/douyin/publications', { cache: 'no-store' }),
    publish: (input: DouyinPublishInput) => request<{ publication: DouyinPublication }>('/api/douyin/publications', { method: 'POST', body: JSON.stringify(input) }),
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
