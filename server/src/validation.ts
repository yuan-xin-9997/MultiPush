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
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, '密码最多 72 字节（汉字通常占 3 字节）')

const displayNameSchema = z.string().trim().max(50, '昵称最多 50 个字符')

const codeSchema = z.string().trim().regex(/^\d{6}$/, '请输入六位邮箱验证码')
export const emailCodeSchema = z.object({ email: emailSchema, purpose: z.enum(['register', 'bind', 'reset']) })
export const bindEmailSchema = z.object({ email: emailSchema, code: codeSchema })
export const resetPasswordSchema = bindEmailSchema.extend({ newPassword: passwordSchema })

export const registerSchema = z.object({
  code: codeSchema,
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
})

/** Local desktop accounts are not backed by SMTP, so no verification code is required. */
export const desktopRegisterSchema = registerSchema.extend({
  code: z.string().max(16).optional(),
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
  kind: z.enum(['article', 'gallery', 'video']).optional(),
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
  kind: z.enum(['article', 'gallery', 'video']).optional(),
  sort: z.enum(['updated_desc', 'created_desc', 'title_asc']).optional().default('updated_desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const mediaListQuerySchema = z.object({
  kind: z.enum(['image', 'video', 'document']).optional(),
  q: z.string().trim().max(200, '搜索关键词最多 200 个字符').optional(),
  folderId: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
})

const mediaFolderNameSchema = z.string().trim().min(1, '请输入文件夹名称').max(40, '文件夹名称最多 40 个字符')
export const mediaStatsQuerySchema = z.object({
  folderId: z.string().trim().min(1).max(100).optional(),
})
export const mediaFolderInputSchema = z.object({ name: mediaFolderNameSchema })
export const mediaMoveInputSchema = z.object({ folderId: z.string().trim().min(1).max(100).nullable() })

const clipTrimSchema = z.number().min(0, '剪辑起点不能为负').max(86_400, '剪辑起点最大 24 小时')
const clipDurationSchema = z.number().min(0.05, '片段最短 0.05 秒').max(86_400, '片段最长 24 小时')

export const videoTimelineSchema = z.object({
  clips: z.array(
    z.object({
      mediaId: z.string().trim().min(1, '视频素材 ID 不能为空').max(100),
      trimStart: clipTrimSchema.optional(),
      trimEnd: clipDurationSchema.nullable().optional(),
      duration: clipDurationSchema.nullable().optional(),
    }),
  ).max(60, '时间线最多 60 个片段'),
})

export const videoExportParamsSchema = z.object({ id: z.string().max(100), exportId: z.string().max(100) })
export const videoContentParamsSchema = z.object({ id: z.string().max(100) })
export const videoExportListQuerySchema = z.object({}).partial()

export const permanentQuerySchema = z.object({
  permanent: booleanQuery,
})

export const favoriteBodySchema = z.object({
  favorite: z.boolean(),
})

const platformSchema = z.enum(['wechat', 'wechatpic', 'xiaohongshu', 'zhihu', 'weibo', 'toutiao', 'baijiahao', 'douban', 'juejin', 'csdn', 'jianshu', 'v2ex', 'douyin', 'sspai', 'blog'])
const mediaUrlSchema = z.string().max(2048).refine((value) => /^(https?:\/\/|\/uploads\/|data:image\/(png|jpeg|webp|gif);base64,)/i.test(value), '图片地址无效')
export const renderPlatformParamsSchema = z.object({ id: z.string().max(100), platform: platformSchema })
export const platformAdjustmentSchema = z.object({
  title: z.string().trim().min(1, '请输入标题').max(500),
  html: z.string().max(1_000_000).optional(),
  body: z.string().max(100_000).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(10),
  cards: z.array(z.object({
    id: z.string().min(1).max(100), type: z.enum(['cover', 'content', 'quote', 'end']),
    index: z.number().int().min(1), total: z.number().int().min(1),
    title: z.string().max(500), body: z.array(z.string().max(100_000)).max(1000),
    images: z.array(mediaUrlSchema).max(2), footer: z.string().max(200),
    imagePosition: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }).optional(),
  })).min(1).max(1000).refine((cards) => new Set(cards.map((card) => card.id)).size === cards.length, '卡片 ID 重复').optional(),
})

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
    .max(14, '最多选择十四个平台')
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

export const batchRenderSchema = z.object({
  contentIds: z.array(z.string().trim().min(1, '内容 ID 不能为空').max(100)).min(1, '请选择要批量渲染的内容').max(30, '一次最多批量渲染 30 篇内容'),
  platforms: z
    .array(platformSchema)
    .min(1, '请至少选择一个平台')
    .max(14, '最多选择十四个平台')
    .transform((platforms) => [...new Set(platforms)]),
  options: renderOptionsSchema.optional(),
}).strict()

export const batchPublishSchema = z.object({
  contentIds: z.array(z.string().trim().min(1, '内容 ID 不能为空').max(100)).min(1, '请选择要批量发布的内容').max(10, '一次最多批量发布 10 篇内容'),
  platform: z.enum(['wechat', 'zhihu', 'weibo', 'toutiao', 'douban', 'juejin', 'csdn', 'jianshu', 'sspai', 'blog'], { message: '该平台暂不支持批量发布' }),
  mode: z.enum(['draft', 'publish']),
  coverMediaId: z.uuid().optional(),
  options: renderOptionsSchema.optional(),
}).strict()

const wechatAppIdSchema = z.string().trim().regex(/^wx[0-9a-fA-F]{16}$/, 'AppID 格式不正确，应以 wx 开头并共 18 位，可在微信开发者平台「我的业务 → 公众号/服务号 → 基础信息」查看')
const wechatAppSecretSchema = z.string().trim().regex(/^[0-9a-fA-F]{32}$/, 'AppSecret 格式不正确，应为 32 位字母或数字，可在微信开发者平台「我的业务 → 公众号/服务号 → 基础信息 → 开发密钥」查看')

export const wechatpicConnectSchema = z.object({
  appId: wechatAppIdSchema,
  appSecret: wechatAppSecretSchema,
}).strict()

export const wechatpicPublishSchema = z.object({
  renderId: z.uuid(),
}).strict()
