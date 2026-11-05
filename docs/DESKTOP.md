# MultiPush 本地桌面版

MultiPush 桌面版是**完全本地运行**的版本：Electron 主进程内启动 Node/Express 后端，托管构建后的 React 前端，使用本机 SQLite 保存账号、内容、素材、渲染记录和发布记录。安装后不需要连接任何服务器，也不需要配置 SMTP。

## 平台与下载

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| Windows 10+ x64 | `MultiPush-Setup-<version>-x64.exe` | NSIS 安装版，可选择安装目录，创建桌面和开始菜单快捷方式 |
| Windows 10+ x64 | `MultiPush-Portable-<version>-x64.exe` | 免安装便携版 |
| macOS 12+（Intel / Apple Silicon） | `MultiPush-<version>-universal.dmg` | 通用包，拖入「应用程序」即可 |
| macOS 12+（Intel / Apple Silicon） | `MultiPush-<version>-universal-mac.zip` | ZIP 包，便于脚本分发 |

安装包发布在 [GitHub Releases](https://github.com/yuan-xin-9997/MultiPush/releases)。`SHA256SUMS.txt` 与安装包一起发布。

> 当前发布未配置商业代码签名证书。Windows SmartScreen 会提示未知发布者，macOS Gatekeeper 会阻止直接双击。请按下方安装说明手动放行，或在本地配置证书后重新签名。

## 首次使用

1. 启动 MultiPush。应用会在 `127.0.0.1` 上启动本地服务，并打开登录页。
2. 点击「立即注册」，填写用户名、邮箱、密码和确认密码。邮箱只作为本地账号标识，**不会发送验证码**。
3. 注册后自动进入内容库，直接新建文档或导入现有内容。
4. 下次启动会自动登录（JWT 和 Chromium 会话保存在本机用户目录）。

本地服务优先使用 `127.0.0.1:34180`，端口被占用时自动尝试后续端口或随机端口，并把可用端口保存到配置中。端口稳定后，导出 HTML 中的本机媒体地址在重启后仍可访问。

## 完全本地运行的含义

```
Electron 主进程
  ├─ 启动本地 Express 服务（127.0.0.1，随机/固定高位端口）
  │    ├─ /api/*        JWT REST API
  │    ├─ /uploads/*    本地媒体文件
  │    └─ 其他路由      内置 web-dist + SPA fallback
  ├─ SQLite            <userData>/data/multipush.sqlite
  └─ BrowserWindow     http://127.0.0.1:<port>
```

- 不依赖 `publish.yuan-xin.top` 或其他远程服务器。
- 不把内容上传到第三方；素材保存在本机 `data/uploads`。
- 账号由本机 SQLite 管理，注册不需要邮箱验证码。
- 自动发布仍由本机 Chrome / Edge 执行，Playwright 只启动本机浏览器，不连接云端浏览器服务。
- 微信、知乎、抖音的登录会话加密保存在本机数据目录。

## 数据位置与备份

| 平台 | 数据目录 |
| --- | --- |
| Windows | `%APPDATA%\MultiPush\data` |
| macOS | `~/Library/Application Support/MultiPush/data` |

目录内容：

```
data/
  multipush.sqlite       账号、文档、渲染与发布记录
  uploads/               图片、视频等上传素材
  .jwt-secret            登录令牌签名密钥
  .wechat-session-key    公众号会话加密密钥
  .zhihu-session-key     知乎会话加密密钥
  .douyin-session-key    抖音会话加密密钥
```

菜单「本地服务 → 打开数据目录」可直接打开。备份时请先退出应用，再复制整个 `data` 目录；恢复时关闭应用，用备份目录替换即可。

桌面窗口配置保存在上一级 `desktop-settings.json`（窗口位置、最大化状态、本地端口），不包含密码或内容。

## 从在线版迁移

- **仅迁移文档内容**：在在线版导出 Markdown / HTML / MultiPush JSON / ZIP，再在本地版内容库导入。
- **完整迁移账号、素材和平台会话**：关闭本地版，把在线服务器 `/opt/MultiPush/.data` 的内容复制到本机 `data` 目录。请确保服务器已停止写入，避免 SQLite WAL 不一致；复制后先备份原目录。
- 迁移后仍使用原用户名和密码登录。若原在线账号没有邮箱，本地版登录不受影响；本地版注册的新账号必须有邮箱标识。

## 自动发布与浏览器

编辑、渲染、预览、复制富文本和下载不需要 Chrome。以下自动发布能力需要本机安装 Chromium 系浏览器：

- 微信公众号扫码登录、草稿/正式发表
- 知乎扫码登录、草稿/发布
- 抖音扫码登录、视频/图文发布

检测顺序：

1. `WECHAT_BROWSER_PATH` / `ZHIHU_BROWSER_PATH` / `DOUYIN_BROWSER_PATH` / `CHROME_BIN` 环境变量
2. Playwright 自带 Chromium（若已安装）
3. Windows：Chrome、Edge
4. macOS：Google Chrome、Microsoft Edge、Chromium、Brave

Windows 通常自带 Edge，可直接使用；macOS 默认只有 Safari，建议安装 Google Chrome 或 Microsoft Edge。未检测到浏览器时，发布页会提示安装并允许重试，其他功能不受影响。

## 桌面端能力

- **本地服务生命周期**：启动、健康检查、异常重启、退出时关闭浏览器与 SQLite。
- **原生菜单**：打开数据目录/日志、重启本地服务、在浏览器中打开、复制本地地址、检查更新。
- **外部链接**：跨站链接使用系统默认浏览器打开。
- **下载处理**：ZIP / HTML / 图片等保存到系统「下载」目录，重名自动追加序号；完成后发送系统通知，点击通知定位文件。
- **窗口状态**：记住位置、大小和最大化状态；屏幕变化导致窗口不可见时回退默认尺寸。
- **权限最小化**：仅允许本机应用源使用剪贴板读写、通知和全屏；拒绝摄像头、麦克风、定位等权限。
- **单实例**：再次启动时聚焦已有窗口。
- **安全边界**：本地服务只监听 `127.0.0.1`，并校验 Host / Origin / `Sec-Fetch-Site`，防止其他网页通过 DNS rebinding 调用本地 API。
- **更新检查**：菜单「本地服务 → 检查更新…」读取 GitHub 最新 Release 并打开下载页；不静默安装更新。

## 开发与测试

要求 Node.js ≥ 22.12。

```bash
npm install
npm ci --prefix desktop
npm run desktop:dev
```

`desktop:dev` 会先构建 `web/dist` 和 `desktop/server/index.cjs`，再启动 Electron。开发模式下数据目录仍使用 Electron `userData`，可用 `MULTIPUSH_USER_DATA` 指向临时目录隔离测试。

冒烟测试不访问任何远程服务：

1. 启动本地服务并确认 `/api/health` 返回 `desktopMode: true`。
2. 打开注册页，确认没有邮箱验证码输入框。
3. 注册本地账号并进入内容库。
4. 确认 SQLite 数据库已创建。
5. 关闭并重新启动桌面应用，确认仍保持登录、本地数据仍在、端口 origin 不变。

```bash
npm run desktop:check
npm run desktop:smoke
```

## 构建与发布

Windows 本机构建：

```bash
npm run desktop:dist:win
```

产物在 `desktop/release/`：

- `MultiPush-Setup-<version>-x64.exe`
- `MultiPush-Portable-<version>-x64.exe`

macOS 必须在 macOS 上构建 universal 包：

```bash
npm run desktop:dist:mac
```

产物：

- `MultiPush-<version>-universal.dmg`
- `MultiPush-<version>-universal-mac.zip`

GitHub Actions：

- `.github/workflows/desktop-ci.yml`：`desktop/**`、`server/**`、`web/**`、`shared/**` 变更时在 Windows 与 macOS 上执行本地版冒烟。
- `.github/workflows/desktop-release.yml`：推送 `v*` 标签时构建两个平台，创建 GitHub Release 并上传安装包与 `SHA256SUMS.txt`。

发布步骤：

```bash
# 1. 更新 desktop/package.json、根 package.json 与工作区版本
# 2. 提交并推送
git push origin main

# 3. 创建并推送标签，触发 Release 工作流
git tag v2.0.0
git push origin v2.0.0
```

也可以手动运行 `Desktop release` 工作流，输入已存在的标签。工作流会校验 `desktop/package.json` 版本与标签一致。

## 代码签名

当前仓库不包含签名证书。正式分发前建议配置：

- Windows：`CSC_LINK` / `CSC_KEY_PASSWORD`，使用代码签名证书。
- macOS：Developer ID Application 证书、`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`，并启用 notarization。

未签名包的绕过方式：

- Windows：SmartScreen →「更多信息」→「仍要运行」。
- macOS：将应用拖入「应用程序」后右键 →「打开」；或执行 `xattr -dr com.apple.quarantine /Applications/MultiPush.app`。

## 常见问题

**启动后提示“无法连接本地服务”**

打开菜单「本地服务 → 打开日志文件」查看原因；先尝试「重启本地服务」。常见原因是端口被占用、安装目录缺少 `resources/web` 或 `server/index.cjs`、或安全软件拦截本地监听。

**第一次打开没有账号**

本地版不会预置账号。点击「立即注册」，邮箱只作为账号标识，不需要验证码。

**忘记本地账号密码**

本地版不提供邮箱找回密码。请使用注册时的密码；如确实无法登录，可在退出应用后备份并重命名 `data/multipush.sqlite`，重新注册（会丢失旧账号数据），或使用 SQLite 工具重置密码哈希。建议定期备份 `data` 目录。

**自动发布提示未安装浏览器**

安装 Google Chrome 或 Microsoft Edge 后重启应用。Windows 通常已有 Edge；macOS 需要单独安装 Chrome/Edge。

**升级后数据还在吗**

在。安装包升级不会删除 `%APPDATA%\MultiPush` 或 `~/Library/Application Support/MultiPush`。卸载应用同样不会自动删除数据目录。
