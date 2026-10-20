# MultiPush 部署文档

本文档描述 MultiPush 从 GitHub 到生产服务器 `/opt/MultiPush` 的自动部署、手动操作、备份、回滚与排障。应用代码与业务接口见 `docs/PRODUCT_SPEC.md`，Jenkins 配置位于 `JenkinsConfig/`。

## 1. 部署架构

```text
GitHub main
   │  Jenkins Poll SCM: H/30 * * * *
   ▼
Jenkins built-in 节点（192.168.0.111，与生产服务同机）
   │  checkout → npm ci → typecheck/test → npm run build
   │  stop multipush.service
   │  bash JenkinsConfig/deploy.sh deploy
   │  start + health.mjs
   │  rsync（只传构建产物）
   ▼
/opt/MultiPush
   ├── server/dist/index.js      # esbuild 单文件后端，无需 node_modules
   ├── web/dist/                 # Vite 前端静态文件
   ├── JenkinsConfig/health.mjs  # 服务器本地健康检查
   ├── package.json              # 版本/元数据，不用于生产安装
   ├── DEPLOYED_COMMIT           # 最近成功部署的完整 commit
   ├── .data/                    # SQLite、uploads、JWT secret（永久保留）
   └── .env                      # 可选环境变量（永久保留）
   │
   ▼
systemd multipush.service（User=jenkins）→ 0.0.0.0:34080
   ├── /api/*      后端 API
   ├── /uploads/*  上传文件
   └── 其他 GET    web/dist 静态文件 + SPA 回退
```

关键假设：

- Jenkins 的 `built-in` 节点就是生产主机；健康检查默认访问 `127.0.0.1:34080`。
- Jenkins 以 `jenkins` 用户运行，`/opt/MultiPush` 归 `jenkins`，因此部署不需要 sudo；只有 `systemctl stop/start multipush.service` 使用免密 sudo。
- Jenkins 不写 `/etc/systemd/system`；unit 由管理员安装。`deploy.sh` 只检测差异并提示。

如果以后把构建迁到独立 agent，需要额外解决产物传输和健康检查地址问题，不能直接套用本文档的 `127.0.0.1` 检查。

## 2. 生产目录与持久化数据

| 路径 | 内容 | 部署时处理 |
| --- | --- | --- |
| `/opt/MultiPush/server/dist/index.js` | 后端单文件构建产物 | `rsync --delete` 替换 |
| `/opt/MultiPush/web/dist/` | 前端静态文件 | `rsync --delete` 替换 |
| `/opt/MultiPush/JenkinsConfig/health.mjs` | 服务器端健康检查脚本 | `install` 覆盖 |
| `/opt/MultiPush/package.json` | 应用元数据 | `install` 覆盖 |
| `/opt/MultiPush/DEPLOYED_COMMIT` | 最近部署的 commit | 原子写入 |
| `/opt/MultiPush/.data/` | `multipush.sqlite`（含 WAL/SHM）、`uploads/`、`.jwt-secret` | **绝不删除、不改权限** |
| `/opt/MultiPush/.env` | 可选环境变量 | **绝不删除、不改权限** |
| `/opt/MultiPush/apps/` | 旧版本遗留目录（如有） | 不自动删除 |

`rsync --delete` 只作用于 `server/dist/` 和 `web/dist/` 两个子目录，不会影响部署根目录下的 `.data`、`.env` 或遗留目录。

## 3. 服务器首次准备

以下命令在 Ubuntu 24.04 生产主机（`192.168.0.111`）上以有 sudo 权限的管理员执行。Jenkins 用户已存在，以下步骤只需首次执行或迁移时执行。

### 3.1 基础组件检查

```bash
node --version        # 需 >= 22.12，已核实 v22.23.3
npm --version         # 已核实 10.9.9
rsync --version
id jenkins
getent passwd jenkins
```

unit 中写死了 `ExecStart=/usr/bin/node`。如果 `command -v node` 不是 `/usr/bin/node`（例如使用 nvm），请调整 unit，或为 `/usr/bin/node` 建立指向实际二进制的链接。不要在 Jenkins 任务中临时 `source nvm`，因为 systemd 和 Jenkins 的非交互 shell 环境不同。

Jenkins 的 `built-in` 节点需要能直接执行 `node`、`npm`、`rsync`，并且 PATH 中包含它们。可用 Jenkins 用户验证：

```bash
sudo -u jenkins bash -lc 'command -v node npm rsync && node -v && npm -v'
```

### 3.2 目录与权限

```bash
# 仅首次执行；已有目录时 install -d 不会清空内容
sudo install -d -o jenkins -g jenkins -m 755 /opt/MultiPush
sudo install -d -o jenkins -g jenkins -m 700 /opt/MultiPush/.data

# 验证 Jenkins 用户可写
sudo -u jenkins test -w /opt/MultiPush && echo "deploy root writable"
sudo -u jenkins test -w /opt/MultiPush/.data && echo "data dir writable"
```

注意：

- 不要在 `/opt/MultiPush` 下执行 `npm install`，生产不需要 `node_modules`。
- 不要对 `.data` 执行 `chmod -R 755` 或 `chown -R` 作为日常部署步骤；数据目录只允许服务用户访问。
- 如果 `/opt/MultiPush` 已存在且属主不对，先确认没有其他应用在使用，再修正属主：

```bash
sudo chown jenkins:jenkins /opt/MultiPush
sudo chown -R jenkins:jenkins /opt/MultiPush/.data   # 仅在确认属主错误时执行
```

### 3.3 可选的环境文件

`.env` 可省略。未提供 `JWT_SECRET` 时，应用会在首次启动时生成 `/opt/MultiPush/.data/.jwt-secret`（权限 600）并持久化，重启后 token 不会失效。

需要覆盖配置时：

```bash
if [ ! -e /opt/MultiPush/.env ]; then
  sudo -u jenkins install -m 600 /dev/null /opt/MultiPush/.env
  sudo -u jenkins tee /opt/MultiPush/.env >/dev/null <<'EOF'
# JWT_SECRET=replace-with-a-long-random-string
# 可覆盖 unit 中的 HOST/PORT/DATA_DIR/WEB_DIST，但通常不需要
EOF
fi
sudo chmod 600 /opt/MultiPush/.env
# 后续修改请使用 sudoedit 或 sudo -u jenkins 编辑该文件
```

`EnvironmentFile` 使用 systemd 语法，不是 shell 脚本：不要写 `export`；含空格的值需要加引号。`.env` 中的同名变量会覆盖 unit 的 `Environment=` 设置，因此不要随意修改 `PORT`/`DATA_DIR`/`WEB_DIST`。

### 3.4 安装 systemd unit

从仓库检出目录安装（不要从 `/opt/MultiPush/JenkinsConfig` 找，部署脚本只同步 `health.mjs` 到生产目录）：

```bash
sudo install -m 644 /path/to/checkout/JenkinsConfig/multipush.service \
  /etc/systemd/system/multipush.service
sudo systemctl daemon-reload
sudo systemctl enable multipush.service
```

首次部署前**不要** `start`：此时还没有 `server/dist/index.js`，服务会失败。`enable` 只设置开机自启；第一次 Jenkins 构建部署完成后，流水线会负责启动。

检查 unit：

```bash
systemctl cat multipush.service
systemctl is-enabled multipush.service
```

更新 unit 时重复 `install` + `daemon-reload`，然后 `restart`。`deploy.sh` 会对比 `/etc/systemd/system/multipush.service` 与仓库版本；不一致时输出安装命令，但不会自动写入。

### 3.5 网络与端口

服务直接监听 `0.0.0.0:34080`，同时提供 API、上传文件和前端静态页面，不假设存在 Nginx 反向代理。

```bash
# 本机健康检查（首次部署成功后）
curl -fsS http://127.0.0.1:34080/api/health

# 监听检查
ss -ltn | grep 34080

# 如需从局域网直接访问，可放行防火墙（按实际安全策略决定）
sudo ufw status
sudo ufw allow 34080/tcp
```

## 4. Jenkins 配置

### 4.1 Git 凭据

现有凭据 ID：`truthanalysis-github-ssh`。

- 类型：SSH Username with private key。
- 用户名一般为 `git`。
- 私钥对应 GitHub 仓库 `yuan-xin-9997/MultiPush` 的 deploy key（或有读权限的账号）。
- 私钥若设置 passphrase，Jenkins 需要同时保存 passphrase。
- 不要在仓库中保存私钥、Jenkins 管理员密码或 API token。

验证方式：在 Jenkins 凭据页面确认 ID，或查看任务配置中的 `credentialsId`。`JenkinsConfig/job-config.xml` 只引用 ID，不包含密钥。

### 4.2 创建/核对任务

任务名：`MultiPush`，类型 Pipeline。配置项：

| 配置 | 值 |
| --- | --- |
| Definition | Pipeline script from SCM |
| SCM | Git |
| Repository URL | `git@github.com:yuan-xin-9997/MultiPush.git` |
| Credentials | `truthanalysis-github-ssh` |
| Branch Specifier | `*/main` |
| Script Path | `JenkinsConfig/Jenkinsfile` |
| Lightweight checkout | 勾选 |
| Build Triggers | Poll SCM：`H/30 * * * *` |
| Build Discarder | 保留最近 20 次构建 |
| Disable concurrent builds | 勾选 |
| 参数化构建 | 不需要 |

`Jenkinsfile` 中也声明了 `pollSCM('H/30 * * * *')`、`disableConcurrentBuilds()`、`logRotator`、`timestamps()` 和 45 分钟超时。任务配置与 Jenkinsfile 保持一致即可。

### 4.3 built-in 节点要求

- 标签 `built-in`，且 Jenkins 与生产服务同机。
- Jenkins 用户为 `jenkins`，对 `/opt/MultiPush` 有写权限。
- PATH 中可找到 `node`（22+）、`npm`、`rsync`、`git`、`bash`。
- 可免密执行：

```bash
sudo -n systemctl stop multipush.service
sudo -n systemctl start multipush.service
```

验证 sudoers：

```bash
sudo -u jenkins sudo -n -l
```

如果 `sudo -n` 要求密码，流水线会在 Stop service / Start & Health 阶段失败。sudoers 授权应覆盖 Jenkinsfile 中使用的命令形式（`systemctl stop multipush.service`、`systemctl start multipush.service`），并由管理员通过 `visudo` 维护。

### 4.4 流水线阶段

| 阶段 | 命令 | 失败影响 |
| --- | --- | --- |
| Checkout | `checkout scm` | 不触碰生产 |
| Install | `npm ci` | 不触碰生产；需要已提交的 `package-lock.json` |
| Verify | `npm run typecheck`、`npm test` | 不触碰生产 |
| Build | `npm run build`、`bash JenkinsConfig/deploy.sh prepare` | 不触碰生产；预检部署路径与产物 |
| Stop service | `sudo -n systemctl stop multipush.service`，并确认已停止 | 服务可能已停，需人工排查/启动 |
| Deploy | `bash JenkinsConfig/deploy.sh deploy` | 服务保持停止；旧产物可能部分更新 |
| Start & Health | `sudo -n systemctl start multipush.service` + `health.mjs` | 自动打印 `systemctl status` 和 `journalctl` |

失败时构建日志会输出排查命令和最近 100 行 journal。部署失败后不要反复重试而不看日志；确认 unit、权限、端口和 `.data` 状态后再启动。

### 4.5 自动触发与手动触发

- 轮询：Jenkins 每 30 分钟检查 `main` 是否有新提交；有则构建。轮询有最多约 30 分钟延迟。
- 手动：任务页面 **Build Now**。
- 可选：配置 GitHub webhook 可缩短延迟，但不要删除 SCM 轮询作为兜底。
- Jenkinsfile 变更在 `main` 上被轮询到后生效；如果 Jenkinsfile 本身有语法错误，构建会在读取流水线时失败，不会停服。
- API 触发（需要 Jenkins 用户和 API token；如启用了 CSRF，需附带 crumb）：

```bash
curl -fsS -u "$JENKINS_USER:$JENKINS_TOKEN" -X POST \
  "http://192.168.0.111:8080/job/MultiPush/build"
```

## 5. 日常部署

### 5.1 自动部署

1. 合并/推送到 `main`。
2. 等待轮询或点击 **Build Now**。
3. 流水线完成构建、停服、部署、启动和健康检查。
4. 在 Jenkins 日志确认 `health.mjs` 输出 `{"status":"ok","service":"multipush",...}`。

### 5.2 手动部署（推荐仍走 Jenkins）

如果只是需要立即发布，使用 **Build Now** 即可，避免手工漏掉 typecheck/test/build。

绕过 Jenkins 时，必须在部署主机上先构建，再停服、部署、启动：

```bash
cd /path/to/checkout
npm ci
npm run build
bash JenkinsConfig/deploy.sh prepare   # 预检，不写文件

sudo -n systemctl stop multipush.service
bash JenkinsConfig/deploy.sh deploy
sudo -n systemctl start multipush.service
node JenkinsConfig/health.mjs
```

注意：

- `deploy.sh` 以当前用户身份写入 `/opt/MultiPush`。普通管理员 `yuanxin` 不是目录属主，直接运行会失败；应在 Jenkins 任务中执行，或以 `jenkins` 用户运行并确保其能读取构建目录。
- 不要用 root 运行；否则新文件归 root，`jenkins` 可能无法写入 `.data`。
- 手动部署不会自动执行 `npm ci`/build，缺少产物时 `prepare` 会直接报错。
- 如果 `deploy.sh` 提示 unit 不一致，按提示安装并 `daemon-reload`，然后重启服务。

### 5.3 deploy.sh 做了什么

`deploy.sh` 只支持 `prepare` 和 `deploy` 两个子命令：

1. `set -euo pipefail`；检查 `rsync`、`realpath`。
2. 解析源码根目录与部署根目录的 `realpath`，拒绝根目录 `/`、源码与部署同目录、以及二者互相嵌套。
3. 校验 `server/dist/index.js`、`web/dist/index.html`、`JenkinsConfig/health.mjs`、`package.json` 存在。
4. 读取 `git rev-parse HEAD`。
5. 确保 `/opt/MultiPush` 和 `.data` 存在（首次创建 `.data` 为 700；已存在则完全不改）。
6. `rsync -a --delete --chmod=D755,F644` 同步 `server/dist/` 和 `web/dist/`。
7. `install` 部署 `health.mjs` 和 `package.json`。
8. 只对受管目录/文件设置 755/644；不递归 `.data`，不改 `.env`。
9. 原子写入 `DEPLOYED_COMMIT`。
10. 对比 systemd unit，输出差异提示；检测遗留 `apps/` 但不会删除。
11. 输出部署摘要。

脚本是幂等的；重复执行同样的产物不会产生额外影响。它不会停止/启动服务，服务生命周期由 Jenkinsfile 或人工命令控制。

### 5.4 首次部署验收

```bash
systemctl is-enabled multipush.service
systemctl is-active multipush.service
cat /opt/MultiPush/DEPLOYED_COMMIT
curl -fsS http://127.0.0.1:34080/api/health
```

浏览器访问 `http://192.168.0.111:34080/`，完成一次注册/登录、创建文档、上传图片，再执行一次部署，确认文档和图片仍在（验证 `.data` 未被删除）。

## 6. 数据备份与恢复

### 6.1 备份范围

必须备份：

- `/opt/MultiPush/.data/`：SQLite 数据库、WAL/SHM、`uploads/`、`.jwt-secret`。
- `/opt/MultiPush/.env`（如存在）。
- 可选的 systemd unit 与当前 `DEPLOYED_COMMIT`，便于恢复环境。

不要只备份 `multipush.sqlite` 而忽略 `uploads/` 和 `.jwt-secret`；否则图片/视频丢失，已有登录 token 也会失效。

### 6.2 冷备份（推荐）

停止服务后备份，保证 SQLite 与上传文件一致：

```bash
STAMP="$(date +%Y%m%d-%H%M%S)"
sudo install -d -m 700 /var/backups/multipush

sudo systemctl stop multipush.service
sudo tar -C /opt/MultiPush -czf "/var/backups/multipush/data-$STAMP.tar.gz" .data
if [ -f /opt/MultiPush/.env ]; then
  sudo cp -a /opt/MultiPush/.env "/var/backups/multipush/env-$STAMP"
fi
sudo cp -a /opt/MultiPush/DEPLOYED_COMMIT "/var/backups/multipush/DEPLOYED_COMMIT-$STAMP" 2>/dev/null || true
sudo systemctl start multipush.service
```

检查备份并复制到异地：

```bash
sudo tar -tzf "/var/backups/multipush/data-$STAMP.tar.gz" | head
sudo journalctl -u multipush.service -n 20 --no-pager
```

`.data` 可能因视频上传而很大，备份前检查磁盘空间；备份完成后把归档同步到另一台机器或对象存储。

### 6.3 在线备份（可选）

服务运行时直接复制 SQLite 文件可能拿到不一致的快照（WAL 模式）。如果必须在线备份，优先使用 SQLite 的 `.backup`：

```bash
STAMP="$(date +%Y%m%d-%H%M%S)"
sqlite3 /opt/MultiPush/.data/multipush.sqlite \
  ".backup '/var/backups/multipush/multipush-$STAMP.sqlite'"
```

数据库快照与 `uploads/` 仍需分别处理，且上传目录可能变化。对完整恢复而言，冷备份更可靠。若命令不存在，安装 `sqlite3` 或直接使用冷备份。

### 6.4 恢复

```bash
STAMP=20260101-030000   # 替换为实际备份时间

sudo systemctl stop multipush.service
sudo mv /opt/MultiPush/.data "/opt/MultiPush/.data.before-restore-$STAMP"
sudo tar -C /opt/MultiPush -xzf "/var/backups/multipush/data-$STAMP.tar.gz"
sudo chown -R jenkins:jenkins /opt/MultiPush/.data
sudo chmod 700 /opt/MultiPush/.data

# 如备份了 .env
sudo cp -a "/var/backups/multipush/env-$STAMP" /opt/MultiPush/.env
sudo chown jenkins:jenkins /opt/MultiPush/.env
sudo chmod 600 /opt/MultiPush/.env

sudo systemctl start multipush.service
node /opt/MultiPush/JenkinsConfig/health.mjs
```

确认无误后再删除 `.data.before-restore-*`。如果恢复后版本不匹配（旧数据库配新代码或反之），先回滚代码或恢复对应版本的数据备份。

## 7. 回滚

### 7.1 确认当前版本

```bash
cat /opt/MultiPush/DEPLOYED_COMMIT
sudo journalctl -u multipush.service -n 50 --no-pager
```

`DEPLOYED_COMMIT` 是最近一次成功部署的提交，不是“上一个版本”。上一个版本需从 Jenkins 构建历史、`git log` 或发布记录中确定。

### 7.2 回滚代码

优先采用“重新构建旧提交 + 同一部署脚本”的方式，不要手工覆盖单个文件：

```bash
# 1. 先备份数据（见第 6 节），尤其是包含数据库迁移的版本
# 2. 在 Jenkins 主机的任务工作区检出旧提交，重新构建
OLD_SHA=<上一版本完整或短 commit>

sudo -u jenkins bash -lc "
  set -e
  cd /var/lib/jenkins/workspace/MultiPush
  git fetch origin
  git checkout --detach $OLD_SHA
  npm ci
  npm run build
  sudo -n systemctl stop multipush.service
  bash JenkinsConfig/deploy.sh deploy
  sudo -n systemctl start multipush.service
  node JenkinsConfig/health.mjs
"
```

实际工作区路径以 Jenkins 任务配置为准（可能是 `$JENKINS_HOME/workspace/MultiPush`）。如果 Jenkins 用户没有交互式 shell，`bash -lc` 仍可执行，但 `.bashrc` 中的 nvm 配置不应成为依赖；Node/npm 必须在系统 PATH 中。

回滚后：

```bash
sudo -u jenkins bash -lc '
  cd /var/lib/jenkins/workspace/MultiPush
  git checkout main
'
```

注意：任务仍每 30 分钟轮询 `main`。如果 `main` 未回退，下一次构建会把新版本重新部署回来。需要保持旧版本时，应暂停任务、创建回滚提交（`git revert`）或调整分支。生产环境通常更推荐 `git revert` 后重新构建，而不是长期让工作区停留在旧提交。

### 7.3 数据库兼容性

应用启动时会执行建表/迁移。旧代码可能不认识新表或新字段；回滚代码前：

1. 停止服务并备份 `.data`。
2. 确认目标版本与当前数据库 schema 兼容。
3. 如不兼容，恢复与旧版本匹配的数据备份；这会丢失备份之后的新数据，需提前评估。

不要为了回滚而删除 `.data` 或 `multipush.sqlite`。

## 8. 排障

### 8.1 服务与日志

```bash
sudo systemctl status multipush.service --no-pager -l
sudo journalctl -u multipush.service -n 200 --no-pager
sudo journalctl -u multipush.service -f
sudo systemctl cat multipush.service
```

常见问题：

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `status=203/EXEC` | `/usr/bin/node` 不存在或不可执行 | 检查 Node 安装路径，调整 unit 或建立链接 |
| `status=200/CHDIR` | `WorkingDirectory` 不存在 | 确认 `/opt/MultiPush` 存在且权限正确 |
| 启动即退出 | 缺少 `server/dist/index.js` | 先完成部署；检查 rsync 是否成功 |
| `EACCES` 写 `.data` | 数据目录属主/权限错误 | `sudo chown -R jenkins:jenkins .data`，保留 700 |
| `ReadWritePaths` 相关失败 | `.data` 不存在 | 运行 `deploy.sh deploy` 创建，或手工 `install -d -o jenkins -g jenkins -m 700` |
| 端口占用 | 旧进程或其他服务占用 34080 | `ss -ltnp | grep 34080`、`sudo lsof -i :34080` |
| 健康检查 30 次失败 | 服务未启动、启动慢、端口/路径错误 | 看 journal、`curl -v`、确认 `.env` 没有覆盖 PORT |

### 8.2 健康检查

```bash
curl -v http://127.0.0.1:34080/api/health
node /opt/MultiPush/JenkinsConfig/health.mjs
```

正常响应应包含：

```json
{"status":"ok","service":"multipush","version":"...","uptime":...,"time":"..."}
```

`health.mjs` 会校验 `status === "ok"` 和 `service === "multipush"`，两个字段任一不匹配都视为失败。若服务正常但检查失败，确认检查的是正确主机/端口；远程检查可设置：

```bash
HEALTH_URL=http://192.168.0.111:34080/api/health node JenkinsConfig/health.mjs
```

### 8.3 部署相关

| 现象 | 排查 |
| --- | --- |
| `npm ci` 失败 | 确认 `package-lock.json` 已提交且与 `package.json` 同步；Node/npm 版本符合要求 |
| `npm: command not found` | Jenkins 的 PATH 不含 Node；检查 built-in 节点环境或 NodeJS 插件配置 |
| `/opt/MultiPush` 写权限拒绝 | `id`、`ls -ld /opt/MultiPush`；Jenkins 应以 `jenkins` 运行 |
| `sudo -n` 失败 | `sudo -u jenkins sudo -n -l`；检查 sudoers 是否允许 stop/start |
| `deploy.sh` 报缺少产物 | 先执行 `npm run build`；确认在工作区根目录执行 |
| 部署脚本报“部署根目录不能与源码目录相同/嵌套” | 检查 `DEPLOY_ROOT`；生产应为 `/opt/MultiPush`，不要从部署目录内运行 |
| unit 不一致警告 | 按提示 `sudo install -m 644 ... && sudo systemctl daemon-reload`，然后重启 |
| 部署成功但页面仍旧 | 停服失败导致旧进程仍在；检查 Stop service 阶段和 `systemctl show -p ActiveEnterTimestamp` |
| 页面 404 / 空白 | `web/dist/index.html` 是否存在、unit 的 `WEB_DIST` 是否正确、浏览器缓存 |
| 上传失败 | `.data/uploads` 权限、磁盘空间、请求大小限制（图片 20MB、视频 200MB） |
| 磁盘满 | `df -h`、`du -sh /opt/MultiPush/.data`；清理旧备份，不要删数据库 |

### 8.4 查看部署记录

```bash
cat /opt/MultiPush/DEPLOYED_COMMIT
stat /opt/MultiPush/server/dist/index.js
stat /opt/MultiPush/web/dist/index.html
systemctl show -p ActiveEnterTimestamp multipush.service
```

如果 `ActiveEnterTimestamp` 早于部署时间，说明服务没有真正重启。执行：

```bash
sudo systemctl restart multipush.service
node /opt/MultiPush/JenkinsConfig/health.mjs
```

## 9. 设计说明与约束

### 9.1 为什么不部署 node_modules

后端构建使用 esbuild：

```text
esbuild src/index.ts --bundle --platform=node --target=node22 --format=cjs \
  --outfile=dist/index.js
```

`--bundle` 会把 Express、bcryptjs、cheerio、zod 等运行时依赖打进 `server/dist/index.js`；`node:sqlite` 等 Node 内置模块由运行时提供。因此生产只需要：

- Node.js 22.12+；
- `server/dist/index.js`；
- `web/dist/`；
- 可写的 `.data/`。

生产不需要 `npm install`、`node_modules` 或 TypeScript/构建工具。`package.json` 被复制到 `/opt/MultiPush` 仅用于版本/元数据。如果未来引入原生扩展（native addon）或依赖运行时按路径查找的文件，单文件 bundle 假设需要重新评估。

前端是 Vite 构建的静态文件，由同一个 Node 服务按 `WEB_DIST` 托管；API、上传文件和前端同源，不需要额外 Web 服务器。

### 9.2 只部署必要文件

`deploy.sh` 明确只同步：

- `server/dist/` → `/opt/MultiPush/server/dist/`
- `web/dist/` → `/opt/MultiPush/web/dist/`
- `JenkinsConfig/health.mjs`
- `package.json`
- `DEPLOYED_COMMIT`

不会同步源码、测试、`node_modules`、`.env`、`.data`、`.git` 或旧的 `apps/`。`rsync --delete` 被限制在两个 dist 目录内，避免误删持久化数据。

### 9.3 服务安全设置

`multipush.service` 的关键项：

- `User=jenkins` / `Group=jenkins`：最小权限运行。
- `Restart=on-failure`、`RestartSec=3`：异常退出自动重启；`systemctl stop` 不会触发重启。
- `TimeoutStopSec=20`、`KillSignal=SIGTERM`：给应用优雅关闭数据库的时间。
- `UMask=0077`：新上传文件默认 600、目录 700。
- `NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectHome=true`、`PrivateDevices=true`、`ProtectKernelTunables/Modules/ControlGroups=true`、`RestrictSUIDSGID=true`、`LockPersonality=true`：常规加固。
- `ProtectSystem=full`：`/usr`、`/boot`、`/etc` 只读。
- `ReadWritePaths=/opt/MultiPush/.data`：显式只允许写数据目录。
- `EnvironmentFile=-/opt/MultiPush/.env`：文件缺失不阻止启动。

如果未来应用需要写 `.data` 之外的路径（例如新的缓存目录），必须同步更新 unit 的 `ReadWritePaths`，否则会得到只读文件系统错误。

### 9.4 Jenkins 流水线约束

- 只在 Jenkins 上执行 `npm ci`，使用 lockfile 保证可重复构建。
- 不执行 Docker、Playwright、浏览器安装或端到端测试，避免生产主机依赖膨胀。
- typecheck/test 在停服之前执行；构建失败不会影响线上服务。
- 部署阶段不停服，停服由独立阶段完成，便于日志定位。
- 健康检查最多 30 次、每次间隔 1 秒，避免启动瞬间误判。
- 禁止并发构建，整体超时 45 分钟，保留最近 20 次构建。
- `JenkinsConfig/Jenkinsfile` 和 `JenkinsConfig/deploy.sh` 由 `.gitattributes` 强制 LF，避免 Windows 检出后出现 `\r` 导致脚本无法执行。

## 10. 上线验收清单

- [ ] Jenkins 凭据 `truthanalysis-github-ssh` 可用，任务能从 SSH SCM 检出 `main`。
- [ ] `MultiPush` 任务使用 `JenkinsConfig/Jenkinsfile`，轮询 `H/30 * * * *`。
- [ ] built-in 节点可执行 `node`、`npm`、`rsync`，`jenkins` 可写 `/opt/MultiPush`。
- [ ] `jenkins` 可免密 `systemctl stop/start multipush.service`。
- [ ] unit 已安装、`daemon-reload`、`enable`，且与仓库版本一致。
- [ ] 一次完整构建通过：Install、Verify、Build、Stop、Deploy、Start & Health。
- [ ] `curl http://127.0.0.1:34080/api/health` 返回 `status=ok`、`service=multipush`。
- [ ] 浏览器可打开 `http://192.168.0.111:34080/`，注册/登录/上传正常。
- [ ] 再次部署后，原有用户、文档和上传文件仍在（`.data` 保留）。
- [ ] `.env` 未被部署覆盖，权限仍为 600。
- [ ] `DEPLOYED_COMMIT` 与本次构建 commit 一致。
- [ ] 冷备份可成功生成并校验；回滚流程已在测试环境演练。
