# 简书发布说明

> 用户需求中的“简体书”按 **简书**（`jianshu.com`）实现。

## 1. 能力范围

- 渲染：简书 Markdown 长文排版，支持标题层级、引用、代码、表格、图片和 `figure/figcaption`；同时提供 HTML 下载。
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
GET  /author/notebooks                 读取文集（默认使用第一个）
POST /author/notes                     创建草稿 { at_bottom, notebook_id, title }
PUT  /author/notes/:id                 保存正文 { autosave_control, content, id, title }
POST /author/notes/:id/publicize       公开发布
GET  /p/{slug}                         核对公开文章
```

- `content` 使用 Markdown。
- 正文图片当前使用 Markdown 中的公网图片地址；简书编辑器如未加载外链图片，请在简书编辑器中重新上传。
- 简书非会员每天公开文章数量有限；平台返回「每天只能发布」时会显示原文并停止，不会自动重试。
- 未返回公开地址时标记「结果待核实」，先到简书后台核实。

## 4. 配置

```dotenv
# 可选，未设置时复用 WECHAT_BROWSER_PATH / CHROME_BIN 或自动探测
JIANSHU_BROWSER_PATH=/usr/bin/chromium
```

登录状态密钥：`DATA_DIR/.jianshu-session-key`。

## 5. 当前验证状态

- Cookie 解析、草稿/发布服务、API、前端页面和批量发布均有单元测试/类型检查。
- 当前环境没有简书账号 Cookie，未执行真实简书草稿和发布验证；首次部署后请用真实 Cookie 先保存草稿，再测试发布。
- 简书网页接口并非官方开放 API，改版时可能需要更新 `server/src/jianshu-browser.ts`。
