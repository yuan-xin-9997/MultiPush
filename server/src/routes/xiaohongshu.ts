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
  router.delete('/publications/:id', asyncHandler((req, res) => {
    const userId = currentUser(req).id
    const publication = database.getXhsPublication(userId, req.params.id)
    if (!publication) throw notFound('小红书发布记录不存在')
    if (publication.status === 'running') throw new ApiError(409, 'xiaohongshu_delete_busy', '小红书任务正在处理，请等待完成后再删除')
    if (publication.status === 'uncertain') throw new ApiError(409, 'xiaohongshu_delete_uncertain', '请先核实这条小红书任务的结果，再删除发布记录')
    if (publication.status === 'published') throw new ApiError(409, 'xiaohongshu_delete_published', '已发布的小红书笔记不能通过这里删除；如需删除请到小红书后台操作')
    if (!database.deleteXhsPublication(userId, req.params.id)) throw notFound('小红书发布记录不存在')
    res.json({ ok: true, remoteDeleted: false })
  }))
  router.use(() => { throw new ApiError(410, 'xiaohongshu_automation_disabled', '小红书自动登录与发布已停用，请导出图片和文案后在官方 App 或创作中心手动发布') })
  return router
}
