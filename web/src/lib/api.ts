import type {
  ApiErrorBody,
  ApiHealth,
  AuthResponse,
  Book,
  BilibiliAccount,
  BilibiliLogin,
  BilibiliPartition,
  BilibiliPublication,
  BilibiliPublishInput,
  BilibiliResolveInput,
  BookInput,
  ContentDetail,
  ContentInput,
  ContentListQuery,
  ContentListResult,
  ContentSummary,
  LoginInput,
  MediaAsset,
  MediaFolder,
  MediaKind,
  MediaListResult,
  MediaStats,
  PlatformInfo,
  PublicationDeletion,
  PlatformId,
  RegisterInput,
  RenderListItem,
  RenderRecord,
  RenderRequest,
  PlatformAdjustment,
  PlatformRender,
  User,
  VideoCapability,
  VideoClipInput,
  VideoExport,
  VideoProject,
  VideoStudioProject,
  WechatAccount,
  WechatLogin,
  WechatPublication,
  WechatPublishInput,
  WechatpicAccount,
  WechatpicConnectInput,
  WechatpicPublication,
  WechatpicPublishInput,
  ToutiaoAccount,
  ToutiaoLogin,
  ToutiaoPublication,
  ToutiaoPublishInput,
  BaijiahaoAccount,
  BaijiahaoLogin,
  BaijiahaoPublication,
  BaijiahaoPublishInput,
  BaijiahaoResolveInput,
  DoubanAccount,
  DoubanLogin,
  DoubanPublication,
  DoubanPublishInput,
  DoubanResolveInput,
  JuejinAccount,
  JuejinLogin,
  JuejinPublication,
  JuejinPublishInput,
  JuejinResolveInput,
  CsdnAccount,
  CsdnLogin,
  CsdnPublication,
  CsdnPublishInput,
  CsdnResolveInput,
  JianshuAccount,
  JianshuConnectInput,
  JianshuPublication,
  JianshuPublishInput,
  JianshuResolveInput,
  V2exAccount,
  V2exConnectInput,
  V2exNode,
  V2exPublication,
  V2exPublishInput,
  V2exResolveInput,
  ToutiaoResolveInput,
  WeiboAccount,
  WeiboLogin,
  WeiboPublication,
  WeiboPublishInput,
  WeiboResolveInput,
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
  SspaiAccount,
  SspaiLogin,
  SspaiPublication,
  SspaiPublishInput,
  SspaiResolveInput,
  BlogAccount,
  BlogConnectInput,
  BlogPublication,
  BlogPublishInput,
  BlogResolveInput,
  AiChatResult,
  AiGatewayStatus,
  AiProbeResult,
  AiProviderPoolInput,
  AiProviderPoolView,
  AiRoutingInfo,
  AiSendMessageInput,
  AiSession,
  AiSessionDetail,
  AiSettings,
  AiSettingsInput,
  BatchJob,
  BatchPublishInput,
  BatchRenderInput,
  SmsLogin,
  SmsLoginPlatform,
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

function uploadWithProgress<T>(
  path: string,
  file: File,
  onProgress?: (percent: number) => void,
  fields?: Record<string, string>,
): Promise<T> {
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
    for (const [name, value] of Object.entries(fields ?? {})) form.append(name, value)
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
          kind: query.kind,
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
    upload: (file: File, onProgress?: (percent: number) => void, folderId?: string | null) =>
      uploadWithProgress<{ media: MediaAsset }>(
        '/api/media',
        file,
        onProgress,
        folderId ? { folderId } : undefined,
      ),
    list: (query: { kind?: MediaKind; q?: string; folderId?: string; page?: number; pageSize?: number } = {}) =>
      request<MediaListResult>(
        `/api/media${qs({
          kind: query.kind,
          q: query.q,
          folderId: query.folderId,
          page: query.page,
          pageSize: query.pageSize,
        })}`,
      ),
    stats: (query: { folderId?: string } = {}) =>
      request<{ stats: MediaStats }>(`/api/media/stats${qs({ folderId: query.folderId })}`),
    folders: () => request<{ folders: MediaFolder[] }>('/api/media/folders'),
    createFolder: (name: string) =>
      request<{ folder: MediaFolder }>('/api/media/folders', { method: 'POST', body: JSON.stringify({ name }) }),
    renameFolder: (id: string, name: string) =>
      request<{ folder: MediaFolder }>(`/api/media/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    removeFolder: (id: string) =>
      request<{ ok: true; moved: number }>(`/api/media/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    move: (id: string, folderId: string | null) =>
      request<{ media: MediaAsset }>(`/api/media/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ folderId }),
      }),
    probe: (id: string) => request<{ probe: { duration: number | null; width: number | null; height: number | null; hasAudio: boolean; videoCodec: string | null; audioCodec: string | null; fps: number | null; formatName: string | null } }>(`/api/media/${encodeURIComponent(id)}/probe`),
    remove: (id: string) => request<{ ok: true }>(`/api/media/${id}`, { method: 'DELETE' }),
  },

  video: {
    getProject: (contentId: string) =>
      request<{ project: VideoProject; capability: VideoCapability }>(`/api/contents/${encodeURIComponent(contentId)}/video`, { cache: 'no-store' }),
    saveTimeline: (contentId: string, clips: VideoClipInput[]) =>
      request<{ project: VideoProject }>(`/api/contents/${encodeURIComponent(contentId)}/video/timeline`, {
        method: 'PUT',
        body: JSON.stringify({ clips }),
      }),
    getStudio: (contentId: string) =>
      request<{ project: VideoStudioProject; capability: VideoCapability }>(`/api/contents/${encodeURIComponent(contentId)}/video/studio`, { cache: 'no-store' }),
    saveStudio: (contentId: string, project: Record<string, unknown>, clips: VideoClipInput[]) =>
      request<{ project: VideoStudioProject }>(`/api/contents/${encodeURIComponent(contentId)}/video/studio`, {
        method: 'PUT',
        body: JSON.stringify({ project, clips }),
      }),
    createExport: (contentId: string, source: 'timeline' | 'materials' = 'timeline') =>
      request<{ export: VideoExport }>(`/api/contents/${encodeURIComponent(contentId)}/video/export`, { method: 'POST', body: JSON.stringify({ source }) }),
    listExports: (contentId: string) =>
      request<{ exports: VideoExport[] }>(`/api/contents/${encodeURIComponent(contentId)}/video/exports`, { cache: 'no-store' }),
    getExport: (exportId: string) =>
      request<{ export: VideoExport }>(`/api/video-exports/${encodeURIComponent(exportId)}`, { cache: 'no-store' }),
    deleteExport: (exportId: string) =>
      request<{ ok: true }>(`/api/video-exports/${encodeURIComponent(exportId)}`, { method: 'DELETE' }),
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
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/wechat/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  wechatpic: {
    account: () => request<{ account: WechatpicAccount }>('/api/wechatpic/account', { cache: 'no-store' }),
    connect: (input: WechatpicConnectInput) => request<{ account: WechatpicAccount }>('/api/wechatpic/connect', { method: 'POST', body: JSON.stringify(input) }),
    disconnect: () => request<{ ok: true }>('/api/wechatpic/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: WechatpicPublication[] }>('/api/wechatpic/publications', { cache: 'no-store' }),
    publish: (input: WechatpicPublishInput) => request<{ publication: WechatpicPublication }>('/api/wechatpic/publications', { method: 'POST', body: JSON.stringify(input) }),
    getPublication: (id: string) => request<{ publication: WechatpicPublication }>(`/api/wechatpic/publications/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/wechatpic/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  zhihu: {
    resolve: (id: string, input: ZhihuResolveInput) => request<{ publication: ZhihuPublication }>(`/api/zhihu/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: ZhihuAccount }>('/api/zhihu/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: ZhihuLogin }>('/api/zhihu/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: ZhihuLogin }>(`/api/zhihu/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/zhihu/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: ZhihuPublication[] }>('/api/zhihu/publications', { cache: 'no-store' }),
    publish: (input: ZhihuPublishInput) => request<{ publication: ZhihuPublication }>('/api/zhihu/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/zhihu/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  toutiao: {
    resolve: (id: string, input: ToutiaoResolveInput) => request<{ publication: ToutiaoPublication }>(`/api/toutiao/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: ToutiaoAccount }>('/api/toutiao/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: ToutiaoLogin }>('/api/toutiao/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: ToutiaoLogin }>(`/api/toutiao/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/toutiao/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: ToutiaoPublication[] }>('/api/toutiao/publications', { cache: 'no-store' }),
    publish: (input: ToutiaoPublishInput) => request<{ publication: ToutiaoPublication }>('/api/toutiao/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/toutiao/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  baijiahao: {
    resolve: (id: string, input: BaijiahaoResolveInput) => request<{ publication: BaijiahaoPublication }>(`/api/baijiahao/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: BaijiahaoAccount }>('/api/baijiahao/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: BaijiahaoLogin }>('/api/baijiahao/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: BaijiahaoLogin }>(`/api/baijiahao/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/baijiahao/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: BaijiahaoPublication[] }>('/api/baijiahao/publications', { cache: 'no-store' }),
    publish: (input: BaijiahaoPublishInput) => request<{ publication: BaijiahaoPublication }>('/api/baijiahao/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/baijiahao/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  douban: {
    resolve: (id: string, input: DoubanResolveInput) => request<{ publication: DoubanPublication }>(`/api/douban/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: DoubanAccount }>('/api/douban/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: DoubanLogin }>('/api/douban/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: DoubanLogin }>(`/api/douban/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/douban/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: DoubanPublication[] }>('/api/douban/publications', { cache: 'no-store' }),
    publish: (input: DoubanPublishInput) => request<{ publication: DoubanPublication }>('/api/douban/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/douban/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  juejin: {
    resolve: (id: string, input: JuejinResolveInput) => request<{ publication: JuejinPublication }>(`/api/juejin/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: JuejinAccount }>('/api/juejin/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: JuejinLogin }>('/api/juejin/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: JuejinLogin }>(`/api/juejin/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/juejin/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: JuejinPublication[] }>('/api/juejin/publications', { cache: 'no-store' }),
    publish: (input: JuejinPublishInput) => request<{ publication: JuejinPublication }>('/api/juejin/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/juejin/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  csdn: {
    resolve: (id: string, input: CsdnResolveInput) => request<{ publication: CsdnPublication }>(`/api/csdn/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: CsdnAccount }>('/api/csdn/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: CsdnLogin }>('/api/csdn/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: CsdnLogin }>(`/api/csdn/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/csdn/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: CsdnPublication[] }>('/api/csdn/publications', { cache: 'no-store' }),
    publish: (input: CsdnPublishInput) => request<{ publication: CsdnPublication }>('/api/csdn/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/csdn/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  jianshu: {
    resolve: (id: string, input: JianshuResolveInput) => request<{ publication: JianshuPublication }>(`/api/jianshu/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: JianshuAccount }>('/api/jianshu/account', { cache: 'no-store' }),
    connect: (input: JianshuConnectInput) => request<{ account: JianshuAccount }>('/api/jianshu/connect', { method: 'POST', body: JSON.stringify(input) }),
    disconnect: () => request<{ ok: true }>('/api/jianshu/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: JianshuPublication[] }>('/api/jianshu/publications', { cache: 'no-store' }),
    publish: (input: JianshuPublishInput) => request<{ publication: JianshuPublication }>('/api/jianshu/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/jianshu/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  bilibili: {
    account: () => request<{ account: BilibiliAccount }>('/api/bilibili/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: BilibiliLogin }>('/api/bilibili/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: BilibiliLogin }>(`/api/bilibili/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/bilibili/account', { method: 'DELETE' }),
    partitions: () => request<{ partitions: BilibiliPartition[] }>('/api/bilibili/partitions', { cache: 'no-store' }),
    listPublications: () => request<{ publications: BilibiliPublication[] }>('/api/bilibili/publications', { cache: 'no-store' }),
    getPublication: (id: string) => request<{ publication: BilibiliPublication }>(`/api/bilibili/publications/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    removePublication: (id: string) => request<{ ok: true }>(`/api/bilibili/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    publish: (input: BilibiliPublishInput) => request<{ publication: BilibiliPublication }>('/api/bilibili/publications', { method: 'POST', body: JSON.stringify(input) }),
    resolve: (id: string, input: BilibiliResolveInput) => request<{ publication: BilibiliPublication }>(`/api/bilibili/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
  },

  v2ex: {
    resolve: (id: string, input: V2exResolveInput) => request<{ publication: V2exPublication }>(`/api/v2ex/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: V2exAccount }>('/api/v2ex/account', { cache: 'no-store' }),
    connect: (input: V2exConnectInput) => request<{ account: V2exAccount }>('/api/v2ex/connect', { method: 'POST', body: JSON.stringify(input) }),
    disconnect: () => request<{ ok: true }>('/api/v2ex/account', { method: 'DELETE' }),
    nodes: () => request<{ nodes: V2exNode[] }>('/api/v2ex/nodes', { cache: 'no-store' }),
    listPublications: () => request<{ publications: V2exPublication[] }>('/api/v2ex/publications', { cache: 'no-store' }),
    publish: (input: V2exPublishInput) => request<{ publication: V2exPublication }>('/api/v2ex/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/v2ex/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  weibo: {
    resolve: (id: string, input: WeiboResolveInput) => request<{ publication: WeiboPublication }>(`/api/weibo/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: WeiboAccount }>('/api/weibo/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: WeiboLogin }>('/api/weibo/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: WeiboLogin }>(`/api/weibo/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/weibo/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: WeiboPublication[] }>('/api/weibo/publications', { cache: 'no-store' }),
    publish: (input: WeiboPublishInput) => request<{ publication: WeiboPublication }>('/api/weibo/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/weibo/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  xiaohongshu: {
    resolve: (id: string, input: XhsResolveInput) => request<{ publication: XhsPublication }>(`/api/xiaohongshu/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: XhsAccount }>('/api/xiaohongshu/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: XhsLogin }>('/api/xiaohongshu/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: XhsLogin }>(`/api/xiaohongshu/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/xiaohongshu/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: XhsPublication[] }>('/api/xiaohongshu/publications', { cache: 'no-store' }),
    publish: (input: XhsPublishInput) => request<{ publication: XhsPublication }>('/api/xiaohongshu/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/xiaohongshu/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  douyin: {
    resolve: (id: string, input: DouyinResolveInput) => request<{ publication: DouyinPublication }>(`/api/douyin/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: DouyinAccount }>('/api/douyin/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: DouyinLogin }>('/api/douyin/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: DouyinLogin }>(`/api/douyin/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/douyin/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: DouyinPublication[] }>('/api/douyin/publications', { cache: 'no-store' }),
    publish: (input: DouyinPublishInput) => request<{ publication: DouyinPublication }>('/api/douyin/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/douyin/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  sspai: {
    resolve: (id: string, input: SspaiResolveInput) => request<{ publication: SspaiPublication }>(`/api/sspai/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: SspaiAccount }>('/api/sspai/account', { cache: 'no-store' }),
    startLogin: () => request<{ login: SspaiLogin }>('/api/sspai/login', { method: 'POST' }),
    loginStatus: (id: string) => request<{ login: SspaiLogin }>(`/api/sspai/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    disconnect: () => request<{ ok: true }>('/api/sspai/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: SspaiPublication[] }>('/api/sspai/publications', { cache: 'no-store' }),
    publish: (input: SspaiPublishInput) => request<{ publication: SspaiPublication }>('/api/sspai/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/sspai/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  blog: {
    resolve: (id: string, input: BlogResolveInput) => request<{ publication: BlogPublication }>(`/api/blog/publications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    account: () => request<{ account: BlogAccount }>('/api/blog/account', { cache: 'no-store' }),
    connect: (input: BlogConnectInput) => request<{ account: BlogAccount }>('/api/blog/connect', { method: 'POST', body: JSON.stringify(input) }),
    disconnect: () => request<{ ok: true }>('/api/blog/account', { method: 'DELETE' }),
    listPublications: () => request<{ publications: BlogPublication[] }>('/api/blog/publications', { cache: 'no-store' }),
    publish: (input: BlogPublishInput) => request<{ publication: BlogPublication }>('/api/blog/publications', { method: 'POST', body: JSON.stringify(input) }),
    deletePublication: (id: string) => request<PublicationDeletion>(`/api/blog/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  ai: {
    settings: () => request<{ settings: AiSettings }>('/api/ai/settings', { cache: 'no-store' }),
    saveSettings: (input: AiSettingsInput) => request<{ settings: AiSettings }>('/api/ai/settings', { method: 'PUT', body: JSON.stringify(input) }),
    deleteSettings: () => request<{ ok: true }>('/api/ai/settings', { method: 'DELETE' }),
    testSettings: () => request<{ ok: true; message: string; model: string; routing?: AiRoutingInfo }>('/api/ai/settings/test', { method: 'POST' }),
    providers: () => request<{ pool: AiProviderPoolView }>('/api/ai/providers', { cache: 'no-store' }),
    saveProviders: (input: AiProviderPoolInput) => request<{ pool: AiProviderPoolView }>('/api/ai/providers', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
    gatewayStatus: () => request<{ gateway: AiGatewayStatus }>('/api/ai/gateway', { cache: 'no-store' }),
    probeGateway: (providerId?: string) => request<{ probes: AiProbeResult[]; gateway: AiGatewayStatus }>('/api/ai/gateway/probe', {
      method: 'POST',
      body: JSON.stringify(providerId ? { providerId } : {}),
    }),
    listSessions: () => request<{ sessions: AiSession[] }>('/api/ai/sessions', { cache: 'no-store' }),
    createSession: (title?: string) => request<{ session: AiSession }>('/api/ai/sessions', { method: 'POST', body: JSON.stringify({ ...(title ? { title } : {}) }) }),
    getSession: (id: string) => request<{ session: AiSessionDetail }>(`/api/ai/sessions/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    deleteSession: (id: string) => request<{ ok: true }>(`/api/ai/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    sendMessage: (id: string, input: AiSendMessageInput) => request<AiChatResult>(`/api/ai/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(input) }),
  },

  platformSms: {
    start: (platform: SmsLoginPlatform, phone: string) =>
      request<{ login: SmsLogin }>(`/api/platform-sms/${platform}/start`, {
        method: 'POST',
        body: JSON.stringify({ phone }),
      }),
    verify: (platform: SmsLoginPlatform, id: string, code: string) =>
      request<{ login: SmsLogin }>(`/api/platform-sms/${platform}/${encodeURIComponent(id)}/verify`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
    cancel: (platform: SmsLoginPlatform, id: string) =>
      request<{ ok: true }>(`/api/platform-sms/${platform}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  batch: {
    listJobs: () => request<{ jobs: BatchJob[] }>('/api/batch/jobs', { cache: 'no-store' }),
    getJob: (id: string) => request<{ job: BatchJob }>(`/api/batch/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    render: (input: BatchRenderInput) => request<{ job: BatchJob }>('/api/batch/render', { method: 'POST', body: JSON.stringify(input) }),
    publish: (input: BatchPublishInput) => request<{ job: BatchJob }>('/api/batch/publish', { method: 'POST', body: JSON.stringify(input) }),
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
  return value === 'wechat' || value === 'wechatpic' || value === 'xiaohongshu' || value === 'zhihu' || value === 'weibo' || value === 'toutiao' || value === 'baijiahao' || value === 'douban' || value === 'juejin' || value === 'csdn' || value === 'jianshu' || value === 'douyin' || value === 'sspai' || value === 'blog'
}

/** Make an uploaded relative URL absolute for previews / rendering. */
export function absoluteUrl(url: string): string {
  if (!url) return url
  if (/^(https?:|data:|blob:)/i.test(url)) return url
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`
}
