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
  ├─ renderers/*      平台规则渲染（纯函数，服务端）
  └─ db.ts            node:sqlite（WAL），单文件 DATA_DIR/multipush.sqlite
```

## 数据模型

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `users` | id, username, email, password_hash, display_name, avatar_url | 唯一用户名/邮箱；bcrypt |
| `books` | id, user_id, name, description, color | 知识库/分组 |
| `contents` | id, user_id, book_id, title, content_json, content_html, excerpt, cover_image, tags, status, favorite, word_count, image_count, video_count, deleted_at | Tiptap JSON + HTML 双存；软删除 |
| `media` | id, user_id, filename, original_name, mime_type, size, kind | 文件在 `DATA_DIR/uploads` |
| `renders` | id, user_id, content_id, platforms, options_json, result_json | 渲染历史；结果完整存储 |

所有业务表都有 `user_id`，查询必须带当前用户条件；跨用户访问统一返回 404。

## 渲染流水线

1. `POST /api/renders` 校验平台列表和内容归属。
2. 读取 `ContentDetail`（Tiptap JSON + HTML）与用户显示名。
3. 构造 `RenderInput`：`content`、`platforms`、`options`、`authorName`、`baseUrl`。
4. `renderPlatforms()` 分派到 `wechat.ts` / `xiaohongshu.ts` / `zhihu.ts` / `douyin.ts`：
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

- JWT Bearer（7 天），密码 bcrypt 12 rounds；注册开放，无邮箱验证。
- 所有 SQL 使用参数绑定；tags 以 JSON 文本存储。
- 上传白名单、大小限制、随机文件名；静态服务防目录穿越。
- 渲染 HTML 清洗并禁止脚本；前端 iframe `sandbox=""` 预览。
- 内容下载只通过鉴权 API 获取；上传文件使用随机 URL，不含用户隐私文件名。
- 生产数据目录权限 700，服务以 `jenkins` 用户运行，systemd 仅允许写 `.data`。

## 前端结构

- 路由：登录/注册、应用壳（内容库/渲染/发布）、全屏编辑器。
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
- 自动发布复用本机 Chrome / Edge；没有浏览器时只影响自动发布，不影响编辑、渲染和导出。
- 发布由 GitHub Actions 在 Windows / macOS 构建，详见 [桌面客户端说明](DESKTOP.md)。

## 部署

- `npm run build`：Vite → `web/dist`；esbuild → `server/dist/index.js`，`playwright-core` 保留为外置运行库并随部署同步。公众号会话与发布 API 见 [接入说明](WECHAT_PUBLISHING.md)。
- Jenkinsfile：安装 → 类型检查/测试 → 构建 → 停服 → `deploy.sh`（仅同步构建产物，保留 `.data`/`.env`）→ 启动 → 健康检查。
- systemd：`multipush.service`，`0.0.0.0:34080`，`DATA_DIR=/opt/MultiPush/.data`，`WEB_DIST=/opt/MultiPush/web/dist`。
