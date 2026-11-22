# 简书发布说明

> 用户需求中的“简体书”按 **简书**（`jianshu.com`）实现。

## 1. 能力范围

- 渲染：简书长文排版，支持标题层级、引用、代码、表格、图片和 `figure/figcaption`；发布使用渲染 HTML，同时提供 Markdown/HTML 下载。
- 发布：连接简书账号后支持：
  - **保存草稿**：在账号默认文集创建草稿；
  - **直接发布**：保存草稿后调用简书发布接口公开发布。
- 发布记录、重复提交保护、结果待核实与人工核实。

## 2. 为什么使用 Cookie 连接

简书网页端没有可用的扫码登录入口（登录页为账号密码/短信 + 验证码）。为避免保存用户密码、处理验证码或绕过安全验证，本系统采用：

1. 用户在已登录简书的浏览器中复制 `Cookie` 请求头；
2. 系统用 Cookie 建立浏览器会话，验证 `/author/notebooks` 可访问；
3. Cookie 加密保存在当前用户下，发布时复用。

至少需要 `remember_user_token`；建议把完整 Cookie 一起复制。Cookie 失效后重新复制即可，系统不会保存密码。

## 3. 草稿与发布流程

```text
GET  /author/notebooks                        读取文集（默认使用第一个）
GET  /upload_images/token.json?filename=...   获取七牛上传 token/key
POST https://upload.qiniup.com                上传图片 { token, key, file, x:protocol }
POST /author/notes                            创建草稿 { at_bottom, notebook_id, title }
PUT  /author/notes/:id                        保存富文本正文 { autosave_control, content, id, title }
GET  /author/notes/:id/content                回读正文，确认不是 Markdown 原文
POST /author/notes/:id/publicize              公开发布
GET  /p/{slug}                                核对公开文章
```

- `content` 使用 **HTML**，与简书账号当前使用的富文本编辑器一致；旧版本发送 Markdown，导致标题、图片语法原样显示。
- 正文图片会先上传到简书图床：`token.json` 必须带 `filename`（七牛 key 会包含扩展名），上传表单必须包含 `token`、`key`、`file` 和 `x:protocol=https`。
- 保存后会回读 `/author/notes/:id/content`；如果发现 Markdown 原文、没有富文本块或图片缺失，会停止发布并保留草稿。
- 图片格式为 JPG/PNG/GIF/WebP（编辑器支持范围），单张不超过 5 MB。
- 简书非会员每天公开文章数量有限；平台返回「每天只能发布」时会显示原文并停止，不会自动重试。
- 未返回公开地址时标记「结果待核实」，先到简书后台核实。

## 记录删除

- 草稿记录支持删除：调用 `POST /author/notes/:id/soft_destroy`，草稿进入简书回收站，随后清理本地记录。
- 失败记录只清理本地记录；如果这次提交留下了远端草稿，会尝试一并删除。
- 已发布、处理中和结果待核实记录不可删除；已发布文章需要到简书后台手动处理。
- 删除草稿会调用 `soft_destroy`；真实账号已验证测试草稿可删除（进入简书回收站）。

## 4. 配置

```dotenv
# 可选，未设置时复用 WECHAT_BROWSER_PATH / CHROME_BIN 或自动探测
JIANSHU_BROWSER_PATH=/usr/bin/chromium
```

登录状态密钥：`DATA_DIR/.jianshu-session-key`。

## 5. 当前验证状态

- Cookie 解析、草稿/发布服务、API、前端页面和批量发布均有单元测试/类型检查。
- 2026-11-22 使用真实简书账号创建了带 HTML 标题、段落和图片的**草稿**，回读确认保存为富文本且图片地址为简书图床，随后删除测试草稿；未发布新的公开文章。
- 简书网页接口并非官方开放 API，改版时可能需要更新 `server/src/jianshu-browser.ts`。
- 线上已存在的旧文章不会自动修复，需要重新生成并发布；截图中的旧文章已被简书转为仅自己可见，和本次 HTML/图片修复是两件事。
