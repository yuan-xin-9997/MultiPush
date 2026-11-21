# MultiPush 架构说明

## 总览

```
Browser / Electron (React SPA)
  ├─ /api/*        JWT REST API
  ├─ /uploads/*    静态媒体（随机文件名，支持 Range）
  └─ 其他路由       web/dist + SPA fallback
        │
Express (single Node process, 0.0.0.0:34080)
  ├─ routes/auth      注册、登录、资料
  ├─ routes/books     知识库
  ├─ routes/contents  内容 CRUD、软删除、收藏、统计
  ├─ routes/media     上传（multer → DATA_DIR/uploads）
  ├─ routes/renders   调用渲染器、保存历史
  ├─ routes/platform-sms 平台手机验证码登录（知乎/微博/头条/百家号/豆瓣/掘金/抖音）
  ├─ routes/weibo     微博扫码登录、发布与核实
  ├─ routes/toutiao   今日头条扫码登录、文章发布与核实
  ├─ routes/baijiahao 百家号扫码登录、文章发布与核实
  ├─ routes/douban    豆瓣日记扫码登录、图片转存、发布与核实
  ├─ routes/juejin    掘金扫码登录、草稿/文章发布与核实
  ├─ routes/csdn      CSDN 扫码登录、Markdown 草稿/文章发布与核实
  ├─ routes/jianshu   简书 Cookie 连接、草稿/文章发布与核实
  ├─ routes/ai        AI 个人配置、会话、消息、工具调用、提供商池编辑与高可用状态
  ├─ routes/video     视频内容剪辑时间线与导出任务
  ├─ routes/batch     批量渲染 / 批量发布任务
  ├─ sms-login.ts     共享短信登录浏览器流程与会话导入
  ├─ ai.ts            AI 会话、工具编排与业务工具
  ├─ ai-gateway.ts    多提供商/多 Key 回退、模型映射、冷却探活与路由审计
  ├─ ai-provider-config.ts 提供商池 JSON 解析、脱敏视图、合并与原子写入（600）
  ├─ video.ts         ffprobe 探测 + ffmpeg 剪辑/合并导出队列（异步、单并发）
  ├─ batch.ts         顺序批量任务执行器
  ├─ renderers/*      平台规则渲染（纯函数，服务端）
  └─ db.ts            node:sqlite（WAL），单文件 DATA_DIR/multipush.sqlite
```

## 数据模型

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `users` | id, username, email, password_hash, display_name, avatar_url | 唯一用户名/邮箱；bcrypt |
| `books` | id, user_id, name, description, color | 知识库/分组 |
| `contents` | id, user_id, book_id, kind, title, content_json, content_html, excerpt, cover_image, tags, status, favorite, word_count, image_count, video_count, deleted_at | Tiptap JSON + HTML 双存；软删除；`kind` 区分图文/视频 |
| `media` | id, user_id, filename, original_name, mime_type, size, kind, meta_json | 文件在 `DATA_DIR/uploads`；视频含 ffprobe 元数据 |
| `video_projects` | content_id, user_id, timeline_json | 视频内容剪辑时间线（有序片段，引用 media 资产） |
| `video_exports` | id, user_id, content_id, status, progress, message, timeline_json, output_media_id | 视频导出异步任务（服务端 ffmpeg） |
| `renders` | id, user_id, content_id, platforms, options_json, result_json | 渲染历史；结果完整存储 |
| `weibo_*` | accounts / publications / resolutions | 微博会话、发布记录与人工核实 |
| `toutiao_*` | accounts / publications / resolutions | 今日头条会话、文章发布记录与人工核实 |
| `baijiahao_*` | accounts / publications / resolutions | 百家号会话、文章发布记录与人工核实 |
| `douban_*` | accounts / publications / resolutions | 豆瓣会话、日记发布记录与人工核实 |
| `juejin_*` | accounts / publications / resolutions | 掘金会话、草稿/文章发布记录与人工核实 |
| `csdn_*` | accounts / publications / resolutions | CSDN 会话、草稿/文章发布记录与人工核实 |
| `jianshu_*` | accounts / publications / resolutions | 简书会话、草稿/文章发布记录与人工核实 |
| `ai_settings` | user_id, encrypted_api_key, base_url, model, temperature | 每用户大模型配置；Key AES-256-GCM 加密 |
| `ai_sessions` / `ai_messages` | id, user_id, title / session_id, role, content, tool_calls_json, tool_result_json | AI 会话、消息与工具轨迹 |
| `ai_provider_key_states` | provider_id, key_id, state, cooldown_until, 计数器, tokens | 每个 Key 的冷却状态与用量（不存 Key 明文） |
| `ai_provider_states` | provider_id, state, cooldown_until, consecutive_failures | 提供商熔断状态 |
| `ai_failover_events` | user_id, session_id, kind, reason, from/to provider/key（脱敏）, model, target_model | Key/提供商切换、冷却、恢复审计 |
| `ai_provider_requests` | user_id, session_id, provider, model, key（脱敏）, status, duration, tokens | 每次实际请求的路由记录 |
| `batch_jobs` | id, user_id, kind, status, total, done, input_json, items_json | 批量渲染/发布任务与每项进度 |

所有业务表都有 `user_id`，查询必须带当前用户条件；跨用户访问统一返回 404。提供商池 Key 只存在于进程环境或受保护配置文件，数据库仅保存脱敏后的 Key 标识与状态。

## 发布记录删除策略

所有平台共用一套状态约束：只有 `draft`（草稿）和 `failed`（失败）记录允许删除；`running`、`published`、`uncertain` 以及公众号的 `awaiting_confirmation` 一律拒绝，已发布内容不会被自动删除或下架。

| 平台 | 删除草稿时的远端行为 |
| --- | --- |
| 微信公众号、公众号贴图、知乎、少数派、个人博客 | 调用平台接口/浏览器流程删除后台草稿，成功后清理本地记录 |
| 掘金 | `POST /content_api/v1/article_draft/delete`（`draft_id`） |
| CSDN | `POST /blog/phoenix/console/v1/article/del`（`articleId`, `deep:true`），复用网页端 X-Ca 签名 |
| 简书 | `POST /author/notes/:id/soft_destroy`（移入简书回收站） |
| 微博、豆瓣 | 草稿只存在于本系统，仅清理本地记录 |
| 抖音、今日头条、百家号、小红书 | 平台未返回可定位草稿编号或写接口受限/自动化停用，仅清理本地记录；界面会提示到平台后台删除 |

失败记录优先清理本地记录；若记录带有远端草稿编号且模式为草稿，会尽量顺带删除远端草稿，远端失败不阻塞本地清理。关联接口：`DELETE /api/<platform>/publications/:id`，返回值统一为 `{ ok: true, remoteDeleted: boolean }`。

## AI 高可用调用链

1. `AiService.chat()` 从 `ai_settings` 读取账号覆盖配置（若存在），否则为空；
2. `AiGateway.complete()` 构建「账号配置（可选）→ 服务器提供商池」有序链；
3. 按提供商顺序、Key 优先级挑选未冷却的 Key，使用该提供商的模型或 `modelMap` 映射模型发起请求；
4. 额度不足（402 / 429 + quota 类错误）、认证失败（401/403）、限流（429）、临时异常（5xx/网络）分别更新 Key 冷却状态；同一提供商全部 Key 不可用或连续失败达到阈值时冷却提供商；
5. 失败后自动尝试下一个 Key/提供商，当前请求不中断；成功后将实际路由写入 `ai_provider_requests`，切换动作写入 `ai_failover_events`；
6. 后台定时器对服务器池中冷却到期的 Key/提供商发起最小探活请求（账号自定义 Key 在下一次使用前探活），成功后恢复为可用，下次调用自动回到最高优先级；
7. `GET /api/ai/gateway` 汇总状态、切换记录和请求记录供「高可用」面板展示，所有 Key 均脱敏；
8. 「设置 → 大模型高可用」通过 `GET/PUT /api/ai/providers` 编辑提供商池：保存时合并未修改的 Key、校验配置、原子写入 `DATA_DIR/ai-providers.json`（0600），调用 `AiGateway.reloadProviderPool()` 热加载并重新启动后台探活，无需重启进程；
9. 生产环境仅 `MULTIPUSH_ADMIN_USERNAMES` 中的用户可写服务器池；开发/桌面版默认允许所有登录用户；环境变量注入的提供商池在页面只读。

## 渲染流水线

1. `POST /api/renders` 校验平台列表和内容归属。
2. 读取 `ContentDetail`（Tiptap JSON + HTML）与用户显示名。
3. 构造 `RenderInput`：`content`、`platforms`、`options`、`authorName`、`baseUrl`。
4. `renderPlatforms()` 分派到 `wechat.ts` / `xiaohongshu.ts` / `zhihu.ts` / `weibo.ts` / `toutiao.ts` / `baijiahao.ts` / `douban.ts` / `juejin.ts` / `jianshu.ts` / `douyin.ts` / `sspai.ts` / `blog.ts`：
   - HTML 清洗（sanitize-html），相对媒体 URL 转绝对；
   - 提取图片/视频、纯文本、字数、标签；
   - 按平台规则排版，生成 `PlatformRender`（HTML、Markdown、文案、卡片数据、下载内容、警告）。
5. 结果写入 `renders`，返回完整 `RenderRecord`。
6. 前端按平台 Tab 预览；小红书卡片在浏览器端用 `html-to-image` 导出 PNG，全部打包用 JSZip。

### 预留的 AI / 增强接口

第一版不调用大模型，渲染器仅做规则模板。后续如需 AI 改写，可在 `renderPlatforms()` 之前或每个平台渲染器内部增加增强层：

```ts
export interface ContentEnhancer {
  readonly id: string
  enhance(input: {
    content: ContentDetail
    platform: PlatformId
    options: RenderOptions
  }): Promise<ContentDetail>
}
```

将增强器组合进 `RenderInput`，保持 `PlatformRender` 输出契约不变，即可在不影响前端预览与下载的前提下接入摘要、标题优化、平台语气改写等能力。`RenderOptions` 已预留 `themeColor`、`cardStyle`、`includeTags`、`authorName` 等可扩展字段。

## 安全

- JWT Bearer（7 天），密码 bcrypt 12 rounds；注册开放，无邮箱验证。AI API Key 使用独立 `.ai-session-key` 加密并按用户绑定，不返回前端。
- 所有 SQL 使用参数绑定；tags 以 JSON 文本存储。
- 上传白名单、大小限制、随机文件名；静态服务防目录穿越。
- 渲染 HTML 清洗并禁止脚本；前端 iframe `sandbox=""` 预览。
- 内容下载只通过鉴权 API 获取；上传文件使用随机 URL，不含用户隐私文件名。
- 生产数据目录权限 700，服务以 `jenkins` 用户运行，systemd 仅允许写 `.data`。

## 前端结构

- 路由：登录/注册、应用壳（AI 创作/内容库/渲染/发布）、全屏编辑器、全屏视频工作台（`/video/:id`：预览播放器 + 片段时间线 + 导出）；内容库多选后可打开批量渲染/发布弹窗。
- 状态：`AuthContext` + 页面局部状态；无全局状态库。
- API：`web/src/lib/api.ts` 唯一入口，401 统一清理 token。
- 导入导出：`web/src/lib/content-io.ts` 纯浏览器解析（marked / turndown / JSZip），不经过服务器。
- 设计系统：`web/src/styles/globals.css` token + 通用组件类；各 feature 独立 CSS。
- 小红书卡片导出：固定 540×720 CSS 容器，`pixelRatio: 2` 输出 1080×1440。

## 本地桌面版

`desktop/` 是独立的 Electron 包（不在 npm workspaces 中）。它把现有前端、Express 后端和 SQLite 一起装进安装包，完全在本机运行：

```
Electron 主进程
  ├─ main.cjs             本地服务生命周期、窗口、菜单、下载、权限、更新检查
  ├─ server/index.cjs     esbuild 打包的 startMultiPushServer（依赖 playwright-core）
  └─ web-dist/            构建后的 React SPA（extraResources）
        │
BrowserWindow → http://127.0.0.1:<port>
        │
Express + node:sqlite → <userData>/data/multipush.sqlite + uploads/
```

- 后端由 `server/src/server.ts` 的 `startMultiPushServer()` 启动；`server/src/index.ts` 仍是 CLI/Jenkins 入口，两者复用同一套路由、渲染和发布逻辑。
- 桌面模式 `desktopMode=true`：只监听 `127.0.0.1`，校验 Host / Origin / `Sec-Fetch-Site`；注册不需要邮箱验证码，避免依赖 SMTP。
- 主窗口 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`；本地页面仍是普通 Web 安全模型。
- 素材、账号、会话和发布记录全部保存在 `userData/data`，升级/卸载不自动删除。
- 自动发布复用本机 Chrome / Edge；没有浏览器时只影响自动发布，不影响编辑、渲染和导出。微博、今日头条网页登录与发布同样依赖浏览器。
- 发布由 GitHub Actions 在 Windows / macOS 构建，详见 [桌面客户端说明](DESKTOP.md)。少数派使用微信扫码登录，会话与发布记录按用户加密保存，详见 [少数派发布说明](SSPAI_PUBLISHING.md)。个人博客使用 Halo 个人令牌连接，地址与令牌按用户加密保存，通过 Halo Console API 上传附件并创建/发布文章，详见 [个人博客发布说明](BLOG_PUBLISHING.md)。公众号贴图使用公众号 AppID/AppSecret 直连官方 API（`server/src/wechatpic-api.ts`），不依赖浏览器；AppSecret 按用户加密保存，详见 [公众号贴图发布说明](WECHATPIC_PUBLISHING.md)。

## 部署

- `npm run build`：Vite → `web/dist`；esbuild → `server/dist/index.js`，`playwright-core` 保留为外置运行库并随部署同步。公众号会话与发布 API 见 [接入说明](WECHAT_PUBLISHING.md)。
- Jenkinsfile：安装 → 类型检查/测试 → 构建 → 停服 → `deploy.sh`（仅同步构建产物，保留 `.data`/`.env`）→ 启动 → 健康检查。
- systemd：`multipush.service`，`0.0.0.0:34080`，`DATA_DIR=/opt/MultiPush/.data`，`WEB_DIST=/opt/MultiPush/web/dist`。
