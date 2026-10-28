import { register } from 'node:module'

// 注册解析钩子：node --test 运行 .ts 源码时自动补 .ts 扩展名
register('./ts-resolver.mjs', import.meta.url)
