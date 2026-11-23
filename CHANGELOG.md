# CHANGELOG

## 2026-11-23 · 账号安全加固（登录限速 / 两步验证 / SSRF / AI 池权限）

**改了什么**

- 新增登录失败限速：账号 15 分钟 8 次、IP 15 分钟 30 次，超限返回 `429` 与 `Retry-After`；二次验证单独限速。生产环境通过 `CF-Connecting-IP` 还原真实客户端 IP，避免 Cloudflare 隧道把所有人算成同一个内网 IP。
- 新增可选 TOTP 两步验证：设置页开启，登录先返回 5 分钟有效的 challenge，再验证 6 位动态码或一次性恢复码；密钥 AES-256-GCM 加密（AAD 绑定用户 ID），恢复码只存 HMAC 哈希。提供 `scripts/reset-2fa.mjs` 应急重置。
- 新增统一 SSRF 防护 `network-guard.ts`：用户可控的博客地址、AI 接口、正文外链图片、B站文章图片全部走公网 DNS 校验、私网/回环地址阻断、DNS 固定、逐跳重定向校验与响应大小限制。
- AI 服务器提供商池改为管理员可用（生产默认 `AI_POOL_ACCESS=admin`），普通账号必须配置自己的 Key；新增非管理员每日额度 `AI_POOL_DAILY_LIMIT`；AI 用量页按账号统计请求、失败、Token 和最近使用时间。
- Cloudflare 登录限流规则：新增 `scripts/cloudflare-login-ratelimit.mjs`，并在 `publish.yuan-xin.top` 应用每 IP 每 10 秒 5 次的登录/二次验证限流（免费版限制周期与封禁均为 10 秒）。
- 新增 `docs/SECURITY.md`、相关环境变量说明与测试。

**验证**

- 新增 network-guard、TOTP、登录限速、真实客户端 IP、配置默认值、2FA 登录全流程、AI 池权限与额度测试。
- `server` 全量 503 项测试通过；`typecheck -w server`、`typecheck -w web`、server/web 生产构建通过。
- 本地 production 模式联调：普通账号调用 AI 返回 403、博客连接 `127.0.0.1` 返回 `blog_url_blocked`、管理员 2FA 登录与用量接口正常。
- Cloudflare 规则实测：并发 8 次登录返回 7×401 + 1×429。

## 2026-11-23 · 复用平台浏览器上下文（P1）

**改了什么**

- 新增 `PublisherContextCache`：同一份加密会话在 45 分钟内复用同一个浏览器 context，最多缓存 8 个，空闲自动关闭；按 storageState 哈希隔离用户/账号。
- 接入微信公众号、知乎、微博、今日头条、百家号、豆瓣、掘金、CSDN、简书、V2EX、B站、抖音、少数派；扫码登录的临时 context 不进入缓存。
- 操作结束改为释放租约并关闭页面，不再每次立即销毁 context；服务关闭时统一关闭全部缓存。
- 连续发布同一账号时，平台侧看到的是同一个浏览器会话，而不是每次都新建设备。

**验证**

- 新增 context cache 单元测试：同会话复用、不同会话隔离、释放不立即关闭、服务关闭统一清理。
- 更新抖音浏览器测试，验证 context 被缓存而不是发布后立即关闭。
- `server` 全量测试 479 项、`web` 测试 26 项通过；`typecheck -w server` 通过。

## 2026-11-23 · 统一平台动作限流（P0-3）

**改了什么**

- 新增 `platform_actions` 表，持久记录 `login_started`、`publish_started`、`session_checked`（并预留 `publish_finished`），服务重启后限流仍然生效。
- 所有平台的发布、扫码登录、手动「刷新状态」统一走 `PlatformActionGuard`：默认发布间隔、滚动 24 小时上限、登录冷却、刷新冷却；超限返回 `429` 并带 `Retry-After`。
- 默认策略：知乎/微博/头条/百家号/掘金/CSDN/简书 10 分钟、8 篇/天；豆瓣 30 分钟、3 篇/天；少数派 10 分钟、5 篇/天；微信公众号 10 分钟、3 篇/天；B站/抖音/V2EX 30 分钟、3 篇/天。
- 配置统一为 `MULTIPUSH_<PLATFORM>_MIN_PUBLISH_INTERVAL_MS` 等；旧的 `SSPAI_*` 变量仍兼容。
- 单元测试使用隔离数据库，默认放宽限流；生产/开发环境使用严格默认值。

**验证**

- 新增 `platform-actions` 单元测试：发布间隔、24 小时上限、用户隔离、登录冷却、刷新冷却、重启后仍然生效。
- `server` 全量测试通过；`typecheck -w server` 通过。

## 2026-11-23 · 减少平台会话：账号状态只读缓存、发布只开一个浏览器上下文

**改了什么**

- 各平台 `GET /account` 默认只读数据库缓存，不再在发布页打开时主动访问平台；`?refresh=1` 或发布页「刷新状态」才强制实时检查。
- 各平台发布不再先 `checkSession` 再 `publish`，改由发布流程内部的账号校验完成；单次发布的平台浏览器上下文从 2 个降到 1 个。
- 覆盖微信公众号、知乎、微博、今日头条、百家号、豆瓣、掘金、CSDN、简书、V2EX、B站、抖音、少数派；公众号贴图和个人博客也改为只读缓存。
- 前端刷新按钮统一传递 `refresh: true`；会话失效仍在发布任务中标记账号 expired，不会静默重登。

**验证**

- 新增知乎账号缓存/强制检查测试，并更新微信账号缓存与过期测试。
- `server` 全量测试通过；`web` 测试通过；`typecheck -w server` 通过。

## 2026-11-23 · 少数派发布限流与会话检查降频

**改了什么**

- 少数派连续创建草稿或文章可能触发平台限制。默认两次提交至少间隔 10 分钟，滚动 24 小时最多 5 篇；超限返回 `429`，不会向少数派发起请求。
- 扫码登录尝试默认增加 2 分钟冷却；账号状态改为默认只读缓存，发布页「刷新状态」才强制实时检查。
- 发布前不再单独打开浏览器做一次 `checkSession`，改由发布流程内部的账号校验完成，单次发布少一个平台会话。
- 新增 `MULTIPUSH_SSPAI_MIN_PUBLISH_INTERVAL_MS`、`MULTIPUSH_SSPAI_DAILY_PUBLISH_LIMIT`、`MULTIPUSH_SSPAI_LOGIN_COOLDOWN_MS` 配置（旧 `SSPAI_*` 名称仍兼容）。
- 增加 `[sspai]` 登录取码、发布接受/完成/失败的审计日志。

**验证**

- 新增限流、每日上限、强制刷新与登录冷却测试；`server` 测试 474 项通过，`web` 测试 26 项通过。
- `npm run typecheck -w server` 通过；`web` 仍存在与本改动无关的 `@twick/studio` 缺失类型错误。

## 2026-11-23 · 修复 B 站图文正文空行过多

**改了什么**

- 新增通用编辑器 HTML 压缩：移除块级元素之间的格式化空白和空段落，保留正文内联空格与 `<pre>/<code>` 的预格式化内容。
- B 站图文发布优先使用编辑器自身的 `editor.setContent(html, true)`，不再依赖合成 paste；避免编辑器把换行解析成额外的空段落，同时保持 ProseMirror 状态同步。
- 合成 paste 仅作为编辑器没有 `setContent` 时的兜底。
- 已同步清理现有《2012》图文中的空段落（图片位置保持不变，正文 4 张图片保留）。

**验证**

- 新增 `compactEditorHtml` 单元测试：块间空白清理、内联空格保留、pre 保留、空段落移除。
- 在生产 B 站编辑器中对现有《2012》图文执行清理后检查：正文空段落从 10 个降为 0，4 张图片仍保留，正文位置不变。
- `npm run typecheck`、`npm run build` 通过；`npm test` 通过。

## 2026-11-23 · 修复 B 站图文正文图片全部跑到末尾

**改了什么**

- 图文渲染服务不再在提取图片后把图片统一追加到正文末尾：每张可上传图片先在原位置留下 `data-multipush-image` 占位标记。
- 图片上传完成后按占位标记替换：图片专段转成 `<figure>`，正文中的图片保留为内联 `<img>`，原有 `<figure>/<figcaption>` 结构保留。
- 新增占位替换/兜底剥离的单元测试，并验证正文顺序与图片顺序一致。
- 剪贴板兜底仍会追加到末尾；只在上传接口失败时使用。

**验证**

- 新增占位替换测试：图片顺序、图注、前后正文位置保持不变。
- `npm run typecheck`、`npm run build` 通过；`npm test -w server` 通过。

## 2026-11-22 · 注册邀请码与管理员设置

**改了什么**

- 用户表新增 `is_admin`；启动迁移把既有 `yuanxin` 账号提升为管理员，其他账号保持普通用户。
- 生产环境注册必须提供有效邀请码；开发、测试和显式 `INVITE_CODE_BYPASS=1` 的验收环境可绕过。
- 新增全局邀请码表：记录使用次数上限、已用次数、失效时间和启停状态；注册消耗邀请码与创建用户在同一个数据库事务中完成，失败会回滚使用次数。
- 新增管理员专用 `/api/admin/invite-codes` 接口，生成、列表和启停邀请码；普通用户访问返回 403。
- 设置页新增「邀请码」Tab，仅 `isAdmin` 用户可见；可生成邀请码、设置使用次数和失效时间、复制和停用。
- 注册页在需要邀请码时显示邀请码输入框；`GET /api/auth/registration-config` 返回当前注册策略。
- Jenkins 测试环境设置 `INVITE_CODE_BYPASS=1`，让既有 API/UI 冒烟可继续创建测试账号；生产 systemd 服务不继承该变量。

**验证**

- `npm run typecheck`、`npm run build` 通过。
- `npm test`：server 48 个文件 / 467 项、web 4 个文件 / 26 项全部通过。
- 真实数据库迁移验证：`yuanxin` 获得管理员标记；普通用户注册需要邀请码。
- API + Playwright 验收：管理员设置页可见邀请码 Tab，生成使用次数/失效时间；使用邀请码注册成功，无邀请码被拒绝；普通用户设置页没有邀请码 Tab，管理员接口返回 403。

## 2026-11-22 · 修复 B 站图文正文图片无法写入

**改了什么**

- 根因一：Playwright 的 `frame.evaluate` 收到的是 JavaScript 字符串时不会执行该函数，原剪贴板写入实际没有发生；文本还有 `insertText` 兜底，图片则被静默跳过，最终 `img` 数量为 0。
- 根因二：图片节点统计使用了被编辑器 locator 二次作用域的 `.tiptap.ProseMirror img`，即使图片存在也会统计为 0；改为在编辑器内统计 `img`。
- 正文图片改为优先走 B 站编辑器真实接口 `x/dynamic/feed/draw/upload_bfs`：使用 WBI 签名、`bili_jct`、`file_up`、`biz=new_dyn`、`category=daily`，确认 CDN 可读后再写入编辑器。
- 正文和图片通过一个合成的 paste 事件一次性写入，不再依赖系统剪贴板；保留剪贴板兜底，但兜底前聚焦编辑器并轮询图片节点确认完成。
- 失败信息现在包含上传接口 HTTP/code、CDN 状态、`img`/`figure`/占位节点数量和安全验证状态。
- 修正草稿列表响应解析（`artlist` 在响应顶层），保存草稿后可取回 B 站草稿 ID。
- 新增图片上传接口参数/响应测试。

**验证**

- 使用真实 B 站账号、草稿模式发布一篇带 3 张图片的图文：3 张图片均上传成功并写入编辑器，保存草稿成功；重新打开草稿确认 3 张图片仍在正文中；测试草稿已删除。
- `npm run typecheck`、`npm run build` 通过；`npm test -w server` 通过。

## 2026-11-22 · 图文编辑器显示图片尺寸与大小

**改了什么**

- 图文编辑器每张图片下方新增元信息行：左侧显示图片实际像素尺寸，右侧显示文件大小。
- 尺寸在图片加载后读取 `naturalWidth × naturalHeight`；大小优先读取 `Content-Length`，Express 静态文件没有该响应头时从 ETag 的十六进制大小回退读取，无法获取时显示「大小未知」。
- 图片重新加载、拖动排序和替换后按图片 ID 更新，不影响配文与封面选择。
- 新增响应头大小解析测试。

**验证**

- `npm run typecheck`、`npm run build` 通过。
- 本地 API + Playwright 验证：3 张 800×500 图片分别显示 `800 × 500` 与对应 KB 大小，无页面错误。
- `npm test`：web 4 个文件 / 26 项全部通过。

## 2026-11-22 · 微博长文改为微博串发布

**改了什么**

- 微博渲染不再把超过 2000 字的正文截断：按段落优先、句子/换行兜底拆成不超过 2000 字的微博串；第一条带标题，最后一条带话题，避免丢失结尾段落。
- 新增 `PlatformRender.thread` 和发布记录的逐条结果；发布器先发第一条，再在微博详情页以评论接龙发后续段落，并记录每条评论编号。
- 发布页展示具体渲染警告、微博串条数和完整分条预览；旧版截断排版会显示警告，按钮改为「仍要发布截断版」，需要二次确认。
- 数据库新增 `weibo_publications.thread_json`，`user_version = 25`；任务中断时保留已完成的微博串进度，状态标记为待核实，避免重复发布。
- 渲染调整（编辑标题/正文/话题）会重新拆分微博串，发布前检查按最长单条计算。
- 新增微博串拆分、渲染、编辑重算和发布记录持久化测试，并更新微博发布说明。

**验证**

- `npm run typecheck`、`npm run build` 通过；`npm test`：server 46 个文件 / 465 项、web 3 个文件 / 23 项全部通过。
- 本地 API + Playwright 验证：长文渲染为 3 条微博串，发布页显示条数/完整分条/警告，按钮显示「发布 3 条微博串」，无页面错误。
- 真实微博账号的评论接龙发布尚未执行；需要真实账号验证评论框定位和评论接口，避免向公开主页产生测试内容。

## 2026-11-22 · 修复微博正文链接丢失

**改了什么**

- 微博文案改为从渲染 HTML 提取正文：遇到 `<a href>` 时保留可见文字，并在下一行追加解析后的完整 URL，避免发布后只剩「打开某条目」而链接消失。
- 链接文字本身已经是 URL 时不重复追加；标题重复的首行会移除，话题和 2000 字截断逻辑保持不变。
- 新增微博链接保留、URL 不重复的回归测试，并更新微博发布说明。

**验证**

- `npm run typecheck`、`npm run build` 通过；`npm test`：server 46 个文件 / 458 项、web 3 个文件 / 23 项全部通过。

## 2026-11-22 · 合并所有功能分支

**改了什么**

- 将 B站视频/专栏图文发布、视频素材/剪辑模式、豆瓣发布修复、简书富文本/图片修复和 Twick 实验剪辑工作台合并到 `main`。
- 数据库迁移合并为 `user_version = 24`：同时包含 `bilibili_*` 表、`video_projects.materials_json` 和 `video_projects.studio_json`；旧库启动时按列增量补齐。
- 修复合并后视频工作台的 React Hook 顺序：`openStudio` 从早返回之后移到组件顶部，避免加载完成时出现 React error #310。
- Twick 仍为「新版剪辑（试验）」入口，旧版工作台保持默认；Twick 章节保留素材桥接、成片导出、1080p 和依赖体积等限制。

**验证**

- `npm run typecheck`、`npm run build` 通过；Twick 页面为懒加载 chunk（约 4.9 MB），不进入首屏主包。
- `npm test`：server 46 个文件 / 456 项、web 3 个文件 / 23 项全部通过。
- 合并后回归：视频工作台 UI、未剪辑渲染门禁、B站发布页 UI、Twick Studio 嵌入冒烟均通过。

## 2026-11-22 · B站视频 / 专栏图文渲染与发布

**改了什么**

- 新增第 16 个平台「B站」。视频内容生成 16:9 视频投稿页（标题 ≤80、简介 ≤2000、标签 ≤10）；普通文章/图文内容生成 B 站专栏/opus 长图文（标题建议 ≤40），提供 HTML、Markdown、文案和 JSON 下载。
- 智能渲染新增 B站 16:9 视频页/专栏长文预览；平台横条、默认全选、批量渲染和 AI 渲染工具均支持 B站。
- 新增「发布管理 → B站」：扫码登录（会话加密保存）、视频投稿、专栏/opus 图文草稿/发布、发布记录、审核状态检查、结果待核实和手动兜底。
- 视频投稿按 B 站 Web 链路实现：封面上传 → 申请 UPOS 凭据 → 分片上传 → 封口 → `add/v3` 创建稿件；得到 BV 号后记录为「审核中」，支持后续检查公开状态。
- 图文使用 B 站新版编辑器：填标题、写入正文、通过剪贴板把正文图片交给 B 站图床、保存草稿；选择公开发布时点击「发布」并捕获 `create/opus` 成功信号，信号不明确时标记待核实，不自动重试。
- 数据库新增 `bilibili_accounts`、`bilibili_publications`、`bilibili_publication_resolutions`，`user_version = 24`；服务重启时把处理中记录标记为待核实，避免重复投稿。
- 新增 `BILIBILI_BROWSER_PATH`、`BILIBILI_HEADLESS` 配置和 [B站发布说明](docs/BILIBILI_PUBLISHING.md)。

**验证**
- `npm run typecheck`、`npm run build` 通过。
- `npm test`：server 46 个文件 / 451 项、web 3 个文件 / 23 项全部通过；新增 B站渲染、WBI 签名/Cookie、服务登录和图文发布落库测试。
- 真实网络验证 B 站官方登录页二维码可被正常截取（140×140 PNG），未执行真实投稿/发布，避免向测试账号产生公开内容。
- API + Playwright 回归（真实服务 + 临时数据目录，mock B站账号/发布接口）：B站发布页正常加载专栏预览，提交图文后状态从处理中更新为已发布，页面无 `pageerror`；截图输出到 `artifacts/bilibili-check/`。

## 2026-11-22 · 修复简书文章格式错乱与正文图片未上传

**改了什么**

- 简书发布从发送 **Markdown** 改为发送渲染后的 **HTML**，与简书账号当前使用的富文本编辑器一致；标题、二级标题、列表、引用、代码、表格、链接和图片不再以 `##`、`![...](...)` 原文显示。
- 新增简书正文图片上传：先请求 `/upload_images/token.json?filename=...` 获取七牛 `token/key`，再向 `https://upload.qiniup.com` 提交 `token`、`key`、`file` 和 `x:protocol=https`；上传成功后把 HTML 中的原图地址替换为简书图床地址。
- 图片上传 token 请求必须带 `filename`，否则七牛 key 缺少扩展名，上传会被回调拒绝；单张图片限制 5 MB。
- 保存草稿后新增回读校验：重新读取 `/author/notes/:id/content`，若正文没有富文本块、仍包含 Markdown 原文或图片数量不足，则停止发布并保留草稿。
- 发布进度现在会显示「正在上传简书图片 i/n」；图片上传失败会带 HTTP 状态和七牛响应，不再静默保留外链。
- 更新简书发布说明、UI 提示和 CHANGELOG。

**验证**

- `npm run typecheck`、`npm run build` 通过；`npm test`：server 45 个文件 / 446 项、web 3 个文件 / 23 项全部通过。
- 使用真实简书账号验证七牛 token/key 上传（Playwright 与编辑器相同的 multipart 字段）返回 200。
- 使用真实账号创建带 `<h2>`、段落和图片的简书**草稿**，回读确认保存为 HTML 且图片地址为简书图床，随后通过 `soft_destroy` 删除测试草稿；未发布新的公开文章。
- 线上已存在的旧文章不会自动修复，需要重新生成/发布；截图中的旧文章被简书转为仅自己可见，是平台侧的另一件事。

## 2026-11-22 · 修复豆瓣日记发布 `invalid_parameter`

**改了什么**

- 对齐豆瓣新版 topic 编辑器的真实保存请求，修复图片日记的 `image_ids` 格式：从错误的 `3_id1,id2,id3` 改为 `1_id1,2_id2,3_id3`。
- Draft.js `entityMap` 补上 `mutability`：LINK 为 `MUTABLE`、IMAGE 为 `IMMUTABLE`；图片实体字段改为豆瓣使用的 `file_name`/`file_size` 等 snake_case，并保留 `src`/`raw_src`/`thumb`/`url`/`width`/`height`/`position`。
- 无图日记不再发送 `image_layout`；有图且不超过 18 张时才发送 `horizontal`。标签继续作为 `interest_tags` 发送。
- 保存失败时错误信息现在包含 HTTP 状态、响应 `code`、顶层字段和豆瓣业务提示，并区分参数错误、账号临时只读、接口 404、服务端错误和非 JSON/登录失效响应；图片上传失败时附带 content-type 与响应字段。
- 新增回归测试：多图 `image_ids`、Draft 实体 `mutability`/snake_case、文字/图片 payload 中 `image_layout` 的有无。

**验证**

- `npm run typecheck`、`npm run build` 通过；`npm test`：server 45 个文件 / 447 项、web 3 个文件 / 23 项全部通过。
- 对比豆瓣编辑器真实请求字段，并用真实账号创建了纯文字、带链接、带图片的**私密**日记，均返回 200；请求体格式验证通过。
- 联调期间豆瓣短暂触发只读风控（`user_is_readonly`），已立即停止请求；冷却后通过日记页删除入口清理全部测试私密日记并确认 404，未发布公开日记。

## 2026-11-22 · 视频内容：素材模式 / 剪辑模式与未剪辑渲染门禁

**改了什么**

- 视频工作台新增「素材模式 / 剪辑模式」切换，标题、正文、标签等元数据在两种模式下保持不变。
  - 素材模式展示新建视频内容后上传的原始素材，按上传顺序排列，保留文件名、完整时长和分辨率；可预览原片、加入剪辑时间线或进入剪辑模式。
  - 剪辑模式保留原有类剪映时间线：入点/出点、调序、删除、整条播放和自动保存。
- 新增 `video_projects.materials_json` 保存原始素材 ID 顺序；保存时间线时保留素材列表并自动补齐新素材，删除片段不会删除素材库原片。数据库 `user_version = 24`，旧库自动增量迁移。
- `VideoProject` 新增 `materials` 与 `edited`：时间线与素材顺序一致、无裁剪时视为未剪辑。
- 新增简单拼接导出：`POST /api/contents/:id/video/export` 支持 `{"source":"materials"}`，按素材上传顺序调用 ffmpeg 直接拼接，不裁剪。
- 渲染工作台增加视频门禁：视频内容未剪辑时弹出「视频素材未剪辑，则简单拼接输出视频」确认框；选择「是」先简单拼接导出成片再继续渲染，选择「否」取消渲染并提示先剪辑。视频内容没有素材时直接提示先上传。
- 更新视频说明、用户指南、产品规格、架构、验收计划和 README。

**验证**
- `npm run typecheck`、`npm run build` 通过。
- `npm test`：server 45 个文件 / 446 项、web 3 个文件 / 23 项全部通过；新增素材列表/`edited` 判定测试。
- 视频工作台 UI 冒烟（真实服务 + 临时数据目录 + headless Chrome）：上传两段素材后素材模式显示原始素材，切换到剪辑模式后完成入出点、调序、导出，渲染预览使用成片。
- 新增未剪辑渲染门禁 UI 冒烟：上传素材后进入渲染，弹出「视频素材未剪辑」确认；取消不产生渲染记录，确认后简单拼接导出并渲染成功。截图输出到 `artifacts/video-render-gate-check/`。

## 2026-11-21 · 智能渲染：知识库内容树、平台独立设置与平台历史

**改了什么**

- 内容选择器改为按知识库分组的树形结构：知识库可展开/收起，内容缩进显示类型、字数和更新时间；支持搜索、展开全部/收起全部、默认展开当前内容所在知识库，空知识库排在末尾。
- 新增「平台设置」弹窗：默认设置 + 每个已选平台单独设置。可分别为平台覆盖作者署名、话题开关、自动目录和小红书卡片风格；未单独设置的平台沿用默认设置。设置会随渲染请求提交并保存到渲染记录，也支持保存为当前账号的浏览器默认设置。
- 渲染请求、渲染记录、批量渲染新增 `platformOptions` 字段；服务端按平台合并默认选项与平台覆盖，渲染器只读取当前平台的最终选项。数据库新增 `renders.platform_options_json` 增量迁移。
- 渲染历史改为内容感知：选中内容后默认查看当前内容的历史，支持「当前内容 / 全部内容」切换和平台筛选，平台筛选按钮显示记录数；点击记录会同时定位到对应平台。页面新增「当前内容已渲染 N 次，覆盖 M 个平台」入口。
- 平台横条在窄屏下改为内部横向滚动，避免把整页撑宽；刷新空状态的过期文案。
- 更新产品规格、用户指南、架构说明和验收计划。

**验证**

- `npm run typecheck`、`npm run build` 通过。
- `npm test`：server 45 个文件 / 445 项、web 3 个文件 / 23 项全部通过；新增平台选项合并、参数校验、偏好解析和数据库持久化测试。
- API + Playwright 回归（1440×980、390×844，真实服务 + 临时数据目录）：知识库树展开/搜索与移动端弹窗无溢出；平台设置覆盖小红书话题/作者和公众号目录/作者后，生成的记录与结果按平台生效；内容历史默认当前内容、平台筛选计数正确，点击记录会定位到对应平台。截图输出到 `artifacts/render-v3-check/`。

## 2026-11-21 · 解除智能渲染平台数量限制

**改了什么**

- 删除智能渲染和批量渲染请求中「最多选择十四个平台」的硬上限。该上限是加入 CSDN 时按当时 14 个平台写死的；V2EX 成为第 15 个平台后没有同步更新，而渲染工作台默认全选所有平台，导致直接点击「生成渲染」会报错。
- 平台仍由请求参数的枚举限定为受支持的平台 ID，重复项会去重；不再维护容易漂移的平台数量常量。
- 新增回归测试：全部平台可一次性通过渲染/批量渲染参数校验，`PLATFORM_ORDER` 与 `PLATFORMS` 保持一致，渲染器可一次生成全部平台。
- 更新验收计划。

**验证**

- `npm run typecheck`、`npm run build` 通过；`npm test`：server 45 个文件 / 443 项、web 3 个文件 / 23 项全部通过。
- API + Playwright 回归（真实服务 + 临时数据目录）：创建文章后带全部 15 个平台调用 `POST /api/renders` 返回 15 条结果；从编辑器进入 `/render?contentId=...` 时默认全选 15 个平台并自动渲染出 15 个结果 tab，不再出现「渲染没有完成」。截图输出到 `artifacts/render-all-platforms/`。

## 2026-11-21 · 内容库卡片类型角标

**改了什么**

- 内容库卡片左上角新增内容类型角标：普通文章为绿色「文章」，图文内容为紫色「图文」，视频内容为红色「视频」（视频原有样式保持不变）。
- 角标抽成共享组件 `ContentKindBadge`，卡片和列表视图统一使用；列表视图保持原有紧凑布局，只在图文/视频行显示角标。
- 修复悬停时选择框与左上角角标重叠的问题：角标固定在左上角，选择框出现在角标右侧；选中状态下两者同时可见。
- 更新产品规格、用户指南、图文/视频说明和验收计划。

**验证**

- `npm run typecheck`、`npm run build` 通过；`npm test`：server 45 个文件 / 441 项、web 3 个文件 / 23 项全部通过（新增 `ContentKindBadge` 3 项类型角标测试）。
- Playwright 视觉回归（1440×980 与 390×844，真实服务 + 临时数据目录）：文章/图文/视频角标正确显示；悬停与选中时选择框位于角标右侧且不重叠；移动端无横向溢出。截图输出到 `artifacts/badge-preview/`。

## 2026-11-21 · 知乎表格提醒与 CSDN 导入/标题加固

**改了什么**

- 知乎渲染在检测到表格时新增提醒：「知乎草稿接口不保留表格，已将 N 张表转为等价列表。」不再静默转换；没有表格时不产生该提醒。
- CSDN 从编辑器打开后立即监听 `saveArticle`，不再等到标题填写完成。导入或标题阶段若编辑器已自动保存，后续失败会标记为待核实（`csdn_result_uncertain`），避免重试产生第二份草稿。
- CSDN 导入校验从「首尾各 40 字」改为「首、中、尾各 40 字」，中间内容丢失也会判定导入未生效。
- CSDN 标题校验改为：先比较输入框完整值，再允许标题栏截断后的去空白前缀（至少 20 字），接近 100 字的长标题不会因显示截断误报失败。
- 新增测试：知乎表格提醒；CSDN 中间丢字、长标题截断、导入期间自动保存的结果分类；更新知乎/CSDN 发布文档。

**验证**

- `npm run typecheck`、`npm test`：server 43 个文件 / 425 项、web 2 个文件 / 20 项全部通过；`npm run build` 通过；`npm run test:publish-ui` 通过。
- 真实 CSDN 登录态 + 生产 Chromium：导入真实长文后，新的首/中/尾校验通过；删除中间段后校验失败；98 字标题写入成功，标题栏与输入值一致；模拟标题栏截断前缀仍匹配。
- 2026-11-20 的知乎表格修复和 CSDN 导入修复保持有效，本次只补充提醒和边界处理。

## 2026-11-21 · V2EX 渲染与发布

**改了什么**

- 新增第 15 个平台 `v2ex`：`PLATFORMS`、渲染器注册、平台图标、渲染工作台平台选择和发布管理 Tab 均支持 V2EX。
- V2EX 渲染：
  - 生成 V2EX Markdown 主题正文（标题单独填写），标题上限 120 字、正文上限 20000 字符；
  - 图片使用绝对 URL，视频会移除并提示 V2EX 不支持视频，表格给出兼容性警告；
  - 输出 HTML / Markdown / 主题 JSON 下载，工作台提供 V2EX 论坛主题预览。
- V2EX 发布：
  - V2EX 没有官方写 API，使用「Cookie 连接 + 隔离 Chrome 浏览器」发布公开主题；不保存密码；
  - 支持节点列表读取和节点选择，发布成功后记录 `/t/<id>` 主题链接；
  - 没有草稿模式；提交后未确认时记录为「结果待核实」，可自动核实、人工关联主题链接或确认未发布，禁止自动重复提交；
  - 始终提供「复制标题」「复制 Markdown」「打开发帖页」手动发布兜底；
  - 仅失败记录可本地删除；已发布主题不可通过本系统删除或下架。
- 服务端新增 `V2EX_BROWSER_PATH`、`V2EX_PROXY_SERVER`（国内服务器访问 V2EX 通常需要代理）、`v2ex_accounts` / `v2ex_publications` / `v2ex_publication_resolutions` 表和服务重启恢复逻辑。
- 新增 `npm run smoke:v2ex` 浏览器回归（真实 API 渲染 + 发布页 UI，不实际发帖）；更新 README、产品规格、用户指南、架构、验收计划和 [V2EX 发布说明](docs/V2EX_PUBLISHING.md)。

**验证**

- `npm run typecheck` 通过。
- `npm test`：server 45 个文件 / 436 项、web 2 个文件 / 20 项全部通过；新增 V2EX 服务/渲染/解析测试覆盖 Cookie 加密、发布、节点校验、结果待核实、重启恢复、Markdown 与下载。
- `npm run build` 通过。
- `npm run smoke:v2ex` 通过：真实服务渲染 V2EX → 工作台 V2EX 主题预览 → 发布页节点列表、连接提示、复制 Markdown/打开发帖页按钮 → 390×844 无横向溢出。
- V2EX 自动发帖未用真实账号做端到端验收（当前环境无 V2EX 账号，生产服务器直连 V2EX 超时）；首次使用请先配置 `V2EX_PROXY_SERVER`，并发布一个测试主题验证节点、Cookie 和网络。

## 2026-11-21 · 素材库 Markdown 预览与语雀文章图片归档

**改了什么**

- 素材库文本预览升级：`md` / `markdown` 文件使用 `marked` 渲染为富文本预览，支持标题、段落、列表、引用、代码块、表格、链接和图片；其他文本格式仍显示源码。
- Markdown 中的相对图片路径会按「同文件夹素材」自动解析为已上传图片 URL，兼容语雀导出的 `文章名.assets/xxx.jpeg|png|heic` 结构。
- 语雀 HEIC 图片在归档时转换为 JPEG；预览按文件主名匹配，因此 Markdown 中仍保留原 `.heic` 引用也能显示转换后的图片。
- 预览 HTML 使用 DOMParser 清洗：移除 script/style/iframe/object/embed/form、事件属性、`javascript:` URL、style/class，外部链接统一新标签打开。
- `npm run smoke:assets` 增加 Markdown 相对图片预览断言，并更新 README、产品规格、用户指南和验收计划。
- 生产数据：在「我写的文章」文件夹补传《构建个人数字生活蓝图》的 39 张配图（9 张 HEIC 已转 JPEG），文件夹共 40 个素材（39 图片 + 1 Markdown）。

**验证**

- `npm run typecheck` 通过；`npm run build` 通过。
- `npm run smoke:assets` 通过：Markdown 预览渲染、同文件夹 `cover.png` 相对引用解析为 `/uploads/` URL，随后继续完成文件夹/移动/删除/移动端回归。
- 生产素材库确认：`我写的文章` 文件夹 39 张图片、1 个 Markdown 文档；所有 39 个 Markdown 图片引用均能在同文件夹按文件名或主名匹配到素材。

## 2026-11-21 · 从素材库向文章 / 图文 / 视频添加内容

**改了什么**

- 新增共享素材选择器 `MediaPicker`：在文章编辑器、图文工作台和视频工作台内直接使用素材库已有文件，不再重复上传。
  - 支持图片 / 视频 / 文档类型切换（按调用场景限制可选类型）；
  - 支持按「全部文件夹 / 未分组 / 指定文件夹」筛选、文件名搜索、分页加载；
  - 多选后显示已选数量；切换类型时保留已选素材，确认后一次性返回。
- 文章编辑器：
  - 工具栏新增「从素材库插入」，`/` 快捷菜单新增「素材库」；
  - 图片、视频插入正文；文档插入为「附件：文件名」链接段落；
  - 插入后触发自动保存，刷新不丢。
- 图文工作台：
  - 图片区新增「从素材库添加」，可一次添加多张已有图片；
  - 自动沿用封面逻辑（无封面时使用第一张），并触发自动保存。
- 视频工作台：
  - 右侧新增「从素材库添加视频」，把已有视频按顺序加入剪辑时间线；
  - 已有素材沿用 ffprobe 时长；缺少时长时通过素材 URL 探测，时间线自动保存。
- 素材选择器只读取当前用户素材，支持文件夹隔离；不会复制文件或重新上传。
- 新增 `npm run smoke:media-picker` 浏览器回归，更新 README、产品规格、用户指南、架构说明和验收计划。

**验证**

- `npm run typecheck` 通过。
- `npm test`：server 44 个文件 / 429 项、web 2 个文件 / 20 项全部通过。
- `npm run build` 通过。
- `npm run smoke:media-picker` 通过：API 预置图片/视频/Markdown 素材 → 新建文章从素材库插入图片和文档并等待自动保存，回读 `contentHtml` 确认图片与附件链接已持久化 → 新建图文从素材库添加图片并保存 → 新建视频从素材库添加片段并保存，回读时间线确认 1 段；截图输出到 `artifacts/media-picker-check/`。
- `npm run smoke:assets`、`npm run smoke:gallery` 继续通过。

## 2026-11-21 · 素材库与素材文件夹

**改了什么**

- 新增导航「素材库」，位于「AI 创作」和「内容库」之间，路由 `/assets`；编辑器、图文工作台、视频工作台、AI 创作和发布页上传的素材统一汇总到这里。
- 素材上传扩展为三类：
  - 图片：JPG / JPEG / PNG / WebP / GIF，单张 ≤20MB；
  - 视频：MP4 / WebM / MOV，单个 ≤200MB；
  - 文档：PDF / Word / Excel / PPT / TXT / Markdown / CSV / JSON / HTML / XML / YAML / RTF，单个 ≤50MB。
- 素材库页面：
  - 顶部统计当前范围（全库或当前文件夹）的素材数量与占用空间，以及图片/视频/文档数量；
  - 类型筛选（全部/图片/视频/文档）、文件名搜索、分页加载；
  - 图片缩略图、视频首帧与时长、文档类型图标与角标；
  - 图片、视频、PDF（iframe）和文本类文档（源码，≤1MB）预览；
  - 下载、复制链接、新标签打开、删除（二次确认并提示引用失效）。
- 素材文件夹：
  - 新建、重命名、删除文件夹；同名（不区分大小写）返回 409；
  - 删除文件夹时素材移到「未分组」，不删除文件；
  - 素材可移动到任意文件夹或未分组；文件夹卡片实时显示素材数量；
  - 在某个文件夹内上传的素材直接归入该文件夹；文件夹导航支持「全部素材」「未分组」和当前文件夹面包屑。
- 数据与服务：
  - `media.kind` 新增 `document`；新增 `media_folders` 表和 `media.folder_id`；旧库启动时自动升级 `media.kind` CHECK 约束并补列，保留原文件和子表数据。
  - 新增 `GET /api/media/stats?folderId=`、分页/筛选的 `GET /api/media`，以及文件夹 CRUD、素材移动接口；`POST /api/media` 支持可选 `folderId`。
  - `list_media` AI 工具支持 `document`，返回文件夹信息；不读取文档全文。
- 移动端：文件夹卡片换行、素材单列、搜索与筛选占满宽度；390×844 无横向溢出。
- 新增 `npm run smoke:assets` 浏览器回归，更新 README、产品规格、用户指南、架构说明和验收计划。

**验证**

- `npm run typecheck` 通过。
- `npm test`：server 44 个文件 / 429 项、web 2 个文件 / 20 项全部通过；新增媒体 API 测试覆盖上传/搜索/分页/统计/删除、文件夹创建/重命名/移动/删除、同名冲突和用户隔离；数据库迁移测试覆盖旧 `media` CHECK 升级与存量图片保留。
- `npm run build` 通过。
- `npm run smoke:assets` 通过：创建文件夹 → 上传图片/视频/Markdown → 文件夹计数 → 移动素材到第二个文件夹 → 重命名/删除文件夹并回退到未分组 → 搜索/类型筛选 → 图片、文本、视频预览 → 下载/删除 → 刷新持久化 → 390×844 无横向溢出；截图输出到 `artifacts/assets-check/`。

## 2026-11-21 · 图文内容类型与内容库新建入口调整

**改了什么**

- 新增第三种内容类型 `gallery`（图文内容）：图片优先，标题 + 有序图片（可逐图填写图注）+ 配文，面向微信公众号贴图、抖音图文和小红书。
- 内容库右上角按钮调整为「导入」「新建图文」「新建视频」「新建文章」：原「新建文档」改为「新建文章」；「新建视频」名称保持原样；导入名称不变。空状态页同步提供「新建文章 / 新建图文 / 新建视频 / 导入内容」。
- 新增全屏图文工作台 `/gallery/:id`：
  - 批量上传 JPG / PNG / WebP / GIF（单张 ≤20MB，最多 35 张），支持拖拽和上传进度；
  - 图片拖拽手柄或 ↑ / ↓ 排序，删除后自动回退封面，星标选择封面；
  - 逐图图注、纯文本配文、标签、草稿/待发布状态、收藏；
  - 0.8 秒自动保存、`Ctrl/Cmd+S`、离开提示、保存状态；
  - 复制图文、导出 Markdown / HTML / MultiPush JSON、删除到回收站；
  - 侧栏实时提示公众号贴图（20 张）、小红书（18 张）、抖音图文（35 张）图片上限。
- 内容库卡片/列表新增紫色「图文」角标和「N 张图」统计；点击图文进入 `/gallery/:id`，误入 `/editor/:id` 或 `/video/:id` 会按类型跳转。
- 图文使用标准 Tiptap 文档保存：图片为 `figure > image + figcaption`，配文为 `paragraph`，同时生成 `contentHtml`；现有渲染、发布、导出和批量任务直接复用，无需新增内容表。
- 渲染验证：同一篇图文渲染公众号贴图、小红书、抖音图文、公众号时均识别全部图片；公众号贴图输出图片清单与纯文本，小红书生成 3:4 卡片，抖音输出竖屏图文文案与素材。
- AI 创作：`create_content` / `list_contents` 支持 `kind="gallery"`，可用 `mediaIds` 批量插入图片并自动设封面，`update_content` 可给已有图文追加图片。
- MultiPush JSON 导入保留 `gallery` 类型；视频 JSON 仍按原规则导入为文章（时间线不在内容 JSON 中）。
- 数据库：`contents.kind` 增加 `gallery`。旧库的 `CHECK (kind IN ('article', 'video'))` 无法原地修改，启动时自动重建 contents 表并保留全部行、索引和子表外键，迁移后执行 `PRAGMA foreign_key_check`；无 `kind` 列的旧库继续走原有增量迁移。
- 新增 [图文内容说明](docs/GALLERY_CONTENT.md)，更新 README、产品规格、用户指南、验收计划和视频内容文档。

**验证**

- `npm run typecheck -w server`、`npm run typecheck -w web` 通过。
- `npm run build` 通过。
- `npm test`：server 43 个文件 / 424 项、web 2 个文件 / 20 项全部通过；新增数据库迁移测试覆盖旧 CHECK 约束升级、旧内容保留、子表行保留、`gallery` 创建与筛选，新增 AI 图文创建测试覆盖 `kind="gallery"` 与图片/封面写入。
- Playwright 端到端（真实服务 + 临时数据目录 + headless Chrome）：内容库四个入口文案正确 → 新建图文 → 上传 3 张图片 → 填写标题/图注/配文 → 调序 → 自动保存 → 刷新恢复 → 内容库显示「图文」角标与「3 张图」→ 重新打开 → API 渲染公众号贴图/小红书/抖音/公众号均识别 3 张图片；1440×980 与 390×844 无横向溢出，页面无 JS 错误。新增 `npm run smoke:gallery` 浏览器回归，覆盖上传、排序、保存、刷新恢复、内容库角标、图文渲染与 390×844 移动端；截图输出到 `artifacts/gallery-check/`。

## 2026-11-20 · 全平台发布记录删除（草稿 / 失败）

**改了什么**

- 统一发布记录删除规则：所有平台只允许删除 `draft`（草稿）和 `failed`（失败）记录；`running`、`published`、`uncertain` 及公众号 `awaiting_confirmation` 一律拒绝，已发布内容不会被自动删除或下架。
- 为微博、今日头条、百家号、豆瓣、掘金、CSDN、简书、小红书补齐 `DELETE /api/<platform>/publications/:id` 和前端删除入口；AI `delete_draft` 同步扩展到已接入发布服务的平台（小红书自动发布已停用，仅保留本地删除）。删除按钮只出现在草稿/失败记录上。
- 新增远端草稿删除：
  - 掘金：`POST /content_api/v1/article_draft/delete`（`draft_id`），复用已保存会话与 CSRF；
  - CSDN：`POST /blog/phoenix/console/v1/article/del`（`articleId`, `deep:true`），按网页端公开的 X-Ca 签名规则生成请求头；
  - 简书：`POST /author/notes/:id/soft_destroy`，草稿移入简书回收站。
- 微信公众号、公众号贴图、知乎、少数派、个人博客既有的远端草稿删除保持不变，同时允许清理失败记录；失败记录带远端草稿编号时尽量顺带删除，远端失败不阻塞本地清理。
- 微博、豆瓣：草稿只存在于本系统，删除仅清理本地记录。
- 抖音、今日头条、百家号、小红书：平台未返回可定位的草稿编号、写接口受限或自动发布已停用，删除仅清理本地记录，确认框会明确提示到平台后台清理。
- 新增共享前端组件 `PublicationDeleteButton`，统一确认文案、远端/本地删除提示和失败反馈。
- 更新 README、产品规格、验收计划、架构说明及 14 个平台发布文档。

**验证**

- `npm run typecheck -w server`、`npm run typecheck -w web` 通过。
- 新增服务测试：掘金/CSDN/简书草稿远端删除、已发布拒绝删除、失败记录在远端清理失败时仍可本地清理；微博本地草稿删除与已发布拒绝；今日头条本地草稿删除；小红书本地删除路由。
- `npm test`：server 43 个文件 / 422 项、web 2 个文件 / 20 项全部通过；`npm run build` 通过。
- 远端删除当前未使用真实账号执行：掘金删除接口、CSDN 删除接口（签名已验证到「请登录后操作」鉴权层）、简书 `soft_destroy` 路径均来自平台公开网页实现，首次使用请先用测试草稿确认。

## 2026-11-20 · 修复知乎表格发布与 CSDN Markdown 导入

**改了什么**

- 知乎：`prepareZhihuContent` 不再输出 `<table data-draft-node="block" data-draft-type="table">`。知乎草稿接口会静默丢弃所有 `table/tr/td`，导致 3 张表（19 行、57 个单元格）的内容在回读时全部消失并触发 `zhihu_content_mismatch`。现在把每张表转换为等价 `<ul>`：每行一个 `<li>`，单元格用 `｜` 分隔，表头行加粗，空单元格跳过，表内链接、行内代码和图片等标记保留；`<caption>` 保留为前置段落。知乎预览、HTML/Markdown 下载与实际提交保持一致。
- 知乎回读：继续核对文字、图片、列表、图注、链接、代码和标题结构，并断言提交内容不含残留 `<table>`；表格失效会以文字或列表项差异被拦截。
- CSDN：修正导入校验。原逻辑把去掉 Markdown 标记后的 Markdown 与未规范化的编辑器文本比较，`# 优化|...` 这类标题必然不匹配，导致导入成功后仍回退粘贴。现在两边都归一化为连续的文字/数字序列，并要求正文首尾都出现，避免只导入标题或残留欢迎页时误判。
- CSDN：编辑器自动弹出的「模版库」模态框和新手指引浮层会遮住标题栏与编辑区，回退粘贴的点击会超时。发布驱动在编辑器就绪后和导入后关闭这些已知浮层；标题点击失败时用 DOM 事件兜底。
- CSDN：回退粘贴改为直接聚焦编辑区、全选并替换，粘贴后同样校验首尾；若仍失败，在点击保存前返回 `csdn_body_failed`。保存请求发出前的页面/网络异常现在返回 `csdn_publish_failed`（可重试），只有确实可能已提交保存时才标记 `uncertain`。
- 新增单元测试：知乎多表格（3 张、共 22 行）、空单元格、表格被丢弃检测；CSDN Markdown 标记、零宽字符、正文截断和欢迎页误判。
- 更新知乎/CSDN 发布文档、产品规格与 README。

**验证**

- `npm run typecheck`、`npm test`：server 43 个文件 / 416 项、web 2 个文件 / 20 项全部通过；`npm run build` 通过。
- 真实知乎账号回读：失败草稿 `2107223098420417881` 的 `content` 中 `table/tr/td` 均为 0，确认草稿接口丢表。
- 真实知乎 API 验收：用失败稿件的原文生成 3 表/19 行正文（51 个列表项、1 张图），创建临时草稿 `2107241611868508742` 并回读；`table=0`、`li=51`，`verifyZhihuContent` 通过；随后删除草稿并确认 HTTP 404。临时草稿已清理，未发布文章。
- 真实 CSDN 登录态 + 生产 Chromium：关闭模板/新手指引后，Markdown 导入校验通过，标题写入正确；拦截 `saveArticle` 响应检查请求体，标题、正文尾部均在且无欢迎页残留。强制走粘贴回退时，全选替换 4881 字后同样校验通过，保存请求体完整；两次均未实际创建 CSDN 草稿。
- 2026-11-20 两次真实 CSDN 失败（21:18、21:30）的日志与上述复现一致：导入成功但校验失败，回退点击被浮层拦截。

## 2026-11-20 · 统一设置页与可视化大模型高可用配置

**改了什么**

- 新增导航「设置」页（`/settings`），集中管理账号与安全、大模型、大模型高可用；AI 创作页不再弹出模型设置弹窗，只保留状态芯片和「设置」入口。
- 设置页三分类：
  - 账号与安全：显示名称、头像、用户名/邮箱/注册时间、修改密码（修改后所有设备重新登录）；
  - 大模型：账号级 OpenAI 兼容接口、模型、API Key、温度，支持保存、保存并测试、清除账号配置和查看服务器池摘要；
  - 大模型高可用：提供商池完整图形化编辑。
- 提供商池图形化编辑：
  - 添加/删除/排序提供商，配置 ID、名称、接口地址、默认模型、可用模型；
  - 每个提供商多个 API Key，可单独配置名称、Key 专属接口地址、启用/停用和优先级；
  - 每个提供商独立开关「多 Key 高可用」：开启时按优先级轮换；关闭时只使用第一个启用的 Key，其余 Key 保留不参与轮换；
  - 高级设置：探活间隔、连续失败熔断阈值、额度/认证/限流/临时异常/提供商熔断冷却、模型等价映射 JSON；
  - 已有 Key 留空保留原值，仅展示脱敏标识；保存时原子写入 `DATA_DIR/ai-providers.json`（0600）并热加载，无需重启。
- 新增 `GET /api/ai/providers`、`PUT /api/ai/providers`；保存合并未修改 Key、校验配置并热加载网关。生产环境只有 `MULTIPUSH_ADMIN_USERNAMES` 中的用户可写，开发/桌面版允许所有登录用户；环境变量提供的池在页面只读。
- 网关支持提供商级 `highAvailability` 和 Key 级 `enabled`：关闭多 Key 高可用时只取第一个启用 Key；停用 Key 保留但跳过请求和后台探活；显式「检测全部 Key」仍覆盖所有已启用的 Key。
- 更新 README、AI 创作、产品规格、架构与部署文档，补充管理员配置、热加载和设置页说明；新增 `npm run smoke:settings` 设置页浏览器回归。

**验证**

- `npm run typecheck`、`npm test`：server 43 个文件 / 410 项、web 2 个文件 / 20 项全部通过；`npm run build` 通过。
- 新增服务端测试覆盖：提供商池脱敏视图、Key 留空保留、新 Key 必填、原子写入 600、全 Key 停用拒绝、多 Key 高可用开关、停用 Key 跳过、运行时热加载、生产管理员权限、只读环境变量池；路由测试覆盖 `GET/PUT /api/ai/providers` 的鉴权、校验和 `no-store`。
- 真实浏览器验证（本地生产构建）：`/settings` 三个分类可切换；提供商页显示 2 个 Key、多 Key 高可用开关和单 Key 启停；关闭高可用与账号2后保存，刷新后状态保持；重新开启并保存成功；AI 页设置入口跳转 `/settings?tab=ai`；390×844 无横向溢出。
- `npm run smoke:settings` 通过并输出截图到 `artifacts/settings-check/`；桌面与 390×844 移动端均无横向溢出。

**部署**

- 已在 `/opt/MultiPush/.env` 配置 `MULTIPUSH_ADMIN_USERNAMES=yuanxin`；Jenkins 构建 #116 成功（提交 `1226445`），部署后启动日志 `[multipush] ai providers=1 keys=2 source=file`。
- 生产 `GET /api/ai/providers`：`editable=true`、`source=file`，返回 2 个 Key 的脱敏标识和高可用开关；`PUT /api/ai/providers` 用现有 Key（不提交明文）保存成功，文件权限 `600` 且包含 `highAvailability`/`enabled`，热加载后探活仍为账号1 额度不足、账号2 可用，证明 Key 未丢失。
- 生产浏览器（LAN 地址，1440×1000 / 390×844）复核：设置导航、三个分类、提供商编辑、多 Key 高可用开关、逐 Key 启停、未保存提示、AI 页跳转设置均正常；移动端无横向溢出。截图见 `artifacts/settings-check/production-settings-*.png`。

## 2026-11-20 · CSDN 渲染与发布

**改了什么**

- 新增 CSDN 平台：`PlatformId`、平台信息、渲染器、预览、下载、发布管理、批量发布与 AI 工具全部接入。
- 新增 `server/src/renderers/csdn.ts`：CSDN 风格技术博客排版（白色正文、`#fc5531` 主色、深色代码块），生成 Markdown 与 HTML 下载；标题上限 100 字，视频不进入正文并给出提醒。
- 新增 CSDN 扫码登录：抓取 `passport.csdn.net` 官方微信登录二维码，按用户加密保存浏览器会话；通过编辑器 `getBaseInfo` 返回 401/403 判断会话失效。
- 新增 CSDN 发布驱动 `server/src/csdn-browser.ts`：打开 `editor.csdn.net/md`，通过 `#import-markdown-file-input` 导入 Markdown、填写标题，保存草稿或打开发布设置自动添加标签后发布；回读 `saveArticle` 响应中的文章编号与公开地址，原创校验未通过、未返回编号、页面异常分别标记失败或结果待核实。
- 新增 `server/src/csdn.ts`、`server/src/routes/csdn.ts` 与 `csdn_accounts` / `csdn_publications` / `csdn_publication_resolutions` 表；支持登录、断开、草稿/发布、发布记录、重复提交保护、重启恢复和人工核实。
- 发布页新增 CSDN 标签页与独立页面（二维码弹窗、标签输入、草稿/发布模式、记录与核实）；渲染工作台新增 CSDN 模拟预览、「发布到 CSDN」和 Markdown/富文本复制；批量发布与 AI 工具（生成排版、发布、批量发布、账号/发布记录查询）同步支持 CSDN。
- 新增 `CSDN_BROWSER_PATH` 配置；更新 README、架构、产品规格、桌面端、部署、视频与链接策略文档，新增 [CSDN 发布说明](docs/CSDN_PUBLISHING.md)。

**验证**

- `npm run typecheck`、`npm test`：server 43 个文件 / 399 项、web 2 个文件 / 20 项全部通过；`npm run build` 通过。
- 新增 `server/test/csdn.test.ts`（7 项）覆盖会话加密与用户隔离、草稿/发布与标签、标题长度校验、结果待核实与人工核实、重启恢复、CSDN Cookie 身份解析、`saveArticle` 响应解析；`server/test/workbench.test.ts` 增加 CSDN 排版调整后 Markdown 重新生成断言。
- 真实 Chrome 验证：CSDN 登录页二维码抓取成功（`data:image/jpeg;base64`），伪造会话被 `getBaseInfo` 401 正确识别为已失效；本地用官方编辑器实测 Markdown 导入、标题填写、保存草稿请求与发布弹窗/标签选择器。
- `node scripts/smoke-juejin-jianshu-ui.mjs` 构建后通过：新增 CSDN 发布页和渲染页「发布到 CSDN」断言，截图输出至 `artifacts/juejin-jianshu-ui-check/`。
- 当前环境没有 CSDN 账号，未执行真实登录后的草稿创建和公开发布；首次部署后请先用真实账号保存草稿，再测试直接发布。

## 2026-11-19 · AI 大模型多 Key / 多提供商高可用

**改了什么**

- 新增服务器提供商池：支持多个提供商按有序回退链排列，每个提供商配置多个 API Key（按优先级），且每个 Key 可单独覆盖 base_url；提供商、模型和 Key 全部来自 `AI_PROVIDERS_JSON` 或受保护的 `DATA_DIR/ai-providers.json`（也可用 `AI_PROVIDERS_FILE`），旧版 `OPENCODE_GO_API_KEY` / `OPENCODE_GO_API_KEYS` 继续兼容。
- 同一提供商内 Key 自动轮换：402、429 额度类错误（含 OpenCode `GoUsageLimitError`）判定额度不足，401/403 判定 Key 失效，二者冷却并切换；429 限流单独处理，优先临时轮换或等待重试，不把 Key 判定为失效；模型保持不变，当前请求自动用新 Key 重试。
- 跨提供商回退：某提供商全部 Key 不可用或连续失败达到阈值时熔断该提供商并切到下一个；优先使用 `modelMap` 等价映射，其次同家族/同级别模型，最后目标提供商默认模型；回复上方展示实际使用的提供商、模型和脱敏 Key，并标注切换原因。
- 冷却与探活：Key/提供商冷却状态持久化到 `ai_provider_key_states` / `ai_provider_states`，后台定时最小请求探活，恢复后按优先级自动回到主 Key/主提供商。
- 新增「高可用」面板（AI 创作页顶部/侧栏入口）：查看每个提供商和 Key 的优先级、脱敏标识、状态（可用/冷却/额度不足/失效/待探活）、冷却时间、成功/失败/额度/认证/限流次数、Token 用量；支持「检测全部 Key」和单提供商测试；展示切换/恢复记录与最近请求的实际路由。
- 新增审计：`ai_failover_events` 记录每次 Key/提供商切换、冷却、限流轮换和恢复（时间、原因、前后提供商/Key 脱敏标识、模型映射）；`ai_provider_requests` 记录每次请求的提供商、模型、脱敏 Key、状态、HTTP 状态、耗时和 Token。Key 明文不写数据库、不写日志、不返回前端。
- 新增 `GET /api/ai/gateway`、`POST /api/ai/gateway/probe`；`POST /api/ai/settings/test` 改走高可用网关并返回 `routing`；`AiChatResult` 增加本轮实际路由 `routing`。
- 新增配置模板 `server/ai-providers.example.json`，更新 README、AI 创作、架构、产品规格与部署文档；新增 `npm run smoke:ai-gateway` 浏览器回归。
- 代码审查后加固：请求级 400/404/422 只跳过当前提供商的本次请求，不再熔断共享提供商；模型映射按“精确键 → 通配键”依次尝试，具体映射缺目标时继续匹配 `*`；探活严格按配置间隔执行，手工探活全局单飞且同一账号 5 秒内只能发起一次；限流重试尊重 Key 的 Retry-After，不会在冷却未到期时提前重试；额度/认证冷却改为固定配置时长，不再按历史累计次数指数放大；账号 Key 冷却到期后在下一次使用前先做 16-token 探活；账号设置留空 Key 仅在接口地址与服务器默认一致时沿用服务器 Key，避免把服务器密钥发往任意地址；保存并测试会明确提示“账号 Key 不可用，已使用备用路由”。

**验证**

- `npm run typecheck`、`npm test`：server 42 个文件 / 391 项、web 2 个文件 / 20 项全部通过；`npm run build` 通过。
- 新增 `server/test/ai-gateway.test.ts`（22 项）覆盖额度不足/401/429 限流区分、单 Key 限流等待重试、跨提供商映射、熔断跳过后恢复、探活回到最高优先级、账号配置回退、配置加载与文件权限、状态/审计不泄露明文；`server/test/ai-gateway-routes.test.ts`（4 项）覆盖鉴权、`no-store`、探活参数；`server/test/ai.test.ts` 增加切换后会话历史完整和工具轨迹保留断言。
- 真实 OpenCode Key 联调：账号1（额度已耗尽）+ 账号2（有额度）按优先级配置，请求命中账号1 的 `HTTP 429 GoUsageLimitError` 后自动切到账号2，模型保持 `deepseek-v4.1-flash`，回复成功，事件记录 Key 脱敏 `oc_sk_e…tK-T`；继续第二轮直接使用账号2，历史 4 条完整。
- 跨提供商联调：停用 OpenCode Go（只保留耗尽 Key），配置本地备用提供商，自动回退并按 `modelMap` 把 `deepseek-v4.1-flash` 映射为 `mock-fallback-model`，6 条会话历史完整；`provider_switch` 记录映射前后模型。
- 真实浏览器 1440×1000 / 390×844 验证高可用面板、探活、切换记录和最近请求；DOM 无 Key 明文，移动端无横向溢出；`npm run smoke:ai-gateway` 通过并输出截图到 `artifacts/ai-gateway-check/`。

**部署**

- Jenkins 构建 #110（`26bb4ad`）、#111（`9296a63`）、#112（`48b7d79`）均成功，部署后 `/opt/MultiPush/.data` 与 `.env` 保留；启动日志 `[multipush] ai providers=1 keys=2 source=file` 确认从受保护配置文件加载了 2 个 Key。
- 生产环境「检测全部 Key」：账号1 返回 `额度不足（HTTP 429）` 并标记 exhausted，账号2 返回「连接成功」；生产对话使用账号2，模型保持 `deepseek-v4.1-flash`，回复「部署验证成功。」，第二轮历史 4 条完整；验证会话随后删除。
- 生产 `/api/ai/gateway` 返回 Key 脱敏标识、状态、用量、切换冷却与最近请求，响应中不含 Key 明文；主 Key 冷却时自动使用账号2，并记录 `key_switch`（账号1 → 账号2）事件。
- 生产浏览器（LAN 地址 `http://192.168.0.111:34080`，1440×1000 与 390×844）复核「高可用」面板：2 个 Key 状态、切换/冷却记录、最近请求均正常，移动端无横向溢出。
- 页面在 1440×1000 与 390×844 下验证通过；`npm run smoke:ai-gateway` 通过并生成 `artifacts/ai-gateway-check/` 截图。

## 2026-11-19 · 移动端 AI 创作页布局优化

**改了什么**

- 手机浏览器（≤700px）下 AI 创作页改为「对话优先」布局：会话列表 + 模型配置压缩成顶部一条横向工具条（模型芯片、可横滑的会话胶囊 + 常显删除按钮、右侧新建会话按钮），原来占约 1/3 屏高的纵向侧栏不再挤压对话区，对话区高度提升约 1 倍。
- 修复对话标题溢出：标题容器补 `min-width: 0`，长会话标题按省略号截断，「模型设置」按钮不再被挤出屏幕（此前线上截图里标题直接顶出右边界、按钮不可见）。
- 视口高度改用 `dvh`（`app-shell` / `ai-page` / `app-main`），iOS Safari 地址栏收起/展开时不再出现多余整页滚动与顶部裁切；`viewport` 增加 `viewport-fit=cover`，AI 输入区底部适配 iPhone 安全区。
- 移动端细节：输入框改为两行左右并禁用拖拽手柄（`resize:none`）、会话条隐藏滚动条、发送按钮右对齐；触屏软键盘 Enter 改为换行（不再误发送），发送统一走「发送」按钮，鼠标/触控板仍保留 Enter 发送（按 `pointer: fine` 判定）。

**验证**

- 新增 `scripts/smoke-ai-mobile-ui.mjs`（`npm run smoke:ai-mobile`，构建后以 390×844 / 430×932 移动端仿真跑 Playwright）：断言整页无横向溢出、不产生整页滚动、标题被省略号截断、「模型设置」按钮在可视区内、输入框底部不超出首屏、对话区高度 ≥320px 且明显大于会话条、触屏 Enter 不发送而按钮可发送；另截 1440×1000 桌面图确认桌面布局不变。产物见 `artifacts/ai-mobile-check/`。
- `npm run typecheck`、`npm run test -w web`（20 项）全部通过；桌面布局（侧栏会话列表、composer、模型设置弹窗）未改动。

## 2026-11-19 · AI 创作不再因工具调用轮数上限中断视频导出

**改了什么**

- 修复线上问题：AI 新建视频内容并导出成片时，`export_video` 后轮询两次 `get_video_export`（31% → 67%）就触发「已达到单次对话的工具调用上限」——8 轮预算被"了解素材→建内容→查时间线→导出→轮询"的正常工作流耗尽，而成片在最后一次轮询后 1.7 秒才完成。
- 单轮工具调用轮数上限 `MAX_TOOL_ROUNDS` 8 → 16（`server/src/ai.ts`），多步创作工作流不再中途被截断；原有 6 分钟单轮 deadline 仍兜底。
- `export_video` 内置等待：触发导出后最多等待 30 秒，短素材（几秒成片）在**同一轮**直接返回 `completed` + `outputMediaId`，模型无需再轮询；长任务超时后返回最新 `queued/running` 状态，交给 `get_video_export` 继续查询。
- `export_video` / `get_video_export` 返回结构统一（新增 `progress`、`message`、`totalDuration`）；系统提示与工具描述同步更新等待与轮询策略。

**验证**

- `server/test/ai.test.ts` 增加断言：`export_video` 等待到终态后才返回，工具结果携带 `status:"failed"` 与失败原因（媒体丢失路径）；`npm run typecheck`、server 40 文件 / 362 项 + web 2 文件 / 20 项全部通过。
- Jenkins 部署后线上复核：AI 建视频内容 → 导出一轮内返回 completed 并汇报成片素材 ID。

## 2026-11-19 · 渲染记录预览视频内容的导出成片

**改了什么**

- 智能渲染在渲染视频内容（`kind: video`）时，自动把**最近一次导出成功的成片**作为正文开头的视频注入渲染快照：
  - 公众号 / 知乎 / 少数派 / 博客等长文平台：正文顶部出现内嵌视频播放器（绝对地址 `<video controls>`），渲染工作台手机壳预览可直接播放；
  - 抖音：自动以视频笔记竖屏预览，文案保持纯文本不含视频地址；
  - 小红书：自动切换到「视频笔记」预览模式；
  - 不支持视频的平台（微博 / 头条 / 百家号 / 豆瓣 / 掘金 / 简书）保持原有「视频将在发布时忽略/移除」提示。
- 没有导出过成片时渲染行为不变；渲染记录保存生成时刻的成片快照，重新导出后再次渲染即获得新成片；注入只发生在渲染快照，不修改视频内容正文。
- AI 创作与批量渲染 / 批量发布走同一管线，行为一致。

**实现**

- `RenderInput` 新增可选 `videoUrl`；`renderers/index.ts` 在渲染前把成片包装成 `<figure><video controls></video></figure>` 前置到 contentHtml（只使用 sanitize 白名单属性）。
- `video.ts` 新增 `latestExportOutputUrl()`（最近完成的导出 → 输出素材 URL）；`routes/renders.ts`、`ai.ts`、`batch.ts`（批量渲染/发布）统一传入。

**验证**

- `server/test/renderers.test.ts` 新增 3 组断言：公众号注入成片（绝对地址、位于正文之前、meta.videoCount=1）、抖音/小红书视频笔记模式（文案不含视频地址）、无成片/图文内容不受影响；`npm test`：server 39 个文件 / 344 项 + web 20 项全部通过。
- `npm run smoke:video` 增加「渲染记录包含导出成片（wechat/douyin/xiaohongshu）」「公众号渲染含内嵌视频播放器」检查，本地与线上均通过。
- `npm run smoke:video-ui` 增加渲染预览检查并截图：公众号手机壳内嵌成片播放器、抖音竖屏视频笔记预览（`artifacts/video-workspace-check/render-wechat.png`、`render-douyin.png`）。
- 已部署复核：线上创建视频内容 → 导出成片 → 渲染，工作台预览可见成片播放器。

## 2026-11-18 · AI 创作助手支持上传图片 / 视频 / 文档附件

**改了什么**

- AI 创作对话输入框新增回形针附件上传：图片、视频走素材库上传（自动登记为素材，≤10 MB 图片 / ≤200 MB 视频），文本文档（txt/md/markdown/json/csv/html/xml/yml/yaml，≤2 MB）前端读取全文随消息发送；支持一次多选、发送前移除、上传进度提示。
- 模型按附件意图创作：
  - 图片：≤6 MB 常见格式以 base64 视觉内容发给模型（可"看图"），消息携带素材 ID 与尺寸；`create_content`/`update_content` 新增 `mediaIds`，图片按顺序追加到图文正文末尾，第一张默认作为封面。
  - 视频：`create_content(kind:"video", mediaIds:…)` 用上传的视频按顺序初始化剪辑时间线（trimStart 0、保留到结尾），之后可继续用剪辑工具修剪/调序/导出成片。
  - 文档：全文作为写作素材注入（注入时每份截断到 2 万字并标注）。
- 上下文与费用保护：附件元数据（含素材 ID）持久保存到消息（`ai_messages.attachments_json`）跨轮可用；**文档全文与图片视觉内容只在发送当轮注入**，历史轮次降级为「[附件] 名称（素材 ID）」紧凑引用。
- 系统提示新增附件使用规则（mediaIds 用法、文档引用、禁止编造素材 ID、图片内容先描述确认）。
- 输入为空但有附件时允许发送；会话标题回退到附件名；失败时保留已上传附件便于重试。

**实现**

- 共享类型：`AiMessageAttachment`、`AiSendMessageInput`；`AiMessage.attachments`。
- 数据库（增量迁移 `ensureAiColumns`）：`ai_messages.attachments_json`；`CreateAiMessageValues`/`mapAiMessage`/`createAiMessage` 读写附件。
- 服务端：`chat` 入参改为 `{message, mediaIds?, documents?}`（归属校验、数量/长度上限、空文本+附件允许）；`providerMessages` 变异步，按"最近一条用户消息"注入完整附件上下文（视觉 parts + 文档全文），旧消息紧凑引用；`create_content`/`update_content` 支持 `mediaIds`（图文插图 + 封面 / 视频时间线初始化，类型与归属校验）。
- 前端：`AiPage.tsx` 附件选择/芯片/移除/进度、用户气泡附件展示（图片缩略图 + 文档/视频图标）、`api.ai.sendMessage` 传完整输入；`ai.css` 附件样式。
- 文档：AI 创作说明新增「对话附件」章节并更新 API 表；同步 README、产品规格。

**验证**

- `npm run typecheck`（server + web）通过；`npm run build` 通过。
- server 39 个文件 / 341 项测试全部通过（`ai.test.ts` 新增 7 项：附件存储与视觉 parts、历史轮次紧凑引用、文档全文当轮注入与截断、无文本纯附件发送、跨用户素材拒绝与数量上限、`create_content` 图片插入与封面、`create_content(kind=video)` 时间线初始化、类型不匹配以工具错误返回）。
- `node scripts/smoke-ai-attachments.mjs`（新增，`npm run smoke:ai-attachments`，headless Chrome + 隔离假 LLM/假素材库）：上传图片+文档 → 芯片展示 → 发送 → 气泡内图片缩略图与文档徽标 → 请求体含 mediaIds 与文档全文 → 发送后清空 → 移动端截图，页面无 JS 错误；截图在 `artifacts/ai-attachments-check/`。
- 未覆盖：真实多模态模型联调（视觉识别效果取决于所配置模型是否支持 image_url 输入；纯文本模型会忽略视觉部分）；PDF/Word 等二进制文档解析留待后续。

## 2026-11-18 · 新增公众号贴图（图片消息）渲染与 API 草稿发布

**改了什么**

- 新增独立平台「公众号贴图」，对应公众号后台「新的创作 → 贴图」（官方 API `article_type: newspic` 图片消息）：渲染提取正文图片（最多 20 张、首图即封面）、标题（≤32 字）与纯文本配文，话题以 `#标签#` 拼入文案；含贴图手机壳预览、文案 TXT 与结构化 JSON 下载。
- 渲染工作台支持贴图独立的标题/配文/话题调整（配文存为 `captionBody`，正文纯文本不参与富文本编辑），发布前检查按贴图上限校验（标题 32 字、图片 20 张、配文必填）。
- 发布中心新增「公众号贴图」页：使用公众号 AppID/AppSecret 连接（AES-256-GCM 按用户加密保存，密钥 `.wechatpic-session-key`），一键「保存为贴图草稿」；正式发表按个人号现状在公众号后台手动完成（2025-07 起个人主体账号被回收 `freepublish` 权限）。
- 服务端经官方 API 完成：`cgi-bin/token`（含内存缓存与 40164 IP 白名单友好提示）、`material/add_material` 上传永久图片素材（仅 JPG/PNG、≤10 MB）、`draft/add` 创建 newspic 草稿、`draft/get` 回读核对标题与图片数量、`draft/delete` 删除草稿；`account/getaccountbasicinfo` 读取公众号名称（无权限回退 AppID）。
- 幂等与安全：同一公众号+原文+标题+配文+图片重复提交复用已有记录；上传失败/明确拒绝→失败，草稿已建但核对未完成/网络中断/服务重启→结果待核实（不自动重试，需人工核对后删除记录再提交）；原文修改/删除阻止发布旧版本；跨用户渲染不可见。
- 贴图发布记录支持删除草稿并同步删除后台草稿（已发表或已消失时自动清理本地记录）。

**实现**

- 共享类型：`PlatformId`/`PLATFORMS`/`PLATFORM_ORDER` 新增 `wechatpic`；`WechatpicAccount`、`WechatpicConnectInput`、`WechatpicPublishInput`、`WechatpicPublication`；`publishChecks` 贴图分支（配文按纯文本长度校验）。
- 数据库（`CREATE TABLE IF NOT EXISTS` 增量，无破坏性迁移）：`wechatpic_accounts`（加密凭证+AppID+名称）、`wechatpic_publications`（状态 running/draft/published/failed/uncertain，幂等键唯一）及重启恢复置 uncertain。
- 后端：`server/src/wechatpic-api.ts`（官方 API 驱动，token 缓存、素材上传、newspic 草稿、错误码映射：40164 IP 白名单/40001 凭证/48001 无权限/45009 限频）、`server/src/wechatpic.ts`（服务层：连接、贴图构造、幂等、状态机、草稿删除）、`server/src/renderers/wechatpic.ts` + `render-adjustment.ts` 贴图分支、`server/src/routes/wechatpic.ts`、`app.ts` 挂载 `/api/wechatpic`、`validation.ts` 新 schema 与平台枚举（渲染平台上限 12→13）。
- 前端：`web/src/features/publish/WechatpicPublishPage.tsx`（连接弹窗、图片清单、iframe 预览、发布记录、IP 白名单提示）、`PublishPage.tsx` 平台 Tab、`RenderPage.tsx` 贴图手机壳场景与复制/发布入口、`platform-glyph.tsx`、`lib/api.ts` `api.wechatpic`、`render.css`/`publish.css` 贴图样式。
- 文档：新增 `docs/WECHATPIC_PUBLISHING.md`；同步 README、产品规格、架构说明、用户指南与 AI 创作说明（AI 工具与批量发布暂不含贴图平台）。

**验证**

- `npm run typecheck`（server + web）通过；`npm run build` 通过。
- `npm test`：server 39 个文件 / 334 项全部通过（新增 `server/test/wechatpic.test.ts` 16 项：渲染器图片提取与 20 张截断、32 字标题截断与无图/视频警告、配文调整与发布检查、AppID/AppSecret schema 校验、凭证加密与用户绑定、连接与失败闭环、建草稿与幂等复用、跨用户/无图/视频/超长标题/原文变更拦截、结果待核实与拦截、核对失败保留草稿状态、删除草稿（含后台已消失）、已知拒绝置失败并在鉴权失败时使连接过期、驱动层先验证 token 再读昵称且凭证错误必须连接失败）；web 20 项通过。
- `node scripts/smoke-wechatpic-publish.mjs`（新增，已加入 `test:publish-ui` 链，headless Chrome + 隔离假 API）：打开发布页 → AppID/AppSecret 连接 → 图片清单（1/20）与配文校验 → 确认创建草稿 → 状态「草稿已创建，待手动发表」→ IP 白名单错误提示 → 删除草稿恢复可提交 → 桌面/移动端截图，页面无 JS 错误；截图在 `artifacts/wechatpic-ui-check/`。
- 未覆盖：真实公众号 API 联调（需 AppID/AppSecret 与 IP 白名单，属账号操作，待用户在受控环境验证）；已认证企业号/服务号的 `freepublish` 自动发表留待后续版本。

## 2026-11-18 · 新增视频内容与系统内剪辑（服务端 ffmpeg）

**改了什么**

- 新增内容类型 `video`（视频为主，带标题和正文文案）：内容库新增「新建视频」入口；视频内容带角标，点击进入独立的全屏视频工作台 `/video/:id`；图文编辑器误入会自动跳转。
- 视频工作台支持一次上传一段或多段视频（MP4/WebM/MOV，单段 ≤200MB，带进度条），上传后进入剪辑时间线；正文按空行分段存储为 HTML 段落，标题/正文/标签与时间线自动保存。
- 系统内剪辑：预览播放器（逐段/整条播放）、片段列表（入点/出点数字输入 + 「设入点/设出点」按钮）、时间线总览条、上移/下移、删除片段（不删素材）、复制内容时同步复制时间线。
- 「导出成片」：服务端 ffmpeg 按时间线逐段裁剪并统一规格（H.264/AAC、30fps、yuv420p、偶数尺寸、缺音轨补静音），再 concat 合并为 `+faststart` MP4；异步任务含进度与失败原因，重启后任务标记失败；成片自动登记为视频素材，可直接用于抖音视频笔记发布。
- AI 创作可操控剪辑：新增工具 `get_video_project`、`update_video_timeline`、`export_video`、`get_video_export`，`list_contents`/`create_content` 支持 `kind`；系统提示增加视频剪辑工作流。
- 服务端能力探测：未安装 ffmpeg/ffprobe 时剪辑仍可保存，导出给出明确提示（页面顶部横幅 + 接口 503）。

**实现**

- 共享类型：`ContentKind`、`VideoClip(Detail/Input)`、`VideoProject`、`VideoExport`、`VideoCapability`；`ContentSummary.kind`、`MediaAsset` 探测元数据。
- 数据库（增量迁移，user_version 18）：`contents.kind`、`media.meta_json`、`video_projects`（timeline_json）、`video_exports`；`video_count` 保存时间线时同步。
- 后端：`server/src/video.ts`（ffprobe 解析、ffmpeg 命令构建、导出队列、进度上报）、`server/src/routes/video.ts`、媒体上传内联探测 + `GET /api/media/:id/probe`、内容路由 kind 支持。
- 前端：`web/src/features/video/VideoWorkspacePage.tsx` + `video.css`、`api.video` 命名空间、内容库新建/跳转/角标、App 路由。
- 文档：新增 `docs/VIDEO_CONTENT.md`，同步 README、AI 创作说明、产品规格、架构说明与 `.env.example`（FFMPEG_PATH/FFPROBE_PATH）。

**验证**

- `npm run typecheck`（server + web）通过；`npm run build` 通过。
- `npm test`：server 38 个文件 / 318 项全部通过（含真实 ffmpeg 导出集成测试与 AI 视频剪辑工具链测试）；web 20 项通过。
- `server/test/video.test.ts`：时间线持久化与用户隔离、修剪裁剪校验（发现并修复了片段缺省起点继承上片段的 bug）、图文内容拒绝剪辑、ffmpeg 命令构建（显式终点/补静音/总时长）、ffprobe JSON 解析；装有 ffmpeg 的环境执行真实导出集成测试：两段混合规格素材（有音轨 320×240 + 无音轨 640×480）→ 裁剪合并 → 输出 3.0s 320×240 H.264+AAC，缺失媒体同步报 400、丢失文件异步任务失败原因正确。
- `node scripts/smoke-video.mjs`（新增，`npm run smoke:video`）：对真实服务完成 注册 → 建视频内容 → 上传两段（含 ffprobe 时长）→ 保存时间线 → 读取项目 → 图文拒绝剪辑 → 导出成片（Range 访问 + 大小校验）→ 回收站清理，全部通过。
- `node scripts/smoke-video-ui.mjs`（新增，`npm run smoke:video-ui`，headless Chrome）：登录 → 内容库「新建视频」→ 工作台打开 → 页面上传两段 → 修剪出点 → 上移调序 → 标题自动保存 → 导出成片完成并可下载，页面无 JS 错误；截图在 `artifacts/video-workspace-check/`。
- 待部署后在服务器复核 http://192.168.0.111:34080 的同一流程（服务器已预装 ffmpeg 6.1.1）。

## 2026-11-17 · 修复豆瓣登录二维码获取失败

- 豆瓣登录页默认打开短信登录，二维码模式需要 `?prefer_login_way=qrcode`；此前直接读取页面导致找不到二维码。
- 豆瓣登录 React 资源从 `asset.doubanio.com` 加载，无头 Chrome 的 ORB 会拦截；driver 改为通过 Playwright API 请求代理这些静态资源，并使用桌面 Chrome UA / 自动化特征开关。
- 二维码选择器改为优先 `.account-qr-scan img`，过滤 37px 的下载 App 小图标；已实测抓到 172×173 的真实登录二维码。
- 新增 `docs/DOUBAN_PUBLISHING.md` 故障排查说明。

## 2026-11-17 · 知识库侧栏图标与数字对齐

- 「未分组」不再使用收件箱图标，统一改为与知识库一致的文件夹图标：知识库使用自身颜色描边和淡色填充，未分组使用中性灰；两者尺寸、间距和行高一致。
- 知识库行始终为右侧操作菜单预留空间，「未分组」行使用同宽占位，文档数量统一右对齐，切换知识库或悬停菜单时数字不跳动。
- 主导航与知识库计数增加最小宽度和右对齐，单/多位数在同一列对齐。
- 验证：`npm run typecheck -w web`、`npm run build`；`scripts/smoke-library-menu.mjs` 增加侧栏图标尺寸与计数右边缘断言，通过。截图产物在 `artifacts/library-menu-check/`。

## 2026-11-17 · 知乎/微博/头条/百家号/豆瓣/掘金/抖音支持手机验证码登录

**改了什么**

- 7 个发布页在原有「扫码连接」之外新增「手机验证码登录」：用户输入 11 位手机号、勾选平台协议、获取并回填短信验证码即可连接。
- 服务端新增共享短信登录管理器：为每次登录启动隔离 Chromium，打开官方登录页，切换到短信/验证码登录，提交验证码后读取 `storageState`，再交给原平台服务执行 `checkSession` 并加密保存。
- 完全不接收、不保存平台密码；不出库完整手机号或验证码，不出现在 API 响应和日志中。验证码 5 分钟有效，同一用户、平台和手机号 20 秒内不能重复发送，同一用户同时只保留一个登录尝试。
- 遇到滑块、安全验证、二次确认、验证码错误或平台未确认发送时停止并提示改用扫码，不绕过平台验证。
- 新增 `POST /api/platform-sms/:platform/start`、`POST /api/platform-sms/:platform/:id/verify`、`DELETE /api/platform-sms/:platform/:id`。
- 未加入：微信公众号（无手机验证码）、小红书（自动登录已停用）、简书/少数派（无手机验证码）、个人博客（Halo 令牌）。

**实现**

- 新增 `server/src/sms-login.ts`、`server/src/routes/platform-sms.ts`；各平台 service 增加 `importPublisherSession` 复用原加密与身份校验。
- 新增前端共享 `SmsLoginModal`、`useSmsLogin`；发布页增加「手机验证码登录」按钮和弹窗。
- 新增 `docs/SMS_LOGIN.md`，并同步 README、产品规格、用户指南、验收计划、平台说明。

**验证**

- `npm run typecheck` 通过。
- `npm test`：server 36 个文件 / 303 项，web 2 个文件 / 20 项全部通过。
- `server/test/sms-login.test.ts`：手机号脱敏、非法手机号/平台、发送后验证、验证码错误重试、安全验证停止，5 项通过。
- `npx tsx scripts/smoke-sms-login-selectors.mts`：在真实官方登录页检查 7 个平台的手机号输入、发送和提交控件；只填测试手机号，不点击发送，不产生短信，全部通过。
- `node scripts/smoke-sms-login-ui.mjs`：7 个发布页弹窗、手机号/协议校验、关闭流程通过；知乎用例 mock 了发送/验证接口，验证验证码表单和连接后的账号名更新。
- 真实短信发送和平台登录需要用户本人手机号；当前环境未实际发送短信，上线后需用真实账号逐平台完成一次端到端验证。滑块/风控情况下应改用扫码。

**回滚**

- `git revert` 后重新构建；没有数据库迁移，已保存的扫码/短信会话均兼容原有字段。
- 若只想临时关闭短信入口，可隐藏发布页按钮并移除 `/api/platform-sms` 路由；不会影响扫码登录。

## 2026-11-17 · 编辑器封面支持选用正文图片

**改了什么**

- 编辑器左侧「封面」区域新增「从正文选择」入口：打开正文图片库，点击任意图片即可设为封面；本地上传、更换和移除封面的原有流程保留。
- 正文图片按文档阅读顺序去重展示，当前封面带「当前封面」标记；正文没有图片时给出插入提示。
- 正文中内嵌的 base64 图片或外部图片，选用时会先读取并转存为本站媒体（`/api/media`），再写入 `coverImage`；跨域、超过 20MB 或不支持的格式会提示改为本地上传。
- 封面仍保存为 `content.coverImage`，未改动数据库结构、内容 API 或发布流程。

**实现**

- 新增 `web/src/features/editor/cover.ts`：正文图片收集、同源地址归一化、图片来源分类、上传文件扩展名判断。
- 编辑器在文档初始化和每次正文更新时同步正文图片列表；封面选择复用现有自动保存。
- 新增 `scripts/smoke-editor-cover.mjs` 与 `npm run smoke:editor-cover`，使用隔离数据库和真实 Chrome 验证正文选图、本地上传、刷新后保留。

**验证**

- `npm run typecheck`、`npm test`（server 35 个文件 / 298 项，web 2 个文件 / 20 项）通过。
- `npm run build` 通过。
- `node scripts/smoke-editor-cover.mjs` 通过：正文 3 张图（含 1 张 base64 内嵌图）→ 选第 1 张 → 自动保存 → 重新打开标记当前封面 → 本地上传替换 → 刷新后保留 → 内嵌图转存后设为封面；截图产物在 `artifacts/editor-cover-check/`。

**回滚**

- `git revert` 本次提交后重新构建即可；无数据库迁移，已有封面数据和正文图片不受影响。

## 2026-11-17 · 微博/头条/百家号/抖音/豆瓣支持保存草稿

- 微博、豆瓣：网页端没有草稿箱，新增 MultiPush 本地草稿模式（`mode=draft`），保存完整发布快照，状态 `draft`，不提交平台。
- 今日头条、百家号、抖音：发布页新增「保存草稿」模式，在平台编辑器点击「存草稿」，状态 `draft`，不公开发布/不提交审核。
- 所有平台发布输入与 API 增加 `mode`（草稿/发布）；批量发布选择草稿模式时按平台能力执行。
- 发布记录 UI 增加草稿状态、草稿链接和模式切换；历史记录区分草稿与发布。
- 注意：微博/豆瓣是本地草稿；头条/百家号/抖音的存草稿按钮依赖平台页面，找不到按钮时会停止并提示人工核对。
- 回滚：`git revert`；数据库原有 `mode/status` 字段已兼容，豆瓣新增 `mode` 列，旧代码会忽略。

## 2026-11-17 · 新增掘金与简书渲染、草稿和发布

- 新增 `juejin` 平台：技术文章 Markdown 渲染/预览、HTML/Markdown 下载、掘金扫码登录、分类与标签解析、保存草稿、直接发布、发布记录和结果人工核实。
- 新增 `jianshu` 平台：Markdown 长文渲染/预览、HTML/Markdown 下载、浏览器 Cookie 连接（不保存密码）、默认文集草稿、公开发布、发布记录和结果人工核实。
- 两个平台均支持「保存草稿」和「直接发布」两种模式；批量发布和 AI 工具同步接入。
- 新增 `/api/juejin/*`、`/api/jianshu/*`、发布页、渲染预览和结果核实 UI。
- 新增 `docs/JUEJIN_PUBLISHING.md`、`docs/JIANSHU_PUBLISHING.md`；新增 `JUEJIN_BROWSER_PATH`、`JIANSHU_BROWSER_PATH`。
- 说明：掘金/Jianshu 均非官方开放写 API；掘金使用网页登录 Cookie + 内容接口，简书使用浏览器 Cookie + 网页接口。接口改版时会停止并保留记录，不自动重试未知结果。
- 回滚：`git revert` 后重新构建；数据库新增 `juejin_*` / `jianshu_*` 表，旧代码忽略，不影响既有数据。

## 2026-11-17 · 新增豆瓣日记渲染与发布

- 新增 `douban` 平台：豆瓣日记风格长文渲染、HTML/Markdown 下载、富文本复制、渲染工作台预览与批量渲染。
- 新增豆瓣扫码登录、加密会话、日记发布、正文图片转存、可见范围/标签、发布记录、幂等和结果人工核实。
- 新增 `/api/douban/*`、豆瓣发布页、批量发布、AI 工具平台枚举。
- 豆瓣没有官方开放写接口，发布使用已登录浏览器会话，属于实验性能力；接口改版、验证码或网络异常会停止并保留记录，不会自动重试。
- 新增 `docs/DOUBAN_PUBLISHING.md`，说明登录、发布、图片转存、风控和故障排查。
- 回滚：`git revert` 后重新构建即可；数据库新增 `douban_*` 表，旧代码会忽略，不影响既有数据。

## 2026-11-17 · 图文 figure/figcaption 与图注空行修复

**改了什么**

- 编辑器新增 Tiptap `figure` / `figcaption` schema，`<figure><img><figcaption>` 打开、保存、再次打开不再被拆成 `<img><p>`；加载和粘贴时由 ProseMirror 插件把“图片 + 紧邻 `图：` 段落”合并成 figure。
- Markdown / HTML 导入新增 `groupImageCaptions()`：只合并“1 张图 + 1 条紧邻图注”，保留全角标点、`：）` 等 caption 文本；多图、非图注、孤立图注不处理。
- 公众号、知乎、博客渲染统一输出 `<figure><img><figcaption>`。图片下边距为 0，图注上边距 8px，figure 外边距只保留一处；历史 `<p><img></p><p>图：…</p>` 在渲染前自动归一化。
- `contentHtml` / `contentJson` 同步：数据库记录 HTML checksum 与 stale 标记。仅 PATCH `contentHtml` 会把 JSON 标为 stale，编辑器改用 HTML；仅 PATCH `contentJson` 会重建 HTML；编辑器保存时两者来自同一份 Tiptap 文档。
- 新增迁移脚本 `npm run normalize:figures`（默认 dry-run，`--apply` 前自动备份数据库）。
- 新增 web 单测（Tiptap round-trip、21 组图、导入 6 类输入）、server 归一化单测、三平台渲染快照、API 同步测试和 21 组图文 E2E。

**影响平台**

- 微信公众号：渲染/草稿正文；旧渲染记录在发布前也会归一化。
- 知乎：渲染与草稿 API；发布仍使用知乎原生 `data-caption`，不产生空段落。
- 个人博客（Halo）：渲染与草稿；发布侧保留 `figure`/`figcaption`，由主题 `.prose figcaption` 控距。
- 少数派、今日头条、百家号等复用统一归一化，渲染结果同样变为 figure；未改变各平台发布专用转换。
- 历史内容：只改结构，不改正文文字；旧 `contentJson` 可继续加载。

**回滚**

1. 代码回滚：`git revert <本次提交>` 后重新构建部署。数据库新增列是向后兼容的，旧代码会忽略 `content_html_hash` / `content_json_stale`，无需删除列。
2. 迁移脚本回滚：脚本在 `--apply` 前生成 `multipush.sqlite.before-figure-normalize-*.bak`；需要时停服后用该备份恢复 `multipush.sqlite`（同时保留 WAL 文件的一致性）。
3. 发布记录：归一化不会删除或重写已有 render 记录；回滚后旧记录仍可打开。
4. 若要撤销单篇的 stale 标记，重新在编辑器打开并保存，或用 API 同时 PATCH `contentHtml` 与 `contentJson`。

**验证**

- `npm test`：server 32 个测试文件 / 271 项，web 11 项，全部通过。
- `npm run typecheck`、`npm run build` 通过。
- `node scripts/smoke-figure-captions.mjs`：Markdown 导入 → 编辑器打开/保存/重开 → 三平台渲染，21 组 figure/figcaption 全部保留；产物在 `artifacts/figure-caption-fix/`。
- 生产库一致性副本上验证真实 21 图文章：编辑器打开/保存/重开仍为 21 组 figure/figcaption，JSON 同步；三平台渲染 21/21。
- 真实公众号草稿、知乎草稿、Halo 页面需要已登录账号/扫码；本地 HTML、生产库副本与端到端链路已验证，平台后台回读步骤见 `docs/FIGURE_CAPTION_FIX.md` 第 7 节。
