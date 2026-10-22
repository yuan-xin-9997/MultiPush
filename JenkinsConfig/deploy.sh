#!/usr/bin/env bash
#
# MultiPush deployment helper.
#
# Usage:
#   bash JenkinsConfig/deploy.sh prepare
#   bash JenkinsConfig/deploy.sh deploy
#
# This script publishes build artifacts and the Playwright runtime. It never deletes /opt/MultiPush/.data or
# /opt/MultiPush/.env. Run it from a checkout after a successful
# `npm run build`, preferably as the same user that owns /opt/MultiPush
# (normally the `jenkins` user).

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/MultiPush}"
SERVICE_NAME="${SERVICE_NAME:-multipush.service}"
UNIT_FILE="${UNIT_FILE:-/etc/systemd/system/multipush.service}"

log()  { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] WARN: %s\n' "$*" >&2; }
die()  { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
用法: bash JenkinsConfig/deploy.sh <prepare|deploy>

  prepare  只做校验并打印部署计划，不写入任何文件
  deploy   校验后同步构建产物到 /opt/MultiPush

可选环境变量:
  DEPLOY_ROOT   部署根目录（默认 /opt/MultiPush）
  SERVICE_NAME  systemd 服务名（默认 multipush.service）
  UNIT_FILE     systemd unit 路径（默认 /etc/systemd/system/multipush.service）
USAGE
}

[ "$#" -eq 1 ] || { usage; exit 2; }
MODE="$1"
case "$MODE" in
  prepare|deploy) ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac

command -v rsync >/dev/null 2>&1 || die "未找到 rsync，请先安装（sudo apt-get install -y rsync）"
command -v realpath >/dev/null 2>&1 || die "未找到 realpath（coreutils 组件）"

case "$DEPLOY_ROOT" in
  /*) ;;
  *) die "DEPLOY_ROOT 必须是绝对路径: $DEPLOY_ROOT" ;;
esac

DEPLOY_REAL="$(realpath -m -- "$DEPLOY_ROOT")"
SOURCE_REAL="$(realpath -e -- "$SOURCE_ROOT")"

[ "$DEPLOY_REAL" != "/" ] || die "拒绝部署到根目录 /"
[ "$DEPLOY_REAL" != "$SOURCE_REAL" ] || die "部署根目录不能与源码目录相同: $DEPLOY_REAL"

# Reject nested source/deploy trees to avoid accidental recursive copies.
case "$DEPLOY_REAL/" in
  "$SOURCE_REAL"/*) die "部署根目录不能位于源码目录内: $DEPLOY_REAL" ;;
esac
case "$SOURCE_REAL/" in
  "$DEPLOY_REAL"/*) die "源码目录不能位于部署根目录内: $SOURCE_REAL" ;;
esac

# Required build outputs and files.
for required in \
  "$SOURCE_ROOT/package.json" \
  "$SOURCE_ROOT/server/dist/index.js" \
  "$SOURCE_ROOT/node_modules/playwright-core/package.json" \
  "$SOURCE_ROOT/web/dist/index.html" \
  "$SOURCE_ROOT/JenkinsConfig/health.mjs"; do
  [ -f "$required" ] || die "缺少构建产物或必要文件: $required（请先执行 npm run build）"
done

if git -C "$SOURCE_ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
  GIT_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD)"
else
  GIT_COMMIT="unknown"
  warn "源码目录不是 git 仓库，DEPLOYED_COMMIT 将写入 unknown"
fi

DATA_DIR="$DEPLOY_REAL/.data"
ENV_FILE="$DEPLOY_REAL/.env"

check_target_writable() {
  local target="$1"
  local parent

  if [ -e "$target" ]; then
    [ -d "$target" ] || die "部署路径已存在但不是目录: $target"
    [ -w "$target" ] || die "当前用户 $(id -un) 对 $target 没有写权限；Jenkins 任务应以 jenkins 用户运行"
    return 0
  fi

  parent="$(dirname -- "$target")"
  while [ ! -e "$parent" ]; do
    parent="$(dirname -- "$parent")"
  done
  [ -w "$parent" ] || die "当前用户 $(id -un) 无法在 $parent 下创建 $target；请检查目录权限"
}

check_target_writable "$DEPLOY_REAL"

if [ "$MODE" = "prepare" ]; then
  log "部署预检通过（未修改任何文件）"
  log "  源码目录:   $SOURCE_REAL"
  log "  部署根目录: $DEPLOY_REAL"
  log "  待部署提交: $GIT_COMMIT"
  log "  后端产物:   server/dist/index.js"
  log "  前端产物:   web/dist"
  log "  数据目录:   $DATA_DIR（保留，不修改）"
  log "  环境文件:   $ENV_FILE（保留，不修改）"
  exit 0
fi

if [ -e "$DEPLOY_REAL" ]; then
  [ -d "$DEPLOY_REAL" ] || die "部署路径已存在但不是目录: $DEPLOY_REAL"
else
  log "创建部署根目录: $DEPLOY_REAL"
  mkdir -p -- "$DEPLOY_REAL" || die "无法创建部署根目录: $DEPLOY_REAL"
fi

[ -w "$DEPLOY_REAL" ] || die "当前用户 $(id -un) 对 $DEPLOY_REAL 没有写权限；Jenkins 任务应以 jenkins 用户运行"

if [ "$(id -u)" -eq 0 ]; then
  warn "当前以 root 运行；新文件将归 root 所有。建议以 jenkins 用户运行，或部署后修正属主。"
fi

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  warn "$SERVICE_NAME 正在运行。Jenkins 流程会先停服；手动部署请先执行 sudo systemctl stop $SERVICE_NAME"
fi

# The data directory must exist before systemd starts the service because the
# unit grants write access to exactly this path. Existing contents are never
# modified and the mode of an existing directory is left untouched.
if [ ! -d "$DATA_DIR" ]; then
  install -d -m 700 -- "$DATA_DIR"
  log "已创建数据目录（700）: $DATA_DIR"
else
  log "保留现有数据目录: $DATA_DIR"
fi

if [ -f "$ENV_FILE" ]; then
  log "保留现有环境文件: $ENV_FILE"
else
  warn "未发现 $ENV_FILE（可选；EnvironmentFile=- 允许缺失）"
fi

install -d -m 755 -- "$DEPLOY_REAL/server" "$DEPLOY_REAL/server/dist" \
  "$DEPLOY_REAL/web" "$DEPLOY_REAL/web/dist" "$DEPLOY_REAL/JenkinsConfig" \
  "$DEPLOY_REAL/node_modules/playwright-core"

log "同步公众号浏览器运行库..."
rsync -a --delete --chmod=D755,F644 -- \
  "$SOURCE_ROOT/node_modules/playwright-core/" "$DEPLOY_REAL/node_modules/playwright-core/"

log "同步后端构建产物..."
rsync -a --delete --chmod=D755,F644 --itemize-changes -- \
  "$SOURCE_REAL/server/dist/" "$DEPLOY_REAL/server/dist/"

log "同步前端构建产物..."
rsync -a --delete --chmod=D755,F644 --itemize-changes -- \
  "$SOURCE_REAL/web/dist/" "$DEPLOY_REAL/web/dist/"

install -m 644 -- "$SOURCE_REAL/JenkinsConfig/health.mjs" "$DEPLOY_REAL/JenkinsConfig/health.mjs"
install -m 644 -- "$SOURCE_REAL/package.json" "$DEPLOY_REAL/package.json"

# Normalize permissions only for files managed by this script. In particular,
# never recurse into .data and never touch .env.
chmod 755 -- "$DEPLOY_REAL" "$DEPLOY_REAL/server" "$DEPLOY_REAL/server/dist" \
  "$DEPLOY_REAL/web" "$DEPLOY_REAL/web/dist" "$DEPLOY_REAL/JenkinsConfig"
find "$DEPLOY_REAL/server/dist" "$DEPLOY_REAL/web/dist" -type d -exec chmod 755 {} +
find "$DEPLOY_REAL/server/dist" "$DEPLOY_REAL/web/dist" -type f -exec chmod 644 {} +
chmod 644 -- "$DEPLOY_REAL/JenkinsConfig/health.mjs" "$DEPLOY_REAL/package.json"

COMMIT_TMP="$DEPLOY_REAL/.DEPLOYED_COMMIT.tmp.$$"
trap 'rm -f -- "$COMMIT_TMP"' EXIT
printf '%s\n' "$GIT_COMMIT" > "$COMMIT_TMP"
chmod 644 -- "$COMMIT_TMP"
mv -f -- "$COMMIT_TMP" "$DEPLOY_REAL/DEPLOYED_COMMIT"
trap - EXIT

if [ -r "$UNIT_FILE" ]; then
  if cmp -s -- "$SOURCE_REAL/JenkinsConfig/multipush.service" "$UNIT_FILE"; then
    log "systemd unit 与仓库版本一致: $UNIT_FILE"
  else
    warn "systemd unit 与仓库版本不一致（或尚未安装为本仓库版本）: $UNIT_FILE"
    warn "请管理员执行: sudo install -m 644 $SOURCE_REAL/JenkinsConfig/multipush.service $UNIT_FILE && sudo systemctl daemon-reload"
  fi
else
  warn "未读取到 $UNIT_FILE；首次部署请管理员安装 unit 后执行 daemon-reload/enable"
fi

BACKEND_SIZE="$(du -h -- "$DEPLOY_REAL/server/dist/index.js" | cut -f1)"
WEB_FILE_COUNT="$(find "$DEPLOY_REAL/web/dist" -type f | wc -l | tr -d ' ')"

log "部署完成"
log "  提交:     $GIT_COMMIT"
log "  后端:     $DEPLOY_REAL/server/dist/index.js ($BACKEND_SIZE)"
log "  前端:     $DEPLOY_REAL/web/dist ($WEB_FILE_COUNT 个文件)"
log "  数据:     $DATA_DIR（保留，不清理）"
log "  环境:     $ENV_FILE（保留，不清理）"
log "  版本记录: $DEPLOY_REAL/DEPLOYED_COMMIT"
log "  启动:     sudo -n systemctl start $SERVICE_NAME"
log "  健康检查: node JenkinsConfig/health.mjs"

if [ -d "$DEPLOY_REAL/apps" ]; then
  warn "检测到遗留目录 $DEPLOY_REAL/apps，本脚本不会自动删除；确认无用后可手动清理"
fi
