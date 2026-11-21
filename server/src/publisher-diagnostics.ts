import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright-core'

export interface PageFailure {
  url: string
  title: string
  text: string
  buttons: string[]
  screenshot: string | null
}

const MAX_TEXT = 240

/** Snapshot the page at failure time so the publication message can point at the real cause. */
export async function capturePageFailure(page: Page, dataDir: string | null, platform: string): Promise<PageFailure> {
  const buttons = await page.locator('button, [role="button"]').evaluateAll(nodes => nodes
    .map(node => (node.textContent || '').trim())
    .filter(text => text && text.length <= 12))
    .catch(() => [])
  const text = await page.locator('body').innerText().catch(() => '')
  let screenshot: string | null = null
  if (dataDir) {
    try {
      const directory = path.join(dataDir, 'debug')
      mkdirSync(directory, { recursive: true })
      const file = path.join(directory, `${platform}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
      await page.screenshot({ path: file })
      screenshot = file
    } catch { /* diagnostics must never mask the original failure */ }
  }
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT),
    buttons: [...new Set(buttons)].slice(0, 8),
    screenshot,
  }
}

/** Compact, secret-free description appended to a failed publication message. */
export function describePageFailure(failure: PageFailure): string {
  const parts = [`页面：${failure.url}`]
  if (failure.text) parts.push(`可见文字：${failure.text}`)
  if (failure.buttons.length) parts.push(`按钮：${failure.buttons.join(' / ')}`)
  if (failure.screenshot) parts.push(`截图：${failure.screenshot}`)
  return parts.join('；')
}
