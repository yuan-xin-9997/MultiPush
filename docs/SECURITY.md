# 安全与账号保护

本文档记录 MultiPush 的账号隔离、登录保护、SSRF 防护和 AI 额度策略。部署与数据目录说明见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 账号与数据隔离

- 所有用户资源表都有 `user_id`，数据库读写始终带 `WHERE user_id = ?`；跨用户访问按 404 处理。
- 平台账号表（公众号、知乎、博客等）以 `user_id` 为主键；Halo 令牌和平台会话使用 AES-256-GCM 加密，AAD 绑定用户 ID，密钥位于 `DATA_DIR/.<platform>-session-key`（600）。
- 邀请码注册：生产环境默认需要邀请码 + 邮箱验证码；邀请码只能由 `is_admin` 账号创建。
- 管理接口（邀请码、AI 用量）要求 `is_admin`。

## 登录保护

应用层对 `/api/auth/login` 和 `/api/auth/2fa/verify` 做失败计数：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LOGIN_MAX_FAILURES` | `8` | 单账号 15 分钟内失败次数 |
| `LOGIN_IP_MAX_FAILURES` | `30` | 单 IP 15 分钟内失败次数 |
| `LOGIN_BLOCK_MINUTES` | `15` | 超限后的封禁时长 |
| `LOGIN_2FA_MAX_FAILURES` | `8` | 单账号 10 分钟内二次验证失败次数 |

超过阈值返回 `429` 与 `Retry-After`。计数保存在进程内，重启后清空；多实例部署时应改用共享存储或网关限流。

### 两步验证（TOTP）

- 设置 → 账号与安全 → 两步验证 → 开启，手动把密钥添加到 1Password / Google Authenticator / Microsoft Authenticator，再输入 6 位验证码。
- 开启后 `/api/auth/login` 先返回 `twoFactorRequired` 和 5 分钟有效的 `challenge`，前端再调用 `/api/auth/2fa/verify` 换取正式 JWT。
- 恢复码共 10 个，每个只能使用一次；服务端只保存 HMAC 哈希。
- 更换或丢失手机时，可在仍能登录的设备上关闭两步验证；全部凭据丢失时，停止服务后运行 `node scripts/reset-2fa.mjs --data-dir /opt/MultiPush/.data --username <用户名>` 清除该账号的两步验证配置，再重启服务。

### Cloudflare WAF 兜底（推荐）

应用层限流之外，建议在 Cloudflare 对登录接口再加一层 IP 限流。仓库提供脚本：

```bash
export CLOUDFLARE_API_TOKEN=...   # 需要 Zone → WAF → Edit 权限
export CLOUDFLARE_ZONE_ID=...
node scripts/cloudflare-login-ratelimit.mjs --dry-run
node scripts/cloudflare-login-ratelimit.mjs --apply
```

默认规则：`publish.yuan-xin.top` 的 `/api/auth/login`、`/api/auth/2fa/verify`、`/api/auth/reset-password`、`/api/auth/email-code`，每 IP 每 10 秒最多 5 次、超限封禁 10 秒（免费版 Cloudflare 的限流周期与封禁时长都只能是 10 秒；长期封禁由应用层负责）；可用 `MULTIPUSH_PUBLIC_HOST`、`LOGIN_LIMIT_*` 覆盖。脚本会保留其他限流规则，只替换同名规则。

## SSRF 防护

用户可控的 URL（Halo 博客地址、AI 接口地址、正文外链图片、B 站文章图片）统一经过 `server/src/network-guard.ts`：

- 仅允许 HTTP/HTTPS，禁止 URL 内嵌用户名密码；
- 解析域名并拒绝任何私有、回环、链路本地、保留或组播地址；
- 连接时固定已校验的 DNS 结果，降低 DNS rebinding 风险；每次重定向重新校验并丢弃跨域认证头；
- 限制响应大小与超时。

生产环境默认禁止私网目标。确需连接局域网 Halo 或局域网模型网关时，显式设置 `MULTIPUSH_ALLOW_PRIVATE_NETWORK=1`，并接受相应风险。

## AI 额度与使用范围

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_POOL_ACCESS` | 生产 `admin`，开发 `all` | 谁可以使用服务器提供商池 |
| `AI_POOL_USERS` | 空 | 单独放行的普通账号（逗号分隔），无需授予管理员 |
| `AI_POOL_DAILY_LIMIT` | `0` | 非管理员每天可用的服务器池请求数，0 为不限额 |
| `AI_POOL_DAILY_TOKENS` | `0` | 非管理员每天可用的服务器池 Token 总量（输入+输出），0 为不限额 |

- `admin` 模式：普通账号必须配置自己的 API Key，服务器的 Key 不会被消耗；管理员账号在 `is_admin` 或 `MULTIPUSH_ADMIN_USERNAMES` 中。
- `all` 模式：所有账号可回退服务器池，非管理员受每日额度限制。
- `AI_POOL_USERS`：在 `admin` 模式下单独放行指定用户名；这些账号仍受每日额度限制，但不能编辑提供商池。
- 额度按实际服务器池请求（含失败重试）与 Token 消耗计数，管理员不受限制；账号有自己的 Key 时优先用自己的 Key，只有真正回退服务器池时才计入。Token 额度在每次回退前校验，单次请求可能让用量略微超过上限。
- 例：`AI_POOL_ACCESS=all` + `AI_POOL_DAILY_TOKENS=2000000` 表示每个普通账号每天最多消耗 200 万服务器池 Token。
- 设置 → AI 用量（仅管理员）按账号查看请求数、失败数、Token 与最近使用时间；数据来自 `ai_provider_requests`。
- 普通账号仍可在“设置 → 大模型高可用”只读查看池配置，但不能修改。

## 其他建议

- 生产 `.data` 保持 700，数据库和密钥文件 600，备份同样按密钥处理。
- 定期在 Halo 后台轮换个人令牌，只授予文章与附件权限。
- 上传素材是随机 UUID 的 capability URL，拿到链接即可匿名访问；不要把敏感文件放在素材库。
