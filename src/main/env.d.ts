/**
 * 构建期注入的全局常量。
 *
 * electron.vite.config.ts 用 define 把 package.json 的版本写进主进程产物，
 * 这样开发态（直接跑 out/main/index.js）也能拿到 JShell 的真实版本，
 * 不会退化成 Electron 自身的版本号。
 */
declare const __JSHELL_VERSION__: string
