import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import type { BilibiliCookies } from './bilibili-cookies'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const COVER_API = 'https://member.bilibili.com/x/vu/web/cover/up'
const TICKET_API = 'https://member.bilibili.com/preupload'
const SUBMIT_API = 'https://member.bilibili.com/x/vu/web/add/v3'
const GEETEST_WARMUP = 'https://member.bilibili.com/x/geetest/pre/add'
const PREDICT_API = 'https://member.bilibili.com/x/vupre/web/archive/types/predict'
const NAV_API = 'https://api.bilibili.com/x/web-interface/nav'
const WBI_MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62,
  11, 36, 20, 34, 44, 52,
]

export interface BilibiliVideoPublishInput {
  videoPath: string
  videoName: string
  coverBuffer: Buffer
  coverMime: string
  title: string
  desc: string
  tags: string
  partitionId?: number
}

export interface BilibiliVideoPublishResult {
  bvid: string
  aid: number | null
  url: string
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function apiError(label: string, body: Record<string, unknown>): Error {
  return new Error(`${label}：${JSON.stringify(body).slice(0, 500)}`)
}

function headers(cookies: BilibiliCookies): Record<string, string> {
  return {
    cookie: cookies.cookie,
    'user-agent': UA,
    referer: 'https://member.bilibili.com/',
    origin: 'https://member.bilibili.com',
    accept: 'application/json, text/plain, */*',
  }
}

function encodeQuery(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  try {
    return object(JSON.parse(text))
  } catch {
    throw new Error(`B 站返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
}

export function wbiMixinKey(orig: string): string {
  return WBI_MIXIN_TABLE.map((index) => orig[index] ?? '').join('').slice(0, 32)
}

export function wbiSign(params: Record<string, string | number>, imgKey: string, subKey: string): Record<string, string | number> {
  const signed: Record<string, string | number> = { ...params, wts: Math.floor(Date.now() / 1000) }
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(signed)) {
    cleaned[key] = String(value).replace(/[!'()*]/g, '')
  }
  const query = Object.entries(cleaned)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  const wRid = createHash('md5').update(query + wbiMixinKey(imgKey + subKey)).digest('hex')
  signed.w_rid = wRid
  return signed
}

async function uploadCover(cookies: BilibiliCookies, buffer: Buffer, mime: string): Promise<string> {
  const body = new URLSearchParams({
    csrf: cookies.csrf,
    cover: `data:${mime};base64,${buffer.toString('base64')}`,
  })
  const response = await fetch(`${COVER_API}?${encodeQuery({ ts: Date.now() })}`, {
    method: 'POST',
    headers: { ...headers(cookies), 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const payload = await jsonResponse(response)
  if (payload.code !== 0) throw apiError('B 站封面上传失败', payload)
  const url = object(payload.data).url
  if (typeof url !== 'string' || !url) throw new Error('B 站封面上传成功但没有返回地址')
  return url
}

async function predictPartition(cookies: BilibiliCookies, title: string): Promise<{ tid: number; name: string; humanType2: number | null }> {
  const body = new URLSearchParams({ filename: '', title })
  const response = await fetch(`${PREDICT_API}?${encodeQuery({ ts: Date.now(), csrf: cookies.csrf })}`, {
    method: 'POST',
    headers: { ...headers(cookies), 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const payload = await jsonResponse(response)
  if (payload.code !== 0) throw apiError('B 站分区预测失败', payload)
  const items = Array.isArray(payload.data) ? payload.data : []
  const first = object(items[0])
  if (typeof first.id !== 'number') throw new Error('B 站分区预测没有返回有效分区')
  const human = object(first.human_type)
  return {
    tid: first.id,
    name: typeof first.name === 'string' ? first.name : '',
    humanType2: typeof human.id === 'number' ? human.id : null,
  }
}

async function wbiKeys(cookies: BilibiliCookies): Promise<{ imgKey: string; subKey: string }> {
  const response = await fetch(NAV_API, { headers: headers(cookies) })
  const payload = await jsonResponse(response)
  const wbi = object(object(payload.data).wbi_img)
  const imgUrl = typeof wbi.img_url === 'string' ? wbi.img_url : ''
  const subUrl = typeof wbi.sub_url === 'string' ? wbi.sub_url : ''
  if (!imgUrl || !subUrl) throw new Error('B 站 nav 接口没有返回 WBI 密钥，请重新扫码登录')
  return {
    imgKey: imgUrl.split('/').pop()?.split('.')[0] ?? '',
    subKey: subUrl.split('/').pop()?.split('.')[0] ?? '',
  }
}

interface UploadTicket {
  endpoint: string
  uposUri: string
  auth: string
  bizId: number
  chunkSize: number
  filename: string
}

async function requestTicket(cookies: BilibiliCookies, filename: string, size: number): Promise<UploadTicket> {
  const params = {
    name: filename,
    size,
    r: 'upos',
    profile: 'ugcfx/bup',
    ssl: 0,
    version: '2.10.4.0',
    build: '2140000',
    webVersion: '2.13.0',
  }
  const response = await fetch(`${TICKET_API}?${encodeQuery(params)}`, { headers: headers(cookies) })
  const payload = await jsonResponse(response)
  if (payload.OK !== 1) throw apiError('B 站申请上传凭据失败', payload)
  const endpoint = typeof payload.endpoint === 'string' ? payload.endpoint : ''
  const uposUri = typeof payload.upos_uri === 'string' ? payload.upos_uri : ''
  const auth = typeof payload.auth === 'string' ? payload.auth : ''
  const bizId = typeof payload.biz_id === 'number' ? payload.biz_id : Number(payload.biz_id)
  const chunkSize = typeof payload.chunk_size === 'number' ? payload.chunk_size : Number(payload.chunk_size)
  if (!endpoint || !uposUri || !auth || !Number.isFinite(bizId) || !Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new Error('B 站上传凭据不完整，已停止发布')
  }
  return { endpoint, uposUri, auth, bizId, chunkSize, filename }
}

async function openUposSession(ticket: UploadTicket, size: number, progress: (message: string) => void): Promise<{ url: string; uploadId: string }> {
  const url = `https:${ticket.endpoint}/${ticket.uposUri.replace(/^upos:\/\//, '')}`
  const query = encodeQuery({
    uploads: '',
    output: 'json',
    profile: 'ugcfx/bup',
    filesize: size,
    partsize: ticket.chunkSize,
    biz_id: ticket.bizId,
  })
  const response = await fetch(`${url}?${query}`, {
    method: 'POST',
    headers: { 'x-upos-auth': ticket.auth, 'user-agent': UA },
  })
  const payload = await jsonResponse(response)
  if (payload.OK !== 1) throw apiError('B 站开启分片上传失败', payload)
  const uploadId = typeof payload.upload_id === 'string' ? payload.upload_id : ''
  if (!uploadId) throw new Error('B 站没有返回 upload_id，已停止发布')
  progress('B 站上传会话已开启')
  return { url, uploadId }
}

async function sendPart(url: string, ticket: UploadTicket, uploadId: string, chunk: Buffer, index: number, total: number, size: number): Promise<string> {
  const start = index * ticket.chunkSize
  const query = encodeQuery({
    uploadId,
    chunks: total,
    total: size,
    chunk: index,
    size: chunk.length,
    partNumber: index + 1,
    start,
    end: start + chunk.length,
  })
  let lastError = ''
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`${url}?${query}`, {
        method: 'PUT',
        headers: {
          'x-upos-auth': ticket.auth,
          'content-type': 'application/octet-stream',
          'user-agent': UA,
        },
        body: new Uint8Array(chunk),
      })
      if (response.ok) {
        const etag = response.headers.get('etag') ?? response.headers.get('Etag') ?? 'etag'
        return etag.replace(/^"|"$/g, '')
      }
      lastError = `HTTP ${response.status} ${(await response.text()).slice(0, 120)}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  throw new Error(`B 站分片 ${index + 1}/${total} 上传失败：${lastError}`)
}

async function sendParts(url: string, ticket: UploadTicket, uploadId: string, videoPath: string, progress: (message: string) => void): Promise<string[]> {
  const info = await stat(videoPath)
  const total = Math.ceil(info.size / ticket.chunkSize)
  const etags: string[] = []
  const handle = await open(videoPath, 'r')
  try {
    for (let index = 0; index < total; index += 1) {
      const buffer = Buffer.alloc(Math.min(ticket.chunkSize, info.size - index * ticket.chunkSize))
      await handle.read(buffer, 0, buffer.length, index * ticket.chunkSize)
      etags.push(await sendPart(url, ticket, uploadId, buffer, index, total, info.size))
      progress(`B 站上传分片 ${index + 1}/${total}`)
    }
  } finally {
    await handle.close()
  }
  return etags
}

async function sealUpload(url: string, ticket: UploadTicket, uploadId: string, etags: string[], total: number): Promise<void> {
  const response = await fetch(`${url}?${encodeQuery({ name: ticket.filename, uploadId, biz_id: ticket.bizId, output: 'json', profile: 'ugcfx/bup' })}`, {
    method: 'POST',
    headers: { 'x-upos-auth': ticket.auth, 'content-type': 'application/json; charset=UTF-8', 'user-agent': UA },
    body: JSON.stringify({ parts: etags.map((etag, index) => ({ partNumber: index + 1, eTag: etag || 'etag' })) }),
  })
  const payload = await jsonResponse(response)
  if (payload.OK !== 1) throw apiError('B 站上传封口失败', payload)
}

export async function publishBilibiliVideo(cookies: BilibiliCookies, input: BilibiliVideoPublishInput, progress: (message: string) => void): Promise<BilibiliVideoPublishResult> {
  const info = await stat(input.videoPath)
  if (!info.isFile() || info.size <= 0) throw new Error('B 站投稿需要有效的视频成片')
  progress('正在上传 B 站封面')
  const coverUrl = await uploadCover(cookies, input.coverBuffer, input.coverMime)
  progress('正在申请 B 站上传凭据')
  const ticket = await requestTicket(cookies, input.videoName, info.size)
  const session = await openUposSession(ticket, info.size, progress)
  const etags = await sendParts(session.url, ticket, session.uploadId, input.videoPath, progress)
  progress('B 站上传封口中')
  await sealUpload(session.url, ticket, session.uploadId, etags, etags.length)
  const stem = ticket.uposUri.split('/').pop()?.replace(/\.[^.]+$/, '') ?? input.videoName.replace(/\.[^.]+$/, '')
  const zone = input.partitionId ? { tid: input.partitionId, humanType2: null as number | null } : await predictPartition(cookies, input.title)
  const { imgKey, subKey } = await wbiKeys(cookies)
  try {
    await fetch(`${GEETEST_WARMUP}?${encodeQuery({})}`, { headers: headers(cookies) })
  } catch {
    // Warm-up is best-effort.
  }
  const query = wbiSign({ web_location: '333.1024', ts: Date.now(), csrf: cookies.csrf }, imgKey, subKey)
  const payload: Record<string, unknown> = {
    videos: [{ filename: stem, title: input.title, desc: '', cid: ticket.bizId }],
    cover: coverUrl,
    cover43: '',
    title: input.title,
    copyright: 1,
    tid: zone.tid,
    tag: input.tags,
    desc_format_id: 9999,
    desc: input.desc,
    recreate: -1,
    dynamic: '',
    interactive: 0,
    act_reserve_create: 0,
    no_disturbance: 0,
    no_reprint: 0,
    subtitle: { open: 0, lan: '' },
    dolby: 0,
    lossless_music: 0,
    up_selection_reply: false,
    up_close_reply: false,
    up_close_danmu: false,
    web_os: 3,
    csrf: cookies.csrf,
  }
  if (zone.humanType2) payload.human_type2 = zone.humanType2
  progress('正在提交 B 站视频投稿')
  const response = await fetch(`${SUBMIT_API}?${encodeQuery(query)}`, {
    method: 'POST',
    headers: { ...headers(cookies), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await jsonResponse(response)
  if (body.code !== 0) throw apiError('B 站视频投稿失败', body)
  const data = object(body.data)
  const bvid = typeof data.bvid === 'string' ? data.bvid : ''
  const aid = typeof data.aid === 'number' ? data.aid : null
  if (!bvid) throw new Error('B 站投稿接口没有返回 bvid，请在创作中心人工确认')
  return { bvid, aid, url: `https://www.bilibili.com/video/${bvid}` }
}

export async function checkBilibiliVideoStatus(cookies: BilibiliCookies, bvid: string): Promise<{ state: 'reviewing' | 'published' | 'missing' | 'unknown'; message: string }> {
  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } })
  const body = await jsonResponse(response)
  if (body.code === -404 || body.code === -400) return { state: 'reviewing', message: 'B 站暂未公开该视频（可能仍在审核）；请稍后在创作中心核实' }
  if (body.code !== 0) return { state: 'unknown', message: `B 站视频状态查询失败：${JSON.stringify(body).slice(0, 200)}` }
  const data = object(body.data)
  const state = typeof data.state === 'number' ? data.state : null
  return state === 0
    ? { state: 'published', message: 'B 站视频已通过审核并公开' }
    : { state: 'reviewing', message: `B 站视频已提交，当前状态码 ${state ?? '未知'}，仍在审核中` }
}
