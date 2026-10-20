# MultiPush 产品与技术规格（第一版）

> 项目：多平台智能发布系统 / MultiPush
> 目标：一次创作，按微信公众号、小红书、知乎、抖音的排版规则渲染，预览并下载，用户手动发布。

## 1. 第一版范围

必须实现：

1. 多用户注册、登录、退出，JWT 鉴权，数据严格按用户隔离。
2. 内容库：知识库（Book）分组、全部内容、收藏、回收站、搜索、排序、卡片/列表视图、新建、编辑、复制、删除/恢复、移动分组。
3. 内容导入/导出：支持批量导入 Markdown、HTML、TXT、MultiPush JSON；支持单篇导出 Markdown / HTML / JSON，支持多选打包 ZIP 导出。
4. 类语雀的富文本编辑器：标题、正文、图片、视频、表格、代码块、引用、任务列表、分割线、链接、文字颜色/高亮、对齐、撤销重做、字数统计、目录大纲、自动保存、封面上传、标签、状态。
5. 智能渲染：选择内容 + 平台（微信公众号 / 小红书 / 知乎 / 抖音），调用模板规则渲染。渲染结果保存在历史记录中。
6. 四个平台各自的模拟预览（手机或文章预览），以及下载：
   - 微信公众号：复制富文本 HTML、下载 HTML。
   - 小红书：图文卡片 PNG（3:4，1080×1440）打包下载、文案/标题/话题、图片素材、视频笔记。
   - 知乎：复制 Markdown/HTML、下载 Markdown/HTML。
   - 抖音：竖屏信息流预览、标题/正文/话题文案、文案 TXT 与图文 HTML/JSON 下载。
   - 支持“下载全部 ZIP”。
7. 发布管理页：第一版只做设计完整的占位页，不接入真实平台。
8. 响应式：桌面优先，至少 1024px 宽度体验完整；移动端可登录、浏览内容库、查看渲染结果（编辑器可提示使用桌面端）。
9. 监听 `0.0.0.0:34080`；生产由同一个 Node 服务提供 API、上传文件和前端静态文件。

非目标：真实 OAuth / 一键发布 / 平台账号连接 / AI 改写（仅预留扩展接口）。

## 2. 技术架构

- 前端：React 19 + TypeScript + Vite 7 + React Router 6；Tiptap 2 编辑器；纯 CSS 设计系统；`html-to-image` + `jszip` 生成小红书 PNG 压缩包。
- 后端：Node.js 22 + Express 4 + TypeScript；`node:sqlite`（DatabaseSync）持久化；JWT + bcryptjs；multer 上传。
- 构建：`esbuild` 将后端打包为 `server/dist/index.js`（单文件），前端 `web/dist`。
- 数据与上传：默认 `DATA_DIR`（开发为项目根 `.data/`，生产为 `/opt/MultiPush/.data`）；SQLite 文件 `multipush.sqlite`，上传目录 `uploads/`。
- 密钥：若未提供 `JWT_SECRET`，在 `DATA_DIR/.jwt-secret` 自动生成并持久化（600 权限）。

目录：

```
shared/types.ts          前后端共享类型与平台元数据
server/src/              API、数据库、鉴权、渲染器
web/src/                 前端
  components/            全局布局与通用组件
  features/auth          登录注册
  features/library       内容库
  features/editor        编辑器
  features/render        智能渲染与预览
  features/publish       发布管理占位页
  lib/api.ts             API 客户端（已提供，勿改接口形状）
  lib/utils.ts           通用工具（已提供）
  contexts/AuthContext   登录态（已提供）
  styles/globals.css     设计系统（已提供）
JenkinsConfig/           Jenkinsfile、deploy.sh、systemd unit、健康检查
docs/                    文档
```

## 3. 页面与交互

### 3.1 登录 / 注册

- 左右分栏：左侧品牌介绍（MultiPush、平台标识、渲染流程卖点），右侧表单。
- 登录字段：账号（用户名或邮箱）+ 密码；注册字段：用户名、邮箱、密码、确认密码、昵称（选填）。
- 校验与错误提示；加载态；成功跳转 `/library`。
- 已登录访问登录页应跳转 `/library`。

### 3.2 应用外壳

- 左侧固定导航：Logo、内容库、智能渲染、发布管理；底部用户菜单（退出登录）。
- 内容库子导航：知识库列表（可新建/重命名/删除）、全部内容、我的收藏、回收站。
- 顶部可按页面定制；整体类语雀：白底、细边框、绿色主色 `#00b96b`。

### 3.3 内容库

- 头部：面包屑/标题、文档数、搜索框、排序、视图切换、新建按钮。
- 文档卡片：标题、摘要、封面缩略图、标签、所属知识库、更新时间、字数、收藏按钮、更多菜单（渲染、复制、移动、删除）。
- 列表视图：表格样式，适合快速扫读。
- 回收站：只显示已删除；支持恢复、彻底删除（二次确认）。
- 空状态友好；加载骨架屏；操作 toast 反馈。
- 点击卡片进入 `/editor/:id`；新建先创建空文档再跳转。

#### 导入 / 导出

- 工具栏提供「导入」和「导出」入口。导入接受 `.md` / `.markdown` / `.html` / `.htm` / `.txt` / `.json`，支持多选与拖拽，单文件 ≤5MB、单次 ≤30 个；导入到当前知识库（未分组时归入未分组）。
- Markdown 使用 GFM 规则转换；HTML 清洗后保留常见排版；TXT 按空行分段；JSON 支持 MultiPush 单篇导出或 `{ contents: [...] }` 批量备份。
- 导入后标题取 `title`、首个 H1 或文件名；生成摘要与字数；编辑器打开无 JSON 的导入文档时以 HTML 初始化编辑器。
- 单篇导出入口在文档卡片更多菜单与编辑器更多菜单：Markdown（.md）、HTML（独立样式）、JSON（.multipush.json）。
- 内容库支持多选文档后打包 ZIP 导出（Markdown / HTML / JSON 三种格式可选）。导出文件名安全、去重。
- 导入导出全部在前端解析（`web/src/lib/content-io.ts`），API 仍走现有内容接口；不上传原始文件到服务器。

### 3.4 编辑器（参照语雀）

- 全屏独立页面，顶部栏：返回、文档标题（大号无边框输入）、保存状态（未保存/保存中/已保存）、收藏、渲染按钮、更多菜单。
- 左侧：知识库/文档信息（所属知识库、封面、标签、状态），可折叠；右侧：大纲（H1-H3，点击滚动）、字数/阅读时间。
- 正文：Tiptap 编辑器，居中最大宽度约 760px，舒适行高；工具栏包含：
  一级/二级/三级标题、加粗、斜体、下划线、删除线、文字颜色、背景高亮、无序/有序/任务列表、引用、代码块、表格、分割线、链接、图片、视频、对齐、清除格式、撤销/重做。
- 粘贴/拖拽图片自动上传；支持插入本地上传的视频（`<video controls>`）。
- 空文档显示占位提示；输入 `/` 唤起快捷插入菜单，支持正文、标题、列表、引用、代码块、分割线、表格、图片、视频和链接；可继续输入关键词筛选，使用 `↑`/`↓` 选择、`Enter` 插入、`Esc` 关闭。支持 Markdown 快捷输入（Tiptap StarterKit 自带）。
- 自动保存：内容变化后 debounce 约 1.2s 保存；`Ctrl/Cmd+S` 立即保存；离开前若未保存给出提示。
- 标题为空时保存为“无标题文档”。
- 编辑器内容保存 `contentJson` + `contentHtml`；后端计算摘要、字数、图片/视频数量。

### 3.5 智能渲染

- 选择内容（搜索选择器，默认从查询参数 `contentId` 带入）+ 选择平台（多选，默认全选）+ 渲染选项（卡片风格：清新/暖阳/醒目）。
- 点击“开始渲染”调用后端，重新渲染生成新记录；渲染历史侧栏可加载旧记录。
- 结果页按平台 Tab 展示：
  - 顶部平台信息、字数、图片数、标题长度/限制、警告。
  - 预览：公众号手机壳、小红书手机壳（卡片轮播/滚动 + 文案区）、知乎桌面文章壳、抖音 9:16 竖屏信息流壳。
  - 操作：复制、下载当前平台、下载全部 ZIP。
- 小红书卡片：客户端用隐藏 DOM 渲染 `XhsCard`，`html-to-image` 以 pixelRatio 2 导出 1080×1440 PNG；支持 zip 打包；导出时显示进度。
- 下载全部 ZIP 包含：各平台 HTML/Markdown/文案、小红书 PNG、原图素材（尽量获取，失败仅警告）。
- 空状态：未渲染时显示流程说明；渲染失败显示可重试错误。
- 移动端：预览缩小但仍可切换平台与下载。

### 3.6 发布管理

- 完整占位页：顶部“发布中心 · 即将上线”，平台卡片（公众号/小红书/知乎/抖音）状态“规划中”，说明第一版下载后手动发布；渲染历史快捷入口；不实现任何真实发布按钮。

## 4. 后端 API 契约

统一前缀 `/api`。除注册/登录/健康检查/平台元数据外都需要 `Authorization: Bearer <token>`。错误格式：

```json
{ "error": "invalid_credentials", "message": "账号或密码错误" }
```

参数校验失败返回 400，`issues` 可选。未登录 401。越权/不存在统一 404。

### 认证

- `POST /api/auth/register` body `{ username, email, password, displayName? }` → `{ token, user }`
  - 用户名 3–24 字符，允许字母数字下划线汉字；邮箱合法；密码 ≥ 8；重复用户名/邮箱 409。
- `POST /api/auth/login` body `{ account, password }` → `{ token, user }`；账号为用户名或邮箱。
- `GET /api/auth/me` → `{ user }`
- `PATCH /api/auth/me` body `{ displayName?, avatarUrl? }` → `{ user }`
- `POST /api/auth/password` body `{ currentPassword, newPassword }` → `{ ok: true }`

### 知识库

- `GET /api/books` → `{ books: Book[] }`（含 docCount，不含回收站文档）
- `POST /api/books` `{ name, description?, color? }` → `{ book }`
- `PATCH /api/books/:id` → `{ book }`
- `DELETE /api/books/:id` → `{ ok: true }`；该知识库下文档移到未分组（不删除）

### 内容

- `GET /api/contents?bookId=&favorite=true&trash=true&q=&sort=updated_desc|created_desc|title_asc&page=1&pageSize=20` → `ContentListResult`
  - 默认排除回收站；`trash=true` 只返回回收站；`bookId=unfiled` 返回未分组。
- `POST /api/contents` `ContentInput` → `{ content: ContentDetail }`（标题默认“无标题文档”）
- `GET /api/contents/:id` → `{ content: ContentDetail }`（回收站中的文档也可读取，用于恢复前查看）
- `PATCH /api/contents/:id` `ContentInput` → `{ content: ContentDetail }`
- `DELETE /api/contents/:id` → 软删除 `{ ok: true }`；`?permanent=true` 彻底删除。
- `POST /api/contents/:id/restore` → `{ content }`
- `POST /api/contents/:id/duplicate` → `{ content }`（标题追加“副本”）
- `POST /api/contents/:id/favorite` `{ favorite: boolean }` → `{ content: ContentSummary }`

后端计算：`excerpt`（未显式提供时取纯文本前 160 字）、`wordCount`（中文按字、英文按词）、`imageCount`、`videoCount`。标签去重、去空、最多 10 个，每个最长 24 字。

### 媒体

- `POST /api/media` multipart 字段 `file` → `{ media: MediaAsset }`
  - 图片：jpg/jpeg/png/webp/gif/svg，≤ 20MB；视频：mp4/webm/mov，≤ 200MB。
  - 存储文件名随机（uuid + 扩展名），静态路径 `/uploads/<filename>`；原始文件名仅存数据库。
- `GET /api/media` → `{ media: MediaAsset[] }`（当前用户，最近 100 个）
- `DELETE /api/media/:id` → `{ ok: true }`（仅删除记录与文件；被正文引用的图片仍可继续通过 URL 访问直到删除）
- `GET /uploads/:filename` 无需鉴权（随机文件名），支持 Range（视频拖动）。

### 平台与渲染

- `GET /api/platforms` → `{ platforms: PlatformInfo[] }`
- `POST /api/renders` `{ contentId, platforms: PlatformId[], options? }` → `{ render: RenderRecord }`
  - `platforms` 必须 1–4 个、去重、合法。
  - 加载内容（含回收站）与用户信息，调用 `renderPlatforms()`。
  - 保存记录（JSON），返回完整结果。
- `GET /api/renders?contentId=` → `{ renders: RenderListItem[] }`（最近 30 条，倒序）
- `GET /api/renders/:id` → `{ render }`
- `DELETE /api/renders/:id` → `{ ok: true }`

### 其他

- `GET /api/health` → `{ status: 'ok', service: 'multipush', version, uptime, time }`，无需鉴权。
- `GET /api/platforms` 需要登录（前端渲染页用）；平台元数据也可直接来自共享常量。

## 5. 渲染器内部契约

文件：`server/src/renderers/`

```ts
export interface RenderInput {
  content: ContentDetail
  platforms: PlatformId[]
  options: RenderOptions
  authorName: string
  baseUrl: string // 例：http://192.168.0.111:34080，用于把 /uploads/... 转成绝对地址
}

export async function renderPlatforms(input: RenderInput): Promise<PlatformRender[]>
```

要求：

1. 不访问外网、不依赖浏览器，纯函数 + cheerio/turndown/sanitize-html。
2. 输出 HTML 必须已清洗（无 script/iframe/事件属性），样式全部内联，适合 iframe `srcDoc` 预览；不得含 `<html>/<head>` 之外的脚本。
3. 相对媒体 URL 转绝对 URL。视频保留 `<video controls>`；不自动下载媒体。
4. 每个平台返回 `downloads`（HTML 完整文档 / Markdown / 文案），文件名安全、带平台后缀。
5. 小红书：`previewMode='cards'`（有视频时为 `'video'`）；生成 1 张封面卡 + 若干内容卡 + 结束卡；每卡正文控制阅读量（约 120–220 字），图片分配到卡片；标题 ≤20 字（超长截断并 warning）；`text` 含标题、正文、3–6 个话题标签。
6. 公众号：标题 ≤64 字；移动端字号 16px、行高 1.8、图片圆角、引用/代码块/表格有专属样式；`previewMode='article'`。
7. 知乎：标题 ≤100 字；正文 16px、行高 1.8；Markdown 用 turndown（表格保留）；`previewMode='article'`。
8. 抖音：标题 ≤55 字、正文 ≤1000 字；`previewMode='vertical'`；`text` 为标题 + 正文 + 3–5 个话题标签，供直接粘贴到抖音发布页；返回文案 TXT、图文 HTML 与笔记 JSON 下载。
9. 所有输出包含 `assets`（图片/视频绝对 URL，去重）、`meta`、`warnings`、`generatedAt`。
10. 空内容、仅图片、长文、包含表格/代码/任务列表时不能崩溃；渲染器应有单元测试。

## 6. UI 与代码约定

- 中文界面文案；时间用 `Intl` 格式；不使用英文占位文案。
- 复用 `globals.css` 的 token 与 `.btn/.input/.card/.modal/.tag` 等类；图标统一 `lucide-react`，尺寸 16/18/20。
- 避免引入新的 UI 框架、CSS-in-JS、状态管理库；React Context + hooks 足够。
- 所有 API 调用走 `web/src/lib/api.ts`；错误提示使用 `sonner` 的 `toast.error`。
- 不提交 `node_modules`、`.data`、构建产物；不修改其他特性的文件。
- 类型完整，`npm run typecheck` 必须通过；核心流程要有后端单测（vitest）或至少可验证的 API smoke。
- 可访问性：按钮有 `title/aria-label`，输入有 label，弹窗支持 Esc 关闭。
