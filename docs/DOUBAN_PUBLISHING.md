# 豆瓣日记发布说明

> 手机验证码登录：在发布页点击「手机验证码登录」，使用豆瓣「短信登录／注册」完成连接；不保存密码。出现安全验证时请改用扫码。

## 草稿

豆瓣新版编辑器有「草稿箱」，但 MultiPush 的「保存草稿」仍然只把完整日记快照保存在本地，状态为 `draft`；需要发布时在渲染页复制正文或打开豆瓣编辑器手动完成（自动草稿需要模拟编辑器交互，暂未实现）。


## 1. 能力范围

- 平台：**豆瓣日记**（编辑器为 `https://www.douban.com/topic/create?subtype=note`；旧的 `/note/create` 会跳转到这里），不是豆瓣广播、书评或小组话题。
- 渲染：生成豆瓣日记风格的长文 HTML 与 Markdown，支持标题层级、引用、代码、表格、图片和 `figure/figcaption`。
- 发布：连接豆瓣账号后，可把渲染记录发布为日记；支持：
  - 可见范围：公开 / 仅自己可见；
  - 标签（最多 10 个）；
  - 正文图片自动上传到豆瓣图床，替换外链；
  - 发布记录、重复提交保护、结果待核实时的人工核实；
  - 批量发布（仅直接发布模式）。

## 2. 重要限制（请务必阅读）

豆瓣没有面向第三方的公开写接口，历史上也没有开放 OAuth 写权限。系统采用：

1. 通过豆瓣官方扫码页登录，保存浏览器 `storage_state`（加密存储）；
2. 使用已登录浏览器会话，调用豆瓣网页端当前使用的「话题」接口保存日记（2026-11 实测）：

   | 环节 | 接口 |
   | --- | --- |
   | 图片上传 | `POST https://upload.douban.com/j/group/topic/add_photo`，multipart 字段 `image_file` / `ck` / `primary_color` / `upload_auth_token`（token 从编辑器页面 `__INIT_STATE__` 读取） |
   | 发布日记 | `POST https://m.douban.com/rexxar/api/v2/topic/post`，JSON body 含 `title`、`content`（Draft.js raw state）、`image_ids`、`subtype: "note"`、`accessible: public/private`，请求头 `x-csrf-token` 取 `ck` Cookie |
   | 日记地址 | `https://www.douban.com/topic/<id>/`（旧地址 `/note/<id>/` 会跳转） |

3. 正文图片先上传到豆瓣图床，再把返回的图片 id/URL 写进 Draft.js 正文和 `image_ids`。

这意味着：

- 豆瓣网页改版可能导致发布失败；失败时会保留记录并停止，不会自动重试未知结果。
- 豆瓣可能要求验证码、滑块、短信或安全验证；系统**不会绕过**，会停止并提示到官方页面处理。
- 豆瓣对自动化发布有风控风险。建议控制发布频率（每天不超过 2–5 篇），使用真实登录环境，不要跨地区频繁切换。
- 这是实验性能力；如果发布接口不可用，可使用发布页的「复制 Markdown」「打开豆瓣编辑器」手动完成。

## 3. 环境要求

- 服务器安装 Chrome / Chromium（与公众号、知乎等平台共用）。
- 可选设置 `DOUBAN_BROWSER_PATH` 指向浏览器绝对路径；未设置时自动探测 `WECHAT_BROWSER_PATH`、`CHROME_BIN` 和常见安装路径。
- 登录状态密钥保存在 `DATA_DIR/.douban-session-key`，与豆瓣 Cookie 分离加密。

## 4. 连接与发布

1. 打开「发布管理 → 豆瓣」。
2. 点击「扫码连接豆瓣」，用豆瓣 App 扫描官方二维码并在手机确认。
3. 在渲染工作台生成豆瓣排版；发布页选择该记录。
4. 选择可见范围，填写标签（可选）。
5. 点击「发布到豆瓣日记」，确认后后台执行：
   - 下载正文图片；
   - 上传到豆瓣图床；
   - 保存日记；
   - 回读标题/正文并记录结果。
6. 若状态为「结果待核实」，先到豆瓣日记列表核对，再使用「核实结果」选择：
   - 确认未发布：解除限制，可重新提交；
   - 确认已发布：填写日记链接，标记为已发布。

## 5. 接口与实现位置

| 文件 | 作用 |
| --- | --- |
| `shared/types.ts` | `douban` 平台类型、账号/登录/发布记录类型 |
| `server/src/renderers/douban.ts` | 豆瓣日记渲染器 |
| `server/src/douban-content.ts` | HTML 清洗、日记 ID/URL、回读校验 |
| `server/src/douban-browser.ts` | 扫码登录、图片转存、日记保存、回读 |
| `server/src/douban.ts` | 账号、发布任务、幂等、人工核实 |
| `server/src/routes/douban.ts` | `/api/douban/*` |
| `web/src/features/publish/DoubanPublishPage.tsx` | 豆瓣发布页 |
| `web/src/features/render/RenderPage.tsx` | 豆瓣日记预览与发布入口 |

服务端接口：

```text
GET    /api/douban/account
DELETE /api/douban/account
POST   /api/douban/login
GET    /api/douban/login/:id
GET    /api/douban/publications
GET    /api/douban/publications/:id
POST   /api/douban/publications
POST   /api/douban/publications/:id/resolve
```

发布输入示例：

```json
{
  "renderId": "渲染记录 UUID",
  "privacy": "public",
  "tags": ["读书", "日记"]
}
```

## 记录删除

- 发布页的草稿和失败记录支持「删除记录」。豆瓣的草稿只保存在本系统，删除只清理本地发布记录，不会操作豆瓣日记。
- 已发布、处理中和结果待核实记录不可删除；已发布的日记需要到豆瓣日记页面手动删除。

## 6. 状态与安全

- 登录状态加密保存，重启后复用；断开连接会删除本地会话。
- 发布请求带幂等键；同一账号、同一渲染内容重复提交不会重复创建。
- 出现网络超时、无日记编号、回读不一致等无法确认结果的情况，标记为「结果待核实」，不会自动重试。
- 不记录明文 Cookie、密码、验证码或正文内容到日志。
- 不会绕过豆瓣验证码/安全验证，也不会自动切换账号。

## 7. 故障排查

| 现象 | 处理 |
| --- | --- |
| 无法取得登录二维码 | 确认访问的是 `accounts.douban.com/passport/login?prefer_login_way=qrcode`；driver 使用桌面 UA 并经 Playwright API 代理 `asset.doubanio.com` 静态资源，避免无头 Chrome ORB 拦截。仍失败时检查服务器访问豆瓣 CDN 的网络/代理 |
| 保存失败/接口不可用 | 豆瓣网页接口可能已改版；到发布页使用「复制 Markdown」或「打开豆瓣编辑器」手动发布 |
| 图片上传失败 | 检查图片格式（JPG/PNG/GIF）与大小（≤10 MB）；发布会在上传阶段停止，不会创建残缺日记 |
| 结果待核实 | 先到豆瓣日记列表确认；确认未发布再重新提交，确认已发布则填写链接关联 |
| 登录失效 | 断开后重新扫码；豆瓣 `dbcl2` 会滑动过期，长期不用需重新登录 |

## 8. 当前验证状态

- 渲染器、HTML/Markdown 导出、发布服务、API、前端页面、批量发布均有自动化测试或类型检查。
- 豆瓣登录/保存接口依赖真实账号和豆瓣网络环境，当前开发环境无法访问豆瓣 CDN，未做真实豆瓣草稿/日记的端到端验证；首次部署后请用真实账号按第 4 节验证一次。
- 如果豆瓣保存接口改版，`server/src/douban-browser.ts` 中的 `saveNote` 端点与响应解析需要按实际响应更新。
