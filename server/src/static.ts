import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import path from 'node:path'
import { UPLOAD_FILENAME_PATTERN } from './upload'

const CACHE_HEADER = 'public, max-age=31536000, immutable'

function sendNotFound(res: Response): void {
  res.status(404).json({ error: 'not_found', message: '文件不存在' })
}

/**
 * Unauthenticated media endpoint. Filenames are random UUIDs (capability
 * URLs); path traversal is rejected before touching the filesystem and
 * express.sendFile handles Content-Type, ETag, Range and conditional requests.
 */
export function createUploadsRouter(uploadsDir: string): Router {
  const router = Router()
  const root = path.resolve(uploadsDir)

  router.get('/:filename', (req: Request, res: Response, next: NextFunction) => {
    const filename = req.params.filename
    if (!filename || !UPLOAD_FILENAME_PATTERN.test(filename) || filename.includes('..')) {
      sendNotFound(res)
      return
    }
    const absolute = path.resolve(root, filename)
    if (path.dirname(absolute) !== root || path.basename(absolute) !== filename) {
      sendNotFound(res)
      return
    }

    // Keep the filename as the lookup path relative to the uploads root.
    // `dotfiles: 'allow'` is required because production data lives under
    // `.data`, and passing the absolute path would make `send` reject every
    // file merely for having a dotted ancestor directory.
    res.sendFile(
      filename,
      {
        root,
        dotfiles: 'allow',
        cacheControl: false,
        lastModified: true,
        etag: true,
        headers: {
          'Cache-Control': CACHE_HEADER,
          'X-Content-Type-Options': 'nosniff',
          // Also isolate previously uploaded SVG files when opened directly.
          'Content-Security-Policy': "sandbox; script-src 'none'; object-src 'none'",
          // Uploaded files are unauthenticated capability URLs. Allow the
          // export flow to fetch them when the app is opened through another
          // hostname (LAN IP, Tailscale, reverse proxy) than the render was
          // originally generated with.
          'Access-Control-Allow-Origin': '*',
        },
      },
      (error) => {
        if (!error) return
        if (res.headersSent) {
          next(error)
          return
        }
        const status = (error as { statusCode?: number }).statusCode
        if (status === 404 || status === 400) sendNotFound(res)
        else next(error)
      },
    )
  })

  return router
}
