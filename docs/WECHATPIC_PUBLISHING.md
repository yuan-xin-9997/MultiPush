# 公众号贴图（图片消息）发布

## 功能定位

微信公众号后台「新的创作 → 贴图」对应官方 API 的图片消息（`draft/add` 的 `article_type: "newspic"`，最多 20 张图、首张即封面，正文仅支持纯文本）。MultiPush 新增独立平台「公众号贴图」：渲染提取正文图片与配文，发布通过公众号官方 API 创建草稿；**正式发表这一步在公众号后台手动完成**（个人主体订阅号自 2025 年 7 月起已被回收 `freepublish` 发布权限，认证企业号/服务号后续可扩展自动发布）。

## 渲染

- 图片：按正文顺序提取最多 20 张，首张即封面；超出 20 张时截断并提示。
- 标题：1–32 字（超长自动截断并提示）。
- 配文：正文纯文本（图片消息正文仅支持纯文本与部分商品标签，上限 2 万字），必填；可在渲染工作台「调整」中编辑标题、配文与话题（话题以 `#标签#` 空格拼接写入文案）。
- 预览：渲染工作台手机壳模拟订阅号消息（标题 + 图片纵向堆叠 + 配文）；发布页提供 iframe 预览与「贴图图片 n/20」缩略图清单。
- 导出：贴图文案 TXT 与结构化 JSON（标题/配文/话题/图片清单）。

## 连接与凭据

- 在公众号后台「设置与开发 → 基本配置」获取 AppID 与 AppSecret，在发布中心「公众号贴图」页连接；AppSecret 用 AES-256-GCM 按用户加密写入 SQLite，密钥在 `DATA_DIR/.wechatpic-session-key`，不返回浏览器、不写日志。
- 连接时通过 `cgi-bin/token` 验证凭证，并尝试 `cgi-bin/account/getaccountbasicinfo` 读取公众号名称（无权限时回退显示 AppID）。
- **IP 白名单**：调用公众号 API 的服务器出口 IP 必须加入「基本配置 → IP 白名单」。未加入时接口返回 409 `wechatpic_ip_not_allowed`，错误信息中包含当前出口 IP，按提示在后台添加后重试。服务器 IP 变化（换网络/换服务器）后需要重新维护白名单。
- AppSecret 重置会使已保存连接失效，系统在下一次调用时标记连接过期，需要重新输入。

## 发布流程

1. 渲染工作台生成「公众号贴图」排版（可调整标题/配文/话题后保存）。
2. 发布中心「公众号贴图」→ 选择内容 → 确认图片清单与配文 → 「保存为贴图草稿」。
3. 服务端逐张上传永久图片素材（`material/add_material?type=image`，仅 JPG/PNG、单张 ≤10 MB），再调用 `draft/add` 创建 `newspic` 草稿，并用 `draft/get` 回读核对标题与图片数量。
4. 状态「草稿已创建，待手动发表」后，到公众号后台「草稿箱」检查并手动发表；发表后微信会自动把该草稿移出草稿箱。

同一公众号、原文、标题、配文与图片内容产生相同幂等标识，重复提交返回已有记录。上传图片失败、微信明确拒绝时标记「失败」；草稿已创建但核对未完成、网络中断或服务重启时标记「结果待核实」——先到后台草稿箱核对，确认后删除该记录即可继续新的提交，系统不会自动重试或重复创建。

## 限制与边界

- 贴图仅支持图片 + 纯文本配文，不支持视频、富文本排版；内容含视频时渲染会提醒，发布直接拒绝。
- 图片仅 JPG/PNG（微信永久素材限制），GIF 需转换格式；单张 ≤10 MB，最多 20 张。
- AI 创作与批量发布暂不支持贴图平台（后续按需扩展）。
- 已认证企业号/服务号如需 API 自动发表（`freepublish/submit`），可在后续版本扩展；当前版本始终止步于草稿。

## API

所有接口都需要 MultiPush Bearer JWT，响应 `Cache-Control: no-store`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/wechatpic/account` | 查询和校验连接状态（TTL 5 分钟内复用缓存） |
| `POST /api/wechatpic/connect` | 提交 `{appId, appSecret}` 验证并加密保存 |
| `DELETE /api/wechatpic/account` | 清除保存的连接（不影响后台已创建草稿） |
| `POST /api/wechatpic/publications` | 提交 `{renderId}`，创建贴图草稿（异步任务，202 返回记录） |
| `GET /api/wechatpic/publications` | 当前用户最近 50 条发布记录 |
| `GET /api/wechatpic/publications/:id` | 查询单条进度与结果 |
| `DELETE /api/wechatpic/publications/:id` | 删除草稿或失败记录：草稿会同步删除后台草稿（已消失时自动清理本地记录）；已发表、处理中和结果待核实记录不可删除 |

业务错误码：`wechatpic_auth_failed`（凭证无效/未连接）、`wechatpic_ip_not_allowed`（IP 白名单）、`wechatpic_unauthorized`（接口无权限）、`wechatpic_rate_limited`（频率限制）、`wechatpic_image_required/type/size/missing`（图片校验）、`wechatpic_title_invalid`、`wechatpic_body_invalid`、`wechatpic_render_stale`（原文已修改）、`wechatpic_result_uncertain`（结果待核实）。

## 实现索引

- 驱动：`server/src/wechatpic-api.ts`（token 缓存、素材上传、newspic 草稿、错误码映射）
- 服务：`server/src/wechatpic.ts`（连接、贴图构造、幂等、状态机、草稿删除）
- 渲染：`server/src/renderers/wechatpic.ts` + `render-adjustment.ts` 贴图分支
- 路由：`server/src/routes/wechatpic.ts`；数据表：`wechatpic_accounts`、`wechatpic_publications`
- 前端：`web/src/features/publish/WechatpicPublishPage.tsx`、`RenderPage.tsx` 贴图场景、`lib/api.ts` `api.wechatpic`
- 测试：`server/test/wechatpic.test.ts`；UI 冒烟：`scripts/smoke-wechatpic-publish.mjs`
