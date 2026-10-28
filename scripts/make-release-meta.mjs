#!/usr/bin/env node
/**
 * 生成打包用的发布元信息 build/release-meta.json。
 *
 * 这份文件会被 electron-builder 复制到安装包 resources/release-meta.json，
 * 运行时用于展示「构建时间 / 分发渠道」，并决定是否启用更新检查。
 *
 * 用法：
 *   node scripts/make-release-meta.mjs
 *   JSHELL_CHANNEL=public JSHELL_UPDATE_URL=https://dl.example.com/jshell \
 *     node scripts/make-release-meta.mjs
 *
 * 说明：内部渠道（默认）不填写更新地址，应用启动后不会发起任何网络请求。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim()
  } catch {
    return undefined
  }
}

const channel = process.env.JSHELL_CHANNEL === 'public' ? 'public' : 'internal'
const updateUrl = (process.env.JSHELL_UPDATE_URL ?? '').trim()

if (channel === 'public' && !updateUrl) {
  console.error('公开渠道必须提供 JSHELL_UPDATE_URL（例如 https://dl.example.com/jshell）')
  process.exit(1)
}
if (updateUrl && !/^https:\/\//i.test(updateUrl)) {
  console.error('JSHELL_UPDATE_URL 必须是 https 地址')
  process.exit(1)
}

const meta = {
  productName: 'JShell',
  version: pkg.version,
  channel,
  updateUrl: channel === 'public' ? updateUrl : '',
  buildTime: new Date().toISOString(),
  gitCommit: gitCommit(),
  homepage: process.env.JSHELL_HOMEPAGE ?? ''
}

const target = path.join(root, 'build', 'release-meta.json')
writeFileSync(target, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
console.log(`已写入 ${path.relative(root, target)}（渠道：${channel === 'public' ? '公开下载' : '内部渠道'}）`)
