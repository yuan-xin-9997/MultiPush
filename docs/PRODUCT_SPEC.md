# MultiPush 产品与技术规格（第一版）

> 项目：多平台智能发布系统 / MultiPush
> 目标：一次创作，按微信公众号（图文/贴图）、小红书、知乎、微博、今日头条、百家号、豆瓣、抖音、少数派、个人博客的排版规则渲染，预览并下载，支持已接入平台自动发布。

## 1. 第一版范围

必须实现：

1. 多用户注册、登录、退出，JWT 鉴权，数据严格按用户隔离。
2. 内容库：知识库（Book）分组、全部内容、收藏、回收站、搜索、排序、卡片/列表视图、新建、编辑、复制、删除/恢复、移动分组；素材库支持图片/视频/文档上传、文件夹、移动、筛选、预览、下载和删除。
3. 内容导入/导出：支持批量导入 Markdown、HTML、TXT、MultiPush JSON；支持单篇导出 Markdown / HTML / JSON，支持多选打包 ZIP 导出。
4. 类语雀的富文本编辑器：标题、正文、图片、视频、表格、代码块、引用、任务列表、分割线、链接、文字颜色/高亮、对齐、撤销重做、字数统计、目录大纲、自动保存、封面（本地上传或选用正文图片）、标签、状态。
5. 智能渲染：选择内容 + 平台（微信公众号 / 公众号贴图 / 小红书 / 知乎 / 微博 / 今日头条 / 百家号 / 豆瓣 / 掘金 / CSDN / 简书 / 抖音 / 少数派 / 个人博客），调用模板规则渲染。渲染结果保存在历史记录中。
6. 十四个平台各自的模拟预览（手机、信息流或文章预览），以及下载：
   - 微信公众号：复制富文本 HTML、下载 HTML。
   - 公众号贴图（图片消息）：正文图片（≤20 张，首图即封面）+ 标题（≤32 字）+ 纯文本配文，手机壳贴图预览、文案 TXT 与 JSON 下载，支持 AppID/AppSecret 连接后经官方 API 保存草稿（发表在公众号后台手动完成）。
   - 小红书：图文卡片 PNG（3:4，1080×1440）打包下载、文案/标题/话题、图片素材、视频笔记。
   - 知乎：复制 Markdown/HTML、下载 Markdown/HTML。
   - 微博：信息流图文预览、标题/正文/`#话题#`、最多 9 图文案 TXT 与 HTML/JSON 下载，支持扫码发布。
   - 今日头条：桌面文章预览、标题/正文 HTML、Markdown 与 HTML 下载，支持扫码发布。
   - 百家号：桌面文章预览、标题/正文 HTML、Markdown 与 HTML 下载，支持百度通行证扫码发布。
   - 豆瓣：日记长文预览、HTML/Markdown 下载、富文本复制，支持豆瓣扫码登录后发布日记（实验性，豆瓣无官方开放写接口）。
   - 掘金：技术文章 Markdown 排版，支持扫码登录、保存草稿或直接发布。
   - CSDN：技术博客 Markdown 排版，支持微信扫码登录、保存草稿或直接发布。
   - 简书：Markdown 长文排版，支持 Cookie 连接、保存到默认文集草稿或公开发布。
   - 抖音：竖屏信息流预览、标题/正文/话题文案、文案 TXT 与图文 HTML/JSON 下载。
   - 少数派：Matrix 长文预览、Markdown/HTML 下载、复制富文本，支持微信扫码保存草稿或立即发布。
   - 个人博客：Halo 博客文章预览、Markdown/HTML 下载、复制富文本，支持令牌连接后保存草稿或公开发布。
   - 支持“下载全部 ZIP”。
7. 发布管理页：支持微信公众号、公众号贴图、知乎、微博、今日头条、百家号、豆瓣、掘金、CSDN、简书、抖音、少数派和个人博客；微信公众号、公众号贴图、知乎、少数派、个人博客、掘金、简书、今日头条、百家号、抖音支持平台草稿，微博、豆瓣支持本地草稿；小红书保留手动发布。接入与限制见 `WECHAT_PUBLISHING.md`、`WECHATPIC_PUBLISHING.md`、`ZHIHU_PUBLISHING.md`、`WEIBO_PUBLISHING.md`、`TOUTIAO_PUBLISHING.md`、`BAIJIAHAO_PUBLISHING.md`、`DOUBAN_PUBLISHING.md`、`JUEJIN_PUBLISHING.md`、`CSDN_PUBLISHING.md`、`JIANSHU_PUBLISHING.md`、`DOUYIN_PUBLISHING.md`、`SSPAI_PUBLISHING.md` 与 `BLOG_PUBLISHING.md`。
8. AI 创作页：配置 OpenAI 兼容大模型接口、模型和按用户加密保存的 API Key；通过对话和工具读取用户内容库、素材、渲染与发布数据，创建/修改文章、生成排版、保存平台草稿、正式发布，并创建批量渲染、批量发布任务；对话支持上传图片/视频/文本文档作为附件，模型可按附件意图新建文章或视频内容（图片视觉识别 + mediaIds 插入文章/初始化视频时间线；文档全文作为写作素材）。
9. 批量任务：内容库多选后支持批量渲染和批量发布；任务在服务端顺序执行，持久保存每项状态，页面可轮询进度并在完成后打开对应排版或发布记录。
10. 响应式：桌面优先，至少 1024px 宽度体验完整；移动端可登录、浏览内容库、使用 AI 创作、查看渲染结果（编辑器可提示使用桌面端）。
11. 监听 `0.0.0.0:34080`；生产由同一个 Node 服务提供 API、上传文件和前端静态文件。

非目标：平台 OAuth 授权接入、绕过平台安全验证 / 验证码、AI 改写（仅预留扩展接口）。

## 2. 技术架构

- 前端：React 19 + TypeScript + Vite 7 + React Router 6；Tiptap 2 编辑器；纯 CSS 设计系统；`html-to-image` + `jszip` 生成小红书 PNG 压缩包。
- 后端：Node.js 22 + Express 4 + TypeScript；`node:sqlite`（DatabaseSync）持久化；JWT + bcryptjs；multer 上传。
- 构建：`esbuild` 将后端打包为 `server/dist/index.js`（单文件），前端 `web/dist`。
- 数据与上传：默认 `DATA_DIR`（开发为项目根 `.data/`，生产为 `/opt/MultiPush/.data`）；SQLite 文件 `multipush.sqlite`，上传目录 `uploads/`。
- 密钥：若未提供 `JWT_SECRET`，在 `DATA_DIR/.jwt-secret` 自动生成并持久化（600 权限）。

目录：

```
shared/types.ts          前后端共享类型与平台元数据
server/src/              API、数据库、鉴权、渲染器
web/src/                 前端
  components/            全局布局与通用组件
  features/auth          登录注册
  features/ai            AI 创作与工具会话
  features/batch         批量渲染 / 批量发布弹窗
  features/library       内容库
  features/editor        编辑器
  features/render        智能渲染与预览
  features/publish       公众号登录、图文发布与记录
  lib/api.ts             API 客户端（已提供，勿改接口形状）
  lib/utils.ts           通用工具（已提供）
  contexts/AuthContext   登录态（已提供）
  styles/globals.css     设计系统（已提供）
JenkinsConfig/           Jenkinsfile、deploy.sh、systemd unit、健康检查
docs/                    文档
```

## 3. 页面与交互

### 3.1 登录 / 注册

- 左右分栏：左侧品牌介绍（MultiPush、平台标识、渲染流程卖点），右侧表单。
- 登录字段：账号（用户名或邮箱）+ 密码；注册字段：用户名、邮箱、密码、确认密码、昵称（选填）。
- 校验与错误提示；加载态；成功跳转 `/library`。
- 已登录访问登录页应跳转 `/library`。

### 3.2 应用外壳

- 左侧固定导航：Logo、AI 创作、内容库、智能渲染、发布管理、设置；底部用户菜单（含设置、退出登录）。
- 内容库子导航：知识库列表（可新建/重命名/删除）、全部内容、我的收藏、回收站。
- 顶部可按页面定制；整体类语雀：白底、细边框、绿色主色 `#00b96b`。

### 3.3 内容库

- 头部：面包屑/标题、文档数、搜索框、排序、视图切换、新建按钮（导入 / 新建图文 / 新建视频 / 新建文章）。
- 文档卡片：标题、摘要、封面缩略图、标签、所属知识库、更新时间、字数或图片/视频数量、收藏按钮、更多菜单（渲染、复制、移动、删除）；图文内容带紫色「图文」角标并显示图片数，视频内容带「视频」角标并显示片段数。
- 列表视图：表格样式，适合快速扫读。
- 回收站：只显示已删除；支持恢复、彻底删除（二次确认）。
- 空状态友好；加载骨架屏；操作 toast 反馈。
- 点击卡片进入 `/editor/:id`；图文内容进入 `/gallery/:id`；视频内容进入 `/video/:id`；新建先创建空内容再跳转。

#### 导入 / 导出

- 工具栏提供「导入」和「导出」入口。导入接受 `.md` / `.markdown` / `.html` / `.htm` / `.txt` / `.json`，支持多选与拖拽，单文件 ≤5MB、单次 ≤30 个；导入到当前知识库（未分组时归入未分组）。
- Markdown 使用 GFM 规则转换；HTML 清洗后保留常见排版；TXT 按空行分段；JSON 支持 MultiPush 单篇导出或 `{ contents: [...] }` 批量备份。
- 导入后标题取 `title`、首个 H1 或文件名；生成摘要与字数；编辑器打开无 JSON 的导入文档时以 HTML 初始化编辑器。
- 单篇导出入口在文档卡片更多菜单与编辑器更多菜单：Markdown（.md）、HTML（独立样式）、JSON（.multipush.json）。
- 内容库支持多选文档后打包 ZIP 导出（Markdown / HTML / JSON 三种格式可选）。导出文件名安全、去重。
- 导入导出全部在前端解析（`web/src/lib/content-io.ts`），API 仍走现有内容接口；不上传原始文件到服务器。

### 3.4 编辑器（参照语雀）

- 全屏独立页面，顶部栏：返回、文档标题（大号无边框输入）、保存状态（未保存/保存中/已保存）、收藏、渲染按钮、更多菜单。
- 左侧：知识库/文档信息（所属知识库、封面、标签、状态），可折叠；右侧：大纲（H1-H3，点击滚动）、字数/阅读时间。
- 封面：支持本地上传，也可打开「从正文选择」从正文图片中选择；图片按阅读顺序去重展示，当前封面带标记。内嵌或外部图片选用时自动转存为本站媒体，读取失败时提示先下载再上传。
- 正文：Tiptap 编辑器，居中最大宽度约 760px，舒适行高；工具栏包含：
  一级/二级/三级标题、加粗、斜体、下划线、删除线、文字颜色、背景高亮、无序/有序/任务列表、引用、代码块、表格、分割线、链接、图片、视频、对齐、清除格式、撤销/重做。
- 粘贴/拖拽图片自动上传；支持插入本地上传的视频（`<video controls>`）。
- 工具栏和 `/` 快捷菜单提供「从素材库插入」：可从全库或指定文件夹选择已有图片、视频和文档；图片/视频直接插入正文，文档插入为带文件名和下载链接的段落。
- 空文档显示占位提示；输入 `/` 唤起快捷插入菜单，支持正文、标题、列表、引用、代码块、分割线、表格、图片、视频和链接；可继续输入关键词筛选，使用 `↑`/`↓` 选择、`Enter` 插入、`Esc` 关闭。支持 Markdown 快捷输入（Tiptap StarterKit 自带）。
- 自动保存：内容变化后 debounce 约 1.2s 保存；`Ctrl/Cmd+S` 立即保存；离开前若未保存给出提示。
- 标题为空时保存为“无标题文档”。
- 编辑器内容保存 `contentJson` + `contentHtml`；后端计算摘要、字数、图片/视频数量。

#### 图文工作台（`kind: "gallery"`）

- 面向公众号贴图、抖音图文、小红书等以图片为主的内容：标题 + 有序图片（可逐图填写图注）+ 配文。
- 顶栏：返回、图文标识、保存状态、收藏、渲染、更多（复制 / 导出 Markdown、HTML、JSON / 删除）。
- 图片区：批量上传（JPG/PNG/WebP/GIF，单张 ≤20MB，最多 35 张），也可「从素材库添加」已有图片；拖拽手柄或 ↑/↓ 调序，星标选择封面，删除图片；触屏设备常显图片工具栏。
- 封面默认第一张；删除封面图自动回退到新的第一张。
- 配文为纯文本多行输入，每行保存为一段；标签、草稿/待发布状态可编辑。
- 自动保存约 0.8s；`Ctrl/Cmd+S` 立即保存；离开前提示未保存；顶部显示保存状态。
- 图片保存为标准 Tiptap `figure`（`image` + 可选 `figcaption`），配文保存为 `paragraph`；同时生成 `contentHtml` 供现有渲染、发布、导出和批量任务复用。
- 右下/侧栏展示公众号贴图（20）、小红书（18）、抖音图文（35）的图片上限提醒。

### 3.5 智能渲染

工作台增强：

- 当前平台可独立调整标题、富文本正文或短文案、话题；修改存入渲染记录，支持恢复最初生成结果，不写回原文。重新生成会创建新记录，旧记录及调整保留。
- 小红书卡片按浏览器实际文字高度自动拆页，保留全部文字；支持缩略图选择、前后排序、光标处分段分页、换图、上传及裁剪位置调整。封面等无法自动拆分的文字溢出会明确提示，阻止该卡片静默裁切导出。
- 发布前检查最终标题、完整文案（含标题和话题）、卡片数量、文字溢出和素材可读取性。平台上限只作参考；素材失败可定位到原地址。
- 渲染结果保存原文更新时间，页面重新获得焦点时检查更新；待应用设置和生成快照分开，预览与导出使用同一快照。
- 导出 ZIP 包含 `导出报告.txt/json`，列出应有及实际卡片数、缺失卡片和素材及原因；支持重试，复用已成功的卡片。纯文本复制降级须明确提示。
- 默认平台、风格、作者和开关按账号保存到当前浏览器；各平台提供分别复制标题、正文、话题以及对应的富文本或 Markdown 入口。

- 选择内容（搜索选择器，默认从查询参数 `contentId` 带入）+ 选择平台（多选，默认全选）+ 渲染选项（卡片风格：清新/暖阳/醒目）。
- 点击“开始渲染”调用后端，重新渲染生成新记录；渲染历史侧栏可加载旧记录。
- 结果页按平台 Tab 展示：
  - 顶部平台信息、字数、图片数、标题长度/限制、警告。
  - 预览：公众号手机壳、公众号贴图手机壳（图片纵向堆叠 + 配文）、小红书手机壳（卡片轮播/滚动 + 文案区）、知乎桌面文章壳、豆瓣日记桌面文章壳、抖音 9:16 竖屏信息流壳、少数派 Matrix 桌面文章壳、个人博客文章壳。
  - 操作：复制、下载当前平台、下载全部 ZIP。
- 小红书卡片：客户端用隐藏 DOM 渲染 `XhsCard`，`html-to-image` 以 pixelRatio 2 导出 1080×1440 PNG；支持 zip 打包；导出时显示进度。
- 下载全部 ZIP 包含：各平台 HTML/Markdown/文案、小红书 PNG、原图素材（尽量获取，失败仅警告）。
- 空状态：未渲染时显示流程说明；渲染失败显示可重试错误。
- 移动端：预览缩小但仍可切换平台与下载。

### 3.6 发布管理

- 平台登录方式：知乎、微博、今日头条、百家号、豆瓣、掘金、抖音在官方扫码之外支持手机验证码登录。用户在系统内输入手机号和短信验证码，服务端使用隔离浏览器完成官方登录，只保存加密会话；不接收、不保存平台密码。遇到滑块或安全验证时停止并提示改用扫码。小红书自动登录仍保持停用；简书、少数派、个人博客没有手机验证码入口，继续使用 Cookie、微信扫码或 Halo 令牌。
- 公众号官方扫码登录（微信没有手机验证码入口），加密保存按用户隔离的会话；选择已保存的公众号排版、封面、作者和摘要，支持草稿与正式发表；安全验证时显示二维码。只有核实微信发表记录后显示成功，网络中断或服务重启后不自动重发。
- 公众号贴图使用 AppID/AppSecret（加密保存按用户隔离）调用官方 API：上传永久图片素材并创建 `newspic` 图片消息草稿，回读核对标题与图片数量；IP 白名单错误会提示当前出口 IP。正式发表在公众号后台手动完成（个人订阅号无 `freepublish` 权限）；结果不确定时不自动重试，草稿记录支持同步删除后台草稿。详见 `WECHATPIC_PUBLISHING.md`。
- 少数派使用微信扫码登录，加密保存按用户隔离的会话；选择 Matrix 排版与题图，支持保存草稿和立即发布。正文图片上传到少数派图床，保存后回读核对标题、正文、图片和链接；结果不确定时不自动重发。
- 微博使用官方二维码或手机验证码登录，加密保存按用户隔离的会话；选择微博排版，将标题、正文、`#话题#` 和最多 9 张图片发布为图文微博。发布结果以 `/ajax/statuses/update` 响应和微博编号为准；结果待核实时人工核实，不自动重发。
- 今日头条使用头条号官方二维码或手机验证码登录，加密保存按用户隔离的会话；选择头条图文排版，填写标题和正文后发布。发布结果以 `/mp/agw/article/publish` 响应和文章编号为准；结果待核实时人工核实，不自动重发。
- 百家号使用百度通行证二维码或手机验证码登录，`BDUSS` 登录态加密保存；选择百家号图文排版，填写标题和正文后发布。发布结果以 `/pcui/article/publish` 响应和文章编号为准；结果待核实时人工核实，不自动重发。
- 个人博客使用 Halo 个人令牌连接，加密保存按用户隔离的地址和令牌；选择博客排版与封面，支持保存草稿和公开发布。正文图片转存到 Halo 附件库，发布后回读核对内容；结果不确定时不自动重发。其他平台继续下载后手动发布。
- 发布记录支持删除草稿和失败记录：微信公众号、公众号贴图、知乎、少数派、个人博客、掘金、CSDN、简书会同步删除平台后台草稿并清理本地记录。微博、豆瓣为本地草稿（删除只影响本系统）；抖音、今日头条、百家号因平台未返回可定位的草稿编号或写接口受限，小红书因自动发布已停用，删除只清理本地记录，平台草稿需到对应后台清理。已发布内容、处理中和结果待核实记录在所有平台都不允许删除，系统不会自动删除或下架已发布内容。

### 3.7 AI 创作

- 左侧会话列表、设置入口（跳转 `/settings?tab=ai`）和新建会话；主区域为消息流与输入框。
- 大模型配置已迁移到统一设置页；AI 页只保留状态芯片和跳转入口，不再弹出配置弹窗。
- 服务器可配置有多个提供商、每个提供商多个 API Key 的提供商池；账号配置优先，其后按 `providers` 顺序回退。
- 额度不足、失效或限流时自动轮换同提供商 Key；提供商全部不可用时自动回退到下一个提供商，并按模型等价映射保持模型能力；Key 与提供商冷却后定期探活，恢复后回到最高优先级。
- 「设置 → 大模型高可用」展示并编辑回退链：提供商增删与排序、每个提供商多 Key、每 Key 接口地址/启用状态/优先级、每提供商“多 Key 高可用”开关、模型映射、冷却与探活参数；运行状态、切换与恢复记录、最近请求在「切换记录」面板查看。完整 Key 不在页面、URL、日志或数据库中出现。
- 工具调用以可折叠轨迹展示参数和结果；助手正文支持多轮对话；回复上方显示本次实际使用的提供商、模型、脱敏 Key，切换时标注原因。
- 未配置模型时显示配置引导，不允许发送消息。
- 工具可读写当前用户数据，并调用现有渲染、发布和批量任务服务。

### 3.8 设置

- 导航「设置」页分三个分类：账号与安全、大模型、大模型高可用；移动端分类横向滚动。
- 账号与安全：显示名称、头像地址、用户名/邮箱/注册时间、修改密码；修改密码后所有设备重新登录。
- 大模型：账号级接口地址、模型、API Key、温度；保存、保存并测试、清除账号配置；显示当前使用的服务器池摘要。
- 大模型高可用：服务器提供商池图形化编辑（详见 3.7）；保存后原子写入受保护配置文件并热加载，无需重启。
- 生产环境只有 `MULTIPUSH_ADMIN_USERNAMES` 中的用户可编辑服务器池；普通用户只读查看，可修改自己的账号级大模型配置。

### 3.9 批量任务

- 内容库多选后出现「批量渲染」「批量发布」按钮。
- 批量渲染选择多个平台；批量发布选择公众号（仅草稿）、知乎、微博、今日头条、豆瓣、掘金、CSDN、简书、少数派或个人博客，并选择草稿/正式发布。
- 弹窗显示任务进度、每篇状态、失败原因，以及打开排版/发布记录的链接。
- 任务在服务端顺序执行；运行中关闭弹窗不终止任务，结果持久保存。

### 3.10 素材库

- 左侧导航「素材库」位于「AI 创作」和「内容库」之间，路由 `/assets`。
- 顶部展示当前范围（全库或当前文件夹）的素材数量/占用空间以及图片、视频、文档数量；按类型筛选（全部/图片/视频/文档）和文件名搜索。
- 支持上传：
  - 图片：JPG / JPEG / PNG / WebP / GIF，单张 ≤20MB；
  - 视频：MP4 / WebM / MOV，单个 ≤200MB；
  - 文档：PDF / Word / Excel / PPT / TXT / Markdown / CSV / JSON / HTML / XML / YAML / RTF，单个 ≤50MB。
- 文件夹：支持新建、重命名、删除；可把素材移动到「未分组」或任意文件夹；删除文件夹时素材移入「未分组」，不删除素材本身。同名文件夹（不区分大小写）不允许重复。
- 素材卡片展示缩略图/类型角标/文件名/大小/时间；支持预览（图片、视频、PDF iframe、文本类文档源码）、下载、复制链接、在新标签打开、删除。
- 图片和文本类文档在小于 1MB 时可在弹窗内预览；Office 文档提示下载后查看。删除素材会同时删除文件，引用该 URL 的内容将无法显示。
- 所有上传入口（编辑器、图文工作台、视频工作台、AI 创作、发布页）共用素材表，新上传的文件会自动出现在素材库；当前所在文件夹中的上传会直接归入该文件夹。
- 素材复用：文章编辑器可通过工具栏或 `/` 菜单「从素材库插入」图片、视频和文档；图文工作台「从素材库添加」图片；视频工作台「从素材库添加视频」把已有视频加入时间线。选择器支持类型切换、文件夹筛选、搜索和分页。
- 移动端：文件夹卡片换行展示，素材卡片单列，无横向溢出。

## 4. 后端 API 契约

统一前缀 `/api`。除注册/登录/健康检查/平台元数据外都需要 `Authorization: Bearer <token>`。错误格式：

```json
{ "error": "invalid_credentials", "message": "账号或密码错误" }
```

参数校验失败返回 400，`issues` 可选。未登录 401。越权/不存在统一 404。

### 认证

- `POST /api/auth/register` body `{ username, email, password, displayName? }` → `{ token, user }`
  - 用户名 3–24 字符，允许字母数字下划线汉字；邮箱合法；密码 ≥ 8；重复用户名/邮箱 409。
- `POST /api/auth/login` body `{ account, password }` → `{ token, user }`；账号为用户名或邮箱。
- `GET /api/auth/me` → `{ user }`
- `PATCH /api/auth/me` body `{ displayName?, avatarUrl? }` → `{ user }`
- `POST /api/auth/password` body `{ currentPassword, newPassword }` → `{ ok: true }`

### 知识库

- `GET /api/books` → `{ books: Book[] }`（含 docCount，不含回收站文档）
- `POST /api/books` `{ name, description?, color? }` → `{ book }`
- `PATCH /api/books/:id` → `{ book }`
- `DELETE /api/books/:id` → `{ ok: true }`；该知识库下文档移到未分组（不删除）

### 内容

- `GET /api/contents?bookId=&favorite=true&trash=true&q=&kind=article|gallery|video&sort=updated_desc|created_desc|title_asc&page=1&pageSize=20` → `ContentListResult`
  - 默认排除回收站；`trash=true` 只返回回收站；`bookId=unfiled` 返回未分组。
- `POST /api/contents` `ContentInput`（含 `kind: "article" | "gallery" | "video"`）→ `{ content: ContentDetail }`（客户端通常显式传入“无标题文章 / 无标题图文 / 无标题视频”作为初始标题）
- `GET /api/contents/:id` → `{ content: ContentDetail }`（回收站中的文档也可读取，用于恢复前查看）
- `PATCH /api/contents/:id` `ContentInput` → `{ content: ContentDetail }`
- `DELETE /api/contents/:id` → 软删除 `{ ok: true }`；`?permanent=true` 彻底删除。
- `POST /api/contents/:id/restore` → `{ content }`
- `POST /api/contents/:id/duplicate` → `{ content }`（标题追加“副本”）
- `POST /api/contents/:id/favorite` `{ favorite: boolean }` → `{ content: ContentSummary }`

后端计算：`excerpt`（未显式提供时取纯文本前 160 字）、`wordCount`（中文按字、英文按词）、`imageCount`、`videoCount`（视频内容取时间线片段数）。标签去重、去空、最多 10 个，每个最长 24 字。

### 视频剪辑

- `GET /api/contents/:id/video` → `{ project, capability }`：时间线片段（含素材信息、入/出点、时长）与服务器 ffmpeg/ffprobe 能力。
- `PUT /api/contents/:id/video/timeline` `{ clips: [{mediaId, trimStart?, trimEnd?, duration?}] }` → `{ project }`：整体替换时间线，顺序即成片顺序；入/出点单位为秒，服务端按素材时长裁剪非法值。
- `POST /api/contents/:id/video/export` → `{ export }`：按当前时间线创建异步导出任务（服务端 ffmpeg 逐段裁剪 + 统一规格 + concat 合并）。
- `GET /api/contents/:id/video/exports` → `{ exports }`；`GET /api/video-exports/:exportId` → `{ export }`（状态/进度/输出素材）；`DELETE /api/video-exports/:exportId` 删除记录。
- `GET /api/media/:id/probe` → `{ probe }`：ffprobe 探测视频素材（时长/分辨率/音轨/编码）。
- 仅 `kind=video` 的内容支持时间线；其他内容返回 400。详见 [视频内容说明](VIDEO_CONTENT.md)。

### 媒体

- `POST /api/media` multipart 字段 `file`、可选 `folderId` → `{ media: MediaAsset }`
  - 图片：jpg/jpeg/png/webp/gif，≤20MB；视频：mp4/webm/mov，≤200MB；文档：pdf/doc/docx/xls/xlsx/ppt/pptx/txt/md/markdown/csv/json/html/htm/xml/yml/yaml/rtf，≤50MB。
  - 存储文件名随机（uuid + 扩展名），静态路径 `/uploads/<filename>`；原始文件名仅存数据库；`kind` 为 `image | video | document`，`folderId` 为空表示未分组。
- `GET /api/media?kind=&q=&folderId=&page=&pageSize=` → `{ media, total, page, pageSize }`（`folderId=unfiled` 表示未分组；默认 pageSize 100 保持旧调用兼容）
- `GET /api/media/stats?folderId=` → `{ stats: { total, images, videos, documents, bytes } }`（不传为全库，传 `unfiled` 或文件夹 ID 为当前范围）
- `PATCH /api/media/:id` `{ folderId: string | null }` → `{ media }`（移动素材到文件夹或未分组；文件夹必须属于当前用户）
- `GET /api/media/folders` → `{ folders: MediaFolder[] }`（含 `assetCount`）
- `POST /api/media/folders` `{ name }` → `{ folder }`；同名（NOCASE）返回 409 `media_folder_exists`
- `PATCH /api/media/folders/:id` `{ name }` → `{ folder }`；同名返回 409
- `DELETE /api/media/folders/:id` → `{ ok: true, moved }`（素材移到未分组，不删除素材）
- `DELETE /api/media/:id` → `{ ok: true }`（删除记录与文件；引用该 URL 的内容会失效）
- `GET /uploads/:filename` 无需鉴权（随机文件名），支持 Range（视频拖动）。

### 平台与渲染

- `GET /api/platforms` → `{ platforms: PlatformInfo[] }`
- `POST /api/renders` `{ contentId, platforms: PlatformId[], options? }` → `{ render: RenderRecord }`
  - `platforms` 必须 1–6 个、去重、合法。
  - 加载内容（含回收站）与用户信息，调用 `renderPlatforms()`。
  - 保存记录（JSON），返回完整结果。
- `GET /api/renders?contentId=` → `{ renders: RenderListItem[] }`（最近 30 条，倒序）
- `GET /api/renders/:id` → `{ render }`
- `DELETE /api/renders/:id` → `{ ok: true }`
- `PATCH /api/renders/:id/platforms/:platform` → `{ result: PlatformRender }`；接收 `{ title, html?, body?, tags, cards? }`，复用渲染器清洗和排版，保存当前平台调整。
- `DELETE /api/renders/:id/platforms/:platform` → `{ result: PlatformRender }`；移除当前平台调整，恢复此记录的生成结果。

### AI 创作与批量

- `GET /api/ai/settings` → `{ settings: AiSettings }`（不返回 Key）
- `PUT /api/ai/settings` `{ baseUrl, model, apiKey?, temperature? }` → `{ settings }`
- `POST /api/ai/settings/test` → `{ ok, message, model, routing }`
- `GET /api/ai/providers` → `{ pool: AiProviderPoolView }`（可编辑视图，Key 仅脱敏）
- `PUT /api/ai/providers` `AiProviderPoolInput` → `{ pool }`（需管理员；保存并热加载）
- `GET /api/ai/gateway` → `{ gateway: AiGatewayStatus }`（提供商/Key 状态、切换记录、最近请求，均脱敏）
- `POST /api/ai/gateway/probe` `{ providerId? }` → `{ probes, gateway }`（最小请求探活并刷新状态）
- `GET /api/ai/sessions` → `{ sessions: AiSession[] }`
- `POST /api/ai/sessions` `{ title? }` → `{ session }`
- `GET /api/ai/sessions/:id` → `{ session: AiSessionDetail }`（含消息与工具轨迹）
- `DELETE /api/ai/sessions/:id` → `{ ok: true }`
- `POST /api/ai/sessions/:id/messages` `{ message }` → `AiChatResult`
- `GET /api/batch/jobs` → `{ jobs: BatchJob[] }`
- `GET /api/batch/jobs/:id` → `{ job }`
- `POST /api/batch/render` `{ contentIds, platforms, options? }` → 202 `{ job }`
- `POST /api/batch/publish` `{ contentIds, platform, mode, coverMediaId?, options? }` → 202 `{ job }`

AI 工具在服务端按当前用户执行，发布仍复用各平台发布服务和幂等、安全校验。批量任务顺序执行并持久化每项状态，最多渲染 30 篇、发布 10 篇。

### 其他

- `GET /api/health` → `{ status: 'ok', service: 'multipush', version, uptime, time }`，无需鉴权。
- `GET /api/platforms` 需要登录（前端渲染页用）；平台元数据也可直接来自共享常量。

## 5. 渲染器内部契约

文件：`server/src/renderers/`

```ts
export interface RenderInput {
  content: ContentDetail
  platforms: PlatformId[]
  options: RenderOptions
  authorName: string
  baseUrl: string // 例：http://192.168.0.111:34080，用于把 /uploads/... 转成绝对地址
}

export async function renderPlatforms(input: RenderInput): Promise<PlatformRender[]>
```

要求：

1. 不访问外网、不依赖浏览器，纯函数 + cheerio/turndown/sanitize-html。
2. 输出 HTML 必须已清洗（无 script/iframe/事件属性），样式全部内联，适合 iframe `srcDoc` 预览；不得含 `<html>/<head>` 之外的脚本。
3. 相对媒体 URL 转绝对 URL。视频保留 `<video controls>`；不自动下载媒体。
4. 每个平台返回 `downloads`（HTML 完整文档 / Markdown / 文案），文件名安全、带平台后缀。
5. 小红书：`previewMode='cards'`（有视频时为 `'video'`）；生成 1 张封面卡 + 若干内容卡 + 结束卡；每卡正文控制阅读量（约 120–220 字），图片分配到卡片；标题 ≤20 字（超长截断并 warning）；`text` 含标题、正文、3–6 个话题标签。
6. 公众号：标题 ≤64 字；移动端字号 16px、行高 1.8、图片圆角、引用/代码块/表格有专属样式；`previewMode='article'`。
7. 知乎：标题 ≤100 字；正文 16px、行高 1.8；表格在知乎排版中转换为等价列表（草稿接口会丢表）；Markdown 用 turndown；`previewMode='article'`。
8. 微博：标题 ≤64 字、正文 ≤2000 字；`previewMode='vertical'`；双井号话题 `#话题#`，最多 9 图；返回文案 TXT、图文 HTML 与 JSON 下载。
9. 今日头条：标题 2–30 字；`previewMode='article'`；推荐流图文排版，正文 17px、行高 1.9，引用/代码/表格有专属样式；Markdown 用 turndown；返回 HTML 与 Markdown 下载。
10. 百家号：标题 2–30 字（少于 5 字给建议）；`previewMode='article'`；百度图文排版，正文 17px、行高 1.9，引用/代码/表格有专属样式；Markdown 用 turndown；返回 HTML 与 Markdown 下载。
11. 抖音：标题 ≤55 字、正文 ≤1000 字；`previewMode='vertical'`；`text` 为标题 + 正文 + 3–5 个话题标签，供直接粘贴到抖音发布页；返回文案 TXT、图文 HTML 与笔记 JSON 下载。
12. 豆瓣：标题 ≤100 字；`previewMode='article'`；日记长文排版，正文 17px、行高 1.9；支持 figure/figcaption、引用/代码/表格；返回 HTML 与 Markdown 下载。
13. 少数派：标题 ≤32 字；`previewMode='article'`；Matrix 阅读排版，正文 16px、行高 1.9，引用/代码/表格有专属样式；Markdown 用 turndown；返回 HTML 与 Markdown 下载。
14. 个人博客：标题 ≤120 字；`previewMode='article'`；Halo 主题阅读排版，正文 17px、行高 1.9；Markdown 用 turndown；返回 HTML 与 Markdown 下载。
15. 所有输出包含 `assets`（图片/视频绝对 URL，去重）、`meta`、`warnings`、`generatedAt`。
16. 空内容、仅图片、长文、包含表格/代码/任务列表时不能崩溃；渲染器应有单元测试。

## 6. UI 与代码约定

- 中文界面文案；时间用 `Intl` 格式；不使用英文占位文案。
- 复用 `globals.css` 的 token 与 `.btn/.input/.card/.modal/.tag` 等类；图标统一 `lucide-react`，尺寸 16/18/20。
- 避免引入新的 UI 框架、CSS-in-JS、状态管理库；React Context + hooks 足够。
- 所有 API 调用走 `web/src/lib/api.ts`；错误提示使用 `sonner` 的 `toast.error`。
- 不提交 `node_modules`、`.data`、构建产物；不修改其他特性的文件。
- 类型完整，`npm run typecheck` 必须通过；核心流程要有后端单测（vitest）或至少可验证的 API smoke。
- 可访问性：按钮有 `title/aria-label`，输入有 label，弹窗支持 Esc 关闭。
