// Safe selector check for the SMS login automation. It fills a dummy phone
// number and verifies that the official send/verify controls are reachable,
// but it never clicks "send code" or "login" (that would send a real SMS).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import {
  SMS_LOGIN_PLATFORMS,
  SMS_PLATFORM_CONFIG,
  openSmsForm,
} from '../server/src/sms-login'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'artifacts', 'sms-login-selectors')
mkdirSync(output, { recursive: true })
const executablePath = process.env.CHROME_BIN || [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate))
assert.ok(executablePath, 'Install Chrome or set CHROME_BIN')

const browser = await chromium.launch({ executablePath, headless: true })
const report: Array<{ platform: string; ok: boolean; error?: string }> = []
try {
  for (const platform of SMS_LOGIN_PLATFORMS) {
    const config = SMS_PLATFORM_CONFIG[platform]
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      locale: 'zh-CN',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    try {
      await openSmsForm(page, platform, '13800138000')
      assert.ok(await page.locator(config.phoneSelector).first().isVisible(), 'phone input not visible')
      const filled = (await page.locator(config.phoneSelector).first().inputValue()).replace(/[\s-]/g, '')
      assert.ok(filled === '13800138000', 'phone input not filled')
      assert.ok(await page.locator(config.codeSelector).first().isVisible(), 'code input not visible')
      assert.ok(await config.send(page).first().isVisible(), 'send control not visible')
      assert.ok(await config.submit(page).first().isVisible(), 'submit control not visible')
      await page.screenshot({ path: path.join(output, `${platform}.png`) })
      report.push({ platform, ok: true })
      console.log(`[sms-selectors] ${platform}: ok`)
    } catch (error) {
      report.push({ platform, ok: false, error: error instanceof Error ? error.message : String(error) })
      console.error(`[sms-selectors] ${platform}: failed`, error)
    } finally {
      await context.close().catch(() => {})
    }
  }
} finally {
  await browser.close().catch(() => {})
}
const failed = report.filter((item) => !item.ok)
if (failed.length) {
  console.error(JSON.stringify({ ok: false, report }, null, 2))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ ok: true, report }, null, 2))
}
