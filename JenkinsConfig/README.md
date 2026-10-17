# Jenkins 部署

- 任务名：`MultiPush`，Pipeline script from SCM。
- SSH 仓库：`git@github.com:yuan-xin-9997/MultiPush.git`，分支 `*/main`。
- 脚本：`JenkinsConfig/Jenkinsfile`，复用 Jenkins 的 `truthanalysis-github-ssh` 凭据。
- SCM 轮询 `H/30 * * * *`：每30分钟检查，有新提交才执行；禁止同任务并发部署。
- 部署目录 `/opt/MultiPush`，systemd 服务 `multipush.service`。

在工作区拉取准确提交，下载并校验项目专用 Node 24.13.0，安装 pnpm 11.19.0、依赖和 Chromium，构建、测试通过后才停服，随后同步代码并启动、只读检查静态页面和 RPC。构建失败不会停止现有服务；同步或启动失败需要查看日志处理，不宣称自动回滚。

更新保留 `.data`（数据库、素材和账号登录）、`.env`、运行时和浏览器目录。不会复制开发机登录状态或密码。Jenkins 执行用户需有该项目目录写权限，以及仅针对本服务的 `systemctl stop/start` sudo 权限。Linux 需安装 `xvfb` 和 Playwright Chromium 系统依赖。

服务默认监听 `127.0.0.1:34080`，通过 `/opt/MultiPush/.env` 设置 `TURBOPUSH_PORT=35080` 后重启可更换端口。当前应用没有远程访问认证，使用 SSH 转发：

```sh
ssh -L 34080:127.0.0.1:34080 yuanxin@192.168.0.111
```

然后访问本机 `http://127.0.0.1:34080`。本机已有同端口服务时，先关闭它或改用其他本地端口；应用的同源校验要求浏览器端口与服务端口一致。Linux 的账号扫码窗口运行在服务器 Xvfb 内，远程交互登录需要另外配置可访问的显示会话；本流水线不迁移Windows账号登录或启动公开发布测试。

日志：`journalctl -u multipush.service`。部署版本：`/opt/MultiPush/DEPLOYED_COMMIT`。

## 本次配置检查

Jenkins 任务已创建：<http://192.168.0.111:8080/job/MultiPush/>。Jenkinsfile 官方校验、SSH 凭据连接检查、Linux Bash 语法、systemd unit 和 sudoers 语法检查均通过；项目专用 Node 24.13.0 与 pnpm 11.19.0 已安装，系统 Node 未修改。

当前任务临时停用，因为 GitHub main 尚无本地 Web 实现和 JenkinsConfig 文件。待确认提交范围并推送后，启用任务，运行首轮部署，再确认构建日志、服务健康和轮询基线。尚未执行真实流水线构建、启动应用或验证 Linux 浏览器依赖；不会把配置语法通过视为部署成功。`job-config.xml` 是源码准备好后使用的启用状态配置模板。
