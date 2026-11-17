# 百家号渲染与发布

## 草稿

发布页支持「保存草稿」：在百家号编辑器填写标题/正文后点击平台「存草稿」按钮，成功时记录状态 `draft`，不公开发布。草稿按钮依赖平台当前页面文案；找不到按钮或无法确认成功时会停止并提示到百家号草稿箱核对。


状态：渲染、扫码登录和发布页面已实现，并通过模拟测试与页面回归；百家号登录页二维码、二维码接口与登录态 Cookie 已用本机无头 Chrome 实测。正式文章发布尚未用真实百家号账号完成端到端验证（当前环境没有可用百家号账号）。

## 渲染

百家号以图文文章呈现。MultiPush 使用百家号图文排版：

- 标题 2–30 字，超长自动截断并提示，少于 5 字给出建议；
- 正文支持标题层级、列表、引用、代码、表格、图片和链接；
- 正文 HTML 最多 1 MB；视频、音频、iframe、SVG 暂不在自动发布范围内；
- 提供百家号 HTML 与 Markdown 下载；
- 预览使用桌面文章卡片模拟百家号图文页。

## 登录

在「发布管理 → 百家号」点击「扫码连接百家号」，系统打开百家号官方登录页 `https://baijiahao.baidu.com/builder/theme/bjh/login`，点击页面上的「登录」打开百度通行证弹窗，读取官方二维码并展示在系统内。

- 使用百度 App 扫码并在手机上确认；
- 二维码元素为 `img.tang-pass-qrcode-img`，源图 `passport.baidu.com/v2/api/qrcode?sign=…` 是 265×265 的 PNG，系统直接取源图展示而不是截屏缩略图；
- 登录成功以 `.baidu.com` 域下的 `BDUSS` Cookie 为准；账号信息来自 `GET /userb/user/loginInfo`，兼容 `userid/user_id/uid` 与 `uname/name/nickname` 等字段；该接口失败不阻塞登录，昵称回退为「百家号作者」；
- 浏览器 Cookie/localStorage 使用 AES-256-GCM 加密保存，密钥位于 `DATA_DIR/.baijiahao-session-key`，加密绑定 MultiPush 用户 ID；
- 断开连接只删除本系统会话，不会退出其他设备；
- 会话过期（`errno` 20040001 / 10001401 / 217100002）时重新扫码；遇到安全验证停止操作。

## 发布

1. 在渲染工作台生成百家号排版；
2. 发布管理 → 百家号，选择排版；
3. 点击「发布到百家号」并确认。

发布使用百家号网页编辑器：

- 打开 `https://baijiahao.baidu.com/builder/rc/edit?type=news`；
- 标题写入 Lexical 编辑器（`[data-testid="news-title-input"] [contenteditable]`），写入后回读校验；
- 正文写入 UEditor：优先调用页面内的 `window.editor.setContent(html)`，失败时在 `#ueditor_0` 内写入 HTML 并派发 `input/change`，最后回读校验；
- 点击文本严格等于「发布」的按钮（避免命中「定时发布」），必要时确认弹窗；
- 捕获 `POST /pcui/article/publish`，只有 `errno=0` 且返回可识别文章编号才标记成功；
- 结果链接形如 `https://baijiahao.baidu.com/s?id=文章编号`；
- 提交后响应不明确、超时或服务重启时标记「结果待核实」，不自动重发。

结果待核实支持：

- 重新自动核实：读取公开文章页并按文章编号/标题确认；
- 我已核实，未发布：解除限制，允许重新提交；
- 我已核实，已发布：填写文章链接并关联，不会再次发布。

## API

所有接口要求 MultiPush Bearer JWT，响应 `Cache-Control: no-store`。百家号会话失效返回 `409 baijiahao_session_expired`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/baijiahao/account` | 查询账号状态 |
| `POST /api/baijiahao/login` | 获取官方登录二维码（202） |
| `GET /api/baijiahao/login/:id` | 查询扫码/确认状态 |
| `DELETE /api/baijiahao/account` | 断开连接 |
| `POST /api/baijiahao/publications` | 提交 `{renderId}` |
| `GET /api/baijiahao/publications` | 当前用户最近 50 条记录 |
| `GET /api/baijiahao/publications/:id` | 查询进度、文章链接 |
| `POST /api/baijiahao/publications/:id/resolve` | `{action:"check"}` 异步复查；`{action:"not_published"}` 人工确认未发布；`{action:"published",articleUrl}` 人工关联已发布文章 |

## 验证与限制

- 单元测试覆盖百家号图文渲染、标题长度、视频拦截、会话加密、幂等、待核实和重启恢复。
- 页面回归：先 `npm run build:web`，再运行 `node scripts/smoke-baijiahao-publish.mjs`，使用隔离 fixture 验证扫码、发布确认、失败、待核实和人工核实流程，不访问真实百家号。
- 真实登录页、二维码接口与 `BDUSS` 登录态已用本机 Chrome 验证；正式发布需要在有百家号账号的环境中扫码后验证标题/正文填写与 `/pcui/article/publish` 响应。
- 百家号正文是 UEditor 富文本，正文图片依赖编辑器对 `<img src>` 的处理；首次真实发布前应检查图片是否保留，必要时在编辑器手动补图。
- 不支持视频、动态、专栏、合集、定时发布、原创声明、首发声明和位置等高级设置。
- 百家号网页与内部接口没有稳定性承诺，改版后可能需要更新选择器和响应解析。
