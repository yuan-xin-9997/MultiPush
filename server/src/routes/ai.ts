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
const messageSchema = z.object({ message: z.string().trim().min(1, '请输入消息').max(20_000, '单条消息最多 20000 个字符') }).strict()

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
    res.json(await service.chat(currentUser(req).id, req.params.id, input.message))
  }))

  return router
}
