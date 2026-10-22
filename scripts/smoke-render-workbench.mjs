// Defaults to an isolated local database; QA_BASE_URL tests a deployed instance with a throwaway account.
// Build first: npm run build; then node scripts/smoke-render-workbench.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import JSZip from 'jszip'

const root = path.resolve(import.meta.dirname, '..')
const directory = path.join(root, 'artifacts', `render-qa-${Date.now()}`)
const downloads = path.join(directory, 'downloads')
mkdirSync(downloads, { recursive: true })
const chrome = process.env.CHROME_BIN || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
if (!chrome) throw new Error('Set CHROME_BIN to a Chrome/Chromium executable')
const port = Number(process.env.QA_PORT || 34181)
const debugPort = Number(process.env.QA_DEBUG_PORT || 39224)
const remoteBase = process.env.QA_BASE_URL?.replace(/\/$/, '')
const base = remoteBase || `http://127.0.0.1:${port}`
const resources = { base, userId: '', username: '', email: '', contents: [], media: [] }
const server = remoteBase ? null : spawn(process.execPath, ['server/dist/index.js'], { cwd: root, windowsHide: true,
  env: { ...process.env, DATA_DIR: path.join(directory, 'data'), WEB_DIST: path.join(root, 'web/dist'), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', PUBLIC_BASE_URL: base, JWT_SECRET: 'isolated-render-qa-secret' }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
server?.stdout.on('data', (data) => { log += data })
server?.stderr.on('data', (data) => { log += data })
let browser
let socket
let cdp
let ownsBrowser = false
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message, timeout = 20_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { try { const result = await check(); if (result) return result } catch {} await delay(150) }
  throw new Error(message)
}
let token
async function api(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${base}/api/${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json()
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`)
  return data
}
try {
  if (!remoteBase) await until(() => log.includes(`[multipush] listening on ${base}`), 'Isolated QA server could not bind its port')
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'QA server did not start')
  const name = `renderqa_${Date.now().toString(36)}`
  const registration = await api('auth/register', { username: name, email: `${name}@example.com`, password: 'RenderQA!2026' })
  token = registration.token
  Object.assign(resources, { userId: registration.user.id, username: name, email: `${name}@example.com` })
  const imageUrls = []
  for (let i = 0; i < 5; i++) {
    const form = new FormData()
    form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), `qa-${i}.png`)
    const response = await fetch(`${base}/api/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
    assert.equal(response.status, 200)
    const { media } = await response.json()
    resources.media.push(media.id)
    imageUrls.push(media.url)
  }
  const contentHtml = Array.from({ length: 10 }, (_, i) => `<p>第${i + 1}段：${'实际高度分页验证🙂，确保图文混排时文字完整。'.repeat(8)}</p>`).join('') + imageUrls.map((url) => `<img src="${url}">`).join('')
  const { content } = await api('contents', { title: '工作台浏览器验证', contentHtml, tags: ['测试'], status: 'ready' })
  resources.contents.push(content.id)
  const { render } = await api('renders', { contentId: content.id, platforms: ['wechat', 'xiaohongshu', 'zhihu', 'douyin'], options: { cardStyle: 'clean', includeTags: true, authorName: '快照作者' } })
  const expectedBody = render.results.find((item) => item.platform === 'xiaohongshu').cards.filter((card) => card.type === 'content').flatMap((card) => card.body).join('')
  browser = spawn(chrome, ['--headless=new', '--enable-automation', '--no-sandbox', '--disable-gpu', '--no-proxy-server', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(directory, 'chrome')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const targets = await until(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(), 'Headless Chrome did not start')
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  const pending = new Map()
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30_000)
    pending.set(id, { resolve: (result) => { clearTimeout(timer); resolve(result) }, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const runtimeErrors = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text)
    const task = pending.get(message.id)
    if (task) { pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result) }
  }
  const commandLine = await cdp('Browser.getBrowserCommandLine')
  assert.ok(commandLine.arguments.includes(`--user-data-dir=${path.join(directory, 'chrome')}`), 'Refusing to control a browser with a different profile')
  ownsBrowser = true
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const click = (text, scope = 'document') => evaluate(`(() => { const button = [...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw Error('Unavailable button: ' + ${JSON.stringify(text)}); button.click(); })()`)
  const fill = (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  const ready = () => until(() => evaluate(`Boolean(document.querySelector('.render-publish-checks')) && !document.querySelector('.render-controls').disabled`), 'Workbench did not become ready', 30_000)
  await cdp('Runtime.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await cdp('Page.navigate', { url: base })
  await until(() => evaluate(`location.origin === ${JSON.stringify(base)} && document.readyState === 'complete'`), 'Initial page did not load')
  await evaluate(`localStorage.setItem('multipush_token', ${JSON.stringify(token)})`)
  await cdp('Page.navigate', { url: `${base}/render?renderId=${render.id}` })
  await ready()
  assert.equal(await evaluate(`[...document.querySelectorAll('.xhs-export-card .xhs-content-lines p')].map(p=>p.textContent).join('')`), expectedBody)
  assert.equal(await evaluate(`[...document.querySelectorAll('.xhs-export-card .xhs-content-lines')].every(e=>e.scrollHeight<=e.clientHeight+1)`), true)
  console.log('PASS: measured pagination preserves every character with images')

  await click('渲染设置')
  await evaluate(`[...document.querySelectorAll('.render-style-option')].find(b=>b.textContent.includes('暖阳')).click()`)
  assert.equal(await evaluate(`document.querySelector('.xhs-export-card .xhs-card').classList.contains('xhs-card-clean')`), true)
  await click('保存为我的默认设置')
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('multipush:render-defaults:' + ${JSON.stringify((await api('auth/me')).user.id)})).options.cardStyle`), 'warm')
  console.log('PASS: pending settings do not change generated cards; account defaults persist')

  await evaluate(`[...document.querySelectorAll('.render-tabs button')].find(b=>b.textContent.includes('小红书')).click()`)
  await click('调整当前平台')
  await until(() => evaluate(`Boolean(document.querySelector('.render-edit-form input'))`), 'Editor did not open')
  await fill('.render-edit-form input', '小红书独立标题')
  await fill('.render-edit-form > label textarea', '只属于小红书的正文')
  await evaluate(`document.querySelector('.render-card-thumbnails button:nth-child(2)').click()`)
  await click('前移', `document.querySelector('[role="dialog"]')`)
  await evaluate(`document.querySelector('.render-card-editor textarea').setSelectionRange(30, 30)`)
  await click('在光标处分页', `document.querySelector('[role="dialog"]')`)
  await fill('.render-card-editor input[type="range"]', '30')
  await delay(250)
  await cdp('Page.captureScreenshot', { format: 'png' }).then(({ data }) => writeFileSync(path.join(directory, 'card-editor.png'), Buffer.from(data, 'base64')))
  await click('保存调整', `document.querySelector('[role="dialog"]')`)
  await until(() => evaluate(`!document.querySelector('[role="dialog"]')`), 'Adjustments did not save')
  await ready()
  let saved = (await api(`renders/${render.id}`)).render
  assert.equal(saved.results.find((item) => item.platform === 'xiaohongshu').title, '小红书独立标题')
  assert.equal(saved.results.find((item) => item.platform === 'wechat').title, '工作台浏览器验证')
  assert.equal((await api(`contents/${content.id}`)).content.title, '工作台浏览器验证')
  assert.equal(saved.results.find((item) => item.platform === 'xiaohongshu').cards[0].imagePosition.x, 30)
  await cdp('Page.reload')
  await ready()
  assert.equal((await api(`renders/${render.id}`)).render.results.find((item) => item.platform === 'xiaohongshu').captionBody, '只属于小红书的正文')
  console.log('PASS: platform title/body/order persist without changing source or other platforms')

  await evaluate(`[...document.querySelectorAll('.render-tabs button')].find(b=>b.textContent.includes('小红书')).click()`)
  await cdp('Page.captureScreenshot', { format: 'png' }).then(({ data }) => writeFileSync(path.join(directory, 'workbench.png'), Buffer.from(data, 'base64')))
  await click('小红书 ZIP')
  await until(() => readdirSync(downloads).some((file) => file.endsWith('.zip')), 'ZIP download did not complete', 60_000)
  const zip = await JSZip.loadAsync(readFileSync(path.join(downloads, readdirSync(downloads).find((file) => file.endsWith('.zip')))))
  const report = JSON.parse(await zip.file('导出报告.json').async('string'))
  assert.equal(report.failedCards.length, 0)
  assert.equal(report.failedAssets.length, 0)
  assert.equal(report.expectedCards, report.successfulCards)
  const png = zip.filter((name) => name.includes('/卡片/') && name.endsWith('.png'))[0]
  const bytes = await png.async('nodebuffer')
  assert.equal(bytes.readUInt32BE(16), 1080)
  assert.equal(bytes.readUInt32BE(20), 1440)
  console.log(`PASS: ZIP contains ${report.successfulCards} complete PNG cards at 1080×1440 with an accurate report`)

  const downloadAgain = async (button) => {
    const folder = path.join(downloads, `attempt-${Date.now()}`)
    mkdirSync(folder)
    await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: folder })
    await click(button)
    const filename = await until(() => readdirSync(folder).find((file) => file.endsWith('.zip')), 'Retry ZIP did not complete', 60_000)
    const archive = await JSZip.loadAsync(readFileSync(path.join(folder, filename)))
    return JSON.parse(await archive.file('导出报告.json').async('string'))
  }
  if (!remoteBase) {
  await ready()
  saved = (await api(`renders/${render.id}`)).render
  const xhs = saved.results.find((item) => item.platform === 'xiaohongshu')
  const brokenCards = xhs.cards.map((card, i) => i === 0 ? { ...card, images: [`${base}/uploads/retry-qa.png`] } : card)
  await api(`renders/${render.id}/platforms/xiaohongshu`, { title: xhs.title, body: xhs.captionBody, tags: xhs.meta.tags, cards: brokenCards }, 'PATCH')
  await cdp('Page.reload')
  await ready()
  await evaluate(`[...document.querySelectorAll('.render-tabs button')].find(b=>b.textContent.includes('小红书')).click()`)
  const partial = await downloadAgain('小红书 ZIP')
  assert.equal(partial.failedCards.length, 1)
  assert.equal(partial.failedAssets.length, 1)
  assert.equal(await evaluate(`document.querySelector('.render-export-report').textContent.includes('导出不完整')`), true)
  writeFileSync(path.join(directory, 'data/uploads/retry-qa.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64'))
  await ready()
  const retried = await downloadAgain('重试失败项并重新导出')
  assert.equal(retried.failedCards.length, 0)
  assert.equal(retried.failedAssets.length, 0)
  console.log('PASS: missing image/card reported accurately; retry completes the archive')
  }

  await ready()
  await evaluate(`[...document.querySelectorAll('.render-tabs button')].find(b=>b.textContent.includes('公众号')).click()`)
  await click('调整当前平台')
  await until(() => evaluate(`Boolean(document.querySelector('.render-article-editor [contenteditable="true"]'))`), 'Rich editor did not initialize')
  await fill('.render-edit-form input', '公众号独立标题')
  await evaluate(`(() => { const editor = document.querySelector('.render-article-editor [contenteditable="true"]'); editor.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, '公众号富文本调整验证'); })()`)
  await click('保存调整', `document.querySelector('[role="dialog"]')`)
  await until(() => evaluate(`!document.querySelector('[role="dialog"]')`), 'Rich text adjustment failed to save')
  await ready()
  const article = (await api(`renders/${render.id}`)).render.results.find((item) => item.platform === 'wechat')
  assert.equal(article.title, '公众号独立标题')
  assert.ok(article.html.includes('公众号富文本调整验证'))
  assert.ok(article.downloads.find((file) => file.kind === 'html').content.includes('公众号富文本调整验证'))
  console.log('PASS: rich article editing updates preview and HTML delivery files')

  await evaluate(`window.__qaExecCommand = document.execCommand; window.__qaClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard'); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async()=>{throw Error('denied')}, writeText: async()=>{} } }); window.__qaCopyCalls = 0; document.execCommand = ()=>window.__qaCopyCalls++>0`)
  await click('复制富文本')
  await until(() => evaluate(`document.body.textContent.includes('仅复制了纯文本')`), 'Clipboard fallback was not identified')
  await evaluate(`document.execCommand = window.__qaExecCommand; if (window.__qaClipboard) Object.defineProperty(navigator, 'clipboard', window.__qaClipboard); else delete navigator.clipboard`)
  console.log('PASS: plain-text fallback is clearly identified instead of claiming rich text')
  await ready()
  const allReport = await downloadAgain('全部平台 ZIP')
  assert.equal(allReport.failedCards.length, 0)
  assert.equal(allReport.failedAssets.length, 0)
  console.log('PASS: all-platform delivery ZIP is complete')

  await ready()
  await evaluate(`[...document.querySelectorAll('.render-tabs button')].find(b=>b.textContent.includes('小红书')).click()`)
  await click('恢复生成结果')
  await click('确认', `document.querySelector('[role="dialog"]')`)
  await until(async () => !(await api(`renders/${render.id}`)).render.results.find((item) => item.platform === 'xiaohongshu').editedAt, 'Reset failed')
  await ready()
  await api(`contents/${content.id}`, { title: '原文已更新' }, 'PATCH')
  await evaluate(`window.dispatchEvent(new Event('focus'))`)
  await until(() => evaluate(`document.body.textContent.includes('原文已修改，当前结果尚未更新')`), 'Source change was not detected')
  console.log('PASS: restore original result and source-version detection')
  await cdp('Page.navigate', { url: `${base}/render` })
  await until(() => evaluate(`Boolean(document.querySelector('.render-sourcebar')) && !document.querySelector('.render-controls').disabled`), 'New workbench did not load')
  await click('渲染设置')
  assert.equal(await evaluate(`document.querySelector('.render-style-option.is-active').textContent.includes('暖阳')`), true)
  console.log('PASS: a new workbench loads the account defaults')
  assert.deepEqual(runtimeErrors, [])
  console.log(`Browser QA passed. Artifacts: ${directory}`)
} catch (error) {
  writeFileSync(path.join(directory, 'server.log'), log)
  if (cdp) await cdp('Page.captureScreenshot', { format: 'png' }).then(({ data }) => writeFileSync(path.join(directory, 'failure.png'), Buffer.from(data, 'base64'))).catch(() => {})
  console.error(error)
  process.exitCode = 1
} finally {
  if (cdp && ownsBrowser) await cdp('Browser.close').catch(() => {})
  socket?.close()
  browser?.kill()
  server?.kill()
  if (remoteBase && token) {
    for (const id of resources.contents) await api(`contents/${id}?permanent=true`, undefined, 'DELETE').catch(() => {})
    for (const id of resources.media) await api(`media/${id}`, undefined, 'DELETE').catch(() => {})
  }
  writeFileSync(path.join(directory, 'qa-resources.json'), JSON.stringify(resources, null, 2))
}
