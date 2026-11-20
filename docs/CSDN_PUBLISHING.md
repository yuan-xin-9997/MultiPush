# CSDN 发布说明

> 登录：使用微信扫描 CSDN 官方登录二维码，不保存 CSDN 密码。
> 发布：通过已登录浏览器操作 CSDN 官方 Markdown 编辑器，保存草稿或发布文章。

## 1. 能力范围

- 平台：CSDN 博客（`https://blog.csdn.net/`）。
- 渲染：Markdown 优先的技术博客排版，支持标题层级、引用、代码块、表格、图片和 `figure/figcaption`；同时提供 HTML 下载。
- 发布：
  - **保存草稿**：在 CSDN 草稿箱创建草稿，不公开；
  - **直接发布**：在 CSDN 发布设置中自动添加标签并公开发布。
- 发布记录、重复提交保护、结果待核实与人工核实。

## 2. 登录

- 打开「发布管理 → CSDN」。
- 点击「扫码连接 CSDN」，使用微信扫描 CSDN 官方登录二维码，并在手机上确认。
- 登录状态加密保存；Cookie 失效后重新扫码即可。
- 系统只保存浏览器登录状态，不接收、不保存 CSDN 账号密码。

CSDN 登录 Cookie 至少包含 `UserToken` 与 `UserName`；展示名称优先使用 `UserNick`。

## 3. 渲染与排版

- 渲染器输出 CSDN 风格的白色正文、橙色主色、深色代码块，并生成 Markdown 与 HTML 两个下载文件。
- 发布时使用 Markdown；标题单独填写到 CSDN 编辑器标题栏，不会在正文中重复 `# 标题`。
- CSDN 标题要求 **5–100 个字**；不足 5 个字时渲染结果会给出提醒，发布时会被拒绝并提示补充标题。
- CSDN 文章暂不支持嵌入视频；包含视频时会在渲染提醒中说明，并在发布前拒绝。
- 正文图片使用渲染结果中的公网图片地址。CSDN 编辑器在发布时可能校验并转存正文图片；如果图片无法显示，可在 CSDN 编辑器中重新上传后再发布。

## 4. 发布流程

系统使用 Playwright 驱动本机/服务器上的 Chrome 或 Chromium，操作 CSDN 官方 Markdown 编辑器：

```text
打开 https://editor.csdn.net/md/
导入 Markdown（编辑器「导入」入口的 #import-markdown-file-input）
填写标题（.article-bar__title--input）
保存草稿：点击「保存草稿」→ POST /blog-console-api/v3/mdeditor/saveArticle（pubStatus=draft）
发布：点击「发布文章」→ 打开发布设置 → 自动添加标签 → 点击「发布文章」
      → POST /blog-console-api/v3/mdeditor/saveArticle（pubStatus=publish）
回读保存响应中的文章编号与公开地址，写入发布记录
```

- 标签在发布设置中逐个输入并按 Enter 添加，最多 5 个；CSDN 发布设置可能要求至少一个标签。
- 创作类型默认使用「原创」，可见范围默认「全部可见」；如需转载、私密或定时发布，请先保存草稿，再到 CSDN 编辑器调整后手动发布。
- 保存响应返回 `code != 200` 时显示平台原文并停止；未返回文章编号时标记「结果待核实」，不自动重试，避免重复文章。
- 原创校验未通过时标记失败，并提示到 CSDN 后台查看审核原因。

## 5. 配置

```dotenv
# 可选，未设置时复用 WECHAT_BROWSER_PATH / CHROME_BIN 或自动探测
CSDN_BROWSER_PATH=/usr/bin/chromium
```

登录状态密钥：`DATA_DIR/.csdn-session-key`。

## 6. 状态与安全

- 草稿成功：状态 `draft`，记录 CSDN 草稿链接（`editor.csdn.net/md/?articleId=…`）。
- 发布成功：状态 `published`，记录文章公开链接。
- 页面改版、网络中断或结果无法确认：停止操作并标记 `uncertain`，先到 CSDN 草稿箱和文章列表核实；确认未发布后可人工解除限制再重试。
- 遇到安全验证会停止并提示改用官方页面完成验证，不绕过平台风控。

## 7. 当前验证状态

- 登录页二维码、Markdown 编辑器标题/导入/保存草稿/发布设置/标签选择的 DOM 与接口已用本地真实浏览器核对。
- 由于当前环境没有可用的 CSDN 账号，未执行真实登录后的草稿创建与公开发布；首次部署后请先用真实账号保存一篇草稿，再到 CSDN 编辑器检查图片和代码块，最后测试直接发布。
- CSDN 编辑器与发布设置属于网页端实现，改版时可能需要更新 `server/src/csdn-browser.ts` 中的选择器。
