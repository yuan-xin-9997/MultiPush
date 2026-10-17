#!/usr/bin/env bash
set -euo pipefail

deploy_root=/opt/MultiPush
node_version=24.13.0
runtime="$deploy_root/.runtime/node-v$node_version-linux-x64"
export PATH="$runtime/bin:$deploy_root/.tools/node_modules/.bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$deploy_root/.browsers"
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

case "${1:-}" in
  prepare)
    test "$(uname -m)" = x86_64
    mkdir -p "$deploy_root/.runtime" "$deploy_root/.tools" "$PLAYWRIGHT_BROWSERS_PATH"
    if [[ ! -x "$runtime/bin/node" ]]; then
      download="$(mktemp -d "$deploy_root/.runtime/download.XXXXXX")"
      trap 'rm -rf -- "$download"' EXIT
      archive="node-v$node_version-linux-x64.tar.xz"
      curl --fail --location --retry 2 --connect-timeout 15 --max-time 300 --speed-time 30 --speed-limit 1024 "https://nodejs.org/download/release/v$node_version/$archive" -o "$download/$archive"
      curl --fail --location --retry 2 --connect-timeout 15 --max-time 300 --speed-time 30 --speed-limit 1024 "https://nodejs.org/download/release/v$node_version/SHASUMS256.txt" -o "$download/SHASUMS256.txt"
      (cd "$download"; grep "  $archive\$" SHASUMS256.txt | sha256sum --check --strict -)
      tar -xJf "$download/$archive" -C "$deploy_root/.runtime"
    fi
    [[ "$(node --version)" = "v$node_version" ]]
    if [[ ! -x "$deploy_root/.tools/node_modules/.bin/pnpm" ]] || [[ "$(pnpm --version)" != 11.19.0 ]]; then
      npm install --prefix "$deploy_root/.tools" --no-audit --no-fund pnpm@11.19.0
    fi
    cd "$source_root"
    pnpm install --frozen-lockfile
    pnpm exec playwright install chromium
    pnpm build
    pnpm test
    ;;
  stop)
    sudo -n /usr/bin/systemctl stop multipush.service
    ;;
  update)
    [[ "$source_root" != "$deploy_root" ]]
    [[ "$(realpath "$deploy_root")" = /opt/MultiPush ]]
    [[ "$(git -C "$source_root" remote get-url origin)" = git@github.com:yuan-xin-9997/MultiPush.git ]]
    rsync -a --delete --exclude='.git/' --exclude='.data/' --exclude='.env' --exclude='.env.*' \
      --exclude='.runtime/' --exclude='.tools/' --exclude='.browsers/' \
      --exclude='.pnpm-store/' --exclude='test-results/' --exclude='playwright-report/' \
      "$source_root/" "$deploy_root/"
    git -C "$source_root" rev-parse HEAD > "$deploy_root/DEPLOYED_COMMIT"
    ;;
  start)
    sudo -n /usr/bin/systemctl start multipush.service
    # Read only: the health check never creates accounts, tasks or platform content.
    node "$deploy_root/JenkinsConfig/health.mjs"
    ;;
  *) echo 'Usage: deploy.sh prepare|stop|update|start' >&2; exit 2 ;;
esac
