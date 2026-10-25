# 抖音发布

状态：已实现并通过模拟测试，尚未使用真实抖音账号验证扫码、上传及正式发布。

## 成熟方案参考

调研[抖音官方 API](https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/create/create-video)及 [social-auto-upload](https://github.com/dreammis/social-auto-upload/blob/main/uploader/douyin_uploader/main.py)。官方 API 需要申请 video.create 权限并获得用户授权。本版复用项目现有 Playwright 发布体系，参考开源项目的创作者中心入口、二维码与表单定位；未引入其运行时或反检测机制。

正常浏览器交互，不伪装真人或绕过验证。检测到安全验证时停止；用户在官方渠道处理后重新连接。本版未提供远程验证码输入或浏览器接管。

## 使用

1. 在渲染工作台生成、调整并保存抖音排版。
2. 发布管理 → 抖音 → 扫码连接，在抖音 App 确认。
3. 选择排版，上传一个 200 MB 以内 MP4，或按顺序上传 1–35 张图片，每张最多 10 MB。
4. 核对文案与素材，点击发布并确认，查看记录。

标题最多 30 字，正文与话题合计最多 1000 字，不自动截断。图文页面或部分账号可能要求更短标题、封面或额外声明，以平台实际要求为准，表单不一致或按钮不可用会停止提交。素材须在发布页选择上传，不自动从原文推断素材或生成图文卡片。

## 配置与数据

安装 Chrome / Chromium；可设置 DOUYIN_BROWSER_PATH，或复用 WECHAT_BROWSER_PATH / CHROME_BIN。浏览器沙箱配置沿用已有发布模块。

会话按用户使用 AES-256-GCM 加密。独立密钥位于 DATA_DIR/.douyin-session-key，备份数据库时一并保留，禁止提交到仓库。会话过期后重新扫码。断开连接删除本系统保存的会话，不等于撤销平台所有设备的登录。

发布记录按用户隔离，内容与素材字节用于重复提交判定。只有明确成功响应及有效作品 ID 才标记成功；提交超时、响应不明确、运行中服务重启均变为“结果待核实”，不会自动重发。先检查创作者中心，再确认未发布，或填写已发布作品的完整链接。所有待核实任务处理完才能继续发布。

## 验证

运行 npm run typecheck、npm test、npm run build；浏览器模拟验证运行 node scripts/smoke-douyin-publish.mjs，覆盖扫码状态、视频选择、发布确认、待核实任务阻止重发。模拟验证不会发布真实内容，截图位于 artifacts/douyin-ui-check/publish.png。

上线前仍需真实账号联调。平台 DOM、发布响应、账号权限与安全策略可能变化。平台接受提交不等于审核通过。
