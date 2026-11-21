# 个人博客（Halo）登录与发布

状态：已实现，并使用真实 Halo 2.26 实例验证了令牌连接、草稿创建、草稿续写更新、附件上传、私有文章发布与回读、清理流程；没有创建公开测试文章。

个人博客发布使用 Halo 2.x 的 Console REST API，不需要 Playwright 或浏览器，也不采集博客管理员密码。

## 连接方式

1. 在 Halo 后台「个人中心 → 个人令牌」创建一个个人令牌，至少需要文章和附件的读写权限。
2. 在 MultiPush「发布管理 → 个人博客」点击「连接个人博客」，填写博客地址和令牌。
3. 地址应填写 Halo 实际对外提供 API 的源站。系统会跟随一次首页重定向以采用规范域名；若站点会把 `https://yuan-xin.top` 重定向到 `https://www.yuan-xin.top`，直接填写 `https://www.yuan-xin.top` 最稳妥，因为跨域重定向会丢失认证头。
4. 系统调用 `GET /apis/api.console.halo.run/v1alpha1/users/-` 验证令牌，验证通过后才保存连接。

每个 MultiPush 用户保存一套独立的博客地址和令牌。令牌使用 AES-256-GCM 加密后写入 `blog_accounts`，加密绑定 MultiPush 用户 ID，密钥位于 `DATA_DIR/.blog-session-key`。令牌不会返回浏览器，也不会写入日志或发布记录。断开连接只删除本系统保存的地址和令牌，不撤销 Halo 中的令牌，也不会删除博客文章；需要撤销令牌时请在 Halo 后台操作。

## 正文与图片

- 使用当前用户保存的个人博客独立排版；原文已修改或删除时，要求重新生成排版。
- 标题 1–120 字，正文 HTML 最多 1 MB、图片最多 200 张。支持每张最多 10 MB 的 PNG/JPEG/GIF/WebP。
- 当前不发布视频、音频、SVG 和 iframe；编辑器中的这些内容会在发布前被拒绝。
- 正文图片先校验素材归属与实际文件格式；外链图片按公网 DNS 校验后下载，不携带登录凭据、不访问内网。
- 图片通过 Halo Console 附件上传接口转存到博客附件库，正文中的图片地址替换为 Halo 返回的 `/upload/...` 永久链接；封面同样转存。
- 正文会去掉内联样式、编辑器 class、重复的页面级 H1 和自动目录，保留标题层级、列表、引用、代码、表格、链接和图片。
- 先读取 Halo 已有标签并按显示名匹配，只写入已有标签，避免自动创建大量标签；未匹配的标签不会发布。

## 发布与核验

- 草稿：`POST /apis/api.console.halo.run/v1alpha1/posts` 创建文章，返回 `metadata.name`；随后读取 `head-content` 核对标题、正文、图片、列表、链接和表格。
- 续写：已有草稿再次提交时优先通过 `PUT /apis/api.console.halo.run/v1alpha1/posts/{name}` 更新原草稿，不重复创建。
- 发布：调用 `PUT /apis/api.console.halo.run/v1alpha1/posts/{name}/publish?async=false`，轮询文章直到 `spec.publish=true` 且 `status.phase=PUBLISHED`，再读取 `release-content` 核对已发布正文，最后使用 `status.permalink` 生成文章链接。
- 保存或发布后内容不一致时停止操作并保留草稿；结果无法确认时标记「结果待核实」，不自动重发。
- 同一账号、原文、模式、标题、正文、标签和图片内容参与幂等判断；服务重启时运行中的任务会标记为待核实。

## 结果待核实后的继续操作

- 「重新自动核实」：只读查询文章状态；确认 `PUBLISHED` 才关联为已发布。
- 「我已核实，未发布」：解除限制，允许再次提交，优先复用原草稿；确认本身不触发发布。
- 「我已核实，已发布」：填写当前博客域名下的文章链接并关联，不再次发送文章。

## API

所有接口均要求 MultiPush Bearer JWT，响应使用 `Cache-Control: no-store`。博客令牌失效返回 `409 blog_auth_failed`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/blog/account` | 查询连接状态、博客名称和地址 |
| `POST /api/blog/connect` | 提交 `{baseUrl, token}`，验证并保存 |
| `DELETE /api/blog/account` | 断开连接 |
| `POST /api/blog/publications` | 提交 `{renderId, mode: "draft"或"publish", coverMediaId?}` |
| `GET /api/blog/publications` | 当前用户最近 50 条记录 |
| `GET /api/blog/publications/:id` | 查询进度、草稿或文章链接 |
| `DELETE /api/blog/publications/:id` | 删除草稿或失败记录：草稿会同步删除 Halo 后台草稿；已发布、处理中和结果待核实记录不可删除 |
| `POST /api/blog/publications/:id/resolve` | `{action:"check"}` 异步复查；`{action:"not_published"}` 人工确认未发布；`{action:"published",articleUrl}` 人工关联已发布文章 |

## 验证

- 单元测试覆盖 URL/令牌校验、用户隔离、加密绑定、幂等、待核实处理、重启恢复和正文准备/回读核对：`npx vitest run test/blog.test.ts`。
- 页面回归：先 `npm run build:web`，再运行 `node scripts/smoke-blog-publish.mjs`，使用隔离 fixture，不访问真实博客。
- 真实实例联调：使用真实令牌创建草稿，检查 Halo 后台显示，再执行一次私有文章发布并立即清理；不要在生产博客上留下测试文章或附件。

## 已知限制

- 只支持 Halo 2.x；Halo 1.x 或非 Halo 博客不适用。
- 只使用已有标签，不会自动创建标签；分类需要在 Halo 后台设置。
- 不支持定时发布、付费文章、置顶、自定义模板和 HTML meta 设置。
- Halo 的 Console API 和附件接口没有稳定性承诺，升级 Halo 后可能需要更新适配。
