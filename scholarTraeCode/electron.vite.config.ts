// electron-vite 配置文件：分别定义主进程、preload、渲染进程的构建入口与插件
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  // 主进程（Node 环境）：外部化 node_modules 依赖，保持 require 可用
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  // preload 脚本：同样外部化依赖，输出 CJS 兼容 Electron 沙箱
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  // 渲染进程（浏览器环境 + Vue SFC）
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue()],
    css: {
      preprocessorOptions: {
        // 使用 Dart Sass 现代编译器 API，消除 legacy-js-api 弃用警告
        scss: {
          api: 'modern-compiler'
        }
      }
    }
  }
})
