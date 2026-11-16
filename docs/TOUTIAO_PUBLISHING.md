# 今日头条渲染与发布

状态：渲染、扫码登录和发布页面已实现并通过模拟测试；真实今日头条登录页二维码已验证，正式文章发布尚未用真实头条号完成端到端验证（当前环境没有可用头条号账号）。

## 渲染

今日头条以推荐流图文文章呈现。MultiPush 使用头条号图文排版：

- 标题 2–30 字，超长自动截断并提示；
- 正文支持标题层级、列表、引用、代码、表格、图片和链接；
- 正文 HTML 最多 1 MB；视频、音频、iframe、SVG 暂不在自动发布范围内；
- 提供今日头条 HTML 与 Markdown 下载；
- 预览使用桌面文章卡片模拟头条号图文页。

## 登录

在「发布管理 → 今日头条」点击「扫码连接今日头条」，系统打开头条号官方登录页 `https://mp.toutiao.com/auth/page/login`，读取官方二维码并展示在系统内。

- 使用今日头条 App 扫码并在手机上确认；
- 扫码登录后 `/mp/agw/media/user_login_status_api` 只返回 `is_login: true`（`user`/`media` 为空），账号 ID 与昵称改从 `GET /mp/agw/media/get_media_info` 读取；该接口失败不阻塞登录，昵称回退为「今日头条作者」；
- 二维码扫码后页面提示「登录成功」并跳转，界面同步显示已扫描/正在读取账号信息；
- 浏览器 Cookie/localStorage 使用 AES-256-GCM 加密保存，密钥位于 `DATA_DIR/.toutiao-session-key`，加密绑定 MultiPush 用户 ID；
- 断开连接只删除本系统会话，不会退出其他设备；
- 会话过期时重新扫码；遇到安全验证停止操作。

真实扫码登录已验证：二维码图片加载完成后再截屏，手机确认后 `is_login` 变为 true 即完成连接。账号状态、二维码轮询和账号隔离由单元测试覆盖。

## 发布

1. 在渲染工作台生成今日头条排版；
2. 发布管理 → 今日头条，选择排版；
3. 点击「发布到今日头条」并确认。

发布使用头条号网页编辑器：

- 打开 `https://mp.toutiao.com/profile_v4/graphic/publish`；
- 填写文章标题；
- 优先通过剪贴板把语义 HTML 粘贴到正文编辑器，失败时回退为纯文本；
- 点击「预览并发布 / 发布」，必要时确认弹窗；
- 捕获 `POST /mp/agw/article/publish`，只有接口返回 `code=0` 且包含有效文章编号才标记成功；
- 结果链接形如 `https://www.toutiao.com/article/文章编号/`；
- 提交后响应不明确、超时或服务重启时标记「结果待核实」，不自动重发。

结果待核实支持：

- 重新自动核实：读取公开文章页并按文章编号/标题确认；
- 我已核实，未发布：解除限制，允许重新提交；
- 我已核实，已发布：填写文章链接并关联，不会再次发布。

## API

所有接口要求 MultiPush Bearer JWT，响应 `Cache-Control: no-store`。今日头条会话失效返回 `409 toutiao_session_expired`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/toutiao/account` | 查询账号状态 |
| `POST /api/toutiao/login` | 获取官方登录二维码（202） |
| `GET /api/toutiao/login/:id` | 查询扫码/确认状态 |
| `DELETE /api/toutiao/account` | 断开连接 |
| `POST /api/toutiao/publications` | 提交 `{renderId}` |
| `GET /api/toutiao/publications` | 当前用户最近 50 条记录 |
| `GET /api/toutiao/publications/:id` | 查询进度、文章链接 |
| `POST /api/toutiao/publications/:id/resolve` | `{action:"check"}` 异步复查；`{action:"not_published"}` 人工确认未发布；`{action:"published",articleUrl}` 人工关联已发布文章 |

## 验证与限制

- 单元测试覆盖头条图文渲染、标题长度、视频拦截、会话加密、幂等、待核实和重启恢复。
- 页面回归：先 `npm run build:web`，再运行 `node scripts/smoke-toutiao-publish.mjs`，使用隔离 fixture 验证扫码、发布确认、失败、待核实和人工核实流程，不访问真实头条号。
- 真实登录页二维码已用本机 Chrome 验证；正式发布需要在有头条号的环境中扫码后验证编辑器、标题/正文填写和 `article/publish` 响应。
- 正文图片依赖编辑器粘贴/页面内图片处理；首次真实发布前应检查图片是否保留在头条编辑器中，必要时在编辑器手动补图。
- 不支持微头条、视频、图文卡片、付费专栏、定时发布、首发声明、作品声明和位置等高级设置。
- 头条号网页与内部接口没有稳定性承诺，改版后可能需要更新选择器和响应解析。
