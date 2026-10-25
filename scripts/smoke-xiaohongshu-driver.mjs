// Isolated creator-page fixture. All requests are intercepted; never publishes to Xiaohongshu.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'xiaohongshu-driver-check')
mkdirSync(output, { recursive: true })
const modulePath = path.join(output, 'driver.cjs')
await build({ entryPoints: [path.join(root, 'server/src/xiaohongshu-browser.ts')], outfile: modulePath, bundle: true, platform: 'node', format: 'cjs', external: ['playwright-core'], logLevel: 'silent' })
const { PlaywrightXhsDriver } = createRequire(import.meta.url)(modulePath)
const executablePath = process.env.XHS_BROWSER_PATH || process.env.CHROME_BIN || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  let submitted = 0
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname === '/api/sns/web/v1/note') {
      submitted++
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, success: true, data: { note_id: '1234567890abcdef12345678' } }) })
    }
    if (request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><meta charset="utf-8"><body>
      <div class="creator-tab" style="position:absolute;left:-9999px;top:-9999px">上传图文</div>
      <div class="creator-tab" aria-hidden="true" style="position:absolute;left:300px;top:20px;opacity:0.00001;z-index:-1">上传图文</div>
      <div class="creator-tab" id="real-tab" style="position:absolute;left:300px;top:20px;width:120px;height:40px">上传图文</div>
      <section id="form" style="display:none;margin-top:100px">
        <input type="file" id="video" accept=".mp4,.mov">
        <div id="image-input"></div><div class="img-preview-area"></div>
        <div class="d-input"><input placeholder="填写标题会有更多赞哦"></div>
        <div role="textbox" class="tiptap" contenteditable="true"></div>
        <div class="publish-page-publish-btn"><button class="bg-red">发布</button></div>
      </section>
      <script>
        window.uploaded=[];window.clickedTab=false;
        function nextInput(){
          const input=document.createElement('input');input.type='file';input.accept='.jpg,.jpeg,.png,.webp';
          if(!window.uploaded.length)input.className='upload-input';
          input.onchange=()=>{window.uploaded.push(input.files[0].name);const preview=document.createElement('div');preview.className='pr';preview.textContent=input.files[0].name;document.querySelector('.img-preview-area').append(preview);input.remove();nextInput()};
          document.querySelector('#image-input').append(input);
        }
        document.querySelector('#real-tab').onclick=()=>{window.clickedTab=true;document.querySelector('#form').style.display='block';nextInput()};
        document.querySelector('button.bg-red').onclick=()=>fetch('/api/sns/web/v1/note',{method:'POST',body:'fixture'});
      </script></body></html>` })
    return route.abort()
  })
  const driver = new PlaywrightXhsDriver()
  // The same production driver runs against an isolated, fully intercepted browser context.
  driver.context = async () => context
  const steps = []
  let snapshot
  const close = context.close.bind(context)
  context.close = async () => {
    const page = context.pages()[0]
    snapshot = await page.evaluate(() => ({ names: window.uploaded, selected: window.clickedTab, title: document.querySelector('.d-input input').value, body: document.querySelector('.tiptap').innerText }))
    await close()
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
  const result = await driver.publish({ cookies: [], origins: [] }, { title: '标题测试', body: '正文测试', images: new Map([['0', { name: 'first.png', mimeType: 'image/png', buffer: png }], ['1', { name: 'second.png', mimeType: 'image/png', buffer: png }]]) }, value => steps.push(value.message))
  assert.equal(result.status, 'published')
  assert.equal(submitted, 1)
  assert.deepEqual(snapshot, { names: ['first.png', 'second.png'], selected: true, title: '标题测试', body: '正文测试' })
  assert.ok(steps.includes('正在上传图片 2/2'))
  console.log('Xiaohongshu driver smoke passed: rendered tab, replacement image inputs, ordered uploads, editor readback and explicit submission confirmation (all mocked)')
} finally { await browser.close() }
