#!/usr/bin/env bash
#
# 把构建产物挂到 GitHub Release 上（供 CI 调用，也可本地 dry-run 验证）。
#
# 环境变量：
#   TAG         目标 tag（默认取 GITHUB_REF_NAME）
#   ARTIFACTS   产物根目录（默认 artifacts）
#   NOTES       版本说明文件（默认 release-notes.md）
#   GH_TOKEN    gh CLI 凭据（CI 里是 secrets.GITHUB_TOKEN）
#   DRY_RUN=1   只打印将要上传的文件，不调用 gh
#
# 为什么不用 softprops/action-gh-release：它在更新资产时会因同名文件报
# "Not Found - update-a-release-asset"，Release 建出来却没有附件。
# 这里用 gh CLI 的 --clobber，行为可预期，且失败信息看得见。
set -euo pipefail

TAG="${TAG:-${GITHUB_REF_NAME:-}}"
ARTIFACTS="${ARTIFACTS:-artifacts}"
NOTES="${NOTES:-release-notes.md}"

if [ -z "$TAG" ]; then
  echo "✗ 缺少 TAG（或 GITHUB_REF_NAME）" >&2
  exit 1
fi

if [ ! -d "$ARTIFACTS" ]; then
  echo "✗ 产物目录不存在：$ARTIFACTS" >&2
  exit 1
fi

# 只认真正的安装包/说明文件；blockmap 与自动生成的源码包不算
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
  echo "（DRY_RUN=1，跳过 gh 调用）"
  exit 0
fi

if [ ! -f "$NOTES" ]; then
  echo "✗ 版本说明文件不存在：$NOTES" >&2
  exit 1
fi

# Release 可能已存在（重发同一版本），存在就改正文，不存在就新建
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG 已存在，更新标题与说明"
  gh release edit "$TAG" --title "JShell $TAG" --notes-file "$NOTES"
else
  echo "创建 Release $TAG"
  gh release create "$TAG" --title "JShell $TAG" --notes-file "$NOTES"
fi

# 逐个上传：某个文件失败不至于全军覆没，而且能明确指出是哪个
FAILED=()
for file in "${FILES[@]}"; do
  name="$(basename "$file")"
  if gh release upload "$TAG" "$file" --clobber; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name" >&2
    FAILED+=("$name")
  fi
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "✗ 有 ${#FAILED[@]} 个文件上传失败：${FAILED[*]}" >&2
  exit 1
fi

echo "✓ 已上传 ${#FILES[@]} 个附件到 $TAG"
