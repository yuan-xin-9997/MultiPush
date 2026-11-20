# 站外链接在各平台的处理

MultiPush 的正文清洗层保留 `<a href>`，但各平台编辑器对站外链接的策略不同。渲染器和发布器需要按平台分别处理，避免出现「链接文字还在、地址已经丢了」的情况。

| 平台 | 渲染器 | 发布后的站外链接 | 当前处理 |
| --- | --- | --- | --- |
| 个人博客（Halo） | 保留 `<a>` | 可点击 | 无需额外处理 |
| 知乎 | 保留 `<a>` | 可点击（知乎会包装成站内跳转） | 发布时校验链接仍在 |
| 微信公众号 | 保留 `<a>` | 有外链权限时可点击；无权限时微信会去掉 href | `prepareWechatLinks` 在发布时降级为「文字（完整地址）」 |
| 今日头条 | 保留 `<a>` | 头条号编辑器会剥离站外 `<a>` | `preserveExternalLinksAsText` 在渲染时降级为可复制地址 |
| 百家号 | 保留 `<a>` | 普通账号的站外链接常被过滤 | `preserveExternalLinksAsText` 在渲染时降级为可复制地址 |
| 掘金 / CSDN / 简书 / 豆瓣 / 少数派 | 保留 `<a>` | 以平台审核为准 | 渲染器不主动剥离 |
| 微博 / 抖音 / 小红书 | 纯文本 caption | 没有可点击 href，地址不会自动进入 caption | 按各平台短文/卡片形态处理；需要时在 caption 里手动补充地址 |

## 今日头条 / 百家号

这两个平台的编辑器会丢弃站外 `<a>`。渲染器在输出 HTML 前调用：

```ts
preserveExternalLinksAsText(prepared.html, { allowedHosts: ['toutiao.com'] })
```

效果：

- 保留原链接文字和内部富文本；
- 在文字后追加 `（完整 URL）`；
- 站内链接、锚点、`mailto:` / `tel:` 不动；
- 原文已经是 URL 时不重复追加；
- 产生渲染提示，说明有多少个外链被转成了可复制地址。

## 微信公众号

公众号是否保留可点击外链取决于账号权限，所以不能在渲染阶段无条件降级。发布器读取编辑器里的 `can_use_hyperlink` / `can_use_appmsg_outer_url`：有权限保留链接，没有权限时把 `<a>` 换成 `文字（完整 URL）`，并通过发布记录提示转换数量。

## 维护要求

新增平台或修改发布器时，至少确认三件事：

1. 渲染结果里是否还有 `<a href>`；
2. 平台保存后回读是否仍有 href（或平台是否把它改写成站内跳转）；
3. 如果平台会丢弃 href，是否已经把完整地址保留为可复制文本。

相关测试：

- `server/test/link-fallback.test.ts`
- `server/test/renderers.test.ts`
- `server/test/wechat-browser.test.ts`
- `server/test/zhihu-content.test.ts`
