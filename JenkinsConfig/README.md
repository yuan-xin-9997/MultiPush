# JenkinsConfig

MultiPush 的 Jenkins 流水线与生产部署配置。这里只存放运维文件，不包含应用代码。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `Jenkinsfile` | Declarative Pipeline：检出 → 安装 → 校验 → 构建 → 停服 → 部署 → 启动与健康检查 |
| `deploy.sh` | 幂等部署脚本，仅同步构建产物到 `/opt/MultiPush`；支持 `prepare` 预检 |
| `multipush.service` | 生产 systemd unit（用户 `jenkins`，端口 `34080`） |
| `health.mjs` | 轮询 `/api/health`（最多 30 次、间隔 1 秒），校验 `status=ok`、`service=multipush` |
| `job-config.xml` | 现有 `MultiPush` Jenkins 任务的配置快照，供审计或灾难重建 |

详细服务器准备、备份、回滚和排障见 [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)。

## 已核实的运行环境

- Jenkins：`http://192.168.0.111:8080`，任务 `MultiPush` 已存在。
- Jenkins 任务：Pipeline script from SCM，仓库 `git@github.com:yuan-xin-9997/MultiPush.git`，凭据 `truthanalysis-github-ssh`，分支 `*/main`，脚本路径 `JenkinsConfig/Jenkinsfile`，30 分钟轮询。
- 构建节点：`built-in`（Jenkins 与生产服务在同一台 Ubuntu 24.04 主机上）。
- Node.js v22.23.3（`/usr/bin/node`）、npm 10.9.9、rsync 可用。
- 生产目录 `/opt/MultiPush` 归 `jenkins` 用户所有；`multipush.service` 以 `jenkins` 运行。
- Jenkins 用户可通过免密 sudo 执行 `systemctl stop/start multipush.service`；不能假设其可写 `/etc/systemd/system`。

> 如果 Jenkins 不在生产主机上，`built-in` 节点上的 `127.0.0.1:34080` 健康检查会失败。此时应改用部署目标可访问的 `HEALTH_URL`，或把任务放到生产主机的 agent 上。当前环境不涉及这种拆分。

## 流水线行为

1. **Checkout**：`checkout scm` 拉取 `main`。
2. **Install**：`npm ci`（依赖根目录 `package-lock.json`，必须已提交）。
3. **Verify**：`npm run typecheck`、`npm test`；任一失败都不会停服。
4. **Build**：`npm run build`（前端 `web/dist`，后端 esbuild 单文件 `server/dist/index.js`），随后 `deploy.sh prepare` 做部署预检（不写文件）。
5. **Stop service**：`sudo -n systemctl stop multipush.service || true`，随后确认服务确实已停止。
6. **Deploy**：`bash JenkinsConfig/deploy.sh deploy`，只 rsync 构建产物，保留 `.data` 与 `.env`。
7. **Start & Health**：启动服务，`node JenkinsConfig/health.mjs` 最多等待约 30 秒。

约束：不执行 Docker、Playwright、浏览器安装；不向生产同步 `node_modules`。整体超时 45 分钟，保留最近 20 次构建，禁止并发。

## Jenkins 任务配置（现有任务核对项）

在 `MultiPush` → Configure 中确认：

- **Definition**：Pipeline script from SCM
- **SCM**：Git
  - Repository URL：`git@github.com:yuan-xin-9997/MultiPush.git`（SSH，不是 HTTPS）
  - Credentials：`truthanalysis-github-ssh`
  - Branch Specifier：`*/main`
- **Script Path**：`JenkinsConfig/Jenkinsfile`
- **Lightweight checkout**：勾选（任务配置中为 `true`）
- **Build Triggers**：Poll SCM，`H/30 * * * *`
- **Build Discarder**：保留最近 20 次
- **Disable concurrent builds**：勾选
- 不需要参数化构建

`Jenkinsfile` 内同样声明了 `pollSCM`、并发禁用和构建保留策略；两处保持一致即可。轮询触发的部署延迟最多约 30 分钟，需要立即发布时使用 **Build Now**。

### 凭据

- Jenkins 凭据 ID：`truthanalysis-github-ssh`
- 类型：SSH Username with private key（用户名通常为 `git`）
- 私钥需在 GitHub 仓库 `yuan-xin-9997/MultiPush` 中登记为 deploy key（或使用有读权限的机器用户）
- 私钥不要提交到仓库；如重新生成，同时更新 GitHub 与 Jenkins

### 用 job-config.xml 重建

仅在任务丢失或需要审计时使用。导入前先备份现有配置：

```bash
curl -fsS -u "$JENKINS_USER:$JENKINS_TOKEN" \
  "http://192.168.0.111:8080/job/MultiPush/config.xml" \
  -o MultiPush-config-backup.xml
```

新建任务时向 `/createItem?name=MultiPush` POST，已有任务则 POST 到 `/job/MultiPush/config.xml`：

```bash
curl -fsS -u "$JENKINS_USER:$JENKINS_TOKEN" \
  -X POST -H 'Content-Type: application/xml' \
  --data-binary @JenkinsConfig/job-config.xml \
  "http://192.168.0.111:8080/job/MultiPush/config.xml"
```

凭据不会写入 XML，Jenkins 只保存凭据 ID。

## 首次安装 systemd unit

unit 安装在 `/etc/systemd/system`，需要管理员权限，`deploy.sh` 不会自动写入，只会在检测到差异时提示。

```bash
sudo install -m 644 /path/to/checkout/JenkinsConfig/multipush.service \
  /etc/systemd/system/multipush.service
sudo systemctl daemon-reload
sudo systemctl enable multipush.service
```

首次部署前不要 `start`（此时还没有 `server/dist/index.js`）。先让 Jenkins 完成一次构建；流水线会在部署后启动服务。若手动准备，也可在部署完成后执行：

```bash
sudo systemctl start multipush.service
curl -fsS http://127.0.0.1:34080/api/health
```

unit 关键点：`User=jenkins`、`WorkingDirectory=/opt/MultiPush`、`ExecStart=/usr/bin/node /opt/MultiPush/server/dist/index.js`、`DATA_DIR=/opt/MultiPush/.data`、`WEB_DIST=/opt/MultiPush/web/dist`、`EnvironmentFile=-/opt/MultiPush/.env`、`Restart=on-failure`、`ProtectSystem=full` + `ReadWritePaths=/opt/MultiPush/.data`、`UMask=0077`。

更新 unit 后：

```bash
sudo systemctl daemon-reload
sudo systemctl restart multipush.service
```

## 手动部署

优先使用 Jenkins **Build Now**（会完整执行校验、构建、停服、部署、启动）。需要绕过 Jenkins 时：

```bash
# 1. 先构建
npm ci
npm run build

# 2. 预检（不写文件）
bash JenkinsConfig/deploy.sh prepare

# 3. 停服、部署、启动（在部署主机上执行）
sudo -n systemctl stop multipush.service
bash JenkinsConfig/deploy.sh deploy
sudo -n systemctl start multipush.service

# 4. 健康检查
node JenkinsConfig/health.mjs
```

注意事项：

- `deploy.sh` 需要以对 `/opt/MultiPush` 有写权限的用户运行（通常是 `jenkins`）。如果当前是 `yuanxin`，请通过 Jenkins 执行，或使用 `sudo -u jenkins` 并确保其能读取构建目录。
- 不要以 root 运行部署脚本；新建文件会变成 root 所有，导致 `jenkins` 无法写入 `.data`。
- 直接部署前必须已经成功执行 `npm run build`，否则 `prepare`/`deploy` 会报缺少产物。
- `deploy.sh` 不会删除遗留的 `/opt/MultiPush/apps/`；确认无用后手工清理。

## 回滚

`/opt/MultiPush/DEPLOYED_COMMIT` 记录最近一次成功部署的完整 git commit。回滚时在 Jenkins 主机上检出旧提交、重新构建，再走同样的停服/部署/启动/健康检查流程。数据库迁移通常是向前的，回滚代码前务必先备份 `.data`。详细步骤见 `docs/DEPLOYMENT.md`。

## 快速排障

```bash
sudo systemctl status multipush.service --no-pager -l
sudo journalctl -u multipush.service -n 100 --no-pager
curl -v http://127.0.0.1:34080/api/health
cat /opt/MultiPush/DEPLOYED_COMMIT
ss -ltn | grep 34080
```

- 健康检查失败：先看 `journalctl`，再确认端口、`.data` 权限和 unit 是否为最新版本。
- `npm ci` 失败：确认 `package-lock.json` 已提交且与 `package.json` 一致。
- `sudo -n` 失败：检查 Jenkins 用户的 sudoers 是否仍允许 `systemctl stop/start multipush.service`。
- 部署成功但仍是旧版本：确认停服阶段没有失败，`systemctl show -p ActiveEnterTimestamp multipush.service` 应晚于部署时间。
- unit 与仓库不一致：按 `deploy.sh` 输出的 `sudo install ... && daemon-reload` 命令更新。
