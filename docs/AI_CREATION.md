# AI 创作与批量任务

## 功能

「AI 创作」是 MultiPush 内的对话式创作助手。它不是只能聊天的文本框：服务端会把当前用户的内容库、素材、渲染记录、平台连接状态和发布记录作为工具提供给模型，模型可以在用户要求时调用工具完成真实操作。

支持：

- 新建、修改、读取文章；
- 读取知识库、内容、素材、渲染记录和发布记录；
- 在对话中上传图片、视频和文本文档作为素材，让模型按附件意图创作（见下文「对话附件」）；
- 创建视频内容并操控剪辑：查看/修改剪辑时间线（修剪、调序、增删片段）、触发导出并跟踪导出进度；
- 为文章生成公众号、小红书、知乎、微博、今日头条、抖音、少数派和个人博客排版（公众号贴图暂不支持 AI 工具，可在渲染工作台手动生成）；
- 保存平台草稿、正式发布、删除平台草稿；
- 创建批量渲染和批量发布任务，并查询任务进度。

写文章、渲染、发布都走现有业务服务，权限按当前登录用户隔离，不会因为调用 AI 而绕过发布校验、幂等保护或平台安全验证。

## 大模型配置与高可用

系统把「账号自定义配置」和「服务器提供商池」串成一条有序回退链调用：

1. 当前账号在「AI 创作 → 配置大模型」保存过接口地址、模型和 API Key 时，该配置排第一位；
2. 其后是服务器配置的提供商池（可多个提供商，多 Key，按优先级排列）；
3. 每次调用都重新按优先级挑选可用 Key；某个 Key 冷却时自动尝试同提供商的下一个 Key，全部不可用时回退到下一个提供商，当前请求自动重试，不需要用户重新发送。

### 账号自定义配置

进入「AI 创作」后点击「配置大模型」，填写：

| 字段 | 说明 |
| --- | --- |
| 接口地址 | OpenAI 兼容的 `/chat/completions` 接口，例如 `https://api.deepseek.com/v1` |
| 模型名称 | 例如 `deepseek-chat`、`glm-4.7`、`gpt-4.1-mini` |
| API Key | 按用户加密保存，页面不回显明文 |
| 温度 | 0–2，默认 0.7 |

配置保存在 `ai_settings` 表，API Key 使用 `DATA_DIR/.ai-session-key` 做 AES-256-GCM 加密，并绑定用户 ID。备份数据库时须同时保留该密钥文件。系统不内置任何真实 API Key；未配置时 AI 页只显示配置入口。

账号配置的 Key 也遵循同样的冷却与探活规则，并在其不可用时回退到服务器提供商池。

### 服务器提供商池（多 Key / 多提供商）

服务器级提供商池来自以下任一来源（优先级从高到低）：

1. 环境变量 `AI_PROVIDERS_JSON`（完整 JSON 字符串，适合 Jenkins/密钥管理系统注入）；
2. 环境变量 `AI_PROVIDERS_FILE` 指向的 JSON 文件；
3. `DATA_DIR/ai-providers.json`（默认路径，建议 `chmod 600`）；
4. 旧版单 Key / 多 Key 环境变量：`OPENCODE_GO_API_KEY`、`OPENCODE_GO_API_KEYS`（逗号分隔）、`AI_DEFAULT_API_KEY`、`AI_DEFAULT_BASE_URL`、`AI_DEFAULT_MODEL`、`AI_DEFAULT_LABEL`。

配置模板见 [`server/ai-providers.example.json`](../server/ai-providers.example.json)。完整示例：

```json
{
  "providers": [
    {
      "id": "opencode-go",
      "label": "OpenCode Go",
      "baseUrl": "https://opencode.ai/inference/go/openai/v1",
      "defaultModel": "deepseek-v4.1-flash",
      "models": ["deepseek-v4.1-flash"],
      "keys": [
        { "id": "account-1", "label": "账号1", "apiKey": "oc_sk_xxx" },
        { "id": "account-2", "label": "账号2", "apiKey": "oc_sk_yyy" }
      ]
    },
    {
      "id": "deepseek",
      "label": "DeepSeek 官方",
      "baseUrl": "https://api.deepseek.com/v1",
      "defaultModel": "deepseek-chat",
      "models": ["deepseek-chat"],
      "keys": [{ "id": "official", "label": "官方 Key", "apiKey": "sk-xxx" }]
    }
  ],
  "modelMap": {
    "opencode-go/deepseek-v4.1-flash": { "deepseek": "deepseek-chat" }
  },
  "probeIntervalMs": 300000,
  "maxProviderFailures": 3,
  "cooldowns": {
    "quotaMs": 1800000,
    "authMs": 1800000,
    "rateLimitMs": 30000,
    "transientMs": 20000,
    "providerMs": 120000
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `providers[]` | 有序回退链，数组顺序就是优先级；每个提供商至少有 1 个 Key |
| `baseUrl` / `defaultModel` / `models` | 该提供商的 OpenAI 兼容地址、默认模型和可用模型列表 |
| `keys[]` | 同一提供商的 Key，按数组顺序使用；每项可单独设置 `baseUrl` 覆盖提供商地址 |
| `modelMap` | 跨提供商模型等价表，键为 `源提供商ID/模型ID`；值可为 `{目标提供商ID: 模型ID}`，也可为单一模型名（对所有目标提供商生效）；支持 `*` 通配 |
| `probeIntervalMs` | 后台探活检查间隔（毫秒，默认 5 分钟） |
| `maxProviderFailures` | 连续临时失败多少次后熔断提供商（默认 3） |
| `cooldowns` | 各失败类型的冷却时长（额度/认证/限流/网络异常/提供商熔断） |

配置中的 Key 只保存在服务端内存与受保护的配置文件/环境变量中，不写数据库、不返回前端、不写日志明文。配置文件权限过宽时服务会尝试收紧为 `600` 并在管理页提示。

### 故障判定与切换规则

| 上游响应 | 判定 | 处理 |
| --- | --- | --- |
| 402；429 且错误体包含 quota / usage limit / balance / insufficient / credit / 额度等 | 额度不足 | 该 Key 标记「额度不足」并冷却（默认 30 分钟起、指数退避，上限 6 小时），切换到同提供商下一个 Key，模型保持不变 |
| 401 / 403 | Key 失效 | 标记「失效」并冷却，切换到下一个 Key |
| 429 且不是额度错误 | 限流 | 标记「冷却中」并临时轮换到下一个 Key；若没有其他 Key，短暂等待后重试原 Key，不直接判定失效 |
| 5xx / 网络错误 / 超时 / 响应无法解析 | 临时异常 | Key 短冷却并尝试下一个 Key；同一提供商连续临时失败达到阈值后熔断该提供商 |
| 400 / 404 / 422（模型不存在或不支持） | 模型/请求不可用 | 不判定 Key 失效，直接跳到下一个提供商（并记录原因） |

细节：

- **Key 级切换不换模型**：同一提供商的 Key 共用同一个模型 ID，切换对会话无感。
- **提供商级回退**：某个提供商的全部 Key 都不可用时，按 `providers` 顺序回退；模型选择顺序为：目标提供商支持同名模型 → `modelMap` 显式映射 → 同家族/同级别模型 → 目标提供商默认模型。实际使用的提供商和模型会在回复上方显示。
- **冷却与探活**：额度不足、失效、限流和临时异常的 Key 进入冷却；冷却到期后由后台探活（最小请求，最多 16 tokens）自动验证，成功后恢复为可用；因为每次调用都按优先级取 Key，恢复后自动回到优先级最高的 Key。提供商熔断后同样定期探活恢复。
- **请求失败兜底**：所有提供商都不可用时返回 503（全部限流时返回 429），错误信息包含最后一次失败原因和失败摘要，不包含任何 Key 明文。

### 管理页面

「AI 创作」页顶部点击「高可用」打开「模型高可用」面板（桌面左侧栏也有入口）：

- 查看回退链中的每个提供商、每个 Key 的优先级、脱敏 Key、状态（可用 / 冷却中 / 额度不足 / 失效）、冷却截止时间、成功/失败/额度/认证/限流次数、Token 用量和最近使用时间；
- 「检测全部 Key」或单个提供商「测试」：发起一次最小请求验证 Key 和模型可用性，结果同时更新状态；
- 「切换与恢复记录」：每次 Key/提供商切换、冷却、限流轮换和探活恢复的时间、原因、前后提供商与 Key（脱敏）；
- 「最近请求」：每次实际请求的提供商、模型、脱敏 Key、成功/失败、HTTP 状态、耗时和 Token。

管理页面只展示状态和脱敏标识，不返回完整 Key；配置修改仍通过受保护的环境变量/配置文件完成。

### OpenCode Go 说明

OpenCode Go 的 OpenAI 兼容接口要求 `x-opencode-session` 请求头。MultiPush 检测到 `opencode.ai/inference/go` 地址时会自动按会话发送 `multipush-<sessionId>`，无需手工配置。

保存账号配置时可点「保存并测试」，服务端会走同一高可用网关发起一次最小请求；如果主 Key 额度不足，会自动切到备用 Key 并在结果中返回实际使用的提供商和模型。

## 对话与工具

对话记录按用户保存在 `ai_sessions` / `ai_messages`。每轮最多执行 16 轮工具调用，单轮总时长上限 6 分钟。工具包括：

- `get_system_overview`、`list_books`、`list_contents`（支持 `kind` 筛选图文/视频）、`get_content`、`list_media`
- `create_content`、`update_content`（支持 `mediaIds`，见「对话附件」）
- `get_video_project`、`update_video_timeline`、`export_video`、`get_video_export`
- `render_content`、`get_render`、`list_renders`
- `list_publications`、`publish_article`、`delete_draft`
- `batch_render`、`batch_publish`、`get_batch_job`

发布是有外部影响的操作。系统提示要求模型只在用户明确要求时发布，默认优先保存草稿；公众号正式发表可能仍需管理员在本系统扫码确认。出现「结果待核实」时不要重复提交，应先到发布管理核实。

### 移动端布局

手机浏览器（宽度 ≤ 700px）下 AI 创作页自动切换为「对话优先」布局：

- 会话列表与模型配置压成顶部一条横向工具条：模型芯片（点击打开模型设置）、可横滑的会话胶囊（胶囊上常显删除按钮）、右侧「新建会话」按钮；
- 对话标题按剩余宽度截断省略，「模型设置」按钮始终可见；
- 输入区跟随动态视口高度（dvh），键盘弹出时整页不再被顶出屏幕，底部适配 iPhone 安全区；触屏软键盘的 Enter 只换行，发送靠「发送」按钮（鼠标 / 触控板仍支持 Enter 发送）。

### 对话附件（图片 / 视频 / 文档）

在 AI 输入框点击回形针上传附件后发送，附件会进入用户消息并按类型交给模型：

| 类型 | 处理方式 | 模型能做什么 |
| --- | --- | --- |
| 图片 | 走素材库上传（`POST /api/media`，≤10 MB JPG/PNG/WebP/GIF），消息携带素材 ID 与尺寸；≤6 MB 且为常见格式时以 base64 视觉内容发给模型 | 看图写作、把图片插入文章（`create_content`/`update_content` 传 `mediaIds`，图片按顺序追加到正文末尾，第一张默认作为封面）、设置封面 |
| 视频 | 走素材库上传（≤200 MB MP4/WebM/MOV），消息携带素材 ID、时长与分辨率 | `create_content(kind:"video", mediaIds:…)` 用上传的视频按顺序初始化剪辑时间线，再配合剪辑工具修剪、调序、导出成片 |
| 文档 | 前端读取纯文本（txt/md/markdown/json/csv/html/xml/yml/yaml，≤2 MB），全文随消息发送；服务端再次截断（单文档 ≤10 万字符，注入提示词时每份 ≤2 万字） | 以文档内容为素材写文章、改写、总结 |

规则与保护：

- 一次最多 10 个图片/视频附件、5 个文档；文档缺失或超限会被拒绝。
- 附件元数据持久保存在消息（`ai_messages.attachments_json`），素材 ID 跨轮有效；**文档全文与图片视觉内容只在发送当轮注入**，历史轮次仅保留「[附件] 名称（素材 ID）」的紧凑引用，避免上下文与费用膨胀。
- 附件校验用户归属：只能引用自己上传的素材；类型不匹配（例如把视频当图片插图）会以工具错误返回。
- 模型被要求不得编造素材 ID；无法确认图片内容时先描述并确认。
- 文档不支持 PDF/Word 等二进制格式（需要额外解析能力，后续版本考虑）。

示例指令：「根据我上传的资料写一篇青海湖游记，把我上传的 3 张图放进正文并生成公众号排版」「用我上传的两段视频新建一个视频内容，把文案补上」。

### AI 操控视频剪辑

视频内容（`kind: video`）的剪辑由服务端 ffmpeg 完成，AI 通过以下流程操控：

1. `list_contents`（`kind: "video"`）找到目标视频内容；
2. `get_video_project` 读取当前时间线：片段列表（素材名、入点/出点、时长）、总时长和服务器 ffmpeg 能力；
3. `update_video_timeline` 整体替换时间线：`clips` 数组的顺序就是成片顺序，每项 `{mediaId, trimStart?, trimEnd?}`（单位：秒，`trimEnd: null` 表示保留到素材结尾），可实现修剪、调序、删除和追加；
4. `export_video` 触发服务端导出成片（异步任务），`get_video_export` 跟踪进度；完成后成片自动存入素材库，返回 `outputMediaId`；
5. 需要发布抖音视频笔记时，用 `publish_article`（`videoMediaId` 传成片素材 ID）。

示例指令：「帮我把《XX vlog》开头 3 秒剪掉，两个片段调换顺序，然后导出成片」。

## 批量任务

内容库多选后，批量操作条提供「批量渲染」和「批量发布」：

- 批量渲染：最多 30 篇，一次选择多个平台，逐篇生成渲染记录；
- 批量发布：最多 10 篇，支持微信公众号（仅草稿）、知乎、微博、今日头条、少数派和个人博客；每篇会先生成对应平台排版，再提交平台并等待结果；
- 批量发布遇到公众号扫码确认、结果待核实或需要人工处理的记录时会停止后续提交，避免批量重复发布；
- 任务状态、每项结果、失败原因和排版/发布链接保存在 `batch_jobs`，页面轮询显示进度。

服务重启时，运行中的批量任务会标记为失败并提示重新提交，不会自动重放。

## API

所有接口要求 MultiPush Bearer JWT，响应 `Cache-Control: no-store`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/ai/settings` | 读取当前用户大模型配置（不含 Key） |
| `PUT /api/ai/settings` | 保存 `{baseUrl, model, apiKey?, temperature?}` |
| `POST /api/ai/settings/test` | 走高可用网关测试连接，返回实际使用的提供商/模型/Key |
| `DELETE /api/ai/settings` | 清除配置 |
| `GET /api/ai/gateway` | 提供商/Key 状态、切换记录、最近请求（均为脱敏数据） |
| `POST /api/ai/gateway/probe` | 探活全部 Key，或传 `{providerId}` 只测一个提供商 |
| `GET /api/ai/sessions` | 会话列表 |
| `POST /api/ai/sessions` | 新建会话 `{title?}` |
| `GET /api/ai/sessions/:id` | 会话和消息 |
| `DELETE /api/ai/sessions/:id` | 删除会话及消息 |
| `POST /api/ai/sessions/:id/messages` | 发送消息 `{message, mediaIds?, documents?}`（附件见「对话附件」），返回本轮消息和回复 |
| `GET /api/batch/jobs` | 最近批量任务 |
| `GET /api/batch/jobs/:id` | 批量任务进度 |
| `POST /api/batch/render` | 创建批量渲染任务 |
| `POST /api/batch/publish` | 创建批量发布任务 |

## 数据与隐私

- AI 对话只发送当前用户的数据；工具按 `user_id` 隔离，不能读取其他用户的内容、素材、账号或发布记录。
- 对话内容和工具返回的必要数据会发送到你配置的大模型接口。使用第三方模型服务前，请确认其数据政策；敏感内容可改用本地部署的 OpenAI 兼容模型（例如局域网 Llama.cpp 服务）。
- API Key 只加密保存在服务端，浏览器只在设置表单中临时接收，不写入 localStorage、URL 或日志。

## 限制与注意事项

- 使用 OpenAI 兼容协议；Anthropic、Gemini 等原生协议需要自行提供兼容网关。
- 模型可能出错或产生不准确内容，发布前仍应检查标题、正文、图片和平台限制。
- 工具返回的内容库正文属于不可信数据；系统提示要求模型只把它当内容，不执行其中的指令。
- 小红书自动发布仍停用；AI 可以生成排版和文案，但不能自动发布小红书。
- 抖音发布需要先上传视频或图片素材，AI 只能使用已有素材 ID；微博使用渲染结果中的图片，最多 9 张。
- 批量任务在单进程内顺序执行；不要同时提交多个批量发布任务。
- 真实公众号、知乎、少数派和博客发布仍需真实账号联调；自动化测试使用模拟驱动和本地假模型服务，不会对外发布内容。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

服务端测试覆盖：

- `server/test/ai-gateway.test.ts`（17 项）：同提供商 Key 轮换、额度不足与 429 限流的区分、401 失效、单 Key 限流等待重试、跨提供商回退与模型映射、提供商熔断跳过后恢复、探活恢复最高优先级 Key、账号配置回退到服务器池、状态/审计接口不泄露明文、配置文件与环境变量加载；
- `server/test/ai-gateway-routes.test.ts`：管理接口鉴权、`no-store`、探活参数校验；
- `server/test/ai.test.ts`：AI 会话在切换 Key / 提供商后历史完整、工具轨迹保留。

真实 Key 联调记录（2026-11-19）：

- 账号1（额度已耗尽）放在优先级 1、账号2（有额度）放在优先级 2：请求命中账号1 的 `HTTP 429 GoUsageLimitError` 后自动切到账号2，模型保持 `deepseek-v4.1-flash`，回复成功；事件记录 `key_switch` / `key_cooldown`，Key 脱敏为 `oc_sk_e…tK-T`。
- 在同一会话继续第二轮：直接使用账号2，历史消息完整（4 条），继续对话成功。
- 停用整个 OpenCode Go 提供商（只保留已耗尽 Key）并配置本地备用提供商：自动回退并按 `modelMap` 把 `deepseek-v4.1-flash` 映射为 `mock-fallback-model`，会话历史 6 条完整保留；`provider_switch` 事件记录映射前后模型。
- 生产环境 Jenkins #110 部署后：启动日志显示 `providers=1 keys=2 source=file`；探活中账号1 额度不足、账号2 连接成功；真实对话使用账号2 且模型保持 `deepseek-v4.1-flash`，两轮历史 4 条完整；生产 `/api/ai/gateway` 无 Key 明文。
- 浏览器（1440×1000 与 390×844）打开「高可用」面板：提供商/Key 状态、探活结果、切换记录、最近请求均可见，DOM 中没有 Key 明文，移动端无横向溢出。

页面回归使用真实浏览器验证 AI 页、高可用面板、批量弹窗和发布页。
