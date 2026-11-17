# CHANGELOG

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
