# 开发交接：从这里继续

> 2026-09-08：项目已继续开发，请先读 [最新逐项实现清单](FEATURE_CHECKLIST.md)，下文是早期交接历史快照，不代表当前功能范围。

更新日期：2026-09-07。工作目录：`E:\dev\TurboPushForked`。

> 后续更新（2026-09-07）：用户取消交接后继续开发，公众号纯文本草稿已实现并通过真实账号和Service集成验证。适配器位于 `packages/publisher-engine/src/platforms/wechat/draft.ts`，任务保存/打开接口及UI已接入；14项测试与TypeScript检查通过。两篇公众号开发测试草稿未发表。标题、正文、作者、摘要和编辑页回读已通过；图片、封面、Markdown与草稿列表回读仍未实现。真实测试入口为 `scripts/wechat-service-smoke.ts`，需要显式开启真实写入。下文是此前交接时历史快照，涉及公众号“未实现/等待扫码”的描述已过时，以本段及 `IMPLEMENTATION_STATUS.md` 最新记录为准。

本文用于让其他对话接手，不要求读取原对话。先读本文，再读 `IMPLEMENTATION_STATUS.md` 和根目录 `DEVELOPMENT_PLAN.md`，最后以实际源码为准。开发计划是目标，不代表功能已经完成。

## 1. 当前停在哪里

用户希望独立实现类似 TurboPush 的多平台桌面工具。首批必须包含微信公众号和知乎；P0 是公众号、知乎、小红书、抖音，P1 是 B站、视频号、头条、百家号。不得复制或破解 TurboPush 私有代码、绕过付费限制。

目前为 v0.0.1 技术验证阶段，M0 未完成。Windows 桌面开发壳、本地内容与任务链路、知乎纯文本草稿已经实现并验证；没有任何平台的公开发布功能。

**下一项是微信公众号。上一轮用户说“继续实现公众号”后，只检查了现有接口和文件，尚未新增公众号适配器或验证脚本，尚未打开公众号登录窗口、扫码或写入公众号草稿。** 随后用户要求停下整理交接。不要把原先宣布的工作计划当成已完成。

此次交接只修改文档，没有修改业务代码、执行新的远端写入或重新运行测试。

## 2. 已做的工作与代码入口

| 范围 | 已实现 | 入口 |
| --- | --- | --- |
| 桌面界面 | 工作台、内容中心、账号管理、批量任务；React/Vite + Tauri | `apps/desktop/src/main.tsx`、`apps/desktop/src-tauri/` |
| 内容与账号 | 本地保存文章/图文/视频字段；账号独立浏览器 Profile；打开登录、关闭、截图 | `packages/shared/src/index.ts`、`packages/publisher-engine/src/browser-manager.ts` |
| 数据与任务 | Node 内置 SQLite、WAL、版本迁移至 v2、任务不可变内容快照、跨账号批量建任务、取消、本地预检、恢复 | `packages/database/src/index.ts` |
| 桌面通信 | WebView → Rust → Node stdio JSON 行协议；超时、退出清理；开发网页使用本机同源 RPC | `apps/desktop/src-tauri/`、`packages/publisher-engine/src/stdio.ts`、`service.ts` |
| 知乎草稿 | 纯文本标题/正文分别保存并确认；刷新编辑页回读；记录草稿链接；防止重复提交；任务页入口 | `packages/publisher-engine/src/platforms/zhihu/draft.ts`、`service.ts` |
| 工具与测试 | Windows 启动脚本、本地测试、真实浏览器隔离测试、UI/原生链路测试、知乎真实验证工具 | `scripts/`、`tests/`、`apps/desktop/scripts/` |

目前 `platforms/` 下只有 `zhihu/draft.ts`。其他平台出现在能力注册表中，不代表有适配器。

### 已有验证记录（2026-09-06，交接时未重跑）

- `pnpm build` 通过：TypeScript、Node 引擎和前端构建；不包括 Rust。
- `pnpm test`：12 项测试通过。
- `pnpm test:browser`：Edge 的 Profile/Cookie 重启持久化、账号隔离通过，仅使用本机测试页面。
- `pnpm test:ui`：创建账号、内容、任务、预检、刷新回读与跨域 RPC 拒绝通过。
- Windows Rust 开发 EXE 编译通过；`pnpm test:native` 的真实 WebView → Rust → Node → SQLite 链路和退出清理通过。
- 用户曾扫码登录知乎，浏览器重启后登录仍有效；这不是当前登录有效的保证。
- 同一真实知乎开发草稿连续 3 次修改、刷新回读通过，约 5.9 / 6.1 / 5.7 秒；Service 层草稿保存、结果入库及重复提交拒绝通过。
- 共保留两篇明确标注开发验证的知乎草稿，没有公开发布。不要为重跑测试随意新增、覆盖或删除用户内容。

## 3. 尚未做的工作

- **公众号整条远端草稿链路**：登录态识别、真实编辑器定位、标题/作者/摘要填写、Markdown → 兼容 HTML、正文图片与封面上传、保存确认、草稿列表回读、任务接入和真实验证。
- 知乎 Markdown 排版、图片/封面/话题、草稿列表回读。现有回读只是刷新远端编辑页，不能称为列表验证。
- 小红书、抖音及全部 P1 平台的草稿/发布适配。
- 所有平台公开发布、微信公众号群发；没有点击这些操作的默认授权。
- 到期自动执行、完整并发队列、自动重试、平台级字段覆盖。现有排期仅保存时间；同账号草稿任务只有进程内互斥保护。
- 编辑已有内容、素材复制托管、文件选择器、导入导出、完整富文本编辑器。封面字段在模型中存在，但目前表单未提供封面输入。
- 独立登录态检测、操作系统 Keychain 业务集成；当前只使用 Chromium 自身的 Profile 存储机制。
- 可分发安装包、内嵌 Node/Playwright、签名与自动更新。`bundle.active=false`，现有 EXE 依赖本机 Node 和仓库，不是独立发行版。

## 4. 接手后优先执行：公众号草稿

1. 阅读 `service.ts`、`browser-manager.ts`、知乎适配器和 `scripts/zhihu-spike.ts`，保留已有知乎实现与用户数据。
2. 确认本项目开发服务与浏览器是否仍运行。不要同时让桌面端和验证脚本占用同一个账号 Profile；也不要并行启动使用同一数据库的 Service（构造时会执行中断恢复）。
3. 创建公众号独立验证脚本，例如 `scripts/wechat-spike.ts`（**尚不存在**）。复用 BrowserManager 和本地账号；打开 `https://mp.weixin.qq.com/`，请用户在独立窗口扫码。用户之前同意的是知乎登录，不代表公众号已经登录。
4. 登录后检查实际页面 DOM，再实现公众号适配器；不要凭猜测固定编辑器、iframe 或按钮定位器。
5. 从明确标注开发测试的单篇草稿开始，接入标题、正文、作者、摘要和封面；逐步加入 Markdown 与正文图片。只保存草稿，不点击发表、发布或群发，不自动勾选原创声明。
6. 获取稳定草稿标识并尽早落检查点；确认保存响应后，再从远端重新打开/草稿列表回读。结果未知时进入人工核对，不能无条件重建草稿。
7. 扩展 `task.saveDraft`、`task.openDraft` 的平台分支和任务按钮。当前这些接口、提示、部分预检文案写死知乎；逐项修改，不提前把公众号标记为已验证。
8. 增加输入、URL、安全重试与保存确认测试；完成真实草稿验证后更新状态文档。最后重建 Node 引擎并重启本项目桌面开发服务，以加载新代码。

公众号安全注意：后台 URL 可能包含登录 token。不要将 token、Cookie、扫码信息或完整敏感请求写入日志、任务结果 URL 或交接文档。建议持久化无凭据的草稿标识，打开时利用当前已登录页面构造导航。截图只存本地忽略目录。真实页面尚未检查，以上是实现约束，不是已验证的平台方案。

## 5. 本机环境与运行方法

已有环境：Windows PowerShell、Node `v24.13.0`（`D:\nodejs\node.exe`）、pnpm `11.19.0`、本机 Edge、Visual Studio C++ 工具链。Rust `1.98.1` 安装在项目 `.toolchains/` 中，未改系统 PATH。新对话应先检查命令是否仍可用。

在项目根目录运行：

```powershell
# 推荐：脚本自动处理本项目 Rust、Edge 和统一数据目录
./scripts/desktop.ps1

# 只启动网页开发界面，与桌面开发服务不能同时占用 1420 端口
$env:TURBOPUSH_BROWSER_CHANNEL = 'msedge'
pnpm dev

# 构建与测试，按需分别执行
pnpm build
pnpm test
pnpm test:browser
pnpm test:ui
./scripts/desktop.ps1 -Build
pnpm test:native
```

如果 PATH 找不到 pnpm，上次可用的入口为：
`C:\Users\yuanx\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd`。
这属于本机缓存路径，接手时先确认存在。启动脚本内部也需要能找到 `pnpm`。

`test:ui`、`test:native` 使用 1420 端口，运行前关闭本项目开发服务，二者不要同时执行。原生测试需要先编译开发 EXE。测试数据使用临时目录；显式真实知乎验证脚本例外。

上轮曾启动桌面开发服务，但交接时没有检查其存活状态。不要依赖旧对话的工具 session ID 或旧 PID。先检查进程和端口，只操作本项目的 `turbopush-forked.exe` 及对应服务；用户电脑上还有商业版 `turbopush.exe`，不要误关。

## 6. 数据保留与已有验证工具

- 根目录 `.data/` 保存 SQLite、账号 Profile 和诊断截图。不要删除、重置或提交该目录。
- `scripts/desktop.ps1` 和默认网页开发模式共用根目录 `.data/`；直接启动 Tauri 默认可能使用系统应用数据目录，必要时显式设置 `TURBOPUSH_DATA_DIR`。
- `.toolchains/`、`.pnpm-store/`、`node_modules/`、`dist/`、`target/`、`test-results/` 等忽略目录不是需要重新实现的源码。
- 已有草稿 URL 从本地任务 `resultUrl` 获取，不在本文复制账号标识和远端草稿资料。
- `scripts/zhihu-spike.ts` 是交互式验证脚本，支持逐行 JSON 命令 `inspect`、`editor`、`verify-draft`、`screenshot`、`close` 等。`verify-draft` 可动态重新导入适配器；没有传既有草稿 URL 时可能创建新草稿，不要当只读检查运行。
- `scripts/zhihu-draft-probe.ts` 是初期探测工具，不是正式适配器。
- `scripts/zhihu-service-smoke.ts` 会操作真实草稿，仅在明确要验证真实写入且已有登录时设置 `TURBOPUSH_LIVE_DRAFT_TEST=1` 运行。默认测试不调用它。

## 7. 必须保留的正确性处理

- 知乎编辑器显示不等于远端数据加载完毕，重开草稿须等待数据回填，防止编辑被覆盖。
- 知乎标题和正文分别保存；等待响应必须匹配实际字段及期望内容，不能收到任意成功请求就判定全文成功。
- HTTP 成功之后仍需刷新回读；成功草稿状态是 `draft_saved`，不是公开发布 `succeeded`。
- 开始远端写入后尽早保存草稿 URL 检查点；有历史尝试但无 URL 时阻止盲目重试。
- 重启时 `publishing` 转为 `intervention_required`，保留结果未知；不要默认恢复为可自动执行。
- 账号列表保持“登录待验证”，不要把曾经成功登录直接当作当前登录有效。
- 增加公众号后仍需严格验证远端 URL 的域名、路径和允许参数，避免任意导航及凭据泄漏。

## 8. 给新对话的接手提示词

> 请接手 E:\dev\TurboPushForked。先阅读 docs/HANDOFF.md、docs/IMPLEMENTATION_STATUS.md 和 DEVELOPMENT_PLAN.md，再检查相关源码。已有 Windows 桌面、本地任务和真实知乎纯文本草稿，请保留它们及 .data 中的登录/任务数据。下一步实现微信公众号草稿，先打开独立登录窗口让我扫码，再基于真实页面实现保存和回读；不要公开发布或群发。不要把计划中的功能视为已经完成，完成后更新交接文档和测试记录。
