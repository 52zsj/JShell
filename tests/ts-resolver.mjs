/**
 * 极简 ESM 解析钩子：让 `node --test` 能直接跑带「无扩展名相对导入」的 TS 源码。
 *
 * 背景：源码里写的是 `import { x } from './pane-tree'`（Vite/tsc 都能解析），
 * 但 Node 的原生 ESM 解析要求显式扩展名。这里只在「默认解析失败」时补一次 `.ts`，
 * 不改变源码写法，也不需要引入 tsx / ts-node 之类的运行时。
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return nextResolve(`${specifier}.ts`, context)
    }
    throw error
  }
}
