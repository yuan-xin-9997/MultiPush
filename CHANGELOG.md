# CHANGELOG

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
