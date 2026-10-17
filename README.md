# TurboPushForked

本地多平台内容发布 Web 端（桌面端暂缓），当前为 **v0.0.1 技术验证阶段**。

最新功能以 [逐项实现清单](docs/FEATURE_CHECKLIST.md) 为准：公众号、知乎均已支持Markdown、正文图片、封面与编辑页回读；小红书图文草稿与抖音“仅自己可见”视频草稿也已完成真实账号验证并接入同步保存和异步队列。本地内容编辑、图片托管、跨机器便携归档及登录态检测已接入。公众号、知乎和小红书已接入需单独确认的实验发布，真实验收结果见 [发布验收记录](docs/PUBLICATION_ACCEPTANCE.md)。

接手开发请先阅读 [逐项实现清单](docs/FEATURE_CHECKLIST.md) 与 [实施进度](docs/IMPLEMENTATION_STATUS.md)；[开发交接文档](docs/HANDOFF.md) 仅保留2026-09-07阶段的历史背景。

微信公众号、知乎、小红书、抖音为 P0；B站、视频号、头条、百家号为 P1。

## 当前可用

- 工作台、内容中心、账号管理、批量任务四个开发页面。
- 文章、图文、视频的本地创建与保存。
- 账号对应独立 Playwright 浏览器 Profile，可打开登录页面、关闭浏览器和保存诊断截图。
- SQLite 数据迁移、内容快照、跨账号任务创建、取消及本地预检。
- 应用重启恢复；中断的发布任务标记为结果未知，避免重复执行。
- 公众号/知乎文章、小红书图文及抖音私密视频草稿可立即入队或到期自动执行；默认全局并发2、同账号严格串行，不执行公开发布。
- 草稿队列统一记录会话、素材上传、字段填写、隐私设置、保存与远端回读进度；任务页可展开事件时间线，并汇总等待、执行、需处理和完成数量。
- Tauri Rust 与 Node 引擎之间的 JSON 行协议、请求超时和退出清理；Windows原生编译与真实WebView通信测试已通过。
- **知乎纯文本文章草稿**：在任务记录中点击“保存知乎草稿”，分别等待标题/正文保存，刷新远端编辑页核对，再记录结果与草稿链接。

**公众号公开页自动回读已通过；知乎文章用户确认可见；小红书真实提交成功且用户确认正文、三图顺序正确。** 公开页自动读取仍可能遇到平台安全限制，详见 [验收记录](docs/PUBLICATION_ACCEPTANCE.md)。 B站、视频号、头条和百家号仍未完成草稿/发布适配。账号列表不会把曾经登录等同于当前登录有效。预检不操作平台；已验证平台的计划时间会触发草稿保存，其他平台仍不会自动执行。

公众号真实测试入口为 `scripts/wechat-service-smoke.ts`，与知乎一样需要显式设置 `TURBOPUSH_LIVE_DRAFT_TEST=1`，会保存标注为开发验证的真实草稿，不属于默认测试套件。

多图与慢网络专项使用 `scripts/live-draft-smoke.ts`。该入口默认不会运行，要求显式授权开关以及平台、账号、数据目录、正文文件、2至20张图片和网络延迟参数；它只异步保存指定测试草稿并轮询事件，不调用公开发布。离线900秒模型已通过；本轮常规网络下公众号、知乎三图草稿及顺序已通过；20图和真实慢网专项仍未完成。详情及安全边界以实施清单为准。

## 公开发布开发状态（2026-10-16）

公众号、知乎文章和小红书图文已接入实验公开发布。仅在核对账号和完整标题后单次提交；提交检查点持久化，结果未知禁止自动重试。公开页只读核对与人工验收记录明确区分。需在服务启动前设置 `TURBOPUSH_EXPERIMENTAL_PUBLISH=1`，草稿队列不会自动公开发布。

公众号已完成公开页标题、正文、三图自动回读；知乎已发布且用户确认可见，但自动公开页受访问限制；小红书已真实发布并由用户在手机端确认正文与三图顺序。公众号本轮最后一次确认由用户点击。微信图文消息与公众号文章属于同一平台。详见 [完整验收证据与限制](docs/PUBLICATION_ACCEPTANCE.md)。

## 环境

- Node.js >= 24.13，pnpm 11.19。
- 本机 Edge，或执行 `pnpm browser:install` 下载 Chromium。
- 原生桌面端另外需要 Rust MSVC 工具链、Visual Studio C++ Build Tools、Windows SDK 和 WebView2。

## 启动 Web 端

首次执行 `pnpm install`，然后执行：

```powershell
pnpm build
pnpm start
```

访问 http://127.0.0.1:34080 。修改端口：`$env:TURBOPUSH_PORT = '35080'`，再启动。端口占用时直接报错，不自动换端口。开发模式 `pnpm dev` 使用相同端口配置。

当前仅监听本机，尚未提供远程访问认证。图片通过浏览器上传到服务端素材库；视频路径指运行服务机器上的路径。账号扫码登录会打开服务机器上的浏览器窗口。无需 Rust 或 Windows 客户端即可运行 Web 端。

## 启动开发界面

在项目根目录执行：

```powershell
pnpm install
$env:TURBOPUSH_BROWSER_CHANNEL = 'msedge'
pnpm dev
```

打开 http://127.0.0.1:34080 。先添加账号、保存文章，再创建本地任务并执行预检。

可选环境变量：

| 变量                        | 用途                                                  |
| --------------------------- | ----------------------------------------------------- |
| `TURBOPUSH_DATA_DIR`        | 自定义数据库、浏览器Profile和诊断截图目录             |
| `TURBOPUSH_BROWSER_CHANNEL` | `msedge` 或 `chrome`；不设置时使用Playwright Chromium |
| `TURBOPUSH_NODE`            | 原生桌面端启动引擎所用的Node可执行文件路径            |

浏览器开发模式默认数据目录为项目根目录的 `.data/`；Windows启动脚本也使用同一目录，便于复用已有登录。直接启动Tauri默认使用系统应用数据目录。自动化测试使用临时目录，显式运行的知乎真实草稿脚本除外。

## 启动原生桌面开发版

```powershell
./scripts/desktop.ps1
```

脚本自动识别本项目 `.toolchains` 中的Rust工具链，或使用系统已有Cargo。该目录不会提交到仓库，不改变系统PATH。

当前原生端仍依赖本机Node与本仓库；`bundle.active=false`，尚未生成可分发安装包。请勿把开发EXE当作独立发行版。

## 验证

```powershell
pnpm build
pnpm test
$env:TURBOPUSH_BROWSER_CHANNEL = 'msedge'
pnpm test:browser
pnpm test:ui
pnpm test:native
```

- `build`：TypeScript检查、Node引擎构建、Vite前端构建，不包含Rust。
- `test`：SQLite恢复、事务完整性、取消、输入校验、素材预检、源码及构建产物的真实子进程通信。
- `test:browser`：真实浏览器验证Profile/Cookie重启持久化与账号隔离，仅访问本机测试页面。
- `test:ui`：账号→文章→任务→预检→刷新回读，截图输出到 `test-results/`。运行前需关闭占用34080端口的开发服务。
- `./scripts/desktop.ps1 -Build`：前端与引擎构建后编译Rust开发EXE。
- `test:native`：需要先编译Rust开发EXE；验证真实Tauri WebView→Rust→Node→SQLite，并确认关闭窗口后引擎正常退出。仅开发测试启用本机调试端口。

知乎真实草稿测试不属于默认测试套件。需要已有账号登录，并明确希望写入测试草稿时，才运行：

```powershell
$env:TURBOPUSH_BROWSER_CHANNEL = 'msedge'
$env:TURBOPUSH_LIVE_DRAFT_TEST = '1'
node --import tsx scripts/zhihu-service-smoke.ts
```

真实测试按固定内容标题复用已有任务，已保存的任务会阻止重复提交。结果未知且未记录草稿链接时，系统要求先人工核对，避免再创建一篇。

## 结构

```text
apps/desktop/                  React开发界面与Tauri壳
packages/shared/               平台注册、Zod校验、通信与领域类型
packages/database/             SQLite存储和版本迁移
packages/publisher-engine/     Node服务、stdio协议、浏览器管理
tests/                         数据和引擎测试
scripts/                       浏览器验证和Windows启动脚本
docs/                          实施状态和后续验收清单
```

阶段0采用Node内置SQLite和显式SQL迁移，减少本机原生模块编译依赖；尚未引入计划中的Drizzle、富文本编辑器及组件库。详见 [开发计划](DEVELOPMENT_PLAN.md) 和 [实施进度](docs/IMPLEMENTATION_STATUS.md)。
