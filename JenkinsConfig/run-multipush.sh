#!/usr/bin/env bash
#
# MultiPush launcher.
#
# 今日头条会拒绝无头浏览器的保存/发布请求（code 7050「保存失败」），所以头条
# 适配器必须用有头 Chrome 运行。Linux 服务器没有物理显示，需要 Xvfb 提供虚拟
# 显示：有 DISPLAY 时直接启动；没有 DISPLAY 但安装了 xvfb-run 时自动包一层。
set -euo pipefail

NODE_BIN="${NODE_BIN:-/usr/bin/node}"
APP_ENTRY="${APP_ENTRY:-/opt/MultiPush/server/dist/index.js}"

if [ -n "${DISPLAY:-}" ]; then
  exec "$NODE_BIN" "$APP_ENTRY"
fi

if command -v xvfb-run >/dev/null 2>&1; then
  echo "[multipush] DISPLAY 未设置，使用 xvfb-run 启动虚拟显示（今日头条发布需要）" >&2
  exec xvfb-run -a --server-args="-screen 0 1600x1000x24" "$NODE_BIN" "$APP_ENTRY"
fi

echo "[multipush] 警告：未检测到 DISPLAY，也未安装 xvfb-run。其他平台不受影响，但今日头条的草稿/发布会被平台拒绝（code 7050）。" >&2
exec "$NODE_BIN" "$APP_ENTRY"
