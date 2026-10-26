import { Router } from 'express'
import { currentUser } from '../auth'
import type { Database } from '../db'
import { ApiError, asyncHandler, notFound } from '../errors'

/** Local records only: this router must never open a Xiaohongshu browser. */
export function createXhsRouter(database: Database): Router {
  const router = Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  router.get('/account', (_req, res) => { res.json({ account: { status: 'disconnected', name: null, checkedAt: null }, disabled: true }) })
  router.delete('/account', (req, res) => { database.deleteXhsAccount(currentUser(req).id); res.json({ ok: true }) })
  router.get('/publications', (req, res) => { res.json({ publications: database.listXhsPublications(currentUser(req).id) }) })
  router.get('/publications/:id', asyncHandler((req, res) => {
    const publication = database.getXhsPublication(currentUser(req).id, req.params.id)
    if (!publication) throw notFound('小红书发布记录不存在')
    res.json({ publication })
  }))
  router.use(() => { throw new ApiError(410, 'xiaohongshu_automation_disabled', '小红书自动登录与发布已停用，请导出图片和文案后在官方 App 或创作中心手动发布') })
  return router
}
