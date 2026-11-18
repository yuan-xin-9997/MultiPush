import { Router } from 'express'
import { z } from 'zod'
import { currentUser } from '../auth'
import type { AiService } from '../ai'
import { asyncHandler } from '../errors'
import { parseInput } from '../validation'

const settingsSchema = z.object({
  baseUrl: z.string().trim().min(1, '请填写接口地址').max(2048),
  apiKey: z.string().trim().min(1).max(4096).optional(),
  model: z.string().trim().min(1, '请填写模型名称').max(200),
  temperature: z.number().min(0).max(2).optional(),
}).strict()

const sessionSchema = z.object({ title: z.string().trim().max(80).optional() }).strict()
const documentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().max(100).default('text/plain'),
  size: z.number().int().min(0).max(50_000_000).optional(),
  text: z.string().max(100_000, '单个文档文本最多 10 万字符'),
}).strict()
const messageSchema = z.object({
  message: z.string().max(20_000, '单条消息最多 20000 个字符').default(''),
  mediaIds: z.array(z.uuid()).max(10, '一次最多 10 个图片或视频附件').optional(),
  documents: z.array(documentSchema).max(5, '一次最多 5 个文档附件').optional(),
}).strict().refine(input => input.message.trim().length > 0 || (input.mediaIds?.length ?? 0) + (input.documents?.length ?? 0) > 0, { message: '请输入消息或先上传附件' })

export function createAiRouter(service: AiService): Router {
  const router = Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })

  router.get('/settings', asyncHandler((req, res) => { res.json({ settings: service.settings(currentUser(req).id) }) }))
  router.put('/settings', asyncHandler((req, res) => {
    const input = parseInput(settingsSchema, req.body)
    res.json({ settings: service.saveSettings(currentUser(req).id, input) })
  }))
  router.delete('/settings', asyncHandler((req, res) => { service.deleteSettings(currentUser(req).id); res.json({ ok: true }) }))
  router.post('/settings/test', asyncHandler(async (req, res) => { res.json(await service.testSettings(currentUser(req).id)) }))

  router.get('/sessions', asyncHandler((req, res) => { res.json({ sessions: service.listSessions(currentUser(req).id) }) }))
  router.post('/sessions', asyncHandler((req, res) => {
    const input = parseInput(sessionSchema, req.body ?? {})
    res.status(201).json({ session: service.createSession(currentUser(req).id, input.title) })
  }))
  router.get('/sessions/:id', asyncHandler((req, res) => { res.json({ session: service.getSession(currentUser(req).id, req.params.id) }) }))
  router.delete('/sessions/:id', asyncHandler((req, res) => { service.deleteSession(currentUser(req).id, req.params.id); res.json({ ok: true }) }))
  router.post('/sessions/:id/messages', asyncHandler(async (req, res) => {
    const input = parseInput(messageSchema, req.body)
    res.json(await service.chat(currentUser(req).id, req.params.id, input))
  }))

  return router
}
