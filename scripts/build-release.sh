#!/usr/bin/env bash
#
# JShell 一键构建 + 打包脚本（macOS / Windows）
#
# 用法：
#   ./scripts/build-release.sh                 # 默认：build + macOS(arm64,x64)，Windows 交给 CI
#   ./scripts/build-release.sh mac             # 只打 macOS
#   ./scripts/build-release.sh win             # 只打 Windows
#   ./scripts/build-release.sh --skip-build    # 复用已有 out/，不重新 build
#   ./scripts/build-release.sh --no-smoke      # 跳过打包版冒烟
#
# 依赖：Node 22+（见 .nvmrc / engines）；首次会从国内镜像下载 Electron 二进制。
set -euo pipefail

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------- 镜像与签名
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
export CSC_IDENTITY_AUTO_DISCOVERY="false"

DO_MAC=1
DO_WIN=1
SMOKE=1
BUILD=1
for a in "$@"; do
  case "$a" in
    mac) DO_WIN=0 ;;
    win) DO_MAC=0 ;;
    --no-smoke) SMOKE=0 ;;
    --skip-build) BUILD=0 ;;
    --help|-h)
      sed -n '2,12p' "$0"; exit 0 ;;
  esac
done

VERSION=$(node -p "require('./package.json').version")
echo "==> 版本 ${VERSION}"

# ---------------------------------------------------------------- 构建
if [ "$BUILD" = "1" ]; then
  echo "==> 构建（typecheck + electron-vite build）"
  npm run build
fi

# ---------------------------------------------------------------- 打包
if [ "$DO_MAC" = "1" ]; then
  echo "==> 打包 macOS（arm64 + x64）"
  node scripts/build-all.mjs --mac --arch arm64,x64 --skip-build
fi

if [ "$DO_WIN" = "1" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    # 不在这里用 --no-sign-edit 兜底：那样打出来的 exe 图标与产品名全是 Electron 默认值
    echo "==> 跳过 Windows：macOS 上交叉打包无法写入 exe 图标与版本资源"
    echo "    请推送到 main 由 CI 的 windows-latest 产出，或用 --docker（需 Docker）"
  else
    echo "==> 打包 Windows（x64，原生环境）"
    node scripts/build-all.mjs --win --arch x64 --skip-build
  fi
fi

# ---------------------------------------------------------------- 冒烟
if [ "$SMOKE" = "1" ] && [ "$DO_MAC" = "1" ]; then
  APP="release/${VERSION}/mac-arm64/JShell.app/Contents/MacOS/JShell"
  if [ -x "$APP" ]; then
    echo "==> 冒烟测试 macOS 打包版"
    SMOKE_DIR="$(mktemp -d)"
    if env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS "$APP" --smoke-test --user-data-dir="$SMOKE_DIR" >/dev/null 2>&1; then
      echo "    冒烟通过"
    else
      echo "    冒烟失败（检查 $SMOKE_DIR/logs/*.log）" >&2
      exit 1
    fi
    rm -rf "$SMOKE_DIR"
  fi
fi

# ---------------------------------------------------------------- 产物清单
echo ""
echo "==> 完成，产物目录 release/${VERSION}/"
ls -lh "release/${VERSION}" | awk 'NR>1 && ($NF ~ /\.(dmg|zip|exe|txt)$/) { printf "    %-42s %s\n", $NF, $5 }'
