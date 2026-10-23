import dns from 'node:dns/promises'
import http from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { downloadWechatImage } from '../src/wechat-image'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
afterEach(() => vi.restoreAllMocks())

it('reads embedded raster images and rejects SVG and empty data', async () => {
  expect((await downloadWechatImage(`data:image/png;base64,${png.toString('base64')}`)).buffer).toEqual(png)
  await expect(downloadWechatImage('data:image/svg+xml;base64,PHN2Zz4=')).rejects.toThrow('内嵌图片')
  await expect(downloadWechatImage('data:image/png;base64,AAAA')).rejects.toThrow('格式')
})

it.each(['http://127.1/a', 'http://10.0.0.1/a', 'http://169.254.169.254/a', 'http://[::1]/a',
  'http://[::ffff:127.0.0.1]/a', 'http://[2002:7f00:1::]/a', 'http://example.com:123/a', 'file:///a', 'https://user:pass@example.com/a'])('rejects unsafe addresses: %s', async (url) => {
  const get = vi.spyOn(http, 'get')
  await expect(downloadWechatImage(url)).rejects.toMatchObject({ code: 'wechat_image_download' })
  expect(get).not.toHaveBeenCalled()
})

it('pins public DNS, follows public redirects, and rejects private redirects, DNS, invalid files, and oversized responses', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/image' }); res.end(); return }
    if (req.url === '/private') { res.writeHead(302, { Location: 'http://127.0.0.1/secret' }); res.end(); return }
    if (req.url === '/large') { res.writeHead(200, { 'Content-Length': String(11 * 1024 * 1024) }); res.end(); return }
    if (req.url === '/chunked') { res.writeHead(200); res.end(Buffer.alloc(11 * 1024 * 1024)); return }
    if (req.url === '/missing') { res.writeHead(404); res.end(); return }
    res.end(req.url === '/invalid' ? '<html>not an image</html>' : png)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const originalGet = http.get
  const resolve = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never)
  // Use a local fixture socket only after the production DNS validator has run.
  vi.spyOn(http, 'get').mockImplementation(((url, options, callback) => {
    return originalGet(url, { ...options, port, agent: false, lookup: (host, lookupOptions, done) => {
      options.lookup(host, lookupOptions, (error, address, family) => {
        if (!error) expect(address).toEqual(lookupOptions.all ? [{ address: '93.184.216.34', family: 4 }] : '93.184.216.34')
        done(error, lookupOptions.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', family)
      })
    } }, callback)
  }) as typeof http.get)
  try {
    expect((await downloadWechatImage('http://images.example/redirect')).buffer).toEqual(png)
    for (const route of ['private', 'large', 'chunked', 'missing', 'invalid']) {
      await expect(downloadWechatImage(`http://images.example/${route}`)).rejects.toMatchObject({ code: 'wechat_image_download' })
    }
    resolve.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }] as never)
    await expect(downloadWechatImage('http://images.example/image')).rejects.toThrow('内网')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
