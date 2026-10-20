import { z } from 'zod'
import type { ApiErrorIssue } from './errors'
import { ApiError } from './errors'

const usernameSchema = z
  .string()
  .trim()
  .min(3, '用户名至少 3 个字符')
  .max(24, '用户名最多 24 个字符')
  .regex(/^[A-Za-z0-9_\u4e00-\u9fff]+$/, '用户名只能包含字母、数字、下划线或汉字')

const emailSchema = z
  .string()
  .trim()
  .max(254, '邮箱地址过长')
  .email('请输入有效的邮箱地址')
  .transform((value) => value.toLowerCase())

const passwordSchema = z.string().min(8, '密码至少 8 个字符').max(128, '密码最多 128 个字符')

const displayNameSchema = z.string().trim().max(50, '昵称最多 50 个字符')

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
})

export const loginSchema = z.object({
  account: z.string().trim().min(1, '请输入用户名或邮箱').max(254, '账号过长'),
  password: z.string().min(1, '请输入密码').max(128, '密码过长'),
})

export const updateProfileSchema = z.object({
  displayName: displayNameSchema.optional(),
  avatarUrl: z.string().trim().max(2048, '头像地址过长').nullable().optional(),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码').max(128, '密码过长'),
  newPassword: passwordSchema,
})

const bookNameSchema = z.string().trim().min(1, '请输入知识库名称').max(80, '知识库名称最多 80 个字符')
const bookDescriptionSchema = z.string().trim().max(500, '描述最多 500 个字符')
const bookColorSchema = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, '颜色格式应为 #RRGGBB')

export const createBookSchema = z.object({
  name: bookNameSchema,
  description: bookDescriptionSchema.optional(),
  color: bookColorSchema.optional(),
})

export const updateBookSchema = z
  .object({
    name: bookNameSchema.optional(),
    description: bookDescriptionSchema.optional(),
    color: bookColorSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要更新的字段' })

const contentJsonSchema = z.record(z.string(), z.unknown())
const contentTagsSchema = z.array(z.string().max(200))

export const contentInputSchema = z.object({
  title: z.string().max(500, '标题最多 500 个字符').optional(),
  bookId: z.string().trim().min(1, '知识库 ID 不能为空').max(100).nullable().optional(),
  contentJson: contentJsonSchema.optional(),
  contentHtml: z.string().optional(),
  excerpt: z.string().max(5000, '摘要最多 5000 个字符').optional(),
  coverImage: z.string().trim().max(2048, '封面地址过长').nullable().optional(),
  tags: contentTagsSchema.optional(),
  status: z.enum(['draft', 'ready']).optional(),
  favorite: z.boolean().optional(),
})

const booleanQuery = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return value
}, z.boolean().optional())

export const contentListQuerySchema = z.object({
  bookId: z.string().trim().max(100).optional(),
  favorite: booleanQuery,
  trash: booleanQuery,
  q: z.string().trim().max(200, '搜索关键词最多 200 个字符').optional(),
  sort: z.enum(['updated_desc', 'created_desc', 'title_asc']).optional().default('updated_desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const permanentQuerySchema = z.object({
  permanent: booleanQuery,
})

export const favoriteBodySchema = z.object({
  favorite: z.boolean(),
})

const platformSchema = z.enum(['wechat', 'xiaohongshu', 'zhihu', 'douyin'])

export const renderOptionsSchema = z.object({
  cardStyle: z.enum(['clean', 'warm', 'bold']).optional(),
  themeColor: z
    .string()
    .trim()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, '主题色格式应为 #RGB 或 #RRGGBB')
    .optional(),
  includeToc: z.boolean().optional(),
  includeTags: z.boolean().optional(),
  authorName: z.string().trim().max(100, '作者名最多 100 个字符').optional(),
  accountName: z.string().trim().max(100, '账号名最多 100 个字符').optional(),
})

export const renderRequestSchema = z.object({
  contentId: z.string().trim().min(1, '请选择要渲染的内容').max(100),
  platforms: z
    .array(platformSchema)
    .min(1, '请至少选择一个平台')
    .max(4, '最多选择四个平台')
    .transform((platforms) => [...new Set(platforms)]),
  options: renderOptionsSchema.optional(),
})

export const renderListQuerySchema = z.object({
  contentId: z.string().trim().max(100).optional(),
})

export function zodIssues(error: z.ZodError): ApiErrorIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.') || '(root)',
    message: issue.message,
  }))
}

/** Parse input with a zod schema, translating failures into a 400 ApiError. */
export function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new ApiError(400, 'validation_failed', '请求参数有误', zodIssues(result.error))
  }
  return result.data
}
