# V2EX 渲染与发布

## 功能边界

V2EX 没有提供官方发帖 / 发布主题的写 API（API 2.0 只提供读取主题、回复、节点等接口）。MultiPush 的 V2EX 发布采用：

1. **渲染**：生成 V2EX 支持的 Markdown 主题正文（标题单独填写），并输出 HTML / Markdown / JSON 下载；
2. **发布**：用户复制已登录 V2EX 浏览器的 Cookie，服务端用隔离 Chrome 打开 `https://www.v2ex.com/new`，选择节点、填写标题和 Markdown，点击 V2EX 页面自身的发布按钮，创建公开主题；
3. **兜底**：发布页始终提供「复制标题」「复制 Markdown」「打开发帖页」，可以在浏览器自动发布不可用时手动完成。

V2EX 没有草稿模式，主题一旦发布就立即公开。发布前请确认标题、节点、Markdown 和图片。

## 渲染规则

- 标题：1–120 个字符；渲染时超长会截断并给出提示。
- 正文：Markdown，最多 20000 个字符（V2EX 前端按 JavaScript 字符长度校验）。
- 图片：使用绝对 URL 的 Markdown 图片语法；图片必须能被 V2EX 访问。
- 视频：V2EX 主题不支持视频，渲染时会移除视频并给出警告。
- 表格：V2EX Markdown 不保证支持表格，渲染会提示发布前检查。
- 输出：HTML 预览、Markdown 下载、JSON 下载。

## 连接 V2EX

V2EX 登录包含验证码，无法稳定地用账号密码自动登录，因此使用 Cookie：

1. 在浏览器打开 `https://www.v2ex.com/` 并登录；
2. F12 → Network → 任意请求 → Request Headers → Cookie；
3. 复制完整 Cookie，粘贴到「发布管理 → V2EX → 连接 V2EX」；
4. 服务端会打开 `/new` 验证登录态，成功后加密保存浏览器会话。

Cookie 只加密保存到当前 MultiPush 账号（`DATA_DIR/.v2ex-session-key`），不要分享给他人。退出 V2EX 或 Cookie 过期后需要重新连接。

## 服务器网络与代理

V2EX 在中国大陆服务器上经常无法直连。浏览器访问 V2EX 需要通过可访问 V2EX 的代理：

```bash
V2EX_BROWSER_PATH=/usr/bin/chromium
V2EX_PROXY_SERVER=http://192.168.0.100:7890
```

- `V2EX_BROWSER_PATH`：Chrome / Chromium 绝对路径；未设置时自动探测。
- `V2EX_PROXY_SERVER`：仅用于 V2EX 的浏览器代理，支持 `http://host:port`；不配置时直连。
- 修改 `/opt/MultiPush/.env` 后重启 `multipush.service`。

无法访问 V2EX 时，发布页返回「无法访问 V2EX，请检查服务器网络……」；不会伪造发布成功。素材库和渲染功能不需要访问 V2EX。

## 发布流程

1. 在渲染工作台生成 V2EX 排版（`/render`）。
2. 打开「发布管理 → V2EX」，选择该排版。
3. 选择节点（连接后会尝试从 `/new` 读取节点列表；否则显示常用节点；也可以选择后手动核对）。
4. 点击「发布到 V2EX」，确认公开主题。
5. 服务端打开 V2EX 发帖页，设置 Markdown 语法、标题、节点、正文，提交并等待跳转到 `/t/<id>`。
6. 成功后记录主题链接、主题编号和发布时间。

### 发布结果状态

- `处理中`：浏览器操作进行中；
- `已发布`：已跳转到 `https://www.v2ex.com/t/<id>`；
- `失败`：提交前失败（节点无效、网络错误、页面结构变化等），可删除记录后重试；
- `结果待核实`：点击提交后未得到明确结果（网络中断、页面异常、反刷屏/验证拦截等）。请先到 V2EX 个人主页/节点确认，**不要重复发布**，然后在记录中：
  - 「重新自动核实」：重新打开主题链接检查；
  - 「我已核实，已发布」：填写主题链接并关联；
  - 「我已核实，未发布」：解除限制后允许重新提交。

V2EX 主题没有草稿，所以发布记录不提供「保存草稿」；已经发布的主题不可通过本系统删除，也无法自动下架，需要到 V2EX 处理。

## 浏览器兼容与失败提示

发布驱动使用 V2EX 发帖页的公开结构：

- `#topic_title`：标题；
- `#nodes` / `select[name="node_name"]`：节点；
- `#select_syntax` 或 `syntax=1`：Markdown 语法；
- CodeMirror 编辑器 / `#topic_content`：正文；
- `window.publishTopic()` / `#compose`：提交。

V2EX 页面结构变化、反自动化、验证码或 Anti Flood 限制都可能导致失败；失败时会保留记录和错误原因，不会静默重复提交。首次使用建议先发一个测试主题验证账号、节点和代理配置。

## 限制

- V2EX 没有官方写 API，也不是扫码/手机验证码登录，必须使用 Cookie。
- 不支持视频、草稿、定时发布。
- 表格、复杂 HTML 的 Markdown 兼容性以 V2EX 实际预览为准。
- 不支持批量发布；如需批量，先生成 Markdown 后手动发布。
- 当前实现未使用真实 V2EX 账号做端到端发布验收；首次使用请用测试主题确认。
