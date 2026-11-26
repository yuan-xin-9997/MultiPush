import { Router } from 'express'
import type { ContentWriteValues } from '../db'
import type { ContentDetail, ContentInput, ContentKind } from '../../../shared/types'
import { currentUser } from '../auth'
import { defaultContentTitle, deriveContentMetrics, normalizeTags } from '../content-utils'
import { contentHtmlHash, tiptapJsonToHtml } from '../tiptap-html'
import type { Database } from '../db'
import { asyncHandler, notFound } from '../errors'
import {
  contentInputSchema,
  contentListQuerySchema,
  favoriteBodySchema,
  parseInput,
  permanentQuerySchema,
} from '../validation'

function normalizeContentKind(value: ContentKind | undefined): ContentKind {
  if (value === 'video') return 'video'
  if (value === 'gallery') return 'gallery'
  return 'article'
}

function resolveBookId(database: Database, userId: string, bookId: string | null): string | null {
  if (bookId === null) return null
  if (!database.getBook(userId, bookId)) throw notFound('合集不存在')
  return bookId
}

function createValues(database: Database, userId: string, input: ContentInput): ContentWriteValues {
  const contentJson = input.contentJson ?? {}
  // API clients may send only one representation. JSON is the structured
  // source when HTML is absent; HTML without JSON is kept and flagged stale by
  // the database so the editor never prefers an old JSON snapshot.
  const contentHtml = input.contentHtml ?? (input.contentJson !== undefined ? tiptapJsonToHtml(contentJson) : '')
  const metrics = deriveContentMetrics({
    contentHtml,
    contentJson,
    excerpt: input.excerpt,
  })
  return {
    title: defaultContentTitle(input.title),
    kind: normalizeContentKind(input.kind),
    bookId: input.bookId ? resolveBookId(database, userId, input.bookId) : null,
    contentJson,
    contentHtml,
    contentHtmlHash: contentHtmlHash(contentHtml),
    contentJsonStale: input.contentHtml !== undefined && input.contentJson === undefined && contentHtml.trim().length > 0,
    excerpt: metrics.excerpt,
    coverImage: input.coverImage ?? null,
    tags: normalizeTags(input.tags),
    status: input.status ?? 'draft',
    favorite: input.favorite ?? false,
    wordCount: metrics.wordCount,
    imageCount: metrics.imageCount,
    // Video clips are tracked by the timeline, not by scanning body HTML.
    videoCount: input.kind === 'video' ? 0 : metrics.videoCount,
  }
}

function updateValues(
  database: Database,
  userId: string,
  current: ContentDetail,
  input: ContentInput,
): ContentWriteValues {
  const hasHtml = input.contentHtml !== undefined
  const hasJson = input.contentJson !== undefined
  let contentHtml = hasHtml ? input.contentHtml! : current.contentHtml
  const contentJson = hasJson ? input.contentJson! : current.contentJson
  let contentHtmlHashValue = current.contentHtmlHash ?? contentHtmlHash(current.contentHtml)
  let contentJsonStale = current.contentJsonStale === true
  if (hasJson && !hasHtml) {
    // A JSON-only PATCH is authoritative; rebuild the HTML used by renderers
    // instead of leaving them on a stale body.
    contentHtml = tiptapJsonToHtml(contentJson)
    contentHtmlHashValue = contentHtmlHash(contentHtml)
    contentJsonStale = false
  } else if (hasHtml && !hasJson) {
    if (contentHtml !== current.contentHtml) {
      // Keep the previous checksum so GET can detect the mismatch even after
      // a process restart; the explicit flag is an additional safety net.
      contentJsonStale = true
    }
  } else if (hasHtml && hasJson) {
    contentHtmlHashValue = contentHtmlHash(contentHtml)
    contentJsonStale = false
  }
  const contentChanged = hasHtml || hasJson
  const metrics =
    contentChanged || input.excerpt !== undefined
      ? deriveContentMetrics({
          contentHtml,
          contentJson,
          excerpt: input.excerpt,
        })
      : {
          excerpt: current.excerpt,
          wordCount: current.wordCount,
          imageCount: current.imageCount,
          videoCount: current.videoCount,
        }

  return {
    title: input.title !== undefined ? defaultContentTitle(input.title) : current.title,
    kind: current.kind,
    bookId:
      input.bookId !== undefined
        ? input.bookId === null
          ? null
          : resolveBookId(database, userId, input.bookId)
        : current.bookId,
    contentJson,
    contentHtml,
    contentHtmlHash: contentHtmlHashValue,
    contentJsonStale,
    excerpt: metrics.excerpt,
    coverImage: input.coverImage !== undefined ? input.coverImage : current.coverImage,
    tags: input.tags !== undefined ? normalizeTags(input.tags) : current.tags,
    status: input.status ?? current.status,
    favorite: input.favorite ?? current.favorite,
    wordCount: metrics.wordCount,
    imageCount: metrics.imageCount,
    // Timeline clips (video contents) are managed by the video routes and
    // must survive body edits.
    videoCount: current.kind === 'video' ? current.videoCount : metrics.videoCount,
  }
}

export function createContentsRouter(database: Database): Router {
  const router = Router()

  router.get(
    '/',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const query = parseInput(contentListQuerySchema, req.query)
      const result = database.listContents(user.id, {
        bookId: query.bookId,
        favorite: query.favorite ?? false,
        trash: query.trash ?? false,
        q: query.q && query.q.length > 0 ? query.q : undefined,
        kind: query.kind,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      })
      res.json(result)
    }),
  )

  router.post(
    '/',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const input = parseInput(contentInputSchema, req.body) as ContentInput
      const content = database.createContent(user.id, createValues(database, user.id, input))
      res.json({ content })
    }),
  )

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const content = database.getContentDetail(user.id, req.params.id)
      if (!content) throw notFound('内容不存在')
      res.json({ content })
    }),
  )

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const current = database.getContentDetail(user.id, req.params.id)
      if (!current) throw notFound('内容不存在')
      const input = parseInput(contentInputSchema, req.body) as ContentInput
      const updated = database.updateContent(user.id, current.id, updateValues(database, user.id, current, input))
      if (!updated) throw notFound('内容不存在')
      res.json({ content: updated })
    }),
  )

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const content = database.getContentDetail(user.id, req.params.id)
      if (!content) throw notFound('内容不存在')
      const query = parseInput(permanentQuerySchema, req.query)
      if (query.permanent) {
        database.permanentlyDeleteContent(user.id, content.id)
      } else if (!content.deletedAt) {
        database.softDeleteContent(user.id, content.id)
      }
      res.json({ ok: true })
    }),
  )

  router.post(
    '/:id/restore',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const content = database.getContentDetail(user.id, req.params.id)
      if (!content) throw notFound('内容不存在')
      if (content.deletedAt) database.restoreContent(user.id, content.id)
      const summary = database.getContentSummary(user.id, content.id)
      if (!summary) throw notFound('内容不存在')
      res.json({ content: summary })
    }),
  )

  router.post(
    '/:id/duplicate',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const original = database.getContentDetail(user.id, req.params.id)
      if (!original) throw notFound('内容不存在')
      const copy = database.createContent(user.id, {
        title: `${original.title}（副本）`,
        kind: original.kind,
        bookId: original.bookId,
        contentJson: original.contentJson,
        contentHtml: original.contentHtml,
        contentHtmlHash: original.contentHtmlHash,
        contentJsonStale: original.contentJsonStale,
        excerpt: original.excerpt,
        coverImage: original.coverImage,
        tags: original.tags,
        status: original.status,
        favorite: original.favorite,
        wordCount: original.wordCount,
        imageCount: original.imageCount,
        videoCount: original.videoCount,
      })
      // Video contents carry their clip timeline over to the copy.
      database.copyVideoProject(user.id, original.id, copy.id)
      res.json({ content: copy })
    }),
  )

  router.post(
    '/:id/favorite',
    asyncHandler((req, res) => {
      const user = currentUser(req)
      const input = parseInput(favoriteBodySchema, req.body)
      const content = database.getContentDetail(user.id, req.params.id)
      if (!content) throw notFound('内容不存在')
      database.setContentFavorite(user.id, content.id, input.favorite)
      const summary = database.getContentSummary(user.id, content.id)
      if (!summary) throw notFound('内容不存在')
      res.json({ content: summary })
    }),
  )

  return router
}
