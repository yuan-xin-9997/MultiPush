# 知乎登录与文章发布

在发布中心切换「知乎」，用知乎 App 扫描系统展示的官方二维码并确认登录。也可在渲染工作台的知乎结果中选择「发布到知乎」。当前支持知乎专栏文章，提供保存草稿和正式发布；不向问题自动发回答。

## 登录状态

每个 MultiPush 用户连接一个知乎账号，浏览器 context、登录请求与发布记录按用户隔离。已验证的 Cookie/localStorage 状态使用 AES-256-GCM 加密后写入 `zhihu_accounts`，加密绑定 MultiPush 用户 ID。知乎账号 ID 用于重复提交判断，不能仅用昵称识别账号。

密钥位于 `DATA_DIR/.zhihu-session-key`，与微信公众号的密钥、会话及应用 JWT 密钥分别保存。备份 SQLite 和数据目录时须包含此密钥。重启后可恢复登录；知乎主动令会话失效时，提示重新扫码，不会退出 MultiPush。断开连接删除系统内的会话，不删除知乎草稿和文章。状态查询最多缓存五分钟，实际提交前再次检查登录状态。二维码仅保留五分钟，过期会关闭浏览器 context。

服务器沿用现有 Playwright Chromium 运行库。可设置 `ZHIHU_BROWSER_PATH`，也会使用现有 `WECHAT_BROWSER_PATH` / `CHROME_BIN` 及系统 Chrome/Chromium 路径。无需额外 AppID 或知乎密码。登录初始化立即返回 `202` 和登录请求 ID，浏览器启动、二维码获取及扫码检查在后台执行，轮询接口只读取当前状态，避免慢网页阻塞公网请求。代理网关返回 HTML 错误页时，前端显示简洁的状态提示，并提供重新连接入口；轮询期间的暂时网络错误会继续查询已有登录请求。登录或发布遇到知乎安全验证时显示原因；不自动破解验证码或重放发布请求。

## 正文与核验

- 使用当前用户保存的知乎独立排版；原文已修改或删除时，要求重新生成排版。
- 标题 1–100 字，正文 HTML 最多 1 MB、图片最多 100 张。支持每张最多 10 MB 的 PNG/JPEG/GIF/WebP；封面可选。当前不自动发布视频、音频、iframe 和 SVG。
- 本站图片校验素材归属与实际文件格式；外链图片按公网 DNS 校验、固定解析地址和重定向校验下载，不携带登录凭据、不访问内网；随后将图片二进制上传到知乎。正文最终只接受知乎图片地址。
- 预览使用 `figure` / `figcaption`；提交到知乎草稿接口时转换为图片原生 `data-caption` 字段，去除会被知乎展开为普通段落的 figure 包装，避免重复图注和空段落。保留标题层级、嵌套列表、编号起始值、链接目标、表格单元格及代码空白。
- 保存草稿后，使用 `/api/articles/{id}/draft` 回读未发布草稿；发布成功后，才用 `/api/articles/{id}` 核对已发布文章。按知乎的原生图注字段还原语义后，核对文字、图片数量/地址、列表、图注、链接、标题结构、代码与表格行数。正文不一致时停止正式发布，记录草稿地址供检查。
- 正式发布通过知乎网页编辑器操作，取得平台返回的发布 ID，再核对该 ID 的文章内容和公开状态。接口受理、同名文章或弹窗消失都不作为成功依据。

同一账号、原文、模式、实际标题、排版和本地图片内容参与幂等判断。保存草稿和正式发布分别记录；结果不确定或服务重启中断的任务不自动重试。已知在发布前失败且存在草稿时，用户再次提交会先核对并复用原草稿及图片，不另建草稿；若草稿状态、标题或内容被外部修改则停止，避免覆盖编辑或重复文章。

## API

所有接口均要求 MultiPush Bearer JWT，响应使用 `Cache-Control: no-store`。知乎会话失效返回 `409 zhihu_session_expired`；安全验证返回 `409 zhihu_security_check`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/zhihu/account` | 查询账号状态 |
| `POST /api/zhihu/login` | 获取官方登录二维码 |
| `GET /api/zhihu/login/:id` | 查询扫码/确认状态 |
| `DELETE /api/zhihu/account` | 断开连接 |
| `POST /api/zhihu/publications` | 提交 `{renderId, mode: "draft"或"publish", coverMediaId?}` |
| `GET /api/zhihu/publications` | 当前用户最近 50 条记录 |
| `GET /api/zhihu/publications/:id` | 查询进度、草稿或文章链接 |

## 参考方案与验收

- [Wechatsync 知乎适配器](https://github.com/wechatsync/Wechatsync/blob/v2/packages/core/src/adapters/platforms/zhihu.ts)：账号检测、知乎草稿接口和 HTML 原生格式处理。
- [Bifrost 知乎流量协议说明](https://github.com/bifrost-proxy/bifrost/blob/main/.agents/skills/zhihu-publish/references/traffic-contract.md)：图片 multipart 上传、分步保存草稿、发布响应中的文章 ID。
- [Playwright Authentication](https://playwright.dev/docs/auth)：按账号恢复独立 storageState。

这些网页接口和编辑器没有稳定性承诺，知乎改版后可能需要更新适配。自动化测试使用隔离数据库和合成凭据，不会向真实知乎账号发布文章，覆盖用户隔离、会话加密与重启恢复、原生格式、内容丢失拦截、图片上传、发布结果确认及超时去重。真实验收需扫码连接后用包含图片、图注、嵌套列表、链接、代码与表格的内容新建草稿并检查知乎实际显示，再由用户发起正式发布。

页面交互回归可先运行 `npm run build:web`，再运行 `node scripts/smoke-zhihu-publish.mjs`；该脚本使用独立本地 API fixture，检查扫码状态、草稿/发布按钮、确认弹窗、错误与不确定状态，以及桌面和手机宽度布局，不访问真实知乎账号。

Jenkins 在构建完成后、停止生产服务前运行 `npm run test:publish-ui`，同时验证微信公众号和知乎页面。页面回归失败时不会进入部署阶段；CI 主机需具备现有发布功能所需的 Chrome/Chromium。
