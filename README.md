# MultiPush · 多平台智能发布系统

> 一次创作，智能渲染，适配微信公众号、小红书、知乎、抖音。支持微信公众号和知乎扫码登录、保持会话、保存草稿与正式发布；小红书仅支持导出后手动发布；抖音新增扫码登录和视频 / 图文发布（待真实账号联调）。

![MultiPush](web/public/favicon.svg)

## 功能

- **多用户**：注册、登录、JWT 鉴权，内容按用户隔离。
- **类语雀内容库**：知识库分组、全部内容、收藏、回收站、搜索、排序、卡片/列表视图、复制、移动、批量操作。
- **类语雀编辑器**：Tiptap 富文本、`/` 快捷插入菜单、标题/列表/任务/表格/代码/引用/图片/视频/链接/颜色/对齐、目录大纲、字数统计、自动保存、封面与标签。
- **导入 / 导出**：批量导入 Markdown、HTML、TXT、MultiPush JSON；单篇导出 Markdown/HTML/JSON；多选打包 ZIP。
- **智能渲染**：
  - 微信公众号：移动端图文排版、内联样式、复制富文本、下载 HTML。
  - 小红书：自动分页 3:4 卡片、1080×1440 PNG、文案与话题、视频笔记预览、ZIP 下载。
  - 知乎：专栏长文排版、Markdown / HTML 导出。
  - 抖音：竖屏图文 / 视频笔记文案、话题标签、文案与图文 HTML / JSON 导出。
- **平台预览**：手机壳公众号、小红书卡片、知乎桌面文章、抖音竖屏信息流，四种平台各按自身视觉模拟。
- **渲染工作台**：各平台独立修改标题、正文、话题并保存到记录，可恢复生成结果；小红书支持卡片排序、光标处分页、换图和裁剪，按实际高度自动分页。提供发布前检查、原文版本提醒、账号默认设置及含缺失清单的 ZIP 导出报告。
- **公众号发布**：系统内展示官方登录二维码，加密保存登录状态；选择公众号排版和封面，一键保存草稿或正式发表。支持正文图片转存、安全扫码确认、发布记录和重复提交保护。
- **小红书发布**：自动登录和自动发布已停用，已清除保存会话；保留卡片与文案导出、历史记录，请在官方 App 或创作中心手动发布。详见 [说明](docs/XIAOHONGSHU_PUBLISHING.md)。
- **知乎发布**：系统内展示知乎官方二维码，按用户加密保存登录状态；选择知乎排版和可选封面，保存草稿或发布专栏文章。图片自动转存、使用原生图注/列表/表格/代码结构，并回读核对内容，发现差异则保留草稿并停止发布。详见 [知乎发布说明](docs/ZHIHU_PUBLISHING.md)。
- **抖音发布**：系统内展示官方登录二维码，按用户加密保存会话；选择 MP4 视频或 1–35 张图片发布。包含发布记录、重复提交保护、重启恢复与结果人工核实；遇到安全验证停止操作。详见 [抖音发布说明](docs/DOUYIN_PUBLISHING.md)。
- **部署**：监听 `0.0.0.0:34080`，Jenkins 每 30 分钟轮询 GitHub，自动停服、构建、部署、启动与健康检查。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite 7、React Router 6、Tiptap 2、纯 CSS |
| 后端 | Node.js 22、Express 4、TypeScript、`node:sqlite`、JWT、bcryptjs、multer |
| 渲染 | 服务端规则模板（cheerio / sanitize-html / turndown），无外部 AI 依赖 |
| 下载 | html-to-image（小红书卡片）、JSZip |
| 部署 | esbuild 单文件后端、Jenkins Pipeline、systemd |

## 本地开发

要求 Node.js ≥ 22.12（推荐 22 LTS 或 24）。

```bash
npm install
npm run dev
```

- 前端：http://127.0.0.1:5173
- 后端：http://127.0.0.1:34080
- 首次打开注册一个账号即可。

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
| `DOUYIN_BROWSER_PATH` | 自动探测 | 抖音发布使用的 Chrome / Chromium 路径 |
| `WECHAT_BROWSER_PATH` | 自动探测 | 服务器 Chrome / Chromium 可执行文件绝对路径 |

数据目录结构：

```
.data/
  multipush.sqlite
  uploads/
  .jwt-secret
  .douyin-session-key
  .xiaohongshu-session-key
  .wechat-session-key
```

## 目录结构

```
shared/types.ts        前后端共享类型
server/src/            API、数据库、鉴权、渲染器
web/src/               前端应用
JenkinsConfig/         Jenkinsfile、部署脚本、systemd unit、健康检查
docs/                  产品规格、协作契约、部署文档
```

## 脚本

```bash
npm run dev         # 同时启动前后端开发服务
npm run typecheck   # 前后端类型检查
npm run test        # 后端单元测试
npm run build       # 构建前端与后端单文件
npm start           # 启动生产构建
node scripts/smoke-render-workbench.mjs # 构建后运行隔离的 Chrome 浏览器验证
node scripts/smoke-wechat-publish.mjs  # 构建后运行公众号发布页模拟交互验证
```

## 部署

详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。服务器 `/opt/MultiPush`，systemd 服务 `multipush.service`，访问 http://192.168.0.111:34080 。

Jenkins 任务：`MultiPush`，SCM `git@github.com:yuan-xin-9997/MultiPush.git`，脚本路径 `JenkinsConfig/Jenkinsfile`，每 30 分钟轮询 `main`。

## 第一版说明

- 微信公众号发布需要服务器安装 Chrome / Chromium，详见 [公众号发布接入说明](docs/WECHAT_PUBLISHING.md)。微信登录会话可能过期，系统提示后重新扫码。正式发表不主动开启群发通知，微信要求安全校验时仍需管理员扫码。
- 微信公众号复制富文本依赖浏览器剪贴板能力，建议使用 Chrome / Edge。
- 小红书卡片导出使用浏览器端渲染，需保持页面打开直至导出完成；外链图片可能受跨域限制，建议使用系统上传的图片。
- 平台独立调整保存在服务端的渲染记录中；常用默认设置按账号保存在当前浏览器。修改设置后须重新生成，已有结果的预览和导出会继续使用原设置。平台长度和数量上限作为参考，发布时以实际后台为准。
- 导出报告会列出缺失卡片和素材；可重试失败项并重新下载，已成功生成的卡片会复用。浏览器验证使用独立数据库和无头 Chrome，产物在 `artifacts/`；可通过 `CHROME_BIN` 指定浏览器路径。
- 设置 `QA_BASE_URL` 可验证已部署地址；脚本使用专用 QA 账号，并清理自己创建的文档和上传文件。账号清单保存在验证产物的 `qa-resources.json`，供管理员精确清理空 QA 账号。
- 视频能力：编辑器支持上传并嵌入视频；公众号/知乎以视频播放器呈现，小红书以视频笔记文案 + 原视频下载呈现。

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
