# CHANGELOG

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

**验证**

- `npm run typecheck`、`npm test`：server 42 个文件 / 385 项、web 2 个文件 / 20 项全部通过；`npm run build` 通过。
- 新增 `server/test/ai-gateway.test.ts`（17 项）覆盖额度不足/401/429 限流区分、单 Key 限流等待重试、跨提供商映射、熔断跳过后恢复、探活回到最高优先级、账号配置回退、配置加载与文件权限、状态/审计不泄露明文；`server/test/ai-gateway-routes.test.ts`（4 项）覆盖鉴权、`no-store`、探活参数；`server/test/ai.test.ts` 增加切换后会话历史完整和工具轨迹保留断言。
- 真实 OpenCode Key 联调：账号1（额度已耗尽）+ 账号2（有额度）按优先级配置，请求命中账号1 的 `HTTP 429 GoUsageLimitError` 后自动切到账号2，模型保持 `deepseek-v4.1-flash`，回复成功，事件记录 Key 脱敏 `oc_sk_e…tK-T`；继续第二轮直接使用账号2，历史 4 条完整。
- 跨提供商联调：停用 OpenCode Go（只保留耗尽 Key），配置本地备用提供商，自动回退并按 `modelMap` 把 `deepseek-v4.1-flash` 映射为 `mock-fallback-model`，6 条会话历史完整；`provider_switch` 记录映射前后模型。
- 真实浏览器 1440×1000 / 390×844 验证高可用面板、探活、切换记录和最近请求；DOM 无 Key 明文，移动端无横向溢出；`npm run smoke:ai-gateway` 通过并输出截图到 `artifacts/ai-gateway-check/`。

**部署**

- Jenkins 构建 #110 成功（提交 `26bb4ad`），部署后 `/opt/MultiPush/.data` 与 `.env` 保留；启动日志 `[multipush] ai providers=1 keys=2 source=file` 确认从受保护配置文件加载了 2 个 Key。
- 生产环境「检测全部 Key」：账号1 返回 `额度不足（HTTP 429）` 并标记 exhausted，账号2 返回「连接成功」；生产对话使用账号2，模型保持 `deepseek-v4.1-flash`，回复「部署验证成功。」，第二轮历史 4 条完整；验证会话随后删除。
- 生产 `/api/ai/gateway` 返回 Key 脱敏标识、状态、用量、切换冷却与最近请求，响应中不含 Key 明文。
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
