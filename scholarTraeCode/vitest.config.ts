import { defineConfig } from 'vitest/config'

// vitest 配置：测试主进程与共享目录纯函数（scheduler/toolCall/keymap 等）
// 这些函数不依赖 Electron/IPC/DOM，可在 Node 环境直接运行
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', 'src/main/index.ts', 'src/main/handlers/**'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage'
    }
  }
})
