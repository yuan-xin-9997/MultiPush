import type { PublisherStorageState } from './publisher-session'
import { ApiError } from './errors'

export interface BilibiliCookies {
  cookie: string
  csrf: string
}

/** Extract a Cookie header and CSRF token from a Playwright storage state. */
export function bilibiliCookies(state: PublisherStorageState): BilibiliCookies {
  const cookies = state.cookies ?? []
  const relevant = cookies.filter((cookie) => /(^|\.)bilibili\.com$/i.test(cookie.domain))
  const map = new Map(relevant.map((cookie) => [cookie.name, cookie.value]))
  const sess = map.get('SESSDATA')
  const csrf = map.get('bili_jct')
  if (!sess || !csrf) throw new ApiError(409, 'bilibili_session_expired', 'B 站登录态缺少 SESSDATA / bili_jct，请重新扫码登录')
  return {
    cookie: relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrf,
  }
}
