#!/usr/bin/env node
/**
 * node-pty 后置修复脚本。
 *
 * 背景：node-pty 1.1 为 macOS/Windows 提供 N-API 预编译产物（无需按 Electron ABI 重建），
 * 但 npm 解包后 `prebuilds/<platform>/spawn-helper` 常会丢失可执行位，
 * 表现为 `posix_spawnp failed`（终端怎么都起不来）。
 * 这里在 install 后统一补上 0755，保证开发机与打包产物一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds')

if (fs.existsSync(prebuilds)) {
  for (const platform of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platform, 'spawn-helper')
    if (!fs.existsSync(helper)) continue
    try {
      fs.chmodSync(helper, 0o755)
      console.log(`[postinstall] chmod 0755 ${path.relative(root, helper)}`)
    } catch (error) {
      console.warn(`[postinstall] 无法修改权限 ${helper}:`, error.message)
    }
  }
}
