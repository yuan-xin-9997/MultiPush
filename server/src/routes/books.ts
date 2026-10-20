import { Router } from 'express'
import type { BookInput } from '../../../shared/types'
import { currentUser } from '../auth'
import { DEFAULT_BOOK_COLOR } from '../config'
import type { Database } from '../db'
import { asyncHandler, notFound } from '../errors'
import { createBookSchema, parseInput, updateBookSchema } from '../validation'

export function createBooksRouter(database: Database): Router {
  const router = Router()

  router.get(
    '/',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      res.json({ books: database.listBooks(user.id) })
    }),
  )

  router.post(
    '/',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const input = parseInput(createBookSchema, req.body)
      const book = database.createBook(user.id, {
        name: input.name,
        description: input.description ?? '',
        color: input.color ?? DEFAULT_BOOK_COLOR,
      })
      res.json({ book })
    }),
  )

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const input = parseInput(updateBookSchema, req.body) as Partial<BookInput>
      const book = database.updateBook(user.id, req.params.id, {
        name: input.name,
        description: input.description,
        color: input.color,
      })
      if (!book) throw notFound('知识库不存在')
      res.json({ book })
    }),
  )

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const removed = database.deleteBook(user.id, req.params.id)
      if (!removed) throw notFound('知识库不存在')
      res.json({ ok: true })
    }),
  )

  return router
}
