// 渲染进程全局类型声明：window.api 由 preload/index.ts 暴露
import type { Api } from './index'

declare global {
  interface Window {
    api: Api
  }
}

export {}
