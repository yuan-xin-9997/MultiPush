# 微信公众号登录与发布

## 使用与运行要求

公众号账号必须具有后台图文编辑和发表权限。无需提供公众号密码、AppID 或 AppSecret；系统使用独立的无头浏览器打开官方后台，管理员在本系统展示的官方二维码上扫码并在手机上选定账号。

开发环境会探测本机 Chrome、Edge、Chromium，也可在 `.env` 设置 `WECHAT_BROWSER_PATH`。生产服务器应安装 Chrome / Chromium，并在 `/opt/MultiPush/.env` 配置可执行文件路径，例如 `/usr/bin/google-chrome`。不要指定自己的日常浏览器 profile，系统会建立隔离的临时浏览器 context。

也可使用 `npx playwright-core install chromium` 安装与依赖匹配的浏览器；systemd 的 `ProtectHome=true` 会隐藏用户缓存，因此生产应将浏览器安装在服务可读的目录，并设置 `WECHAT_BROWSER_PATH`。Ubuntu 需要安装浏览器所需系统运行库。浏览器默认启用沙箱；仅在受控容器无法运行沙箱时才设置 `WECHAT_BROWSER_NO_SANDBOX=1`。

后端构建将 `playwright-core` 保留为运行时依赖。`JenkinsConfig/deploy.sh` 会单独同步该包到 `/opt/MultiPush/node_modules/playwright-core`，其他后端依赖继续打包进 `server/dist/index.js`。浏览器可执行程序需由管理员准备，CI 不自动安装系统软件。

## 登录状态与数据

每个 MultiPush 用户连接一个公众号，浏览器 context、会话与发布记录均按用户隔离。扫码成功后，Playwright 的 cookies/localStorage 状态用 AES-256-GCM 加密后写入 SQLite；加密绑定用户 ID，密钥位于 `DATA_DIR/.wechat-session-key`，独立于 JWT 密钥。API 不返回 Cookie、token 或完整浏览器状态。

必须一起备份 SQLite、上传目录、`.jwt-secret` 和 `.wechat-session-key`。丢失公众号会话密钥需要重新扫码。二维码只存于内存，不写日志或数据库。登录请求五分钟后释放浏览器 context；登录中断或服务重启后可重新获取。

账号状态查询最多缓存五分钟，实际发布前重新校验会话并保存更新后的状态。微信可以主动使会话失效，系统不能承诺永久免扫码。断开连接清除本系统的会话和登录请求；不会删除微信上的草稿或文章。

## 内容与发表

使用服务端保存的平台独立调整结果，标题 1–64 字、作者最多 8 字、摘要最多 120 字；原文已修改或删除时阻止发布旧版本。封面必填，素材需属于当前用户。上传图片支持 JPG、PNG、GIF，每张最多 10 MB；正文最多 100 张图片、HTML 最多 1 MB。包含视频、音频或 iframe 的结果需先处理后再发布。

正文中的本系统上传图片会逐张上传到微信 CDN 并改写地址，已有微信 CDN 图片可保留。公网 HTTP(S) 外链图片及内嵌的 PNG/JPEG/GIF 会自动读取、校验格式并上传到微信；每张最多 10 MB，下载最多 20 秒、3 次重定向。外链下载不携带账号凭据，校验并固定 DNS 解析地址，每次重定向重新校验，禁止访问内网。本站上传图片仍校验素材归属。上传后同时写入微信素材 ID、格式及 `data-src` 等原生编辑器字段，避免手机草稿只有空白。

新生成排版及历史排版的提交都会清理列表项之间的空白节点、空列表项，并将图片与图注的边距合并为单个 `margin` 声明，避免微信编辑器生成多余圆点或叠加出空行。此处理直接进入系统流程，保存草稿和正式发表共用，无需逐篇修补微信草稿。

「保存草稿」调用后台素材及草稿接口，并取得草稿 ID；「正式发表」继续操作官方编辑器。发表会明确关闭群发通知；如果后台结构变化，无法确认通知状态，会停止操作并保留草稿。安全校验由管理员在本系统显示的二维码上完成。最终按微信发表记录中的草稿关联 ID 和文章永久链接核实，不用标题、弹窗消失或接口受理作为成功依据。

正文外部超链接受公众号权限限制。提交时读取微信编辑器的外链权限；无权限或无法识别权限时，将外链转换为“原文字（完整地址）”，保留图片和文字格式，避免微信过滤链接后地址丢失。微信文章链接和目录锚点保持原样；有外链权限的账号保留可点击链接。发布表单可另填一个 HTTP(S)「阅读原文链接」，通过微信的 `sourceurl0` 保存，读者可在文章底部打开。

同一公众号、原文、模式、实际排版、作者、摘要和封面产生相同幂等标识，重复请求返回已有任务。网络中断、服务重启、提交结果无法确认时标记「结果待核实」，不自动重发。草稿与正式发表有不同幂等标识，保存草稿后仍可提交正式发表。

## API

所有接口都需要 MultiPush Bearer JWT，响应 `Cache-Control: no-store`。公众号会话过期使用业务错误 `409 wechat_session_expired`，不退出 MultiPush 登录。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/wechat/account` | 查询和校验账号状态 |
| `POST /api/wechat/login` | 获取官方登录二维码 |
| `GET /api/wechat/login/:id` | 查询扫码结果 |
| `DELETE /api/wechat/account` | 清除保存的会话 |
| `POST /api/wechat/publications` | 提交 `{renderId, mode: "draft"或"publish", coverMediaId, author?, digest?, sourceUrl?}` |
| `GET /api/wechat/publications` | 当前用户最近 50 条发布记录 |
| `GET /api/wechat/publications/:id` | 查询进度、安全二维码与最终链接 |

## 参考实现与维护

回归检查运行 `npm test` 和 `npm run typecheck`，覆盖外链图片下载及校验、上传素材字段、列表空项目、历史边距规范化、外链权限降级和阅读原文参数传递。线上验收应通过正常 `/api/wechat/publications` 的 `draft` 模式新建草稿，再回读微信保存的正文，核对图片素材 ID、图片地址可访问、列表、图注及网址；修改已有草稿不能替代这项验收。微信可能移除 `src` 并保留 `data-src` 作为图片地址，回读时应按微信实际存储格式核对。手机显示和正式发表的扫码流程需另行验证。

- [Playwright Authentication](https://playwright.dev/docs/auth)：隔离 context 与 storageState 恢复。
- [Wechatsync 微信驱动](https://github.com/wechatsync/Wechatsync/blob/master/packages/@wechatsync/drivers/src/weixin.js)：后台素材与草稿接口。
- [Easel 会话式上传](https://github.com/ZJU-REAL/Easel/blob/main/skills/shared/scripts/weixin_mp_stats.py)：ticket、图片上传和草稿表单。
- [maxiaoer 公众号驱动](https://github.com/siaikin/maxiaoer/blob/main/src/main/platforms/wechat-mp.ts)：官方编辑器发表流程。
- [mpdt 发表记录样例](https://github.com/ttxs69/mpdt/blob/main/tests/fixtures/publish_list.json)：草稿 ID 与发表 ID 的关联。

上述网页后台接口与选择器没有公开稳定性承诺，微信改版时需要更新驱动。上线验收须用有权限的真实公众号完成扫码、服务重启后恢复、图片草稿、正式发表及安全验证；本地自动化测试使用隔离数据和模拟驱动，不会向真实粉丝发表文章。
