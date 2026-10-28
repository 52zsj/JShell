#!/usr/bin/env node
/**
 * 为 release/<版本>/ 生成中文分发说明与校验值：
 *   - 安装说明.txt   ：产物清单、安装 / 便携版使用方法、系统提示处理
 *   - SHA256SUMS.txt ：逐文件校验值（内网分发时附在下载页）
 *
 * 用法：node scripts/write-release-notes.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const releaseDir = path.join(root, 'release', pkg.version)

if (!existsSync(releaseDir)) {
  console.error(`未找到产物目录：${path.relative(root, releaseDir)}`)
  process.exit(1)
}

const ARTIFACT = /\.(dmg|zip|exe|AppImage|deb)$/i
const artifacts = readdirSync(releaseDir)
  .filter((file) => ARTIFACT.test(file))
  .sort()
  .map((file) => {
    const full = path.join(releaseDir, file)
    const size = statSync(full).size
    const sha256 = createHash('sha256').update(readFileSync(full)).digest('hex')
    return { file, size, sha256 }
  })

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const rows = artifacts
  .map((item) => `  ${item.file.padEnd(44)} ${mb(item.size).padStart(9)}  ${item.sha256}`)
  .join('\n')

const notes = `JShell ${pkg.version} 安装说明
================================================================

版本：${pkg.version}
构建时间：${new Date().toISOString()}
分发渠道：内部渠道（未签名，可直接内网分发）

一、产物清单
----------------------------------------------------------------
${rows}

二、macOS
----------------------------------------------------------------
安装版（.dmg）
  1. 双击打开 dmg，把 JShell 拖入「应用程序」。
  2. 首次打开若提示「无法验证开发者」：右键点击 JShell → 打开；
     或在终端执行：xattr -dr com.apple.quarantine /Applications/JShell.app

便携版（-portable.zip）
  1. 解压到任意目录（U 盘、内网共享目录均可）。
  2. 双击 JShell.app 启动；配置、密钥与日志保存在同级的 JShell-Data 文件夹。
  3. 迁移时整个目录拷走即可，不写入系统用户目录。
  4. 不要删除 jshell-portable.marker，否则会按安装版处理数据目录。

三、Windows
----------------------------------------------------------------
安装版（-setup.exe）
  1. 双击运行，安装向导为简体中文，可自选安装目录（默认当前用户，无需管理员权限）。
  2. 若出现 SmartScreen 提示：点击「更多信息」→「仍要运行」。

便携版（-portable.exe）
  1. 直接双击运行，无需安装；数据保存在该 exe 同级的 JShell-Data 文件夹。
  2. 放到 U 盘或共享目录即可带走，换机器不用重新配置。

四、开机自启与托盘
----------------------------------------------------------------
  设置 → 系统集成 中可开启「开机自动启动」「启动后仅驻留托盘」「关闭窗口时最小化到托盘」。
  默认关闭窗口不退出应用，可在托盘菜单选择「退出 JShell」。
  便携版更换目录后，请重新开关一次开机自启以刷新系统登记的路径。

五、数据与隐私
----------------------------------------------------------------
  安装版数据目录：macOS ~/Library/Application Support/JShell，Windows %APPDATA%\\JShell
  便携版数据目录：程序目录下的 JShell-Data
  日志：数据目录下 logs/jshell-YYYY-MM-DD.log（不含口令与终端输出）
  本应用不采集、不上报任何使用数据；隐私说明见应用内「设置 → 关于 → 隐私说明」。

六、校验
----------------------------------------------------------------
  下载后可执行以下命令核对（SHA256SUMS.txt 同目录提供）：
    macOS / Linux : shasum -a 256 <文件名>
    Windows       : certutil -hashfile <文件名> SHA256
`

writeFileSync(path.join(releaseDir, '安装说明.txt'), notes, 'utf8')
writeFileSync(
  path.join(releaseDir, 'SHA256SUMS.txt'),
  `${artifacts.map((item) => `${item.sha256}  ${item.file}`).join('\n')}\n`,
  'utf8'
)

console.log(`已生成：${path.relative(root, releaseDir)}/安装说明.txt 与 SHA256SUMS.txt（${artifacts.length} 个产物）`)
