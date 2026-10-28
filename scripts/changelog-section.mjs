#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 抽出「当前 package.json 版本」那一节，写成 release-notes.md。
 *
 * 用途：GitHub Release 的正文只应该是这一版改了什么，
 * 而不是把整份 CHANGELOG 贴上去（几百行、翻不到重点）。
 *
 * 用法：
 *   node scripts/changelog-section.mjs            # 写 release-notes.md
 *   node scripts/changelog-section.mjs --check    # 只校验该版本章节存在
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const changelogPath = path.join(root, 'CHANGELOG.md')

if (!existsSync(changelogPath)) {
  console.error('找不到 CHANGELOG.md')
  process.exit(1)
}

const lines = readFileSync(changelogPath, 'utf8').split('\n')
const start = lines.findIndex((line) => line.startsWith(`## ${version}`))
if (start < 0) {
  console.error(`CHANGELOG.md 里没有 ${version} 的章节——发版前必须先补上这一节`)
  process.exit(1)
}

// 下一个同级标题即为本节结尾
let end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
if (end < 0) end = lines.length

const section = lines
  .slice(start + 1, end) // 去掉标题行本身
  .join('\n')
  .trim()

if (!section) {
  console.error(`${version} 的章节是空的`)
  process.exit(1)
}

if (process.argv.includes('--check')) {
  console.log(`CHANGELOG 中 ${version} 章节存在（${section.split('\n').length} 行）`)
  process.exit(0)
}

const body = `## 下载对应包

| 平台 | 文件 |
| --- | --- |
| macOS（Apple Silicon） | \`JShell-${version}-arm64.dmg\` / \`-arm64-portable.zip\` |
| macOS（Intel） | \`JShell-${version}-x64.dmg\` / \`-x64-portable.zip\` |
| Windows | \`JShell-${version}-x64-setup.exe\`（安装版）/ \`-x64-portable.exe\`（便携版） |

> Apple Silicon 请下载 arm64 包：装成 x64 会走 Rosetta，启动从 0.4 秒变成 8 秒以上。
> 未签名版本首次打开会被 Gatekeeper / SmartScreen 拦一次，属正常现象。

---

${section}
`

const out = path.join(root, 'release-notes.md')
writeFileSync(out, body, 'utf8')
console.log(`已写入 ${path.relative(root, out)}（${version}，${section.split('\n').length} 行）`)
