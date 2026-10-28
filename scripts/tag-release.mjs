#!/usr/bin/env node
/**
 * 一键发版：打 tag 并推送，触发 GitHub Actions 产出安装包与 Release。
 *
 * 做的事：
 *   1. 校验工作区干净（有未提交改动就停下，避免把半成品打出去）
 *   2. 校验 package.json 版本与 CHANGELOG 章节对得上
 *   3. 校验该 tag 还不存在
 *   4. 创建附注 tag v<版本>，推送 main 与该 tag
 *
 * 用法：
 *   node scripts/tag-release.mjs --dry-run   # 只检查，不落任何东西
 *   node scripts/tag-release.mjs             # 真正打 tag 并推送
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

const git = (args, options = {}) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const tag = `v${version}`

// 1. 工作区必须干净
const status = git(['status', '--porcelain'])
if (status) {
  fail(`工作区有未提交改动，先提交再发版：\n${status}`)
}

// 2. CHANGELOG 必须有这一版
try {
  execFileSync(process.execPath, ['scripts/changelog-section.mjs', '--check'], { cwd: root, stdio: 'pipe' })
} catch (error) {
  fail(`CHANGELOG 校验未通过：${(error.stdout || error.stderr || '').toString().trim()}`)
}

// 3. tag 不能已存在
const existing = git(['tag', '--list', tag])
if (existing) fail(`tag ${tag} 已存在，改版本号或先删除旧 tag`)

// 4. 与远端同步
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') fail(`当前分支是 ${branch}，发版应在 main 上`)

if (dryRun) {
  console.log(`将创建 tag ${tag}（当前版本 ${version}），并推送 ${branch} 与该 tag。`)
  process.exit(0)
}

git(['tag', '-a', tag, '-m', `JShell ${version}`])
console.log(`✓ 已创建 tag ${tag}`)

git(['push', 'origin', branch])
git(['push', 'origin', tag])
console.log(`✓ 已推送 ${branch} 与 ${tag}`)
console.log('')
console.log('GitHub Actions 会开始构建 macOS + Windows 产物，并创建 Release：')
console.log('  https://github.com/52zsj/JShell/actions')
console.log('  https://github.com/52zsj/JShell/releases')
