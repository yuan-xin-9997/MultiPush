# 图文 figure/figcaption 与图注空行修复

日期：2026-11-17

## 0. 项目信息（本次实测补齐）

| 项 | 值 |
| --- | --- |
| 仓库路径 | `/Users/xinyuan/dev/MultiPush` |
| 前端启动 | `npm run dev -w web`；或根目录 `npm run dev` 同时启动前后端。前端 http://127.0.0.1:5173 |
| 后端启动 | `npm run dev -w server`；后端 http://127.0.0.1:34080（Vite 代理 `/api`、`/uploads`） |
| 测试命令 | `npm test`（先 server Vitest，再 web Vitest）；`npm run typecheck`；`npm run build` |
| 21 组图文 E2E | `npm run build && node scripts/smoke-figure-captions.mjs` |
| 图注迁移脚本 | 停服后执行 `npm run normalize:figures -- --db=.data/multipush.sqlite --report`，确认后 `--apply`（自动 checkpoint + 备份） |
| 部署方式 | Jenkins 任务 `MultiPush`，SCM 轮询 `main`（30 分钟），Pipeline 脚本 `JenkinsConfig/Jenkinsfile`；生产主机 `192.168.0.111`，部署目录 `/opt/MultiPush`，systemd 服务 `multipush.service`，对外 https://publish.yuan-xin.top/ |
| 手工部署（应急） | `npm ci && npm test && npm run build && bash JenkinsConfig/deploy.sh prepare && ... deploy`，详见 `docs/DEPLOYMENT.md` |

## 1. 复现结果（改前）

### 1.1 编辑器丢 figure

输入：

```html
<figure><img src="/uploads/a.png" alt="图"><figcaption>图：我的器材</figcaption></figure><p>正文</p>
```

用旧 Tiptap 配置（StarterKit + Image + Link）打开后：

```json
{"type":"doc","content":[{"type":"image","attrs":{"src":"/uploads/a.png","alt":"图","title":null}},{"type":"paragraph","content":[{"type":"text","text":"图：我的器材"}]},{"type":"paragraph","content":[{"type":"text","text":"正文"}]}]}
```

```html
<img src="/uploads/a.png" alt="图"><p>图：我的器材</p><p>正文</p>
```

结论：schema 没有 `figure` / `figcaption`，解析降级为 image + paragraph；保存后再打开无法恢复。基线保存在 `artifacts/figure-caption-fix/before-editor.txt`。

### 1.2 渲染出现空行

输入：

```html
<p><img src="/uploads/a.png" alt="图"></p><p><em>图：我的器材：）</em></p><p>正文</p>
```

旧渲染结果（节选）：

- 公众号：`<p><img ... style="...margin:20px auto;"></p><p style="...margin:0 0 16px;"><em>图：我的器材：）</em></p>`；图片下边距 20px + 段落上间距叠加，出现空行。
- 知乎：`<figure><img ...></figure><p><em>图：...</em></p>`；图注在 figure 外。
- 博客：同样 `figure` 无 `figcaption`，图注是独立段落。

基线保存在 `artifacts/figure-caption-fix/before-render.txt`。

### 1.3 contentJson 旧快照

`PATCH /api/contents/:id` 只带 `contentHtml` 时，旧逻辑保留 `contentJson` 原样且不标记；编辑器 `jsonHasContent(contentJson)` 为真时优先读 JSON，于是正文已改、编辑器没变。

## 2. 根因与改造方案

| 根因 | 改造 |
| --- | --- |
| Tiptap schema 无 figure/figcaption | `web/src/features/editor/figure.ts` 新增 block 级 `Figure`、`FigureCaption` 节点；figure parse 优先级 1000；renderHTML 输出标准结构 |
| 历史文档是 image + paragraph | `NormalizeFigureCaptions` ProseMirror 插件（appendTransaction）+ 初始加载显式 `normalizeEditorFigures()`；只处理相邻 image + `图：`/`图:`/编号图注段落 |
| Markdown 导入把图与图注拆成两个 block | `groupImageCaptions()` 在 sanitize 后、生成 contentJson 前合并；粘贴走 `transformPastedHTML` 同一函数 |
| 各平台渲染器未归一化，且重复 margin | `server/src/renderers/figure-captions.ts` 在 `normalizeContentHtml` 中统一归一化；公众号/知乎/博客样式改为 figure 20px、图片下边距 0、图注上边距 8px |
| contentHtml 与 contentJson 不同步 | DB 新增 `content_html_hash`、`content_json_stale`；路由计算/校验；编辑器 stale 时读 HTML；JSON-only PATCH 重建 HTML |
| 旧 render 记录仍可能 p+p | 公众号发布 `article()`、知乎/博客 `prepare*Content()` 再归一化一次 |

## 3. 代码变更

- `shared/figure-caption.ts`：图注判定（`图` + 可选编号 + 全角/半角冒号）和统一间距常量；前后端共用。
- `server/src/renderers/figure-captions.ts`：cheerio 归一化；支持 `<p><img></p>`、裸 `<img>`、已有 `<figure>` 缺 figcaption；只合并紧邻图注；保留 caption 内 `strong`/`a` 等混合格式；整段斜体时去掉外层 `em`（figcaption 本身即语义图注）。
- `server/src/renderers/common.ts`：`normalizeContentHtml()` 在样式和媒体采集前调用归一化，因此所有平台渲染和批量渲染使用同一结构。
- `server/src/renderers/wechat.ts`：新增 `figure img` 样式；`normalizeWechatCaptions()` 同时处理 figure 与历史 p+p；figure 外边距统一 20px，图片 0，图注 8px。
- `server/src/renderers/zhihu.ts` / `blog.ts`：figcaption 统一 `#8a8f99`、13px、上间距 8px；figure 20px；博客发布仍交给 Halo 主题 `.prose figcaption`。
- `server/src/zhihu-content.ts` / `blog-content.ts` / `sspai-content.ts`：prepare 入口先归一化；知乎发布仍转原生 `data-caption`，不产生空段落。
- `server/src/wechat.ts`：发布前对旧 render 记录再归一化。
- `web/src/lib/content-io.ts`：新增并导出 `groupImageCaptions()`；Markdown、HTML、JSON 导入均接入。
- `web/src/features/editor/EditorPage.tsx`：注册 figure 扩展和归一化插件；加载时 stale JSON 不覆盖 HTML；粘贴 HTML 归一化；保存同时提交同一份文档的 HTML/JSON。
- `web/src/features/render/PlatformEditor.tsx`：平台调整编辑器保留 figure/figcaption。
- `server/src/tiptap-html.ts`：JSON-only PATCH 的最小 Tiptap JSON→HTML 序列化，覆盖段落/标题/列表/引用/代码/表格/图片/视频/figure/figcaption 及常用 marks。
- `server/src/db.ts`：additive 迁移；旧库启动时自动加列并按现有 HTML 回填 checksum；新增内容写路径记录 hash 与 stale。
- `server/src/routes/contents.ts`、`server/src/ai.ts`：PATCH 语义与 stale 标记；AI 只改 HTML 时标记 stale。
- `scripts/normalize-figures.ts`：历史库迁移脚本（dry-run 默认，`--apply` 前 checkpoint + 备份，只改结构并标记 stale）。

## 4. 内容同步语义

| 写入 | contentHtml | contentJson | stale |
| --- | --- | --- | --- |
| 编辑器保存（同时带两者） | 使用请求值 | 使用请求值 | false |
| 仅 PATCH contentHtml | 使用请求值 | 保留旧值 | true（编辑器读 HTML） |
| 仅 PATCH contentJson | 由 JSON 重建 | 使用请求值 | false |
| 创建时只有 HTML | 使用请求值 | `{}` | true（编辑器读 HTML） |
| 创建时只有 JSON | 由 JSON 重建 | 使用请求值 | false |
| 旧库首次启动 | 原值 | 原值 | false（按现有 HTML 回填 hash） |

checksum 为 SHA-256；GET 时同时检查持久化 hash 与显式 stale 标记。即使进程重启，HTML-only 修改也不会被旧 JSON 覆盖。

## 5. 样式结果

公众号/知乎/博客统一：

```html
<figure style="margin:20px 0;">
  <img style="display:block;max-width:100%;height:auto;border-radius:8px;margin:0 auto;">
  <figcaption style="margin-top:8px;text-align:center;color:#8a8f99;font-size:13px;line-height:1.6;">图：...</figcaption>
</figure>
```

- 公众号输出 `margin:20px 0;`（figure）/ `margin:0 auto;`（图片）/ `margin:8px 0 0;`（图注）；图片下边距 0，图注上边距 8px。
- 不再出现 `<p><img></p><p>图注</p>`；`<figure>` 内没有 `<p>`，`<figcaption>` 不在 `<p>` 内。
- 多图共用图注、正文中普通 `图：` 段落不处理。

## 6. 测试与实测

### 6.1 自动化

| 测试 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（server + web） |
| `npm test` | server 32 个文件 / 271 项；web 11 项；全部通过 |
| `npm run build` | 通过 |
| `node scripts/smoke-figure-captions.mjs` | 通过：21 组导入/保存/重开/三平台渲染 |
| 渲染快照 | `server/test/__snapshots__/figure-render-snapshots.test.ts.snap`，wechat/zhihu/blog 各 3 组 |
| 历史 p+p 单测 | `server/test/figure-normalization.test.ts` 8 项 |
| content 同步单测 | `server/test/content-sync.test.ts` 4 项（含旧库迁移、重启后 checksum） |
| 编辑器 round-trip | `web/test/figure.test.ts` 11 项（含 21 组 figure 保存/重开） |

### 6.2 E2E 实测

命令：`node scripts/smoke-figure-captions.mjs`（隔离数据库、本地服务，不向任何平台发布）。

流程：Markdown（21 组 `![...](...)` + `*图：...*`）→ 内容库导入 → Tiptap 编辑器打开 → Cmd/Ctrl+S 保存 → 重新打开 → 仅 PATCH contentHtml 制造 stale → 编辑器确认显示新 HTML → 保存后 stale=false → 调 `/api/renders` 生成三平台结果。

结果：

- 编辑器：21 个 `<figure>`、21 个 `<figcaption>`；保存后 `contentJsonStale=false`，JSON 中 21 个 figure 节点；重新打开仍为 21。
- 公众号：21 个 figure、21 个 figcaption；图注不在 p 内；图片 margin 下边距 0；图注上边距 8px。
- 知乎：21/21；图注上边距 8px。
- 博客：21/21；图注上边距 8px。
- 截图/HTML：`artifacts/figure-caption-fix/`（`editor-21-figures.png`、`editor-21-figures-reopened.png`、`wechat-preview.png`、`zhihu-preview.png`、`blog-preview.png`、`*-render.html`、`e2e-result.json`）。

### 6.3 真实生产数据副本验证

用 SQLite `VACUUM INTO` 从生产库生成一致性副本（不写入生产库），迁移后启动新版本，使用真实 21 图文章 `我把家变成了数据中心：一个 INTJ 的数字生活蓝图`：

- GET API：21 个 `<figure>`、21 个 `<figcaption>`；旧 `contentJson` 为 `{}`，`contentJsonStale=true`，编辑器应读 HTML。
- 浏览器打开编辑器：21 个 figure、21 个 figcaption；截图 `artifacts/figure-caption-fix/editor-real-figure.png`、`editor-real-21-figures.png`。
- Cmd+S 保存并刷新：仍为 21/21；`contentJsonStale=false`，JSON 中 21 个 figure 节点。
- 三平台渲染：wechat/zhihu/blog 均 21 figure、21 figcaption，`<p img>` 与 `<p><figcaption>` 均为 0，图注上边距 8px。
- 21 张真实图片已从生产 uploads 复制到测试副本，编辑器显示正常。

在只读副本/生产库查询：21 图文章当前有 21 个 `<figure>`/`<figcaption>`；用同一 HTML 跑 wechat/zhihu/blog，三平台均输出 21/21，`<p img>` 为 0。

另取两篇历史文章做回归（`artifacts/figure-caption-fix/regression-existing-articles.json`）：

- 「1277 部影视」：7 张图片 + 7 段 `图 1：…` 普通段落，改前 p+p；改后公众号/知乎/博客均为 7 个 figure + 7 个 figcaption，正文纯文本、7 个图片路径、6 个链接与原文一致。
- 「4.4 万本电子书」：8 张图片无 `图：` 图注；公众号保持 8 张 p 内图片，知乎/博客按既有逻辑包成 8 个无 figcaption 的 figure；正文纯文本、8 个图片路径、6 个链接与原文一致。

## 7. 真实草稿箱验证（需要登录/扫码）

代码与本地链路已完成；真实平台后台验证仍需已登录账号，操作如下（不会自动发布，只保存草稿）：

1. 部署本次提交（Jenkins `MultiPush` → Build Now，或按 `docs/DEPLOYMENT.md` 手工部署）。
2. 打开 https://publish.yuan-xin.top/ ，用 21 组图文内容生成公众号、知乎、博客排版。
3. 公众号：发布管理 → 保存草稿；在微信后台草稿箱打开，确认 21 组图注紧贴图片（6–10px）、无空行；如果微信把 `figcaption` 拆成独立段落，记录实际 DOM，启用 `CHANGELOG.md` 中的降级方案（图片 + 紧贴说明段落）。
4. 知乎：保存草稿；在知乎草稿箱确认 21 个图注为图片原生 caption，无空段落。
5. Halo：保存草稿；打开文章页面确认 21 个 `figcaption`，主题图注间距 ≤12px。
6. 回归：打开「1277 部影视」「4.4 万本电子书」各生成一次排版，确认图片、链接、标题、摘要、标签不变。

> 说明：当前执行环境没有公众号/知乎/Halo 的登录凭据，微信扫码需要管理员人工确认；因此本次交付没有在真实账号后台创建草稿，避免擅自发布或改动用户账号内容。真实后台的自动化回读代码路径（知乎 `verifyZhihuContent`、博客 `verifyBlogContent`、公众号发布前归一化）已保留并通过单测。

## 8. 影响面与回滚

- 数据库：只新增 `content_html_hash`、`content_json_stale` 两个带默认值的列，旧代码可忽略；启动时按现有 HTML 回填，不修改文本。
- API：`ContentDetail` 新增可选 `contentJsonStale` / `contentHtmlHash`，不改变既有字段；PATCH 语义见第 4 节。
- 渲染：公众号/知乎/博客的结构由 p+p 变为 figure；其他平台复用统一归一化，输出也可能新增 figure。图片、链接、标题、摘要、标签内容不变。
- 历史 render 记录：不删除、不重写；公众号发布时再归一化；知乎/博客发布 prepare 阶段再归一化。
- 回滚：`git revert` + 重新构建；DB 新列可保留；迁移脚本在 `--apply` 前生成 `.bak`，可停服恢复。
