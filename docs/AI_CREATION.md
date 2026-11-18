# AI 创作与批量任务

## 功能

「AI 创作」是 MultiPush 内的对话式创作助手。它不是只能聊天的文本框：服务端会把当前用户的内容库、素材、渲染记录、平台连接状态和发布记录作为工具提供给模型，模型可以在用户要求时调用工具完成真实操作。

支持：

- 新建、修改、读取文章；
- 读取知识库、内容、素材、渲染记录和发布记录；
- 创建视频内容并操控剪辑：查看/修改剪辑时间线（修剪、调序、增删片段）、触发导出并跟踪导出进度；
- 为文章生成公众号、小红书、知乎、微博、今日头条、抖音、少数派和个人博客排版（公众号贴图暂不支持 AI 工具，可在渲染工作台手动生成）；
- 保存平台草稿、正式发布、删除平台草稿；
- 创建批量渲染和批量发布任务，并查询任务进度。

写文章、渲染、发布都走现有业务服务，权限按当前登录用户隔离，不会因为调用 AI 而绕过发布校验、幂等保护或平台安全验证。

## 大模型配置

进入「AI 创作」后点击「配置大模型」，填写：

| 字段 | 说明 |
| --- | --- |
| 接口地址 | OpenAI 兼容的 `/chat/completions` 接口，例如 `https://api.deepseek.com/v1` |
| 模型名称 | 例如 `deepseek-chat`、`glm-4.7`、`gpt-4.1-mini` |
| API Key | 按用户加密保存，页面不回显明文 |
| 温度 | 0–2，默认 0.7 |

配置保存在 `ai_settings` 表，API Key 使用 `DATA_DIR/.ai-session-key` 做 AES-256-GCM 加密，并绑定用户 ID。备份数据库时须同时保留该密钥文件。系统不内置任何真实 API Key；未配置时 AI 页只显示配置入口。

### 服务器默认配置（OpenCode Go）

部署环境可以提供一套默认模型，未单独保存 AI 设置的用户会直接使用它：

```dotenv
OPENCODE_GO_API_KEY=oc_sk_xxx
AI_DEFAULT_BASE_URL=https://opencode.ai/inference/go/openai/v1
AI_DEFAULT_MODEL=deepseek-v4.1-flash
AI_DEFAULT_LABEL=OpenCode Go
```

也可以使用通用变量 `AI_DEFAULT_API_KEY` 代替 `OPENCODE_GO_API_KEY`。只要地址、模型和 Key 都存在，AI 页会显示「OpenCode Go」并使用服务器默认 Key，页面不会返回明文。用户在设置里保存自己的配置后，会优先使用账号配置；之后修改服务器 Key 不会覆盖已保存的账号配置。

OpenCode Go 的 OpenAI 兼容接口要求 `x-opencode-session` 请求头。MultiPush 检测到 `opencode.ai/inference/go` 地址时会自动按会话发送 `multipush-<sessionId>`，无需手工配置。

保存时可点「保存并测试」，服务端会发起一次最小请求验证地址、模型和 Key。部分只支持特定参数或非标准 OpenAI 协议的供应商可能无法使用，以实际返回为准。

## 对话与工具

对话记录按用户保存在 `ai_sessions` / `ai_messages`。每轮最多执行 8 轮工具调用，单轮总时长上限 6 分钟。工具包括：

- `get_system_overview`、`list_books`、`list_contents`（支持 `kind` 筛选图文/视频）、`get_content`、`list_media`
- `create_content`、`update_content`
- `get_video_project`、`update_video_timeline`、`export_video`、`get_video_export`
- `render_content`、`get_render`、`list_renders`
- `list_publications`、`publish_article`、`delete_draft`
- `batch_render`、`batch_publish`、`get_batch_job`

发布是有外部影响的操作。系统提示要求模型只在用户明确要求时发布，默认优先保存草稿；公众号正式发表可能仍需管理员在本系统扫码确认。出现「结果待核实」时不要重复提交，应先到发布管理核实。

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
| `POST /api/ai/settings/test` | 保存后测试连接 |
| `DELETE /api/ai/settings` | 清除配置 |
| `GET /api/ai/sessions` | 会话列表 |
| `POST /api/ai/sessions` | 新建会话 `{title?}` |
| `GET /api/ai/sessions/:id` | 会话和消息 |
| `DELETE /api/ai/sessions/:id` | 删除会话及消息 |
| `POST /api/ai/sessions/:id/messages` | 发送消息 `{message}`，返回本轮消息和回复 |
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

服务端测试覆盖大模型配置加密、工具调用链、文章创建/渲染/发布、批量渲染和批量发布等待逻辑；页面回归使用真实浏览器验证 AI 页、批量弹窗和发布页。
