#!/usr/bin/env node
/**
 * MultiPush API smoke test.
 *
 * Usage:
 *   node scripts/smoke-api.mjs
 *   MULTIPUSH_BASE_URL=http://192.168.0.111:34080 node scripts/smoke-api.mjs
 *
 * Uses two existing verified QA accounts and creates content, renders all three platforms and
 * verifies user isolation. Intended for development / staging verification.
 */

const base = (process.env.MULTIPUSH_BASE_URL || 'http://127.0.0.1:34080').replace(/\/$/, '')
const stamp = Date.now().toString(36)

let failures = 0
function check(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: response.status, data }
}

async function register(label) {
  const account = process.env[`QA_ACCOUNT_${label.toUpperCase()}`]
  const accountPassword = process.env[`QA_PASSWORD_${label.toUpperCase()}`]
  if (!account || !accountPassword) throw new Error('Set QA_ACCOUNT_A, QA_PASSWORD_A, QA_ACCOUNT_B and QA_PASSWORD_B to two verified QA accounts')
  const result = await request('/api/auth/login', {
    method: 'POST', body: { account, password: accountPassword },
  })
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`register(${label}) failed: ${result.status} ${JSON.stringify(result.data)}`)
  }
  return result.data
}

async function main() {
  console.log(`MultiPush smoke test → ${base}`)
  const health = await request('/api/health')
  check(health.status === 200 && health.data?.status === 'ok', 'health endpoint is ok')

  const userA = await register('a')
  const userB = await register('b')
  check(Boolean(userA.token && userB.token), 'two QA users can log in')

  const book = await request('/api/books', {
    method: 'POST',
    token: userA.token,
    body: { name: `验收知识库 ${stamp}`, description: 'API smoke test', color: '#00b96b' },
  })
  check(book.status === 201 || book.status === 200, 'create book')
  const bookId = book.data?.book?.id

  const html = [
    '<h1>一次创作，多平台发布</h1>',
    '<p>这是 <strong>MultiPush</strong> 的验收文档，包含中文、English、列表、引用、代码与表格。</p>',
    '<h2>核心流程</h2>',
    '<ul><li>创建内容</li><li>智能渲染</li><li>预览下载</li></ul>',
    '<blockquote>好的排版，是内容被读完的第一步。</blockquote>',
    '<h2>代码示例</h2>',
    '<pre><code>const message = &quot;Hello MultiPush&quot;</code></pre>',
    '<h2>数据表</h2>',
    '<table><thead><tr><th>平台</th><th>输出</th></tr></thead><tbody><tr><td>小红书</td><td>3:4 卡片</td></tr><tr><td>知乎</td><td>Markdown</td></tr></tbody></table>',
    '<p><img src="/favicon.svg" alt="MultiPush icon" width="120"></p>',
  ].join('\n')

  const created = await request('/api/contents', {
    method: 'POST',
    token: userA.token,
    body: {
      title: `验收文档 ${stamp}`,
      bookId,
      contentHtml: html,
      contentJson: { type: 'doc', content: [] },
      tags: ['验收', '多平台'],
      status: 'ready',
    },
  })
  check(created.status === 201 || created.status === 200, 'create content')
  const content = created.data?.content
  const contentId = content?.id
  check(Boolean(contentId), 'content id returned')
  check(content?.wordCount > 0, 'word count computed')
  check(content?.imageCount === 1, 'image count computed')

  const foreign = await request(`/api/contents/${contentId}`, { token: userB.token })
  check(foreign.status === 404, 'user B cannot read user A content')

  const listed = await request('/api/contents?pageSize=50', { token: userA.token })
  check(Array.isArray(listed.data?.items) && listed.data.items.some((item) => item.id === contentId), 'content appears in list')

  const rendered = await request('/api/renders', {
    method: 'POST',
    token: userA.token,
    body: {
      contentId,
      platforms: ['wechat', 'xiaohongshu', 'zhihu', 'douyin'],
      options: { cardStyle: 'clean', includeTags: true },
    },
  })
  check(rendered.status === 201 || rendered.status === 200, 'render all platforms')
  const results = rendered.data?.render?.results || []
  check(results.length === 4, 'four platform results returned')

  const wechat = results.find((item) => item.platform === 'wechat')
  const xhs = results.find((item) => item.platform === 'xiaohongshu')
  const zhihu = results.find((item) => item.platform === 'zhihu')
  const douyin = results.find((item) => item.platform === 'douyin')

  check(Boolean(wechat?.html?.includes('一次创作')), 'wechat HTML rendered')
  check(Boolean(wechat?.downloads?.length), 'wechat download payload present')
  check(Array.isArray(xhs?.cards) && xhs.cards.length >= 2, 'xiaohongshu cards rendered')
  check(Boolean(xhs?.text), 'xiaohongshu caption rendered')
  check(Boolean(zhihu?.markdown?.includes('#')), 'zhihu markdown rendered')
  check(Boolean(douyin?.text?.includes('#')), 'douyin caption rendered')
  check(douyin?.previewMode === 'vertical', 'douyin vertical preview mode')
  check(results.every((item) => item.generatedAt), 'render timestamps present')
  check(results.every((item) => !/<script/i.test(item.html)), 'rendered HTML contains no script tags')

  const history = await request('/api/renders', { token: userA.token })
  check(Array.isArray(history.data?.renders) && history.data.renders.length >= 1, 'render history persisted')

  const deleted = await request(`/api/contents/${contentId}`, { method: 'DELETE', token: userA.token })
  check(deleted.status === 200, 'soft delete content')
  const trash = await request('/api/contents?trash=true', { token: userA.token })
  check(trash.data?.items?.some((item) => item.id === contentId), 'deleted content appears in trash')

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log('\nAll smoke checks passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
