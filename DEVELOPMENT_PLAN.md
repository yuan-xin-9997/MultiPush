# TurboPushForked 桌面端开发计划

> 2026-09-06 已开始阶段0。具体代码、已验证范围和未完成项见 [实施进度](docs/IMPLEMENTATION_STATUS.md)。Windows开发壳、本地任务链路和知乎纯文本草稿已验证；尚不支持公开发布，四个平台Spike的M0里程碑仍未全部完成。

## 1. 项目目标

从零实现一个代码独立、可本地运行、可审计的多平台内容发布桌面端，不复制或逆向 TurboPush 私有代码。

核心闭环：

> 创建或导入内容 → 选择多个平台与账号 → 按平台调整内容 → 批量或定时发布 → 查看结果、失败原因与诊断信息

首批支持以下平台：

| 平台 | 图文/文章 | 视频 | 首批优先级 |
| --- | --- | --- | --- |
| 微信公众号 | 文章 | 暂不支持 | P0 |
| 知乎 | 文章；回答后续增加 | 视频后续评估 | P0 |
| 小红书 | 图文 | 视频 | P0 |
| 抖音 | 图文 | 视频 | P0 |
| B站 | 暂不支持专栏 | 视频 | P1 |
| 微信视频号 | 暂不支持图文 | 视频 | P1 |
| 今日头条 | 图文/文章 | 视频 | P1 |
| 百家号 | 图文/文章 | 视频 | P1 |

第二批候选平台：微博、快手、CSDN、掘金、YouTube、TikTok。

## 2. MVP范围

MVP必须包含：

- Windows桌面客户端。
- 多平台、多账号登录与登录状态检测。
- Markdown/HTML文章、图文和视频三类统一内容模型。
- 微信公众号文章保存草稿，支持封面、摘要、作者和原创声明等必要参数。
- 知乎文章发布或保存草稿，支持标题、正文、话题等参数。
- 小红书图文发布和抖音视频发布。
- 一份内容生成多个平台任务。
- 批量任务、定时任务、失败重试和应用重启恢复。
- 平台级内容覆盖，例如为小红书单独修改标题和标签。
- 发布日志、失败截图及人工接管浏览器。
- Cookie和浏览器用户数据只保存在本地。

MVP明确不做：

- 云端账号同步和团队权限。
- 代理池、验证码破解或设备指纹伪造。
- AI写作、AI配图和数据分析。
- 手机客户端和插件市场。
- 所有平台完全无人值守。

## 3. 技术架构

```text
Tauri 2 + React/TypeScript 桌面界面
                  │
                  │ Tauri command / 本地IPC
                  ▼
Node.js Sidecar 发布引擎
                  │
                  ├── Playwright有头浏览器自动化
                  ├── 平台Publisher适配器
                  ├── SQLite持久化任务队列
                  ├── 定时调度与重试
                  └── 日志、截图和诊断信息

SQLite数据库                 本地数据目录
├── accounts                 ├── browser-profiles
├── contents                 ├── assets
├── campaigns                ├── screenshots
├── publish_tasks            └── logs
└── publish_attempts
```

### 3.1 技术选型

- 桌面框架：Tauri 2。
- 前端：React、TypeScript、Vite。
- UI：Ant Design或shadcn/ui，技术验证阶段二选一。
- 自动化：Node.js、Playwright。
- 数据库：SQLite、Drizzle ORM。
- 数据校验：Zod。
- 日志：Pino。
- 密钥保护：操作系统Keychain；必要时使用Keychain密钥加密本地敏感数据。
- 工作区：pnpm workspace。
- 构建发布：GitHub Actions、Tauri Bundler。

Node Sidecar负责浏览器自动化，Rust/Tauri只负责桌面能力和进程生命周期。这样可以降低平台页面变化时的维护成本。

## 4. 核心领域模型

### 4.1 内容模型

```ts
type ContentType = "article" | "gallery" | "video";

interface Content {
  id: string;
  type: ContentType;
  title: string;
  body: string;
  images: string[];
  video?: string;
  cover?: string;
  summary?: string;
  author?: string;
  tags: string[];
}

interface PlatformOverride {
  platform: string;
  title?: string;
  body?: string;
  images?: string[];
  cover?: string;
  tags?: string[];
  settings: Record<string, unknown>;
}
```

### 4.2 任务模型

一次批量发布称为Campaign，每个平台账号对应一个PublishTask：

```text
Campaign
├── 微信公众号账号A任务
├── 知乎账号A任务
├── 小红书账号A任务
├── 小红书账号B任务
└── 抖音账号A任务
```

任务状态：

```text
pending → validating → scheduled → publishing → succeeded
                                         ├── retrying
                                         ├── intervention_required
                                         ├── cancelled
                                         └── failed
```

## 5. 平台适配器设计

所有平台实现相同接口：

```ts
interface Publisher {
  checkLogin(accountId: string): Promise<LoginStatus>;
  validate(input: PublishInput): Promise<ValidationResult>;
  publish(input: PublishInput): Promise<PublishResult>;
  saveDraft?(input: PublishInput): Promise<PublishResult>;
  schedule?(input: PublishInput): Promise<PublishResult>;
}
```

建议目录：

```text
packages/publisher-engine/
├── core/
│   ├── publisher.ts
│   ├── browser-manager.ts
│   ├── task-runner.ts
│   └── diagnostics.ts
└── platforms/
    ├── wechat-official/
    ├── zhihu/
    ├── xiaohongshu/
    ├── douyin/
    ├── bilibili/
    ├── wechat-channels/
    ├── toutiao/
    └── baijiahao/
```

每个平台目录至少包含：

- `schema.ts`：平台参数、长度和素材规则。
- `selectors.ts`：页面选择器及多级降级策略。
- `login.ts`：登录、过期检测和重新登录。
- `transform.ts`：统一内容到平台内容的转换。
- `publisher.ts`：草稿或发布流程。
- `tests/`：转换测试、选择器测试和发布冒烟测试。

## 6. 微信公众号实现要求

首版优先实现保存草稿，正式群发作为显式可选能力。

功能范围：

- 扫码登录微信公众号后台。
- 识别账号名称与登录过期状态。
- Markdown转换为公众号兼容HTML。
- 上传正文图片和封面。
- 填写标题、作者、摘要、原创声明及转载设置。
- 保存到草稿箱并验证草稿存在。
- 用户确认后允许执行正式发布；默认不自动点击最终群发按钮。

验收重点：

- 图片不引用本机路径。
- 排版、表格、代码块和链接转换结果可预览。
- 保存草稿后必须回读草稿列表确认，不能只凭按钮点击判断成功。
- 群发等不可逆操作必须有二次确认和审计记录。

## 7. 知乎实现要求

功能范围：

- 浏览器扫码或账号登录，并持久化独立浏览器Profile。
- 发布文章或保存草稿。
- 支持Markdown正文、标题、封面、话题和声明。
- 保持标题层级、引用、代码块、图片和链接。
- 发布成功后记录文章URL。
- 遇到验证码或安全验证时暂停任务并允许人工接管。

首版以“知乎文章”为主；回答问题功能放入MVP之后的小版本。

## 8. 账号与安全设计

- 每个平台账号使用独立Playwright persistent context。
- Cookie不写入业务数据库，不提供云端同步。
- 浏览器Profile目录与业务数据分开备份。
- 日志禁止输出Cookie、Token、密码和完整请求头。
- 同一账号的任务严格串行。
- 默认使用有头浏览器，发布过程可以观察。
- 验证码、安全验证或审核拒绝不自动重试。
- 每个账号可设置每日上限与最小发布间隔。
- 删除账号时分别提供“移除配置”和“同时删除本地登录数据”选项。

## 9. 批量发布与调度

- 默认全局并发为2。
- 同平台默认并发为1，可由适配器声明安全上限。
- 同账号永远串行。
- 网络或页面加载失败可指数退避重试，默认最多2次。
- 内容校验失败不可重试。
- 应用退出前持久化任务状态，重启后恢复安全任务。
- 无法确认是否已经发布的任务进入`intervention_required`，禁止盲目重发。
- 定时任务使用本地时区保存，同时记录UTC时间，避免夏令时和时区迁移问题。

## 10. 桌面端页面

1. 仪表盘：待发布、进行中、成功、失败和账号过期统计。
2. 内容中心：文章、图文、视频的创建、导入和预览。
3. 发布工作台：选择平台、账号、发布时间和平台覆盖参数。
4. 批量任务：CSV/Excel导入、多篇内容排期和任务复制。
5. 账号管理：登录、重新认证、状态检查和Profile隔离。
6. 发布记录：作品URL、耗时、失败步骤、截图与重试入口。
7. 设置：数据目录、并发、浏览器、日志和更新策略。

## 11. 分阶段实施

### 阶段0：仓库与技术验证（第1周）

任务：

- 初始化pnpm monorepo、Tauri、React和Node Sidecar。
- 建立共享类型、日志和本地IPC。
- 验证Playwright浏览器由桌面端启动、关闭和人工接管。
- 验证SQLite迁移与应用重启恢复。
- 使用测试账号打通四条最小链路：微信公众号保存草稿、知乎保存草稿、小红书发布图文、抖音发布视频。

退出标准：四条链路分别至少成功3次，失败时能产生步骤日志和截图。若任一平台不可行，先解决技术阻塞，不进入完整UI开发。

### 阶段1：桌面骨架与统一数据模型（第2周）

任务：

- 完成账号、内容、发布工作台和记录页面骨架。
- 完成数据库表、迁移、仓储层和统一内容模型。
- 完成素材导入、校验和本地预览。
- 产出首个Windows开发安装包。

退出标准：可以在桌面端创建内容、添加测试账号、生成任务并持久化。

### 阶段2：P0平台产品化（第3至5周）

任务：

- 微信公众号文章转换、图片上传、封面和草稿回读验证。
- 知乎文章转换、话题、草稿/发布和URL回读。
- 小红书图文与视频。
- 抖音图文与视频。
- 平台参数表单根据Schema动态生成。
- 登录过期、验证码和人工接管流程。

退出标准：每个平台连续执行至少20个测试任务，成功率达到90%以上；所有失败可定位到明确步骤。

### 阶段3：批量发布与定时调度（第6周）

任务：

- Campaign与PublishTask编排。
- 多账号选择、平台级内容覆盖。
- 批量导入、定时发布、取消、重试和崩溃恢复。
- 发布前预检和风险确认。

退出标准：创建50个混合任务，重启应用后任务数量、顺序和状态保持正确；同账号无并发发布。

### 阶段4：P1平台接入（第7至9周）

按以下顺序接入：

1. B站视频。
2. 今日头条图文和视频。
3. 百家号图文和视频。
4. 微信视频号视频。

退出标准：每个平台具备登录检测、字段校验、发布结果验证、诊断截图和至少一组冒烟测试。

### 阶段5：稳定化与首个公开版本（第10至11周）

任务：

- 数据备份恢复、数据库迁移和自动更新。
- Cookie与日志安全审计。
- 平台适配器健康检查。
- Windows安装包、升级和卸载验证。
- 用户手册、故障排查和适配器开发文档。
- macOS构建验证；是否作为首发平台根据测试结果决定。

退出标准：核心回归用例通过，无明文敏感信息，安装、升级、重启恢复和卸载路径通过测试。

## 12. 测试策略

### 单元测试

- 内容转换和平台长度规则。
- 时间、重试和状态机。
- 数据库迁移和恢复。
- 日志脱敏。

### 集成测试

- Tauri与Sidecar通信。
- 浏览器Profile隔离。
- 素材上传与任务持久化。
- 应用异常退出后的队列恢复。

### 平台冒烟测试

- 每个平台准备专用测试账号。
- 每次选择器或发布流程修改后运行手动冒烟测试。
- 保存页面截图、最终URL和后台列表回读结果。
- 页面选择器测试失败时标记对应适配器为不健康，不继续批量任务。

## 13. 开源复用与许可证

可优先参考：

- `dreammis/social-auto-upload`：MIT，可参考Playwright平台流程。
- `biliup/biliup`：用于评估B站上传能力，接入前确认当前许可证兼容性。
- `doocs/md`：用于评估公众号Markdown排版，集成前确认并保留许可证和版权声明。
- `wechatsync/Wechatsync`：可研究产品交互和数据模型；其GPL代码不得直接复制进计划采用MIT许可证的核心模块。

每次引入第三方代码必须记录来源、版本、许可证、修改内容和NOTICE要求。

## 14. 建议仓库结构

```text
TurboPushForked/
├── apps/
│   └── desktop/
├── packages/
│   ├── shared/
│   ├── database/
│   ├── publisher-engine/
│   ├── task-runner/
│   └── content-transformer/
├── docs/
│   ├── architecture.md
│   ├── platform-adapters.md
│   ├── security.md
│   └── testing.md
├── fixtures/
├── scripts/
├── package.json
└── pnpm-workspace.yaml
```

## 15. 里程碑

| 里程碑 | 预计时间 | 可交付结果 |
| --- | --- | --- |
| M0 技术可行性 | 第1周末 | 公众号、知乎、小红书、抖音各一条真实链路 |
| M1 桌面骨架 | 第2周末 | 可安装的Windows开发版 |
| M2 P0平台 | 第5周末 | 公众号、知乎、小红书、抖音可用 |
| M3 批量与定时 | 第6周末 | 多账号、多平台批量任务闭环 |
| M4 首批平台完整 | 第9周末 | 八个平台进入统一任务系统 |
| M5 v0.1发布 | 第11周末 | 安全审计、文档和Windows正式安装包 |

## 16. 第一项开发任务

第一项任务不是制作完整界面，而是建立最小技术骨架并完成四个Spike：

1. 微信公众号测试账号保存一篇含图片和代码块的草稿，并回读草稿列表。
2. 知乎测试账号保存一篇Markdown文章草稿，并验证格式。
3. 小红书测试账号发布一篇两图笔记。
4. 抖音测试账号上传一个短视频并取得发布结果。

只有四个Spike具备可重复性，才开始建设完整批量任务系统。
