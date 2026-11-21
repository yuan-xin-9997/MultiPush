# Twick 剪辑工作台技术验证（Spike）

## 目标

评估用开源 [Twick Studio](https://github.com/ncounterspecialist/twick) 替换 MultiPush 现有视频片段列表式剪辑器的可行性。验证范围：

1. 能否在现有 React + Vite 前端中加载 Twick Studio；
2. 能否把现有 `video_projects.timeline_json` 的双片段时间线映射成 Twick 多轨项目；
3. 能否自动保存 Twick `ProjectJSON` 并持续维护旧版兼容的 `clips`；
4. 评估依赖体积、运行时错误和后续需要补齐的能力。

## 已验证

- 新增试验路由 `/video/:id/studio`，从旧版视频工作台「新版剪辑（试验）」进入。
- 使用两个真实 MP4 片段（带裁剪、顺序、时长）生成 Twick `ProjectJSON`：
  - 视频元素写入 `props.src`、`props.time`（源入点）、`s/e`（时间线区间）；
  - `metadata.mediaId` 用于回写旧版兼容片段；
  - 项目包含 `assets` 清单，便于后续导出器读取素材。
- Twick Studio 正常渲染时间线、画布、素材面板和右侧 Composition 面板；页面无 `pageerror`。
- 自动保存会把 `ProjectJSON` 写入 `video_projects.studio_json`，同时把从视频元素推导出的 `clips` 写回 `timeline_json`；旧版导出、发布、渲染注入和 AI 时间线工具仍能读到片段列表。
- 验证代码：`VideoStudioPage.tsx`、`VideoStudioService`、`POST/PUT /api/contents/:id/video/studio`。
- 截图为 `artifacts/twick-spike/studio.png`（1600×1000）。

## 当前限制

### 1. 素材库还没有接 MultiPush

Twick 媒体面板默认使用 IndexedDB。当前试验把已有片段作为种子写入 IndexedDB，所以能显示已有视频，但：

- 在 Twick 里上传的新素材只存在浏览器 IndexedDB，不会进入 MultiPush 素材库；
- 新素材的 `blob:` URL 无法被服务端导出或兼容片段识别。

正式接入需要实现一个 `BaseMediaManager`，把 `getItems/search/addItem/deleteItem` 接到 MultiPush 的 `/api/media`，并处理视频上传和封面缩略图。

### 2. 成片导出仍走旧版

Twick 顶部 Export 当前会保存项目并返回旧版工作台；本试验没有接 Twick 渲染器。因此：

- 视频轨道的裁剪、排序、拆分可以回写旧版并导出；
- 文字、字幕、贴纸、特效、转场、多轨画面等 Twick 项目内容暂时不参与成片。

正式接入有两条路：

- `@twick/render-server`：Node + Puppeteer + FFmpeg，适合长视频/服务端批量导出，但会增加 Chromium/FFmpeg 依赖和部署复杂度；
- `@twick/browser-render`：WebCodecs + FFmpeg.wasm，无需服务端渲染，受浏览器内存和时长限制，适合短内容/桌面版。

导出完成后仍需登记到现有 `video_exports` 和 `media`，才能保持“最近一次成片注入渲染、发布页可选成片”的既有链路。

### 3. Twick Studio 的 720p 硬编码

Twick Studio 头部会把项目分辨率固定为 720×1280（竖屏）或 1280×720（横屏），并通过 `localStorage.orientation` 记忆。试验目前按首个素材横竖屏设置该值，因此预览/导出为 720p；如果要 1080p，需要 fork/补丁 Studio Header，或者隐藏其分辨率控件并自行管理 `setVideoResolution`。

### 4. 依赖和构建体积

- `web` 主包仍按路由懒加载 Twick，首屏 JS 约 1.48 MB（gzip 416 KB），没有明显变大；
- Twick 页面单独 chunk 约 5.1 MB（gzip 2.0 MB）；
- 安装 Twick Studio 会带入 `puppeteer`、`@twick/renderer`、React 18 嵌套副本等约 390 MB 的 `node_modules` 增量。浏览器构建不会把 Puppeteer 打进包，但 CI/部署必须设置 `PUPPETEER_SKIP_DOWNLOAD=1`，否则安装会额外下载 Chromium。
- 许可为 Twick Sustainable Use License：允许在应用内商用/自托管/修改，不允许把 Twick 本身当成独立 SDK 转售。当前确认仅个人/内部使用。

### 5. 其他

- Twick 的 `New Project` 会清空时间线；试验在服务端加了「空时间线不允许保存」的保护，避免误覆盖旧片段，但仍建议正式接入时隐藏/替换该按钮。
- 1600×1000 视口下时间线底部略被裁切，需要按实际布局微调 `.twick-editor-container` 高度或 Studio CSS。
- Twick 样式会加载 Google Fonts 等外部字体，离线/内网环境需要本地化字体或移除 `@import`。

## 下一步建议

1. **媒体桥接**：实现 MultiPush `BaseMediaManager`，支持列出、上传、删除素材，替换种子方案。
2. **导出桥接**：先选 `@twick/render-server` 或 `@twick/browser-render`，跑通“Twick 项目 → MP4 → video_exports → 渲染/发布”闭环。
3. **1080p/项目尺寸**：补丁或替换 Studio Header，支持 1080×1920 / 1920×1080。
4. **AI 与兼容层**：继续从视频轨推导 `clips`，为文字/字幕/多轨信息设计新的 AI 工具契约（旧工具只认识 `clips`）。
5. **灰度上线**：保留旧编辑器入口，新工作台先作为试验入口，跑通真实发布后再切换默认入口。

## 运行方式

```bash
cd /Users/xinyuan/dev/MultiPush/.agents/worktrees/spike-twick-video-editor
npm install
npm run dev
```

打开某条视频内容，在旧版视频工作台点击「新版剪辑（试验）」，或直接访问 `/video/:id/studio`。

如果只需要浏览器端验证、不跑 Twick 服务端渲染：

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm ci
```

## 结论

Twick Studio 的核心编辑器可以嵌入现有 React 应用，并且时间线自动保存、旧版兼容片段回写这条主链路已经跑通。它适合作为后续替换的 UI 基础，但目前还不能直接替换旧版：**素材库桥接和成片导出是必须补齐的两块，720p/依赖体积/许可也需要确认**。
