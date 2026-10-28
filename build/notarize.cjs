/**
 * macOS 公证钩子（预留）。
 *
 * 内部渠道默认不签名、不公证，本脚本会直接跳过；
 * 开放公测下载时配置以下环境变量即可启用，无需改动打包命令：
 *   CSC_LINK / CSC_KEY_PASSWORD      —— 开发者 ID 证书（自动签名）
 *   APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD、APPLE_TEAM_ID —— 公证账号
 *
 * 用 xcrun notarytool 而不是 @electron/notarize，是为了少一个构建期依赖。
 */
const { execFileSync } = require('node:child_process')

exports.default = async function notarize(context) {
  if (process.platform !== 'darwin') return

  const appleId = process.env.APPLE_ID
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID
  if (!appleId || !password || !teamId) {
    console.log('未配置 Apple 公证凭据，跳过公证（内部渠道产物为未签名/自签名包）')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = `${context.appOutDir}/${appName}.app`
  console.log(`开始公证：${appPath}`)
  execFileSync(
    'xcrun',
    [
      'notarytool',
      'submit',
      appPath,
      '--apple-id',
      appleId,
      '--password',
      password,
      '--team-id',
      teamId,
      '--wait'
    ],
    { stdio: 'inherit' }
  )
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' })
  console.log('公证完成并已装订票据')
}
