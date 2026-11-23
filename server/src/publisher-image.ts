import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { ApiError } from './errors'
import { isPublicAddress } from './network-guard'
export interface PublisherImage { name: string; mimeType: string; buffer: Buffer }

const MAX_BYTES = 10 * 1024 * 1024

export function publisherImage(buffer: Buffer, webp = false): PublisherImage {
  if (!buffer.length || buffer.length > MAX_BYTES) throw new Error('图片为空或超过 10 MB')
  const ext = buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png'
    : buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff ? 'jpg'
      : /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii')) ? 'gif'
        : webp && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null
  if (!ext) throw new Error('图片请使用 JPG、PNG 或 GIF 格式')
  return { name: `body.${ext}`, mimeType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, buffer }
}

/** No cookies or credentials; pin validated DNS addresses and recheck every redirect. */
export async function downloadPublisherImage(src: string, platform: 'wechat' | 'zhihu' | 'weibo' | 'toutiao' | 'baijiahao' | 'douban' | 'jianshu' | 'sspai' | 'blog' = 'wechat'): Promise<PublisherImage> {
  try {
    if (/^data:/i.test(src)) {
      if (src.length > MAX_BYTES * 1.4) throw new Error('图片超过 10 MB')
      const match = /^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/=\s]+)$/i.exec(src)
      if (!match) throw new Error('不支持的内嵌图片格式')
      return publisherImage(Buffer.from(match[2], 'base64'), platform !== 'wechat')
    }
    const signal = AbortSignal.timeout(20_000)
    let url = new URL(src)
    for (let redirects = 0; redirects <= 3; redirects++) {
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))
        || (isIP(hostname) && !isPublicAddress(hostname))) throw new Error('图片地址必须是公网 HTTP/HTTPS 地址')
      const result = await new Promise<Buffer | URL>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).get(url, {
          signal,
          lookup: (host, options, callback) => {
            void dns.lookup(host, { all: true }).then((addresses) => {
              if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
                callback(new Error('图片域名不能指向内网地址'), '', 4)
              } else if (options.all) callback(null, addresses)
              else callback(null, addresses[0].address, addresses[0].family)
            }, (error: Error) => callback(error, '', 4))
          },
        }, (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
            response.destroy()
            try { resolve(new URL(response.headers.location, url)) } catch (error) { reject(error) }
            return
          }
          if (response.statusCode !== 200 || Number(response.headers['content-length']) > MAX_BYTES) {
            response.destroy()
            reject(new Error(response.statusCode === 200 ? '图片超过 10 MB' : `图片服务器返回 HTTP ${response.statusCode}`))
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BYTES) { response.destroy(new Error('图片超过 10 MB')); return }
            chunks.push(chunk)
          })
          response.on('end', () => resolve(Buffer.concat(chunks)))
          response.on('error', reject)
        })
        request.on('error', reject)
      })
      if (Buffer.isBuffer(result)) return publisherImage(result, platform !== 'wechat')
      url = result
    }
    throw new Error('图片重定向次数过多')
  } catch (error) {
    throw new ApiError(400, `${platform}_image_download`, `正文图片读取失败：${error instanceof Error ? error.message : '下载失败'}。请检查图片链接或在编辑器上传后重试`)
  }
}
