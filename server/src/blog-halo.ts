import { load } from 'cheerio'
import { ApiError } from './errors'
import { blogEditorContent, blogImagePath, blogSlug, verifyBlogContent } from './blog-content'
import type { PublisherImage } from './publisher-image'
import type { BlogPublication } from '../../shared/types'

export interface BlogCredentials {
  baseUrl: string
  token: string
}

export interface HaloUser {
  metadata: { name: string }
  spec: { displayName?: string; email?: string }
}

export interface HaloPost {
  apiVersion: string
  kind: string
  metadata: { name?: string; generateName?: string; labels?: Record<string, string>; annotations?: Record<string, string> }
  spec: {
    allowComment: boolean
    categories: string[]
    cover: string
    deleted: boolean
    excerpt: { autoGenerate: boolean; raw: string }
    htmlMetas: Array<Record<string, string>>
    pinned: boolean
    priority: number
    publish: boolean
    publishTime?: string
    slug: string
    tags: string[]
    template: string
    title: string
    visible: 'PUBLIC' | 'INTERNAL' | 'PRIVATE'
  }
  status?: { phase?: string; permalink?: string }
}

export interface HaloContent {
  content: string
  raw: string
  rawType: string
}

export interface HaloPostRequest {
  post: HaloPost
  content: HaloContent & { version?: number }
}

export interface HaloContentWrapper extends HaloContent { snapshotName?: string }

export interface HaloAttachment {
  apiVersion: string
  kind: string
  metadata: { name: string; annotations?: Record<string, string> }
  spec: { displayName?: string; mediaType?: string; size?: number; policyName?: string }
  status?: { permalink?: string; thumbnails?: Record<string, string> }
}

export interface HaloTag {
  metadata: { name: string }
  spec: { displayName: string }
}

type Json = Record<string, unknown>

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

export function normalizeBlogBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new ApiError(400, 'blog_url_invalid', '请输入个人博客地址')
  let url: URL
  try { url = new URL(trimmed) } catch { throw new ApiError(400, 'blog_url_invalid', '博客地址格式不正确，请填写完整的 http(s) 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ApiError(400, 'blog_url_invalid', '博客地址必须是 http(s) 地址，且不能包含用户名或密码')
  if (url.search || url.hash) throw new ApiError(400, 'blog_url_invalid', '博客地址不能包含查询参数或锚点')
  if (url.hostname === '169.254.169.254' || url.hostname === 'metadata.google.internal' || url.hostname === '0.0.0.0') throw new ApiError(400, 'blog_url_invalid', '不允许连接该地址')
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href.replace(/\/+$/, '')
}

/**
 * Follow the public homepage once to capture a canonical host such as
 * yuan-xin.top -> www.yuan-xin.top. Cross-host redirects drop the Authorization
 * header, so the connection must use the final origin directly.
 */
export async function canonicalBlogBaseUrl(input: string): Promise<string> {
  const normalized = normalizeBlogBaseUrl(input)
  try {
    const response = await fetch(`${normalized}/`, { redirect: 'follow', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15_000) })
    const final = new URL(response.url)
    if (!['http:', 'https:'].includes(final.protocol) || final.username || final.password) return normalized
    const original = new URL(normalized)
    if (final.origin === original.origin) return normalized
    const finalPath = final.pathname.replace(/\/+$/, '')
    if (finalPath && finalPath !== original.pathname.replace(/\/+$/, '')) return normalized
    return normalizeBlogBaseUrl(`${final.origin}${finalPath}`)
  } catch {
    return normalized
  }
}

export class HaloClient {
  readonly baseUrl: string
  private readonly token: string

  constructor(credentials: BlogCredentials) {
    this.baseUrl = normalizeBlogBaseUrl(credentials.baseUrl)
    this.token = credentials.token.trim()
    if (!this.token) throw new ApiError(400, 'blog_token_invalid', '请输入 Halo 个人令牌')
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.token}`)
    headers.set('Accept', 'application/json')
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) })
    } catch (error) {
      throw new ApiError(502, 'blog_unreachable', `无法连接个人博客：${error instanceof Error ? error.message : '网络错误'}`)
    }
    if (response.status === 401 || response.status === 403) throw new ApiError(409, 'blog_auth_failed', '个人博客令牌无效或权限不足，请重新连接')
    if (response.status === 404) throw new ApiError(404, 'blog_not_found', '个人博客接口不存在或文章已删除')
    if (response.status === 204) return undefined as T
    if (!/json/i.test(response.headers.get('content-type') || '')) throw new ApiError(502, 'blog_bad_response', '个人博客返回了非接口页面，请确认地址指向 Halo 2.x 站点且未被重定向到登录页')
    const text = await response.text()
    let payload: unknown = null
    try { payload = text ? JSON.parse(text) : null } catch { payload = null }
    if (!response.ok) {
      const detail = typeof object(payload).detail === 'string' ? object(payload).detail : typeof object(payload).title === 'string' ? object(payload).title : ''
      throw new ApiError(502, 'blog_rejected', `个人博客请求失败${detail ? `：${detail}` : `（HTTP ${response.status}）`}`)
    }
    return (payload ?? undefined) as T
  }

  async currentUser(): Promise<HaloUser> {
    const response = await this.request<{ user?: HaloUser }>('/apis/api.console.halo.run/v1alpha1/users/-')
    const user = response?.user
    if (!user?.metadata?.name) throw new ApiError(502, 'blog_bad_response', '个人博客没有返回有效用户信息')
    return user
  }

  async getPost(name: string): Promise<HaloPost> {
    return this.request<HaloPost>(`/apis/content.halo.run/v1alpha1/posts/${encodeURIComponent(name)}`)
  }

  async getHeadContent(name: string): Promise<HaloContentWrapper> {
    return this.request<HaloContentWrapper>(`/apis/api.console.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/head-content`)
  }

  async getReleaseContent(name: string): Promise<HaloContentWrapper> {
    return this.request<HaloContentWrapper>(`/apis/api.console.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/release-content`)
  }

  async createPost(request: HaloPostRequest): Promise<HaloPost> {
    return this.request<HaloPost>('/apis/api.console.halo.run/v1alpha1/posts', { method: 'POST', body: JSON.stringify(request) })
  }

  async updatePost(name: string, request: HaloPostRequest): Promise<HaloPost> {
    return this.request<HaloPost>(`/apis/api.console.halo.run/v1alpha1/posts/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(request) })
  }

  async updateContent(name: string, content: HaloContent): Promise<HaloPost> {
    return this.request<HaloPost>(`/apis/api.console.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/content`, { method: 'PUT', body: JSON.stringify(content) })
  }

  async publishPost(name: string): Promise<HaloPost> {
    return this.request<HaloPost>(`/apis/api.console.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/publish?async=false`, { method: 'PUT' })
  }

  async unpublishPost(name: string): Promise<HaloPost> {
    return this.request<HaloPost>(`/apis/api.console.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/unpublish`, { method: 'PUT' })
  }

  async recyclePost(name: string): Promise<void> {
    await this.request(`/apis/api.console.halo.run/v1alpha1/posts/${encodeURIComponent(name)}/recycle`, { method: 'PUT' })
  }

  async deletePost(name: string): Promise<void> {
    await this.request(`/apis/content.halo.run/v1alpha1/posts/${encodeURIComponent(name)}`, { method: 'DELETE' })
  }

  async uploadAttachment(image: PublisherImage): Promise<{ name: string; permalink: string }> {
    const form = new FormData()
    form.append('file', new Blob([image.buffer], { type: image.mimeType }), image.name)
    const attachment = await this.request<HaloAttachment>('/apis/console.api.storage.halo.run/v1alpha1/attachments/-/upload', { method: 'POST', body: form })
    let current = attachment
    let permalink = current?.status?.permalink || current?.metadata?.annotations?.['storage.halo.run/uri'] || ''
    if (!current?.metadata?.name) throw new ApiError(502, 'blog_attachment_failed', '个人博客没有返回有效附件信息，已停止发布')
    for (let attempt = 0; !permalink && attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      current = await this.request<HaloAttachment>(`/apis/storage.halo.run/v1alpha1/attachments/${encodeURIComponent(attachment.metadata.name)}`)
      permalink = current?.status?.permalink || current?.metadata?.annotations?.['storage.halo.run/uri'] || ''
    }
    if (!permalink) throw new ApiError(502, 'blog_attachment_failed', '个人博客附件尚未生成可访问地址，已停止发布')
    return { name: attachment.metadata.name, permalink }
  }

  async listTags(): Promise<HaloTag[]> {
    const response = await this.request<{ items?: HaloTag[] }>('/apis/content.halo.run/v1alpha1/tags?page=0&size=1000')
    return (response?.items || []).filter((tag) => tag.metadata?.name && tag.spec?.displayName)
  }

  async resolveTags(displayNames: string[]): Promise<{ names: string[]; unmatched: string[] }> {
    if (!displayNames.length) return { names: [], unmatched: [] }
    const tags = await this.listTags()
    const byName = new Map<string, string>()
    for (const tag of tags) {
      byName.set(tag.spec.displayName.trim().toLowerCase(), tag.metadata.name)
      byName.set(tag.metadata.name.trim().toLowerCase(), tag.metadata.name)
    }
    const names: string[] = [], unmatched: string[] = []
    for (const displayName of displayNames) {
      const name = byName.get(displayName.trim().toLowerCase())
      if (name) { if (!names.includes(name)) names.push(name) } else unmatched.push(displayName)
    }
    return { names, unmatched }
  }
}

export interface BlogIdentity { accountId: string; name: string }
export interface BlogArticle { title: string; html: string; tags: string[]; images: Map<string, PublisherImage>; cover?: PublisherImage; slugSeed: string }
export interface BlogDriver {
  checkSession(credentials: BlogCredentials): Promise<{ identity: BlogIdentity }>
  checkPublication(credentials: BlogCredentials, remoteId: string, title: string): Promise<{ status: 'published' | 'draft' | 'missing' | 'unknown'; url: string | null; message: string }>
  publish(credentials: BlogCredentials, article: BlogArticle, mode: 'draft' | 'publish', progress: (value: Partial<Pick<BlogPublication, 'message' | 'remoteId' | 'url'>>) => void, resumeId?: string): Promise<{ status: 'draft' | 'published'; remoteId: string; url: string; message: string }>
}

export class HaloBlogDriver implements BlogDriver {
  async checkSession(credentials: BlogCredentials): Promise<{ identity: BlogIdentity }> {
    try {
      const user = await new HaloClient(credentials).currentUser()
      return { identity: { accountId: user.metadata.name, name: user.spec?.displayName?.trim() || user.metadata.name } }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw new ApiError(400, 'blog_url_invalid', '该地址不是可访问的 Halo 2.x 站点，请检查博客地址')
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'blog_check_failed', '个人博客连接检查未完成，请检查地址和令牌')
    }
  }

  async checkPublication(credentials: BlogCredentials, remoteId: string, title: string) {
    const client = new HaloClient(credentials)
    let post: HaloPost
    try {
      post = await client.getPost(remoteId)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { status: 'missing' as const, url: null, message: '原个人博客文章不存在，请确认是否已删除；确认未发布后可重新创建' }
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'blog_check_failed', '重新核实个人博客结果未完成，请稍后重试或人工核实')
    }
    if (post.spec.title !== title) return { status: 'unknown' as const, url: null, message: '个人博客文章标题已变化，请到后台核对后选择人工核实结果' }
    const permalink = blogPostUrl(client.baseUrl, post.status?.permalink)
    if (post.spec.publish && post.status?.phase === 'PUBLISHED') return { status: 'published' as const, url: permalink, message: '已重新核实：个人博客确认该文章已发布' }
    if (!post.spec.publish && (!post.status?.phase || post.status.phase === 'DRAFT')) return { status: 'draft' as const, url: `${client.baseUrl}/console/posts/${remoteId}`, message: '个人博客仍有这份草稿。请确认未通过其他记录发布，再选择“已核实未发布，允许重试”' }
    return { status: 'unknown' as const, url: permalink, message: '个人博客文章状态暂无法确认，请到后台人工核对' }
  }

  async publish(credentials: BlogCredentials, article: BlogArticle, mode: 'draft' | 'publish', progress: Parameters<BlogDriver['publish']>[3], resumeId?: string) {
    const client = new HaloClient(credentials)
    let remoteId = resumeId || ''
    try {
      await client.currentUser()
      const $ = load(article.html, null, false)
      const uploaded = new Map<string, string>()
      progress({ message: '正在上传个人博客正文图片与封面' })
      for (const [src, image] of article.images) {
        const attachment = await client.uploadAttachment(image)
        uploaded.set(src, attachment.permalink)
      }
      for (const node of $('img').toArray()) {
        const src = $(node).attr('src') || ''
        if (blogImagePath(src, client.baseUrl)) continue
        const permalink = uploaded.get(src)
        if (!permalink) throw new ApiError(400, 'blog_external_image', '正文仍含未上传到个人博客的图片，已停止发布')
        $(node).attr('src', permalink)
      }
      let cover = ''
      if (article.cover) cover = (await client.uploadAttachment(article.cover)).permalink
      const body = blogEditorContent($.html())
      const ready = load(body, null, false)
      if (ready('img').toArray().some((node) => !blogImagePath(ready(node).attr('src') || '', client.baseUrl))) throw new ApiError(400, 'blog_external_image', '正文仍含未上传到个人博客的图片，已停止发布')
      const resolvedTags = await client.resolveTags(article.tags)
      const content = { raw: body, content: body, rawType: 'HTML' }
      let post: HaloPost
      if (resumeId) {
        progress({ message: '正在恢复已有个人博客草稿', remoteId, url: `${client.baseUrl}/console/posts/${remoteId}` })
        try {
          post = await client.getPost(remoteId)
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) throw new ApiError(409, 'blog_draft_missing', '原个人博客草稿已不存在，请核实发布结果；确认未发布后可重新创建')
          throw error
        }
        if (post.spec.title !== article.title) throw new ApiError(409, 'blog_draft_changed', '已有个人博客草稿标题已变更，已停止重试，请到博客后台核对')
        if (post.spec.publish && post.status?.phase === 'PUBLISHED') {
          return { status: 'published' as const, remoteId, url: blogPostUrl(client.baseUrl, post.status.permalink)!, message: '个人博客该文章已发布，已关联原文章，未重复提交' }
        }
        if (post.status?.phase !== 'DRAFT' && post.status?.phase !== undefined) throw new ApiError(409, 'blog_draft_changed', '已有个人博客文章状态已变更，已停止重试，请到博客后台核对')
        if (post.spec.publish) throw new ApiError(409, 'blog_draft_changed', '已有个人博客文章已提交发布，已停止重试，请到博客后台核对')
        progress({ message: '正在保存个人博客正文', remoteId, url: `${client.baseUrl}/console/posts/${remoteId}` })
        post = await client.updatePost(remoteId, {
          post: { ...post, status: undefined, spec: { ...post.spec, title: article.title, cover: cover || post.spec.cover, tags: resolvedTags.names, publish: false } },
          content,
        })
      } else {
        progress({ message: '正在创建个人博客草稿' })
        post = await client.createPost({
          post: {
            apiVersion: 'content.halo.run/v1alpha1',
            kind: 'Post',
            metadata: { generateName: 'post-', labels: {} },
            spec: {
              allowComment: true,
              categories: [],
              cover,
              deleted: false,
              excerpt: { autoGenerate: true, raw: '' },
              htmlMetas: [],
              pinned: false,
              priority: 0,
              publish: false,
              slug: blogSlug(article.title, article.slugSeed),
              tags: resolvedTags.names,
              template: '',
              title: article.title,
              visible: 'PUBLIC',
            },
          },
          content,
        })
        if (!post.metadata?.name) throw new ApiError(502, 'blog_draft_unverified', '个人博客未返回有效文章编号，请检查草稿箱，避免重复创建')
        remoteId = post.metadata.name
      }
      progress({ message: '已创建或更新个人博客草稿', remoteId, url: `${client.baseUrl}/console/posts/${remoteId}` })
      if (mode === 'draft') {
        const head = await client.getHeadContent(remoteId)
        verifyBlogContent(body, head.content)
        return { status: 'draft' as const, remoteId, url: `${client.baseUrl}/console/posts/${remoteId}`, message: '已保存个人博客草稿，并核对标题、正文、图片与链接' }
      }
      progress({ message: '正在发布个人博客文章', remoteId, url: `${client.baseUrl}/console/posts/${remoteId}` })
      await client.publishPost(remoteId)
      let published = post
      for (let attempt = 0; attempt < 30; attempt++) {
        published = await client.getPost(remoteId)
        if (published.spec.publish && published.status?.phase === 'PUBLISHED') break
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      if (!published.spec.publish || published.status?.phase !== 'PUBLISHED' || !published.status.permalink) throw new ApiError(502, 'blog_publish_unverified', '个人博客尚未确认文章发布状态，请到博客后台核实，避免重复发布')
      const release = await client.getReleaseContent(remoteId)
      verifyBlogContent(body, release.content)
      return { status: 'published' as const, remoteId, url: blogPostUrl(client.baseUrl, published.status.permalink)!, message: '已发布到个人博客，并核对文章内容与发布状态；未匹配的标签未写入博客' }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : ''
      if (remoteId && !['blog_auth_failed', 'blog_not_found', 'blog_draft_missing', 'blog_draft_changed', 'blog_content_mismatch', 'blog_publish_unverified'].includes(code)) throw new ApiError(502, 'blog_result_uncertain', '个人博客草稿可能已创建，但后续步骤失败；请先查看博客草稿，避免重复发布')
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'blog_preparation_failed', remoteId ? '个人博客操作中断，已保留草稿，请在博客后台检查' : '个人博客准备步骤失败，尚未提交文章，请检查网络后重试')
    }
  }
}

export function blogPostUrl(baseUrl: string, permalink: string | null | undefined): string | null {
  if (!permalink) return null
  if (/^https?:\/\//i.test(permalink)) return permalink
  return `${baseUrl.replace(/\/+$/, '')}${permalink.startsWith('/') ? '' : '/'}${permalink}`
}
