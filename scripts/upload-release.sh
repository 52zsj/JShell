#!/usr/bin/env bash
#
# 把构建产物挂到 GitHub Release 上（供 CI 调用，也可本地 dry-run 验证）。
#
# 环境变量：
#   TAG         目标 tag（默认取 GITHUB_REF_NAME）
#   ARTIFACTS   产物根目录（默认 artifacts）
#   NOTES       版本说明文件（默认 release-notes.md）
#   GH_TOKEN    GitHub 凭据（CI 里是 secrets.GITHUB_TOKEN）
#   DRY_RUN=1   只打印将要上传的文件，不发任何请求
#
# 为什么不用 gh CLI / softprops-action：
#   · softprops/action-gh-release 遇到重名文件会报 "Not Found - update-a-release-asset"，
#     Release 建出来却没有附件；
#   · gh CLI 的报错只在日志里，而 Actions 日志需要登录才看得到，排查极其困难。
# 这里用 curl 直连 REST API：每次请求都打印 HTTP 状态码，出错立刻能看出是哪一步。
set -euo pipefail

TAG="${TAG:-${GITHUB_REF_NAME:-}}"
ARTIFACTS="${ARTIFACTS:-artifacts}"
NOTES="${NOTES:-release-notes.md}"
API="https://api.github.com/repos/${GITHUB_REPOSITORY:-}"
AUTH_HEADER="Authorization: Bearer ${GH_TOKEN:-}"
ACCEPT="Accept: application/vnd.github+json"

if [ -z "$TAG" ]; then
  echo "✗ 缺少 TAG（或 GITHUB_REF_NAME）" >&2
  exit 1
fi
if [ ! -d "$ARTIFACTS" ]; then
  echo "✗ 产物目录不存在：$ARTIFACTS" >&2
  exit 1
fi

# 只认真正的安装包/说明文件；blockmap、解包目录、Electron 自带文件都不算
FILES=()
while IFS= read -r -d '' file; do
  FILES+=("$file")
done < <(
  find "$ARTIFACTS" -type f \
    \( -name '*.dmg' -o -name '*.zip' -o -name '*-setup.exe' -o -name '*-portable.exe' -o -name '*.txt' \) \
    ! -name '*.blockmap' \
    ! -path '*/win-unpacked/*' \
    ! -path '*/mac/*' ! -path '*/mac-arm64/*' \
    -print0 | sort -z
)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "✗ 在 $ARTIFACTS 下没有找到可上传的产物" >&2
  ls -R "$ARTIFACTS" >&2 || true
  exit 1
fi

echo "tag: $TAG"
echo "将上传 ${#FILES[@]} 个文件："
printf '  %s\n' "${FILES[@]}"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "（DRY_RUN=1，跳过所有网络请求）"
  exit 0
fi

if [ -z "${GH_TOKEN:-}" ]; then
  echo "✗ 缺少 GH_TOKEN" >&2
  exit 1
fi
if [ ! -f "$NOTES" ]; then
  echo "✗ 版本说明文件不存在：$NOTES" >&2
  exit 1
fi

# ---- 1. 创建 Release（同名已存在就删掉重建，避免残留的旧 Release 收不到附件）----
existing=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH_HEADER" -H "$ACCEPT" "$API/releases/tags/$TAG")
echo "查询 Release $TAG -> HTTP $existing"

if [ "$existing" = "200" ]; then
  echo "  已有同名 Release，先删除重建"
  curl -s -o /dev/null -w '  删除 -> HTTP %{http_code}\n' \
    -X DELETE -H "$AUTH_HEADER" -H "$ACCEPT" "$API/releases/tags/$TAG" || true
fi

body=$(python3 -c 'import json,sys;print(json.dumps(open(sys.argv[1],encoding="utf-8").read()))' "$NOTES")
create_code=$(curl -s -o /tmp/jshell-release.json -w '%{http_code}' \
  -X POST "$API/releases" \
  -H "$AUTH_HEADER" -H "$ACCEPT" -H 'Content-Type: application/json' \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"JShell $TAG\",\"body\":$body,\"draft\":false,\"prerelease\":false}")
echo "创建 Release -> HTTP $create_code"

if [ "$create_code" != "201" ] && [ "$create_code" != "200" ]; then
  echo "::error title=创建 Release 失败::HTTP $create_code $(head -c 300 /tmp/jshell-release.json)"
  exit 1
fi

upload_url=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("upload_url",""))' /tmp/jshell-release.json)
if [ -z "$upload_url" ]; then
  echo "::error title=缺少上传地址::响应里没有 upload_url：$(head -c 300 /tmp/jshell-release.json)"
  exit 1
fi
upload_url=${upload_url%%\{*}
echo "上传地址：$upload_url"

# ---- 2. 逐个上传 ----
FAILED=()
for file in "${FILES[@]}"; do
  name=$(basename "$file")
  code=$(curl -s -o /tmp/jshell-asset.json -w '%{http_code}' \
    -X POST "${upload_url}?name=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$name")" \
    -H "$AUTH_HEADER" -H 'Content-Type: application/octet-stream' \
    --data-binary "@$file")
  if [ "$code" = "201" ] || [ "$code" = "200" ]; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name (HTTP $code)" >&2
    FAILED+=("$name")
    echo "::error title=上传失败::$name HTTP $code $(head -c 200 /tmp/jshell-asset.json)"
  fi
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "✗ 有 ${#FAILED[@]} 个文件上传失败：${FAILED[*]}" >&2
  exit 1
fi

echo "✓ 已上传 ${#FILES[@]} 个附件到 $TAG"
