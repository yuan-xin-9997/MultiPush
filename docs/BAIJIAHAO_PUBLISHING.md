# 百家号渲染与发布

> 手机验证码登录：在发布页点击「手机验证码登录」，使用百度通行证的「短信快捷登录」完成连接；不保存密码。出现安全验证时请改用扫码。

## 登录状态“很快过期”

百家号登录本身使用百度通行证 Cookie（`BDUSS` 等），正常有效期以年计；系统会加密保存完整 storage state。如果页面很快显示过期，先区分两种情况：

- `BDUSS` 仍在，但 `loginInfo` 返回 `errno: 20040000`、`errmsg: 当前用户未绑定百家号`、`data.have_account: 0`：这是**百度账号没有开通/绑定百家号作者账号**，不是登录过期。请改用已开通百家号的百度账号登录，或先到 `baijiahao.baidu.com` 完成作者注册。
- `BDUSS` 缺失或百度返回未登录：才是真正的会话失效，需要重新登录。

系统现在会在状态检查时重新验证已标记过期的会话；如果只是误判，会自动恢复，不再要求重复登录。登录确认后如果百度账号未绑定百家号，会直接提示原因，不会保存成“已连接”。

## 草稿

发布页支持「保存草稿」：在百家号编辑器填写标题/正文并上传图片后点击平台「存草稿」按钮（捕获 `POST /pcui/article/save`），成功时记录状态 `draft`，不公开发布。草稿不需要封面（平台允许草稿无封面），但正文图片同样会先上传到百家号图床。找不到按钮或无法确认成功时会停止并提示到百家号草稿箱核对。


状态：渲染、扫码登录、正文图片/封面上传与发布页面已实现，并通过模拟测试与页面回归；2026-11-19 已用真实百家号账号完成端到端验证（含图片链路验证文章：正文图片与图注在公开页正常显示）。

## 渲染

百家号以图文文章呈现。MultiPush 使用百家号图文排版：

- 标题 2–30 字，超长自动截断并提示，少于 5 字给出建议；
- 正文支持标题层级、列表、引用、代码、表格、图片和链接；
- 普通百家号账号的站外链接常被过滤，渲染时自动把站外链接保留为「文字（完整地址）」，读者可复制打开；
- 正文 HTML 最多 1 MB；视频、音频、iframe、SVG 暂不在自动发布范围内；
- 提供百家号 HTML 与 Markdown 下载；
- 预览使用桌面文章卡片模拟百家号图文页。

## 登录

在「发布管理 → 百家号」点击「扫码连接百家号」，系统打开百家号官方登录页 `https://baijiahao.baidu.com/builder/theme/bjh/login`，点击页面上的「登录」打开百度通行证弹窗，读取官方二维码并展示在系统内。

- 使用百度 App 扫码并在手机上确认；
- 二维码元素为 `img.tang-pass-qrcode-img`，源图 `passport.baidu.com/v2/api/qrcode?sign=…` 是 265×265 的 PNG，系统直接取源图展示而不是截屏缩略图；
- 登录页上还有「下载百度 APP / 立即体验创作中心」等营销二维码（`img[class*="qrcode"]`），它们排在登录二维码之前，绝不能作为选择器，否则会把「创作中心」深链当成登录码展示（扫码后手机显示空白页）；系统只接受 `passport.baidu.com/v2/api/qrcode` 源图的二维码；
- 登录成功以 `.baidu.com` 域下的 `BDUSS` Cookie 为准；账号信息来自 `GET /userb/user/loginInfo`，兼容 `userid/user_id/uid` 与 `uname/name/nickname` 等字段；该接口失败不阻塞登录，昵称回退为「百家号作者」；
- 浏览器 Cookie/localStorage 使用 AES-256-GCM 加密保存，密钥位于 `DATA_DIR/.baijiahao-session-key`，加密绑定 MultiPush 用户 ID；
- 断开连接只删除本系统会话，不会退出其他设备；
- 会话过期（`errno` 20040001 / 10001401 / 217100002）时重新扫码；遇到安全验证停止操作。

## 发布

1. 在渲染工作台生成百家号排版；
2. 发布管理 → 百家号，选择排版；
3. 点击「发布到百家号」并确认（也可选择「保存草稿」）。

发布使用百家号网页编辑器：

- 打开 `https://baijiahao.baidu.com/builder/rc/edit?type=news`；
- 标题写入 Lexical 编辑器（`[data-testid="news-title-input"] [contenteditable]`），写入后回读校验；
- 正文写入 UEditor：优先调用页面内的 `window.editor.setContent(html)`，失败时在 `#ueditor_0` 内写入 HTML 并派发 `input/change`，最后回读校验；
- 点击 `button[data-testid="publish-btn"]`（回退到文本严格等于「发布」的按钮，避免命中「定时发布」），必要时确认弹窗；
- 捕获 `POST /pcui/article/publish`，只有 `errno=0` 且返回可识别文章编号才标记成功（编号优先取 `ret.article_id` / `ret.id`，`ret.url` 是预览链接不采信）；
- 结果链接形如 `https://baijiahao.baidu.com/s?id=文章编号`；
- 提交后响应不明确、超时或服务重启时标记「结果待核实」，不自动重发。

### 正文图片自动上传到百家号图床

2026-11 起正文图片不再依赖编辑器抓取外链（UEditor 的 `catchremoteimage` 会把图片替换成占位 GIF `df3e567d6f16d040326c7a0ea29a4f41.gif`，已禁用），流程改为：

1. **收集**：service 层从渲染 HTML 按文档顺序提取所有唯一 `<img src>`（`srcset`/`data-src` 丢弃），相对地址按站点 origin 解析；`/uploads/` 本站图片直接读文件，其他 HTTP(S)/data URL 在后台任务中下载（`downloadPublisherImage`，仅公网地址 + MIME/魔数校验）；超过 100 张或格式不支持（仅 JPG/PNG/GIF，单张 ≤10 MB）会明确报错；
2. **上传**：driver 调用编辑器自身使用的真实接口 `POST https://baijiahao.baidu.com/materialui/picture/uploadProxy`（multipart 字段名 `media`，带编辑器 Referer/Origin），按原文档顺序逐张上传，取响应 `ret.https_url`（`https://baijiahao.baidu.com/bjh/picproxy?param=…`）；
3. **改写**：把渲染 HTML 的 `<figure><img><figcaption>` 重写成编辑器自身的结构——`<p class="bjh-image-container" data-bjh-caption-id="cap-mp-N"><img src="图床地址" data-bjh-origin-src="…" data-bjh-type="IMG" data-w data-h></p>`，配 `<p class="bjh-image-caption ue_t" data-bjh-caption-for="cap-mp-N">图注</p>`；图注 ≤18 字用原生图注，超过 18 字保留为居中灰色段落（百家号图注有 18 字上限，超长会丢字，所以不截断）；`alt`、`width`、`height` 原样保留；
4. **校验**：setContent 后读取 `#ueditor_0` 内 `<img>`，数量必须与预期一致、每个 src 必须是百家号域名（`baidu.com`/`bdstatic.com`/`bdimg.com`/`bcebos.com`/`baidubce.com`），出现占位 GIF 或外链立即报 `baijiahao_image_upload_failed` 终止，不会带占位图发布；
5. **回读**：发布响应 `errno=0` 后再拉一次公开文章页，统计百家号 CDN 图片数量；一张都没有时标记「结果待核实」，部分缺失时在成功消息里提示人工复核。

幂等键包含封面文件与全部正文图片的字节哈希，重复提交同一篇文章不会重复上传/发布。

### 封面自动设置

百家号发布必须设置封面（「设置封面」为必填项），系统按 `原文封面（content.coverImage）→ 第一张正文图` 的顺序取封面：

- 打开编辑器下方「选择封面」；
- 上传到弹窗内的 `input[name="media"][type="file"][accept="image/*"]`（平台封面限制 5 MB，超限报 `baijiahao_cover_size`）；
- 等待上传完成后点击文本以「确定」开头的按钮（实际是 `确定 (1)`，用 `/^确定/` 正则匹配，不用精确文本）；
- 确认后等待弹窗关闭再发布；
- 没有任何可用封面时发布模式直接报 `baijiahao_cover_required`，不会发布无封面文章。

保存草稿不设置封面（平台允许草稿无封面），正文图片仍会全部上传。

### 已发布文章不能编辑补图（平台限制）

百家号对普通作者账号不允许修改已发布文章：打开 `edit?type=news&article_id=已发布文章编号` 会提示「该文章不允许再次修改，请返回发布新文章」。因此发布后发现缺图时，**不能**通过编辑原文补图，只能用修复后的发布链路重新发布（新文章编号），旧文需要到百家号后台手动删除。内容管理的列表页在自动化浏览器中不渲染（微前端不挂载），且平台写接口（删除/撤回等）要求 `token` 请求头并加密参数（分散认证），暂无法自动化删除。

### 运营弹窗处理

百家号编辑器会延迟弹出「立即体验」等运营弹窗（`.cheetah-modal`，只有 `button[aria-label="关闭"]`），出现在标题/正文/发布按钮上方拦截点击（报 `cheetah-modal-wrap intercepts pointer events`）。`dismiss()` 在三个时点执行：打开编辑器后、标题/正文填写并校验完成后、点击发布按钮前；处理内容包括原有的「我知道了/知道了/暂不开启/关闭」文字按钮，以及 `.cheetah-modal` 的 `button[aria-label="关闭"]`（绝不点「立即体验」，也不碰带 `input[name="media"]` 的封面弹窗），关闭后等待遮罩消失才继续。

结果待核实支持：

- 重新自动核实：读取公开文章页并按文章编号/标题确认；
- 我已核实，未发布：解除限制，允许重新提交；
- 我已核实，已发布：填写文章链接并关联，不会再次发布。

## API

所有接口要求 MultiPush Bearer JWT，响应 `Cache-Control: no-store`。百家号会话失效返回 `409 baijiahao_session_expired`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/baijiahao/account` | 查询账号状态 |
| `POST /api/baijiahao/login` | 获取官方登录二维码（202） |
| `GET /api/baijiahao/login/:id` | 查询扫码/确认状态 |
| `DELETE /api/baijiahao/account` | 断开连接 |
| `POST /api/baijiahao/publications` | 提交 `{renderId}` |
| `GET /api/baijiahao/publications` | 当前用户最近 50 条记录 |
| `DELETE /api/baijiahao/publications/:id` | 删除本系统的草稿或失败记录，不会操作百家号后台（平台删除接口需加密参数且列表页在无头浏览器中不渲染）；已发布、处理中和结果待核实记录不可删除 |
| `POST /api/baijiahao/publications/:id/resolve` | `{action:"check"}` 异步复查；`{action:"not_published"}` 人工确认未发布；`{action:"published",articleUrl}` 人工关联已发布文章 |

## 验证与限制

- 单元测试覆盖百家号图文渲染、标题长度、视频拦截、站外链接降级、会话加密、幂等、待核实和重启恢复；`server/test/baijiahao-browser.test.ts` 覆盖图片收集顺序、figure→图床 HTML 改写、原生图注、占位 GIF 检测、上传响应解析（`ret.article_id`）、公开页图片回读和无封面报错。
- 页面回归：先 `npm run build:web`，再运行 `node scripts/smoke-baijiahao-publish.mjs`，使用隔离 fixture 验证扫码、发布确认、失败、待核实和人工核实流程，不访问真实百家号。
- 真实链路已于 2026-11-19 用真实百家号账号验证：编辑器真实接口抓包（`materialui/picture/uploadProxy`、封面弹窗 `pcui/picture/processproxy`）、setContent 图片改写、封面「确定 (1)」确认、`/pcui/article/publish` 返回 `ret.article_id`，以及公开页图片/图注渲染。
- 百家号正文是 UEditor 富文本；正文图片必须经 `materialui/picture/uploadProxy` 上传后以 `bjh/picproxy` 地址写入，禁止外链和 `catchremoteimage`。
- 不支持视频、动态、专栏、合集、定时发布、原创声明、首发声明和位置等高级设置。
- 百家号网页与内部接口没有稳定性承诺，改版后可能需要更新选择器和响应解析。
