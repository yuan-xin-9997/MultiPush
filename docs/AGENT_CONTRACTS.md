# 子智能体协作契约

> 所有子智能体必须只修改自己负责的文件，禁止改写他人负责的模块。完成前运行相关 typecheck/build，禁止提交（commit/push）。

## 已由项目经理提供、视为只读的文件

- `package.json`、`server/package.json`、`web/package.json`、`web/tsconfig.json`、`web/vite.config.ts`
- `shared/types.ts`（如确需扩展，先在最终回复中说明，不要破坏既有字段）
- `web/src/lib/api.ts`（API 方法已固定；只允许在你的模块内调用）
- `web/src/lib/utils.ts`
- `web/src/lib/content-io.ts`（导入/导出工具，已提供；核心智能体在内容库中调用，编辑器智能体可在更多菜单调用）
- `web/src/contexts/AuthContext.tsx`
- `web/src/main.tsx`
- `web/src/styles/globals.css`（只允许追加本模块独立 CSS 文件，不要改这里）
- `web/index.html`、`web/public/**`
- `docs/PRODUCT_SPEC.md`

## 文件所有权

### 后端 API 智能体

拥有：

- `server/src/**`（除 `server/src/renderers/**`）
- `server/test/**` 或 `server/tests/**`
- `server/.env.example`
- `docs/API_NOTES.md`（可选）

必须导入渲染器，不得实现或修改渲染器：

```ts
import { renderPlatforms } from './renderers'
```

渲染器签名：

```ts
renderPlatforms({
  content,
  platforms,
  options,
  authorName,
  baseUrl,
}): Promise<PlatformRender[]>
```

服务入口负责：`app.listen(34080, '0.0.0.0')`；生产 `NODE_ENV=production` 时托管 `web/dist`（路径优先级：`WEB_DIST` 环境变量，默认 `path.resolve(process.cwd(), 'web/dist')`），并对非 `/api`、非 `/uploads` 的 GET 请求回退 `index.html`。上传目录优先级 `DATA_DIR/uploads`。

要求实现：

- `node:sqlite` DatabaseSync，启动时建表/迁移；WAL；外键；busy_timeout。
- 数据表：`users`、`books`、`contents`、`media`、`renders`。
- bcryptjs 12 rounds；JWT 7d；secret 从 `JWT_SECRET` 或 `DATA_DIR/.jwt-secret`（自动生成）。
- zod 校验；统一错误处理；请求体上限 2MB；上传限制见规格。
- 所有查询按 `user_id` 隔离；越权返回 404。
- CORS：开发允许 `http://localhost:5173`、`http://127.0.0.1:5173`；同源生产无需。监听 0.0.0.0。
- 静态 `/uploads` 支持 Range、正确 Content-Type、缓存头；不要目录穿越。
- 渲染记录：`result_json` 存完整 `PlatformRender[]`，列表不返回大字段。
- 首次启动自动创建数据目录；`GET /api/health` 正常。
- 优雅退出（SIGTERM/SIGINT 关闭 server + db）。
- 可选：登录失败限流（内存即可）。

### 渲染器智能体

拥有：

- `server/src/renderers/**`
- `server/test/renderers.test.ts`（或 `server/tests/renderers.test.ts`）
- 可新增 `server/src/renderers/fixtures.ts`

不要修改 `shared/types.ts`、`server/src/index.ts`、路由、数据库。`renderPlatforms` 从 `server/src/renderers/index.ts` 导出，签名见规格第 5 节。

### 前端核心智能体

拥有：

- `web/src/App.tsx`
- `web/src/components/**`（`AppShell.tsx` 及新增通用组件）
- `web/src/features/auth/**`
- `web/src/features/library/**`
- `web/src/features/publish/**`
- 对应 CSS 文件（如 `web/src/features/library/library.css`）
- `web/src/lib/format.ts` 等新增工具（不要改 `utils.ts`）

不要修改：`main.tsx`、`contexts/AuthContext.tsx`、`lib/api.ts`、`lib/utils.ts`、`lib/content-io.ts`、`styles/globals.css`、`features/editor/**`、`features/render/**`。

内容库必须实现导入/导出 UI（使用 `@/lib/content-io`）：

- 导入：`<input type="file" multiple accept={IMPORT_ACCEPT}>` + 拖拽；`parseImportFile` 得到 `ContentInput[]`，逐篇 `api.contents.create({ ...doc, bookId: 当前知识库 })`；显示进度与结果统计。
- 单篇导出：文档更多菜单提供 Markdown / HTML / JSON；需先 `api.contents.get(id)` 再 `exportContentFile`。
- 多选：卡片/列表支持勾选；批量操作条提供 ZIP 导出（调用 `exportContentsZip`，需先获取详情）与批量删除/移动（可选）。
- 导入是客户端解析，不要新增后端上传接口。

App 路由必须保留：

- `/login`、`/register`
- `/editor/:id`（独立全屏，受保护，渲染 `features/editor/EditorPage`）
- 应用壳内：`/library`、`/library/favorites`、`/library/trash`、`/library/book/:bookId`、`/render`、`/publish`、`*` 回退 `/library`
- 支持 `?contentId=` 传给 RenderPage（用 `useSearchParams` 由 RenderPage 自行读取即可）
- AppShell 使用 `<Outlet />`；底部用户菜单退出登录。

### 编辑器智能体

拥有：

- `web/src/features/editor/**`（包括替换 `EditorPage.tsx` 和新增 CSS）
- 可新增 `web/src/features/editor/components/**`

不要修改 App 路由、AppShell、globals、api、contexts、`lib/content-io.ts`。页面路由固定为 `/editor/:id`；`id === 'new'` 时前端创建新文档再 `replace` 到真实 id。若进入时文档在回收站，显示横幅并支持恢复。编辑器通过 `useAuth()` 获取用户，通过 `api.*` 调用后端。媒体上传用 `api.media.upload`；上传后的 URL 为相对 `/uploads/...`。

导入文档的 `contentJson` 可能是空文档而 `contentHtml` 有内容：初始化编辑器时若 JSON 的 `content` 为空且 HTML 非空，必须用 `setContent(contentHtml)`，避免导入内容丢失。更多菜单增加「导出 Markdown / HTML」，调用 `@/lib/content-io` 的 `exportContentFile`。

编辑器根容器应使用 `position: fixed; inset: 0; z-index: 30; background: #fff;` 或等价的全屏布局，因为该路由在 AppShell 之外。

### 渲染前端智能体

拥有：

- `web/src/features/render/**`（包括替换 `RenderPage.tsx` 和新增 CSS/子组件）

不要修改 App 路由、AppShell、globals、api、contexts、editor、library。页面路由 `/render`，读取 `contentId` 查询参数；调用 `api.renders.create`。小红书卡片 PNG 使用 `html-to-image` 的 `toPng`（pixelRatio 2，1080×1440 容器），zip 用 `jszip`。下载/复制工具从 `@/lib/utils` 导入。平台预览使用 iframe `srcDoc` 隔离渲染 HTML，不执行脚本。

### 部署智能体

拥有：

- `JenkinsConfig/**`
- `docs/DEPLOYMENT.md`

不要修改应用代码。已知环境：

- Jenkins `http://192.168.0.111:8080`（管理员凭据由运维单独保管）；任务 `MultiPush` 已存在（SCM: `git@github.com:yuan-xin-9997/MultiPush.git`，分支 `*/main`，脚本路径 `JenkinsConfig/Jenkinsfile`，30 分钟轮询）。
- 运行机 Ubuntu 24.04、Node v22.23.3、npm 10.9.9；部署目录 `/opt/MultiPush`，系统服务 `multipush.service`，用户 `jenkins`。
- GitHub SSH 凭据已在 Jenkins：`truthanalysis-github-ssh`。
- 生产服务命令：`/usr/bin/node /opt/MultiPush/server/dist/index.js`；`WorkingDirectory=/opt/MultiPush`；环境 `HOST=0.0.0.0`、`PORT=34080`、`DATA_DIR=/opt/MultiPush/.data`、`NODE_ENV=production`、`WEB_DIST=/opt/MultiPush/web/dist`；`EnvironmentFile=-/opt/MultiPush/.env`。
- Jenkins 可通过 `sudo -n systemctl stop/start multipush.service` 控制服务。

Jenkinsfile 必须：pollSCM 30 分钟、checkout、`npm ci`、typecheck/test/build、停服、部署构建产物（保留 `.data`、`.env`）、启动、健康检查（`/api/health` 重试 30 次）。部署脚本要幂等、`set -euo pipefail`、校验 `realpath /opt/MultiPush`。只部署 `server/dist`、`web/dist`、`package.json`、`JenkinsConfig/health.mjs` 等必要文件，不要把 node_modules 同步到生产。由于服务为 `jenkins` 用户且 `/opt/MultiPush` 可写，使用 rsync/install 不需要 sudo（系统服务文件除外，可提供手工安装命令）。

## 验收命令（根目录）

```bash
npm install
npm run typecheck
npm run build
npm test
```

本地启动：`npm run dev`（后端 34080，前端 5173）。生产模拟：`npm run build && npm start`，访问 34080。
