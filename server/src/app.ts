import { DouyinService } from './douyin'
import { PlaywrightDouyinDriver, type DouyinDriver } from './douyin-browser'
import { createDouyinRouter } from './routes/douyin'
import type { XhsDriver } from './xiaohongshu-browser'
import { createXhsRouter } from './routes/xiaohongshu'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type { AppConfig } from './config'
import type { Database } from './db'
import { createRequireAuth } from './auth'
import { createAuthRouter } from './routes/auth'
import { createBooksRouter } from './routes/books'
import { createContentsRouter } from './routes/contents'
import { createMediaRouter } from './routes/media'
import { createRendersRouter } from './routes/renders'
import { createMetaRouter } from './routes/meta'
import { createUploadsRouter } from './static'
import { errorHandler } from './errors'
import { WechatService } from './wechat'
import { PlaywrightWechatDriver, type WechatBrowserDriver } from './wechat-browser'
import { createWechatRouter } from './routes/wechat'
import { WechatpicService } from './wechatpic'
import { WechatStickerApiDriver, type WechatStickerDriver } from './wechatpic-api'
import { createWechatpicRouter } from './routes/wechatpic'
import { ZhihuService } from './zhihu'
import { PlaywrightZhihuDriver, type ZhihuDriver } from './zhihu-browser'
import { createZhihuRouter } from './routes/zhihu'
import { WeiboService } from './weibo'
import { PlaywrightWeiboDriver, type WeiboDriver } from './weibo-browser'
import { createWeiboRouter } from './routes/weibo'
import { ToutiaoService } from './toutiao'
import { PlaywrightToutiaoDriver, type ToutiaoDriver } from './toutiao-browser'
import { createToutiaoRouter } from './routes/toutiao'
import { BaijiahaoService } from './baijiahao'
import { PlaywrightBaijiahaoDriver, type BaijiahaoDriver } from './baijiahao-browser'
import { createBaijiahaoRouter } from './routes/baijiahao'
import { DoubanService } from './douban'
import { PlaywrightDoubanDriver, type DoubanDriver } from './douban-browser'
import { createDoubanRouter } from './routes/douban'
import { CsdnService } from './csdn'
import { PlaywrightCsdnDriver, type CsdnDriver } from './csdn-browser'
import { createCsdnRouter } from './routes/csdn'
import { JuejinService } from './juejin'
import { PlaywrightJuejinDriver, type JuejinDriver } from './juejin-browser'
import { createJuejinRouter } from './routes/juejin'
import { JianshuService } from './jianshu'
import { PlaywrightJianshuDriver, type JianshuDriver } from './jianshu-browser'
import { createJianshuRouter } from './routes/jianshu'
import { V2exService } from './v2ex'
import { PlaywrightV2exDriver, type V2exDriver } from './v2ex-browser'
import { createV2exRouter } from './routes/v2ex'
import { SspaiService } from './sspai'
import { PlaywrightSspaiDriver, type SspaiDriver } from './sspai-browser'
import { createSspaiRouter } from './routes/sspai'
import { BlogService } from './blog'
import { HaloBlogDriver, type BlogDriver } from './blog-halo'
import { createBlogRouter } from './routes/blog'
import { BatchService } from './batch'
import { AiService } from './ai'
import { VideoService } from './video'
import { createBatchRouter } from './routes/batch'
import { createAiRouter } from './routes/ai'
import { createVideoRouter } from './routes/video'
import { SmsLoginManager } from './sms-login'
import { createPlatformSmsRouter } from './routes/platform-sms'

function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  next()
}

function apiNotFound(_req: express.Request, res: express.Response): void {
  res.status(404).json({ error: 'not_found', message: '接口不存在' })
}

/**
 * The desktop build listens on loopback only. Reject unexpected Host/Origin
 * combinations so a browser page on another origin cannot drive the local
 * service through DNS rebinding.
 */
function desktopLoopbackGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const host = req.headers.host
  if (!host || !/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/i.test(host)) {
    res.status(403).json({ error: 'invalid_host', message: '本地服务只接受 127.0.0.1 或 localhost 访问' })
    return
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    res.status(403).json({ error: 'cross_site_request', message: '不允许跨站访问本地服务' })
    return
  }
  const origin = req.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== host) {
        res.status(403).json({ error: 'invalid_origin', message: '不允许的请求来源' })
        return
      }
    } catch {
      res.status(403).json({ error: 'invalid_origin', message: '不允许的请求来源' })
      return
    }
  }
  next()
}

function mountWebApp(app: express.Express, webDist: string): void {
  if (!existsSync(path.join(webDist, 'index.html'))) {
    console.warn(`[multipush] web dist not found at ${webDist}; API-only mode`)
    return
  }

  app.use(
    express.static(webDist, {
      index: false,
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache')
        } else if (/\/assets\//.test(filePath.replace(/\\/g, '/'))) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600')
        }
      },
    }),
  )

  app.get('*', (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
      next()
      return
    }
    const acceptsHtml = req.accepts(['html', 'json']) === 'html'
    if (!acceptsHtml) {
      next()
      return
    }
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(path.join(webDist, 'index.html'), (error) => {
      if (error) next(error)
    })
  })
}

export function createApp(config: AppConfig, database: Database, wechatDriver?: WechatBrowserDriver, zhihuDriver?: ZhihuDriver, _xhsDriver?: XhsDriver, douyinDriver?: DouyinDriver, sspaiDriver?: SspaiDriver, blogDriver?: BlogDriver, weiboDriver?: WeiboDriver, toutiaoDriver?: ToutiaoDriver, baijiahaoDriver?: BaijiahaoDriver, doubanDriver?: DoubanDriver, juejinDriver?: JuejinDriver, jianshuDriver?: JianshuDriver, wechatpicDriver?: WechatStickerDriver, csdnDriver?: CsdnDriver, v2exDriver?: V2exDriver): express.Express {
  const app = express()
  const wechat = new WechatService(database, config, wechatDriver ?? new PlaywrightWechatDriver(config))
  app.locals.wechat = wechat
  const wechatpic = new WechatpicService(database, config, wechatpicDriver ?? new WechatStickerApiDriver())
  app.locals.wechatpic = wechatpic
  const zhihu = new ZhihuService(database, config, zhihuDriver ?? new PlaywrightZhihuDriver())
  app.locals.zhihu = zhihu
  const weibo = new WeiboService(database, config, weiboDriver ?? new PlaywrightWeiboDriver())
  app.locals.weibo = weibo
  const toutiao = new ToutiaoService(database, config, toutiaoDriver ?? new PlaywrightToutiaoDriver())
  app.locals.toutiao = toutiao
  const baijiahao = new BaijiahaoService(database, config, baijiahaoDriver ?? new PlaywrightBaijiahaoDriver())
  app.locals.baijiahao = baijiahao
  const douban = new DoubanService(database, config, doubanDriver ?? new PlaywrightDoubanDriver())
  app.locals.douban = douban
  const juejin = new JuejinService(database, config, juejinDriver ?? new PlaywrightJuejinDriver())
  app.locals.juejin = juejin
  const jianshu = new JianshuService(database, config, jianshuDriver ?? new PlaywrightJianshuDriver())
  app.locals.jianshu = jianshu
  const csdn = new CsdnService(database, config, csdnDriver ?? new PlaywrightCsdnDriver())
  app.locals.csdn = csdn
  const v2ex = new V2exService(database, config, v2exDriver ?? new PlaywrightV2exDriver())
  app.locals.v2ex = v2ex
  database.clearXhsAccounts()
  const douyin = new DouyinService(database, config, douyinDriver ?? new PlaywrightDouyinDriver())
  app.locals.douyin = douyin
  const sspai = new SspaiService(database, config, sspaiDriver ?? new PlaywrightSspaiDriver())
  app.locals.sspai = sspai
  const blog = new BlogService(database, config, blogDriver ?? new HaloBlogDriver())
  app.locals.blog = blog
  const batch = new BatchService(database, config, wechat, zhihu, sspai, blog, weibo, toutiao, douban, juejin, jianshu, csdn)
  app.locals.batch = batch
  const video = new VideoService(database, config)
  app.locals.video = video
  const ai = new AiService(database, config, wechat, zhihu, sspai, blog, douyin, weibo, toutiao, douban, juejin, jianshu, csdn, batch, video)
  app.locals.ai = ai
  const smsLogin = new SmsLoginManager({
    zhihu: { importPublisherSession: (userId, state) => zhihu.importPublisherSession(userId, state) },
    weibo: { importPublisherSession: (userId, state) => weibo.importPublisherSession(userId, state) },
    toutiao: { importPublisherSession: (userId, state) => toutiao.importPublisherSession(userId, state) },
    baijiahao: { importPublisherSession: (userId, state) => baijiahao.importPublisherSession(userId, state) },
    douban: { importPublisherSession: (userId, state) => douban.importPublisherSession(userId, state) },
    juejin: { importPublisherSession: (userId, state) => juejin.importPublisherSession(userId, state) },
    douyin: { importPublisherSession: (userId, state) => douyin.importPublisherSession(userId, state) },
  })
  app.locals.smsLogin = smsLogin
  app.disable('x-powered-by')
  app.use(securityHeaders)
  if (config.desktopMode) app.use(desktopLoopbackGuard)

  if (!config.isProduction) {
    app.use(cors({ origin: true }))
  }
  app.use(express.json({ limit: '2mb' }))
  app.use(express.urlencoded({ extended: false, limit: '2mb' }))

  const requireAuth = createRequireAuth(database, config.jwtSecret)

  app.use('/uploads', createUploadsRouter(config.uploadsDir))
  app.use('/api/auth', createAuthRouter(database, config, requireAuth))
  app.use('/api/books', requireAuth, createBooksRouter(database))
  app.use('/api/contents', requireAuth, createContentsRouter(database))
  app.use('/api/media', requireAuth, createMediaRouter(database, config))
  app.use('/api', createVideoRouter(database, video, requireAuth))
  app.use('/api/renders', requireAuth, createRendersRouter(database, config))
  app.use('/api/wechat', requireAuth, createWechatRouter(wechat))
  app.use('/api/wechatpic', requireAuth, createWechatpicRouter(wechatpic))
  app.use('/api/douyin', requireAuth, createDouyinRouter(douyin))
  app.use('/api/xiaohongshu', requireAuth, createXhsRouter(database))
  app.use('/api/zhihu', requireAuth, createZhihuRouter(zhihu))
  app.use('/api/weibo', requireAuth, createWeiboRouter(weibo))
  app.use('/api/toutiao', requireAuth, createToutiaoRouter(toutiao))
  app.use('/api/baijiahao', requireAuth, createBaijiahaoRouter(baijiahao))
  app.use('/api/douban', requireAuth, createDoubanRouter(douban))
  app.use('/api/juejin', requireAuth, createJuejinRouter(juejin))
  app.use('/api/csdn', requireAuth, createCsdnRouter(csdn))
  app.use('/api/jianshu', requireAuth, createJianshuRouter(jianshu))
  app.use('/api/v2ex', requireAuth, createV2exRouter(v2ex))
  app.use('/api/sspai', requireAuth, createSspaiRouter(sspai))
  app.use('/api/blog', requireAuth, createBlogRouter(blog))
  app.use('/api/ai', requireAuth, createAiRouter(ai))
  app.use('/api/platform-sms', requireAuth, createPlatformSmsRouter(smsLogin))
  app.use('/api/batch', requireAuth, createBatchRouter(batch))
  app.use('/api', createMetaRouter(config, requireAuth))
  app.use('/api', apiNotFound)

  if (config.isProduction) {
    mountWebApp(app, config.webDist)
  }

  app.use(errorHandler)
  return app
}
