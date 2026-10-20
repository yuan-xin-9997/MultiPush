# MultiPush · 多平台智能发布系统

> 一次创作，智能渲染，适配微信公众号、小红书、知乎。第一版聚焦「排版渲染 + 预览 + 下载」，不连接任何平台账号，发布动作由用户手动完成。

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
- **平台预览**：手机壳公众号、小红书卡片、知乎桌面文章，三种平台各按自身视觉模拟。
- **发布管理**：第一版为完整占位页，预留后续自动化发布能力。
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

数据目录结构：

```
.data/
  multipush.sqlite
  uploads/
  .jwt-secret
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
```

## 部署

详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。服务器 `/opt/MultiPush`，systemd 服务 `multipush.service`，访问 http://192.168.0.111:34080 。

Jenkins 任务：`MultiPush`，SCM `git@github.com:yuan-xin-9997/MultiPush.git`，脚本路径 `JenkinsConfig/Jenkinsfile`，每 30 分钟轮询 `main`。

## 第一版说明

- 不真正连接平台 / 不执行一键发布，仅生成平台适配内容供下载后手动发布。
- 微信公众号复制富文本依赖浏览器剪贴板能力，建议使用 Chrome / Edge。
- 小红书卡片导出使用浏览器端渲染，需保持页面打开直至导出完成；外链图片可能受跨域限制，建议使用系统上传的图片。
- 视频能力：编辑器支持上传并嵌入视频；公众号/知乎以视频播放器呈现，小红书以视频笔记文案 + 原视频下载呈现。
