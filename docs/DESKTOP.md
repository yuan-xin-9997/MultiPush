# MultiPush 桌面客户端

MultiPush 桌面客户端使用 Electron 封装现有 Web 应用，支持 Windows 与 macOS。客户端不复制后端、不创建本地数据库：内容、账号、登录会话、渲染结果和发布记录仍保存在 MultiPush 服务器上。

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

1. 启动 MultiPush。
2. 在「服务器地址」填写 MultiPush 服务：
   - 公网默认：`https://publish.yuan-xin.top`
   - 局域网：`http://192.168.0.111:34080`
   - 本机开发：`http://127.0.0.1:34080`
3. 点击「测试连接」确认 `/api/health` 返回 `service=multipush`，再点击「连接」。
4. 进入登录页后使用原有账号登录。Chromium 会按服务器 origin 隔离 Cookie 与 localStorage。

可从菜单「连接 → 切换服务器…」修改地址；「连接 → 在浏览器中打开」会用系统浏览器打开当前服务器。

## 桌面端能力

- **服务器连接向导**：首次启动、连接失败或手动切换服务器时显示；支持 HTTP/HTTPS、路径前缀和自动去除 `/api/health`。
- **原生菜单**：macOS 应用菜单、编辑菜单、视图缩放、全屏、开发者工具、检查更新。
- **外部链接**：跨站链接使用系统默认浏览器打开，避免在应用内丢失登录状态。
- **下载处理**：ZIP / HTML / 图片等下载保存到系统「下载」目录，重名自动追加序号；完成后发送系统通知，点击通知定位文件。
- **窗口状态**：记住窗口位置、大小和最大化状态；屏幕变化导致窗口不可见时回退到默认尺寸。
- **权限最小化**：仅允许应用源使用剪贴板读写、通知和全屏；拒绝摄像头、麦克风、定位等权限。
- **单实例**：再次启动时聚焦已有窗口。
- **更新检查**：菜单「连接 → 检查更新…」读取 GitHub 最新 Release 并打开下载页；不静默安装更新。

## 安全设计

- 主窗口加载远程页面时 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`，远程页面不能访问 Node.js 或 Electron API。
- 只有本地 `setup.html` 加载 `setup-preload.cjs`，并校验 IPC 调用来源必须是 `file://`。
- 导航白名单限定为当前服务器同源（支持 HTTP→HTTPS 同主机升级）；其他 URL 一律交给系统浏览器。
- 禁止 `webview`，不开放自定义协议；证书错误不会绕过。
- 服务器地址、窗口状态保存在 Electron `userData/desktop-settings.json`，不保存密码、JWT 或发布凭据。登录 Cookie / localStorage 由 Chromium 会话目录管理，可按服务器地址隔离。

数据目录位置：

- Windows：`%APPDATA%\MultiPush`
- macOS：`~/Library/Application Support/MultiPush`

## 本地开发与测试

要求 Node.js ≥ 22.12。

```bash
npm run desktop:install
npm run desktop:dev
```

`desktop:dev` 会传递 `--setup`，强制显示连接向导。若桌面依赖尚未安装，先运行 `desktop:install`。

冒烟测试不访问线上服务，使用本地 HTTP fixture 验证：

1. 连接向导加载并预填 `MULTIPUSH_SERVER`。
2. 错误地址返回错误状态。
3. 正确地址通过 `/api/health` 校验并显示服务版本。
4. 点击连接后主窗口加载 fixture 页面。

```bash
npm run desktop:check
npm run desktop:smoke
```

测试通过 `MULTIPUSH_USER_DATA` 使用临时目录，不会污染真实客户端配置。

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

- `.github/workflows/desktop-ci.yml`：`desktop/**` 变更时在 Windows 与 macOS 上执行安装、语法检查和 Playwright Electron 冒烟。
- `.github/workflows/desktop-release.yml`：推送 `v*` 标签时构建两个平台，创建 GitHub Release 并上传安装包与 `SHA256SUMS.txt`。

发布步骤：

```bash
# 1. 更新 desktop/package.json、根 package.json 与工作区版本
# 2. 提交并推送
git push origin main

# 3. 创建并推送标签，触发 Release 工作流
git tag v1.1.0
git push origin v1.1.0
```

也可以手动运行 `Desktop release` 工作流，输入已存在的标签。工作流会校验 `desktop/package.json` 版本与标签一致，避免安装包版本错位。

## 代码签名

当前仓库不包含签名证书。正式分发前建议配置：

- Windows：`CSC_LINK` / `CSC_KEY_PASSWORD`，使用代码签名证书。
- macOS：Developer ID Application 证书、`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`，并启用 notarization。

未签名包的绕过方式：

- Windows：SmartScreen →「更多信息」→「仍要运行」。
- macOS：将应用拖入「应用程序」后右键 →「打开」；或执行 `xattr -dr com.apple.quarantine /Applications/MultiPush.app`。

## 常见问题

**连接向导提示“该地址不是可用的 MultiPush 服务”**

确认地址指向 MultiPush 服务根路径，且 `/api/health` 返回 JSON：

```bash
curl https://publish.yuan-xin.top/api/health
```

**macOS 提示应用已损坏或无法验证开发者**

这是未签名/未公证导致。右键打开或移除 quarantine 属性；不要关闭系统级 Gatekeeper。

**下载文件没有弹出保存对话框**

桌面端默认保存到系统「下载」目录，重名时自动追加 `(1)`、`(2)`。下载完成后点击系统通知可定位文件。

**切换服务器后需要重新登录**

这是预期行为。登录状态按 origin 隔离，不同服务器不会共享 JWT 或 Cookie。
