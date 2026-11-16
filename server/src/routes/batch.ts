import { Router } from 'express'
import type { BatchPublishInput, BatchRenderInput } from '../../../shared/types'
import { currentUser } from '../auth'
import type { BatchService } from '../batch'
import { asyncHandler } from '../errors'
import { batchPublishSchema, batchRenderSchema, parseInput } from '../validation'

function baseUrl(req: import('express').Request): string {
  return `${req.protocol}://${req.get('host')}`
}

export function createBatchRouter(service: BatchService): Router {
  const router = Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })

  router.get('/jobs', asyncHandler((req, res) => {
    res.json({ jobs: service.list(currentUser(req).id) })
  }))

  router.get('/jobs/:id', asyncHandler((req, res) => {
    res.json({ job: service.get(currentUser(req).id, req.params.id) })
  }))

  router.post('/render', asyncHandler((req, res) => {
    const input = parseInput(batchRenderSchema, req.body) as BatchRenderInput
    res.status(202).json({ job: service.createRenderJob(currentUser(req).id, input, baseUrl(req)) })
  }))

  router.post('/publish', asyncHandler((req, res) => {
    const input = parseInput(batchPublishSchema, req.body) as BatchPublishInput
    res.status(202).json({ job: service.createPublishJob(currentUser(req).id, input, baseUrl(req)) })
  }))

  return router
}
