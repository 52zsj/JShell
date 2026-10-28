import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * 三段式构建配置：
 *  - main     : Electron 主进程（Node 环境，CJS 输出，产物 out/main/index.js）
 *  - preload  : 预加载脚本（隔离上下文桥，产物 out/preload/index.js）
 *  - renderer : React 界面（浏览器环境，由 Vite 打包为静态资源，产物 out/renderer）
 *
 * externalizeDepsPlugin 会把 package.json 的 dependencies（ssh2 / node-pty）保持为
 * 运行时 require，避免把 CJS 原生模块打进 bundle 后出现动态 require 失败。
 */
/** 版本号在构建期注入：开发态 app.getVersion() 会返回 Electron 版本而不是应用版本 */
const pkgVersion = (
  JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }
).version

export default defineConfig(({ command }) => {
  const dev = command === 'serve'
  const csp = [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    dev ? "connect-src 'self' ws:" : "connect-src 'self'"
  ].join('; ')

  return {
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __JSHELL_VERSION__: JSON.stringify(pkgVersion)
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [
      react(),
      {
        name: 'jshell-csp',
        transformIndexHtml(html: string) {
          return html.replace('%CSP%', csp)
        }
      }
    ],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      outDir: 'out/renderer',
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
  }
})
