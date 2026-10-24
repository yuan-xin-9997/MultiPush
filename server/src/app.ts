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
import { ZhihuService } from './zhihu'
import { PlaywrightZhihuDriver, type ZhihuDriver } from './zhihu-browser'
import { createZhihuRouter } from './routes/zhihu'

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

export function createApp(config: AppConfig, database: Database, wechatDriver?: WechatBrowserDriver, zhihuDriver?: ZhihuDriver): express.Express {
  const app = express()
  const wechat = new WechatService(database, config, wechatDriver ?? new PlaywrightWechatDriver())
  app.locals.wechat = wechat
  const zhihu = new ZhihuService(database, config, zhihuDriver ?? new PlaywrightZhihuDriver())
  app.locals.zhihu = zhihu
  app.disable('x-powered-by')
  app.use(securityHeaders)

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
  app.use('/api/renders', requireAuth, createRendersRouter(database, config))
  app.use('/api/wechat', requireAuth, createWechatRouter(wechat))
  app.use('/api/zhihu', requireAuth, createZhihuRouter(zhihu))
  app.use('/api', createMetaRouter(config, requireAuth))
  app.use('/api', apiNotFound)

  if (config.isProduction) {
    mountWebApp(app, config.webDist)
  }

  app.use(errorHandler)
  return app
}
