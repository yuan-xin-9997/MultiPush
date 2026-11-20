# MultiPush · 多平台智能发布系统

> 一次创作，智能渲染，适配微信公众号（图文/贴图）、小红书、知乎、微博、今日头条、百家号、豆瓣、掘金、CSDN、简书、抖音、少数派与个人博客。支持微信公众号、知乎、微博、今日头条、百家号、豆瓣、掘金、CSDN、简书、抖音、少数派和个人博客连接、保持会话与发布（微博、豆瓣为本地草稿；头条、百家号、抖音、掘金、CSDN、简书等保存到平台草稿箱）；公众号贴图通过官方 API 保存草稿、后台手动发表；小红书仅支持导出后手动发布。

![MultiPush](web/public/favicon.svg)

## 功能

- **多用户**：注册、登录、JWT 鉴权，内容按用户隔离。
- **类语雀内容库**：知识库分组、全部内容、收藏、回收站、搜索、排序、卡片/列表视图、复制、移动、批量操作。
- **视频内容与系统内剪辑**：新建「视频内容」（视频为主，带标题和正文文案），支持上传一段或多段视频；在视频工作台内对同一视频内容修剪片段（入点/出点）、调序、增删片段并自动保存时间线；「导出成片」用服务端 ffmpeg 逐段剪辑、统一规格并合并成片，成片自动存入素材库，可直接用于抖音等平台发布；智能渲染自动把最近导出的成片嵌入渲染结果（公众号内嵌播放器、抖音/小红书视频笔记预览）。详见 [视频内容说明](docs/VIDEO_CONTENT.md)。
- **类语雀编辑器**：Tiptap 富文本、`/` 快捷插入菜单、标题/列表/任务/表格/代码/引用/图片/视频/链接/颜色/对齐、目录大纲、字数统计、自动保存、封面与标签；封面支持本地上传，也可一键选用正文中的图片。
- **导入 / 导出**：批量导入 Markdown、HTML、TXT、MultiPush JSON；单篇导出 Markdown/HTML/JSON；多选打包 ZIP。导入与粘贴会自动把“图片 + 紧邻图注”合并为 `figure/figcaption`。
- **平台登录**：知乎、微博、今日头条、百家号、豆瓣、掘金、抖音支持「手机验证码登录」，在 MultiPush 内输入手机号和短信验证码即可连接；不保存平台密码，扫码登录保留为兜底。遇到滑块或安全验证会停止并提示改用扫码。该能力复用现有 Playwright Chromium 运行环境。详见 [手机验证码登录说明](docs/SMS_LOGIN.md)。
- **智能渲染**：
  - 图文 figure/figcaption：编辑器保留、历史 `p+p` 自动归一化；公众号、知乎、博客统一输出 figure，图片下边距 0、图注上边距 8px，不再出现空行。
  - 微信公众号：移动端图文排版、内联样式、复制富文本、下载 HTML。
  - 公众号贴图：提取正文图片（最多 20 张，首图即封面）、标题（≤32 字）与纯文本配文，手机壳贴图预览、文案与 JSON 导出。
  - 小红书：自动分页 3:4 卡片、1080×1440 PNG、文案与话题、视频笔记预览、ZIP 下载。
  - 知乎：专栏长文排版、Markdown / HTML 导出。
  - 豆瓣：日记长文排版、Markdown / HTML 导出；连接豆瓣账号后可发布日记（豆瓣无官方开放写接口，使用已登录浏览器会话）。
  - 掘金：技术文章 Markdown 排版；连接掘金账号后可保存草稿或直接发布。
  - CSDN：技术博客 Markdown 排版；连接 CSDN 账号后可保存草稿或直接发布。
  - 简书：Markdown 长文排版；使用浏览器 Cookie 连接后可将文章保存到默认文集草稿或公开发布。
  - 抖音：竖屏图文 / 视频笔记文案、话题标签、文案与图文 HTML / JSON 导出。
  - 少数派：Matrix 风格长文、内联排版、Markdown / HTML 导出。
  - 个人博客：Halo 博客文章排版、Markdown / HTML 导出。
- **平台预览**：手机壳公众号、手机壳公众号贴图、小红书卡片、知乎桌面文章、微博信息流、今日头条文章、百家号文章、豆瓣日记、掘金技术文章、CSDN 技术博客、简书文章、抖音竖屏、少数派 Matrix 文章、个人博客文章，各按自身视觉模拟。
- **渲染工作台**：各平台独立修改标题、正文、话题并保存到记录，可恢复生成结果；小红书支持卡片排序、光标处分页、换图和裁剪，按实际高度自动分页。提供发布前检查、原文版本提醒、账号默认设置及含缺失清单的 ZIP 导出报告。
- **公众号发布**：系统内展示官方登录二维码，加密保存登录状态；选择公众号排版和封面，一键保存草稿或正式发表。支持正文图片转存、安全扫码确认、发布记录和重复提交保护。
- **公众号贴图发布**：输入公众号 AppID / AppSecret（按用户加密保存），通过官方 API 上传永久图片素材并创建图片消息（newspic）草稿，回读核对标题与图片数量；正式发表按个人号实际情况在公众号后台手动完成。支持 IP 白名单错误提示、发布记录与草稿删除。详见 [公众号贴图发布说明](docs/WECHATPIC_PUBLISHING.md)。
- **小红书发布**：自动登录和自动发布已停用，已清除保存会话；保留卡片与文案导出、历史记录，请在官方 App 或创作中心手动发布。详见 [说明](docs/XIAOHONGSHU_PUBLISHING.md)。
- **知乎发布**：系统内展示知乎官方二维码，按用户加密保存登录状态；选择知乎排版和可选封面，保存草稿或发布专栏文章。图片自动转存、使用原生图注/列表/代码结构，表格自动转换为等价列表，并回读核对内容，发现差异则保留草稿并停止发布。详见 [知乎发布说明](docs/ZHIHU_PUBLISHING.md)。
- **抖音发布**：系统内展示官方登录二维码，按用户加密保存会话；选择 MP4 视频或 1–35 张图片，可保存草稿或发布。包含发布记录、重复提交保护、重启恢复与结果人工核实；遇到安全验证停止操作。详见 [抖音发布说明](docs/DOUYIN_PUBLISHING.md)。
- **微博发布**：系统内展示微博官方登录二维码，按用户加密保存会话；选择微博排版，可保存本地草稿或一键发布标题、正文、`#话题#` 和最多 9 张图片。包含发布记录、幂等保护、结果待核实人工核实；遇到安全验证停止操作。详见 [微博发布说明](docs/WEIBO_PUBLISHING.md)。
- **今日头条发布**：系统内展示头条号官方登录二维码，按用户加密保存会话；选择头条图文排版，填写标题和正文，可保存草稿或发布。包含发布记录、幂等保护、结果待核实人工核实；遇到安全验证停止操作。详见 [今日头条发布说明](docs/TOUTIAO_PUBLISHING.md)。
- **百家号发布**：系统内展示百家号（百度通行证）官方登录二维码，按用户加密保存会话；选择百家号图文排版，填写标题和正文，可保存草稿或发布。包含发布记录、幂等保护与结果待核实人工核实；遇到安全验证停止操作。详见 [百家号发布说明](docs/BAIJIAHAO_PUBLISHING.md)。
- **少数派发布**：使用微信扫描少数派官方登录二维码，按用户加密保存会话；选择 Matrix 排版，保存草稿或立即发布。正文图片自动上传到少数派图床，发布前回读核对标题、正文、图片和链接；结果不确定时停止重发并支持人工核实。详见 [少数派发布说明](docs/SSPAI_PUBLISHING.md)。
- **个人博客发布**：输入 Halo 博客地址和个人令牌，按用户加密保存；选择博客排版与封面，保存草稿或公开发布。正文图片自动转存到 Halo 附件库，发布后回读核对内容；支持标签匹配、重复提交保护和结果人工核实。详见 [个人博客发布说明](docs/BLOG_PUBLISHING.md)。
- **豆瓣发布（实验性）**：豆瓣没有官方开放写接口，系统使用已登录浏览器会话发布日记；网页端无草稿箱，支持保存 MultiPush 本地草稿；二维码登录、正文图片转存、可见范围、标签、发布记录与结果人工核实。详见 [豆瓣发布说明](docs/DOUBAN_PUBLISHING.md)。
- **掘金发布**：掘金扫码登录，选择分类与最多 5 个标签，支持保存草稿或直接发布；发布记录与结果人工核实。详见 [掘金发布说明](docs/JUEJIN_PUBLISHING.md)。
- **CSDN 发布**：微信扫码登录 CSDN，自动导入 Markdown、填写标题与标签，支持保存草稿或直接发布；发布记录与结果人工核实。详见 [CSDN 发布说明](docs/CSDN_PUBLISHING.md)。
- **简书发布**：简书网页端无扫码登录，使用浏览器 Cookie 连接（不保存密码）；支持保存到默认文集草稿或公开发布，发布记录与结果人工核实。详见 [简书发布说明](docs/JIANSHU_PUBLISHING.md)。
- **草稿删除**：微信公众号、公众号贴图、知乎、少数派和个人博客的发布记录支持删除草稿，并同步删除平台后台的对应草稿；已发表内容不会被删除。抖音/头条/百家号/微博/豆瓣的草稿记录目前只删除本地记录，平台草稿需到对应后台清理。
- **AI 创作**：AI 创作页可按账号配置 OpenAI 兼容大模型接口、模型与 API Key；对话中可读取知识库、内容、素材、渲染和发布记录，并通过工具写文章、生成多平台排版、保存草稿、正式发布及创建批量任务；支持通过工具操控视频内容的剪辑时间线（修剪、调序、增删片段、导出成片）；对话支持上传图片/视频（自动进素材库、可视觉识别、一键插入文章或建视频时间线）与文本文档（全文作为写作素材）。
- **AI 高可用**：服务器可配置多个提供商，每个提供商多个 API Key；额度不足、失效或限流时自动轮换 Key；整个提供商不可用时按有序链回退，并通过模型等价映射保持模型能力；每个提供商可单独开关“多 Key 高可用”，每个 Key 可停用；Key/提供商冷却与定期探活、切换审计和每次请求的实际路由均可在设置页查看。详见 [AI 创作说明](docs/AI_CREATION.md#大模型配置与高可用)。
- **统一设置页**：导航新增「设置」，集中管理个人资料/密码、账号级大模型配置和服务器提供商池（提供商、多个 Key、每 Key 接口地址、高可用开关、模型映射、冷却与探活参数）；保存后立即生效，无需重启服务。
- **批量任务**：内容库多选后支持批量渲染和批量发布；任务在服务端顺序执行并持久保存进度，可查看每篇内容的排版、发布状态和失败原因。
- **本地桌面版**：Electron 客户端支持 Windows 10+（x64）与 macOS（Intel / Apple Silicon 通用包），内置前端、Node 后端与 SQLite，完全在本机运行；首次启动直接注册本地账号，无需服务器、SMTP 或邮箱验证码。
- **图注修复说明**：见 [docs/FIGURE_CAPTION_FIX.md](docs/FIGURE_CAPTION_FIX.md) 与 [CHANGELOG.md](CHANGELOG.md)。
- **部署**：监听 `0.0.0.0:34080`，Jenkins 每 30 分钟轮询 GitHub，自动停服、构建、部署、启动与健康检查。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite 7、React Router 6、Tiptap 2、纯 CSS |
| 后端 | Node.js 22、Express 4、TypeScript、`node:sqlite`、JWT、bcryptjs、multer |
| 渲染 | 服务端规则模板（cheerio / sanitize-html / turndown），不依赖外部 AI；AI 创作通过高可用网关调用用户配置或服务器提供商池的 OpenAI 兼容模型 |
| 下载 | html-to-image（小红书卡片）、JSZip |
| 桌面端 | Electron 45、electron-builder、Playwright Electron 冒烟测试 |
| 部署 | esbuild 单文件后端、Jenkins Pipeline、systemd、GitHub Actions 桌面构建 |

## 本地开发

要求 Node.js ≥ 22.12（推荐 22 LTS 或 24）。

```bash
npm install
npm run dev
```

- 前端：http://127.0.0.1:5173
- 后端：http://127.0.0.1:34080
- 首次打开注册一个账号即可。

### 本地桌面版

Windows 和 macOS 安装包发布在 [GitHub Releases](https://github.com/yuan-xin-9997/MultiPush/releases/latest)。安装后完全本地运行：后端、前端、SQLite 数据库和上传文件都在本机，不依赖 `publish.yuan-xin.top` 或任何远程服务器。首次启动直接注册本地账号，不需要配置 SMTP。

```bash
npm run desktop:install       # 安装 Electron / electron-builder / playwright-core
npm run desktop:build         # 构建桌面端内置的前端与后端
npm run desktop:dev           # 构建并启动本地桌面版
npm run desktop:smoke         # 注册/登录/重启持久化 Playwright 冒烟
npm run desktop:dist:win      # Windows NSIS + 便携版
npm run desktop:dist:mac      # macOS universal DMG + ZIP（需在 macOS 构建）
```

数据目录：Windows `%APPDATA%\MultiPush\data`，macOS `~/Library/Application Support/MultiPush/data`。公众号、知乎、抖音与少数派的自动发布需要本机安装 Chrome 或 Edge；个人博客使用 HTTP API，不依赖浏览器；不安装浏览器仍可编辑、渲染和导出。详见 [本地桌面版说明](docs/DESKTOP.md)。安装包目前未使用商业代码签名证书，Windows SmartScreen 与 macOS Gatekeeper 会要求手动确认。

生产模式本地验证：

```bash
npm run build
npm start
# http://127.0.0.1:34080
```

## 配置

复制 `server/.env.example` 为项目根 `.env`（或生产 `/opt/MultiPush/.env`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听网卡 |
| `PORT` | `34080` | 服务端口 |
| `NODE_ENV` | `development` | 生产设为 `production` 以托管前端 |
| `DATA_DIR` | `./.data`（开发）/ `/opt/MultiPush/.data`（生产） | SQLite 与上传目录 |
| `WEB_DIST` | `./web/dist` | 前端构建产物 |
| `JWT_SECRET` | 自动生成 | 未设置时写入 `DATA_DIR/.jwt-secret` |
| `PUBLIC_BASE_URL` | 请求 Host | 渲染结果中的媒体绝对地址 |
| `FFMPEG_PATH` | `ffmpeg` | 视频剪辑导出使用的 ffmpeg 绝对路径（默认从 PATH 查找） |
| `FFPROBE_PATH` | `ffprobe` | 视频元数据探测使用的 ffprobe 绝对路径 |
| `DOUYIN_BROWSER_PATH` | 自动探测 | 抖音发布使用的 Chrome / Chromium 路径 |
| `SSPAI_BROWSER_PATH` | 自动探测 | 少数派发布使用的 Chrome / Chromium 路径 |
| `WEIBO_BROWSER_PATH` | 自动探测 | 微博发布使用的 Chrome / Chromium 路径 |
| `TOUTIAO_BROWSER_PATH` | 自动探测 | 今日头条发布使用的 Chrome / Chromium 路径 |
| `BAIJIAHAO_BROWSER_PATH` | 自动探测 | 百家号发布使用的 Chrome / Chromium 路径 |
| `DOUBAN_BROWSER_PATH` | 自动探测 | 豆瓣发布使用的 Chrome / Chromium 路径 |
| `JUEJIN_BROWSER_PATH` | 自动探测 | 掘金发布使用的 Chrome / Chromium 路径 |
| `CSDN_BROWSER_PATH` | 自动探测 | CSDN 发布使用的 Chrome / Chromium 路径 |
| `JIANSHU_BROWSER_PATH` | 自动探测 | 简书发布使用的 Chrome / Chromium 路径 |
| `AI_PROVIDERS_JSON` | 未设置 | AI 提供商池完整 JSON；支持多提供商、多 Key、模型映射（优先级最高） |
| `AI_PROVIDERS_FILE` | `DATA_DIR/ai-providers.json` | 受保护的提供商池 JSON 文件路径；建议 `chmod 600` |
| `MULTIPUSH_ADMIN_USERNAMES` | 未设置 | 生产环境允许在设置页修改服务器提供商池的用户名，逗号分隔；开发/桌面版默认允许所有用户 |
| `OPENCODE_GO_API_KEY` | 未设置 | 旧版单 Key；未配置提供商池时使用 OpenCode Go |
| `OPENCODE_GO_API_KEYS` | 未设置 | 旧版同提供商多 Key，逗号/空白分隔 |
| `AI_DEFAULT_API_KEY` | 未设置 | 旧版通用单 Key，优先于 `OPENCODE_GO_API_KEY` |
| `AI_DEFAULT_BASE_URL` | OpenCode Go 地址 | 旧版默认模型接口地址 |
| `AI_DEFAULT_MODEL` | `deepseek-v4.1-flash` | 旧版默认模型名称 |
| `AI_DEFAULT_LABEL` | `OpenCode Go` | 旧版 AI 页面显示的默认配置名称 |
| `WECHAT_BROWSER_PATH` | 自动探测 | 服务器 Chrome / Chromium 可执行文件绝对路径 |

数据目录结构：

```
.data/
  multipush.sqlite
  uploads/
  .jwt-secret
  .blog-session-key
  .weibo-session-key
  .toutiao-session-key
  .baijiahao-session-key
  .douban-session-key
  .juejin-session-key
  .jianshu-session-key
  .douyin-session-key
  .sspai-session-key
  .xiaohongshu-session-key
  .wechat-session-key
  .zhihu-session-key
  .ai-session-key
  ai-providers.json     # 可选：受保护的多提供商/多 Key 池（chmod 600）
```

## 目录结构

```
shared/types.ts        前后端共享类型
server/src/            API、数据库、鉴权、渲染器
web/src/               前端应用
desktop/               Electron 本地桌面版（内置前端、后端与 SQLite）
.github/workflows/     桌面端检查与 Release 构建
JenkinsConfig/         Jenkinsfile、部署脚本、systemd unit、健康检查
docs/                  产品规格、协作契约、部署文档
```

## 脚本

```bash
npm run dev         # 同时启动前后端开发服务
npm run typecheck   # 前后端类型检查
npm test            # 后端 + 前端单元测试
npm run test:web    # 前端 Tiptap / 导入归一化测试
npm run normalize:figures -- --db=.data/multipush.sqlite --report  # 历史图注迁移 dry-run
node scripts/smoke-figure-captions.mjs  # 构建后跑 21 组图文 E2E（编辑器/三平台渲染）
node scripts/smoke-editor-cover.mjs     # 构建后验证封面上传与正文选图
node scripts/smoke-sms-login-ui.mjs      # 构建后验证 7 个平台的手机验证码登录弹窗
npx tsx scripts/smoke-sms-login-selectors.mts # 真实登录页选择器检查（不发短信）
node scripts/smoke-douban-ui.mjs        # 构建后跑豆瓣渲染/发布页 UI 冒烟
node scripts/smoke-juejin-jianshu-ui.mjs # 构建后跑掘金/CSDN/简书发布页 UI 冒烟
npm run build       # 构建前端与后端单文件
npm start           # 启动生产构建
npm run desktop:smoke # 本地桌面版 Playwright 冒烟
npm run desktop:dist:win # Windows 安装包与便携版
node scripts/smoke-render-workbench.mjs # 构建后运行隔离的 Chrome 浏览器验证
node scripts/smoke-wechat-publish.mjs  # 构建后运行公众号发布页模拟交互验证
node scripts/smoke-wechatpic-publish.mjs # 构建后运行公众号贴图发布页模拟交互验证
node scripts/smoke-weibo-publish.mjs   # 构建后运行微博发布页模拟交互验证
node scripts/smoke-toutiao-publish.mjs # 构建后运行今日头条发布页模拟交互验证
node scripts/smoke-baijiahao-publish.mjs # 构建后运行百家号发布页模拟交互验证
```

## 部署

详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。服务器 `/opt/MultiPush`，systemd 服务 `multipush.service`，访问 http://192.168.0.111:34080 。

Jenkins 任务：`MultiPush`，SCM `git@github.com:yuan-xin-9997/MultiPush.git`，脚本路径 `JenkinsConfig/Jenkinsfile`，每 30 分钟轮询 `main`。

## 第一版说明

- 微信公众号发布需要服务器安装 Chrome / Chromium，详见 [公众号发布接入说明](docs/WECHAT_PUBLISHING.md)。微信登录会话可能过期，系统提示后重新扫码。正式发表不主动开启群发通知，微信要求安全校验时仍需管理员扫码。
- 公众号贴图使用官方 API（AppID / AppSecret）创建图片消息草稿，不依赖浏览器；个人订阅号只能建草稿，正式发表在公众号后台手动完成，详见 [公众号贴图发布说明](docs/WECHATPIC_PUBLISHING.md)。AI 创作与批量发布暂不支持贴图平台。
- 微信公众号复制富文本依赖浏览器剪贴板能力，建议使用 Chrome / Edge。
- 小红书卡片导出使用浏览器端渲染，需保持页面打开直至导出完成；外链图片可能受跨域限制，建议使用系统上传的图片。
- 平台独立调整保存在服务端的渲染记录中；常用默认设置按账号保存在当前浏览器。修改设置后须重新生成，已有结果的预览和导出会继续使用原设置。平台长度和数量上限作为参考，发布时以实际后台为准。
- 导出报告会列出缺失卡片和素材；可重试失败项并重新下载，已成功生成的卡片会复用。浏览器验证使用独立数据库和无头 Chrome，产物在 `artifacts/`；可通过 `CHROME_BIN` 指定浏览器路径。
- 设置 `QA_BASE_URL` 可验证已部署地址；脚本使用专用 QA 账号，并清理自己创建的文档和上传文件。账号清单保存在验证产物的 `qa-resources.json`，供管理员精确清理空 QA 账号。
- 视频能力：编辑器支持上传并嵌入视频；公众号/知乎以视频播放器呈现，小红书以视频笔记文案 + 原视频下载呈现。
- 视频内容：支持以视频为主的内容类型，多段上传 + 系统内时间线剪辑 + ffmpeg 导出成片，见 [视频内容说明](docs/VIDEO_CONTENT.md)；导出需要服务器安装 ffmpeg / ffprobe。

## 邮箱验证与找回密码

新账号必须填写邮箱并输入邮件中的六位验证码后才能完成注册。登录框同时接受用户名和邮箱。历史账号如果邮箱为空，可在登录后的左下角用户菜单选择“绑定邮箱”；已绑定邮箱不能通过该入口更换。登录页的“忘记密码”使用已绑定邮箱验证并设置新密码，重置后原有登录会话失效。

服务端环境变量（在运行环境配置，勿提交真实凭据）：

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_FROM=MultiPush <noreply@example.com>
SMTP_USER=noreply@example.com
SMTP_PASSWORD=your-smtp-password
```

465 端口使用 `SMTP_SECURE=true`；其他端口要求 STARTTLS。未配置 SMTP_HOST 或 SMTP_FROM 时，发送验证码返回服务不可用，不会跳过验证。验证码 10 分钟有效、一次性使用，同一邮箱/用途 60 秒内不能重发，每个验证码最多尝试 5 次；单进程每个来源 IP 每小时最多请求 10 次。反向代理默认按代理 IP 计数；多实例部署时需在入口增加共享发送限流。

`npm run smoke` 使用两个已验证的专用账号，设置 `QA_ACCOUNT_A`、`QA_PASSWORD_A`、`QA_ACCOUNT_B`、`QA_PASSWORD_B`。渲染浏览器验收默认在隔离数据库创建测试账号；验证远端时设置 `QA_ACCOUNT` 和 `QA_PASSWORD`，不绕过正式注册验证。
