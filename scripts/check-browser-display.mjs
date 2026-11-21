// 浏览器有头环境自检：确认今日头条能拿到「有头」浏览器所需的显示环境。
// 用法：node scripts/check-browser-display.mjs
// 在服务器上执行；今日头条发布依赖有头浏览器 + Xvfb 虚拟显示。
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const executablePath = process.env.CHROME_BIN || process.env.TOUTIAO_BROWSER_PATH || [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync)

if (!executablePath) {
  console.error('未找到 Chrome/Chromium，请先安装，或设置 CHROME_BIN')
  process.exit(2)
}

console.log('DISPLAY =', process.env.DISPLAY || '(未设置)')
console.log('浏览器 =', executablePath)

let browser
try {
  browser = await chromium.launch({
    executablePath,
    headless: false,
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled', '--window-size=1440,1000', '--window-position=0,0'],
  })
} catch (error) {
  console.error('有头浏览器启动失败：', String(error).slice(0, 300))
  if (/Missing X server|DISPLAY|Xvfb/i.test(String(error))) {
    console.error('请在服务器安装 xvfb：sudo apt-get install -y xvfb xauth，并通过 xvfb-run 启动服务')
  }
  process.exit(1)
}

const page = await browser.newPage()
const info = await page.evaluate(`(() => {
  let webgl = 'unavailable'
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl')
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
    webgl = gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : 'no-webgl'
  } catch (error) { webgl = 'error' }
  return {
    webdriver: navigator.webdriver,
    screen: [screen.width, screen.height],
    outer: [outerWidth, outerHeight],
    inner: [innerWidth, innerHeight],
    devicePixelRatio,
    webgl,
    ua: navigator.userAgent,
  }
})()`)
await browser.close()

console.log(JSON.stringify(info, null, 2))
const ok = info.screen[0] > 0 && info.outer[0] > 0 && info.webdriver === false
console.log(ok
  ? 'OK：有头浏览器与显示环境正常，今日头条的草稿/发布可以工作'
  : 'WARN：显示环境异常（screen/outer 为 0 或 webdriver=true），今日头条可能仍返回 code 7050')
process.exit(ok ? 0 : 1)
