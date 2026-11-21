import { createHash } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import type { V2exNode } from '../../shared/types'
import type { PublisherStorageState } from './publisher-session'
import { publisherExecutablePath } from './wechat-browser'
import { ApiError } from './errors'

export interface V2exIdentity {
  accountId: string
  name: string
}

export interface V2exArticle {
  title: string
  markdown: string
  nodeName: string
}

export interface V2exPublishResult {
  state: PublisherStorageState
  status: 'published'
  remoteId: string
  url: string
  message: string
}

export interface V2exDriver {
  connect(cookie: string): Promise<{ state: PublisherStorageState; identity: V2exIdentity }>
  checkSession(state: PublisherStorageState): Promise<{ state: PublisherStorageState; identity: V2exIdentity }>
  listNodes(state: PublisherStorageState): Promise<V2exNode[]>
  publish(
    state: PublisherStorageState,
    article: V2exArticle,
    progress: (value: { message: string }) => void,
  ): Promise<V2exPublishResult>
  checkPublication(
    state: PublisherStorageState,
    url: string,
    title: string,
  ): Promise<{ state: PublisherStorageState; status: 'published' | 'missing' | 'unknown'; url: string | null; message: string }>
  close(): Promise<void>
}

const HOME = 'https://www.v2ex.com/'
const NEW_TOPIC = 'https://www.v2ex.com/new'
const expired = () => new ApiError(409, 'v2ex_session_expired', 'V2EX 登录状态已失效，请重新复制 Cookie 连接')
const uncertain = (message: string) => new ApiError(502, 'v2ex_result_uncertain', message)

function log(...parts: unknown[]): void {
  console.log('[v2ex]', ...parts)
}

/** Parse a Cookie request header into Playwright cookie objects. */
export function parseV2exCookies(header: string): Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite: 'Lax' }> {
  const cookies: Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite: 'Lax' }> = []
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!name || !value) continue
    cookies.push({ name, value, domain: '.v2ex.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' })
  }
  return cookies
}

export function v2exTopicUrl(id: string): string {
  return `https://www.v2ex.com/t/${encodeURIComponent(id)}`
}

export function parseV2exTopicId(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (!/(^|\.)v2ex\.com$/i.test(parsed.hostname)) return null
    return parsed.pathname.match(/^\/t\/(\d{1,30})\/?$/)?.[1] ?? null
  } catch {
    return null
  }
}

export function parseV2exNodesFromHtml(html: string): V2exNode[] {
  const nodes: V2exNode[] = []
  const seen = new Set<string>()
  const pattern = /<option\b[^>]*\bvalue="([^"]+)"[^>]*>([\s\S]*?)<\/option>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const name = match[1].trim()
    const title = match[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name) || seen.has(name)) continue
    seen.add(name)
    nodes.push({ name, title: title || name })
  }
  return nodes
}

export class PlaywrightV2exDriver implements V2exDriver {
  private browser: Promise<Browser> | null = null

  private async context(state?: PublisherStorageState): Promise<BrowserContext> {
    if (!this.browser) {
      const executablePath = publisherExecutablePath('v2ex')
      if (!executablePath) throw new ApiError(503, 'v2ex_browser_unavailable', '服务器未安装可用的 Chrome / Chromium 浏览器')
      this.browser = chromium.launch({
        executablePath,
        headless: true,
        chromiumSandbox: process.env.WECHAT_BROWSER_NO_SANDBOX !== '1',
        args: ['--disable-dev-shm-usage'],
      }).then(browser => {
        browser.on('disconnected', () => { this.browser = null })
        return browser
      }).catch(() => {
        this.browser = null
        throw new ApiError(503, 'v2ex_browser_unavailable', '无法启动 V2EX 浏览器，请检查服务器浏览器配置')
      })
    }
    const proxy = process.env.V2EX_PROXY_SERVER?.trim()
    const context = await (await this.browser).newContext({
      storageState: state,
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
      ...(proxy ? { proxy: { server: proxy } } : {}),
    })
    context.setDefaultTimeout(20_000)
    return context
  }

  private async openComposer(context: BrowserContext): Promise<Page> {
    const page = await context.newPage()
    try {
      await page.goto(NEW_TOPIC, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch {
      throw new ApiError(502, 'v2ex_network', '无法访问 V2EX，请检查服务器网络；如服务器无法直连 V2EX，请配置 V2EX_PROXY_SERVER')
    }
    if (/\/signin(?:[/?#]|$)/i.test(page.url())) throw expired()
    const title = await page.title().catch(() => '')
    if (/Just a moment|security verification|安全验证/i.test(title)) {
      throw new ApiError(503, 'v2ex_security_check', 'V2EX 暂时触发了安全验证，请稍后重试或手动打开发帖页发布')
    }
    await page.locator('#topic_title, input[name="title"]').first().waitFor({ state: 'visible', timeout: 25_000 })
    return page
  }

  private async identity(page: Page, cookieSeed: string): Promise<V2exIdentity> {
    const accountId = createHash('sha256').update(cookieSeed).digest('hex').slice(0, 16)
    let name = 'V2EX 用户'
    try {
      const candidate = (await page.locator('a[href^="/member/"]').first().innerText()).trim()
      if (candidate && candidate.length <= 40 && !/登录|注册/i.test(candidate)) name = candidate
    } catch {
      // The composer page may not render the member link in every layout.
    }
    return { accountId, name }
  }

  private async nodesFromPage(page: Page): Promise<V2exNode[]> {
    const options = await page.locator('#nodes option, select[name="node_name"] option').evaluateAll((nodes) =>
      nodes.map((node) => ({
        name: String((node as unknown as { value?: unknown }).value ?? ''),
        title: String((node as unknown as { textContent?: unknown }).textContent ?? '').trim(),
      })),
    ).catch(() => [])
    const seen = new Set<string>()
    return options
      .filter(option => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(option.name) && option.name !== '0')
      .filter(option => {
        if (seen.has(option.name)) return false
        seen.add(option.name)
        return true
      })
      .map(option => ({ name: option.name, title: option.title || option.name }))
  }

  private async cookiesSeed(context: BrowserContext): Promise<string> {
    return (await context.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).sort().join('; ')
  }

  async connect(cookie: string) {
    const parsed = parseV2exCookies(cookie)
    if (parsed.length === 0) throw new ApiError(400, 'v2ex_cookie_invalid', 'Cookie 为空，请从已登录 V2EX 的浏览器复制完整 Cookie')
    const context = await this.context()
    try {
      await context.addCookies(parsed)
      const page = await this.openComposer(context)
      try {
        const identity = await this.identity(page, await this.cookiesSeed(context))
        return { state: await context.storageState(), identity }
      } finally {
        await page.close().catch(() => {})
      }
    } finally {
      await context.close().catch(() => {})
    }
  }

  async checkSession(state: PublisherStorageState) {
    const context = await this.context(state)
    try {
      const page = await this.openComposer(context)
      try {
        return { state: await context.storageState(), identity: await this.identity(page, await this.cookiesSeed(context)) }
      } finally {
        await page.close().catch(() => {})
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'v2ex_check_failed', 'V2EX 连接检查未完成，请检查网络后重试')
    } finally {
      await context.close().catch(() => {})
    }
  }

  async listNodes(state: PublisherStorageState) {
    const context = await this.context(state)
    try {
      const page = await this.openComposer(context)
      try {
        return await this.nodesFromPage(page)
      } finally {
        await page.close().catch(() => {})
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'v2ex_nodes_failed', '读取 V2EX 节点列表失败，请稍后重试')
    } finally {
      await context.close().catch(() => {})
    }
  }

  async checkPublication(state: PublisherStorageState, url: string, title: string) {
    const context = await this.context(state)
    try {
      const response = await context.request.get(url, { timeout: 30_000, headers: { Accept: 'text/html' } })
      if (response.status() === 404 || response.status() === 410) {
        return { state: await context.storageState(), status: 'missing' as const, url: null, message: 'V2EX 主题不存在，可能已被删除或未发布成功' }
      }
      if (!response.ok()) {
        return { state: await context.storageState(), status: 'unknown' as const, url: null, message: `V2EX 返回 HTTP ${response.status()}，暂时无法确认主题` }
      }
      const html = await response.text()
      const topicTitle = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() ?? ''
      if (!title || topicTitle.includes(title.slice(0, 12)) || html.includes(title.slice(0, 12))) {
        return { state: await context.storageState(), status: 'published' as const, url, message: '已重新核实：V2EX 主题已发布' }
      }
      return { state: await context.storageState(), status: 'unknown' as const, url: null, message: 'V2EX 主题页标题与预期不一致，请到 V2EX 核实' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, 'v2ex_check_failed', 'V2EX 发布结果核实未完成，请稍后重试')
    } finally {
      await context.close().catch(() => {})
    }
  }

  async publish(state: PublisherStorageState, article: V2exArticle, progress: (value: { message: string }) => void) {
    const context = await this.context(state)
    let submitted = false
    try {
      const page = await this.openComposer(context)
      try {
        progress({ message: '正在填写 V2EX 主题标题和节点' })
        const titleInput = page.locator('#topic_title, input[name="title"]').first()
        await titleInput.fill(article.title)

        const nodeSelect = page.locator('#nodes, select[name="node_name"]').first()
        if (await nodeSelect.count()) {
          const options = await nodeSelect.locator('option').evaluateAll((nodes) => nodes.map(node => String((node as unknown as { value?: unknown }).value ?? '')))
          if (!options.includes(article.nodeName)) {
            throw new ApiError(400, 'v2ex_node_invalid', `V2EX 节点「${article.nodeName}」不存在或不可用，请重新选择节点`)
          }
          await nodeSelect.selectOption(article.nodeName)
        } else {
          const nodeInput = page.locator('input[name="node_name"]').first()
          if (!await nodeInput.count()) throw new ApiError(502, 'v2ex_composer_unsupported', '未找到 V2EX 节点选择器，页面结构可能已更新')
          await nodeInput.fill(article.nodeName)
        }

        if (await page.locator('#select_syntax').count()) {
          await page.locator('#select_syntax').selectOption('1')
        } else if (await page.locator('input[name="syntax"][value="1"]').count()) {
          await page.locator('input[name="syntax"][value="1"]').check()
        }

        progress({ message: '正在填写 V2EX 主题正文' })
        const hasEditor = await page.evaluate((markdown) => {
          const scope = globalThis as unknown as {
            editor?: { setValue?: (value: string) => void }
          }
          if (scope.editor && typeof scope.editor.setValue === 'function') {
            scope.editor.setValue(markdown)
            return true
          }
          const cmRoot = (globalThis as unknown as {
            document?: { querySelector: (selector: string) => { CodeMirror?: { setValue?: (value: string) => void } } | null }
          }).document?.querySelector('.CodeMirror')
          if (cmRoot?.CodeMirror && typeof cmRoot.CodeMirror.setValue === 'function') {
            cmRoot.CodeMirror.setValue(markdown)
            return true
          }
          return false
        }, article.markdown)
        const contentArea = page.locator('#topic_content, textarea[name="content"]').first()
        if (await contentArea.count()) {
          await contentArea.fill(article.markdown)
        } else if (!hasEditor) {
          throw new ApiError(502, 'v2ex_composer_unsupported', '未找到 V2EX 正文编辑器，页面结构可能已更新')
        } else {
          await page.evaluate((markdown) => {
            const doc = (globalThis as unknown as {
              document?: { querySelector: (selector: string) => { value: string } | null }
            }).document
            const area = doc?.querySelector('#topic_content')
            if (area) area.value = markdown
          }, article.markdown)
        }

        progress({ message: '正在提交 V2EX 主题' })
        const invoked = await page.evaluate(() => {
          const scope = globalThis as unknown as { publishTopic?: () => void }
          if (typeof scope.publishTopic === 'function') {
            scope.publishTopic()
            return true
          }
          return false
        })
        if (!invoked) {
          const submit = page.locator('#compose input[type="submit"], #compose button[type="submit"], input[type="submit"][value*="发布"], button:has-text("发布")').first()
          if (!await submit.count()) throw new ApiError(502, 'v2ex_composer_unsupported', '未找到 V2EX 发布按钮，页面结构可能已更新')
          await submit.click()
        }
        submitted = true

        try {
          await page.waitForURL(/\/t\/\d+/i, { timeout: 45_000 })
        } catch {
          const errorText = await page.locator('#error_message, .error, .problem, .problem-list').allInnerTexts().catch(() => [])
          const message = errorText.map(text => text.replace(/\s+/g, ' ').trim()).filter(Boolean).join('；')
          if (/频繁|太快|验证|请求过多|anti|flood/i.test(message)) {
            throw new ApiError(409, 'v2ex_publish_rejected', `V2EX 拒绝发布：${message}`)
          }
          if (message) throw new ApiError(502, 'v2ex_publish_failed', `V2EX 发布失败：${message}`)
          throw uncertain('V2EX 已提交主题，但页面未返回主题地址；请到 V2EX 后台核实，避免重复发布')
        }

        const url = page.url()
        const remoteId = parseV2exTopicId(url)
        if (!remoteId) throw uncertain(`V2EX 已提交主题，但未能解析主题地址（${url}）；请到 V2EX 核实`)
        progress({ message: 'V2EX 主题已发布' })
        return {
          state: await context.storageState(),
          status: 'published' as const,
          remoteId,
          url: v2exTopicUrl(remoteId),
          message: 'V2EX 主题已发布',
        }
      } finally {
        await page.close().catch(() => {})
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      log('publish error', error)
      if (submitted) throw uncertain('V2EX 发布过程异常中断，结果未确认；请先到 V2EX 核实，避免重复发布')
      throw new ApiError(502, 'v2ex_publish_failed', 'V2EX 发帖页操作失败，尚未提交主题，请重试')
    } finally {
      await context.close().catch(() => {})
    }
  }

  async close(): Promise<void> {
    if (!this.browser) return
    const browser = await this.browser.catch(() => null)
    this.browser = null
    await browser?.close().catch(() => {})
  }
}
