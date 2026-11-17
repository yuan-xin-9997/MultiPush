# 掘金发布说明

> 手机验证码登录：在发布页点击「手机验证码登录」，使用掘金默认的手机验证码登录完成连接；不保存密码。出现安全验证时请改用扫码。

## 1. 能力范围

- 平台：掘金（`https://juejin.cn/`）技术文章。
- 渲染：Markdown 优先的技术文章排版，支持标题层级、引用、代码块、表格、图片和 `figure/figcaption`；同时提供 HTML 下载。
- 发布：连接掘金账号后支持两种模式：
  - **保存草稿**：创建掘金草稿，不公开；
  - **直接发布**：创建草稿并调用掘金发布接口，公开文章。
- 发布记录、重复提交保护、结果待核实与人工核实。

## 2. 登录

- 打开「发布管理 → 掘金」。
- 点击「扫码连接掘金」，使用掘金 App 扫描官方二维码。
- 登录状态加密保存；Cookie `sessionid` 约 30 天有效，失效后重新扫码。

## 3. 分类与标签

- 发布页可选择分类（后端、前端、Android、iOS、人工智能、开发工具、代码人生、阅读）。
- 标签最多 5 个，按名称提交；服务端通过掘金标签搜索接口解析为 `tag_id`。
- 未识别到标签时使用默认技术标签，不会阻塞发布。

## 4. 接口与草稿

使用掘金网页编辑器同源的 Cookie 鉴权接口：

```text
POST https://api.juejin.cn/content_api/v1/article_draft/create
POST https://api.juejin.cn/content_api/v1/article/publish
GET  https://api.juejin.cn/user_api/v1/user/get?aid=2608
POST https://api.juejin.cn/tag_api/v1/query_tag_list
GET  https://api.juejin.cn/tag_api/v1/query_category_briefs
```

- 草稿创建使用 `edit_type: 10`（Markdown）和 `mark_content`。
- 直接发布在草稿创建成功后使用 `draft_id` 调用发布接口。
- 未返回草稿/文章编号时标记为「结果待核实」，不自动重试，避免重复文章。
- 正文图片当前使用 Markdown 中的公网图片地址；不额外走掘金 ImageX 图床上传。若图片无法显示，请在掘金编辑器重新上传。

## 5. 配置

```dotenv
# 可选，未设置时复用 WECHAT_BROWSER_PATH / CHROME_BIN 或自动探测
JUEJIN_BROWSER_PATH=/usr/bin/chromium
```

登录状态密钥：`DATA_DIR/.juejin-session-key`。

## 6. 状态与安全

- 草稿成功：状态 `draft`，记录草稿链接。
- 发布成功：状态 `published`，记录文章链接。
- 风控/安全验证/网络中断：停止操作；无法确认结果时标记 `uncertain`，先到掘金后台核实。
- 不保存掘金密码，只保存浏览器登录状态。

## 7. 当前验证状态

- 掘金登录页二维码抓取已在本地真实浏览器验证通过（二维码可正常显示）。
- 由于没有可用掘金账号，未执行真实草稿创建和发布；首次部署后请用真实账号先保存一篇草稿，再测试直接发布。
- 如果掘金接口改版，`server/src/juejin-browser.ts` 的端点和响应解析需要按实际响应更新。
