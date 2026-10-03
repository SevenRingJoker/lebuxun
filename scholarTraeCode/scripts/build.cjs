// 跨平台构建包装器：自动设置国内镜像（仅在国内网络环境需要）
// 用法：node scripts/build.cjs [--dir]
//   --dir  只产出解包目录（不打安装包），用于快速验证
const { spawn } = require('node:child_process')

// 国内镜像（Electron 二进制 + electron-builder 依赖工具）
const MIRRORS = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

const args = process.argv.slice(2)
const isDir = args.includes('--dir')

const cmd = isDir
  ? 'electron-vite build && electron-builder --dir'
  : 'electron-vite build && electron-builder'

// Windows 用 cmd /c，POSIX 用 sh -c
const shell = process.platform === 'win32' ? 'cmd' : 'sh'
const shellFlag = process.platform === 'win32' ? '/c' : '-c'

const proc = spawn(shell, [shellFlag, cmd], {
  stdio: 'inherit',
  env: { ...process.env, ...MIRRORS }
})

proc.on('exit', (code) => process.exit(code ?? 0))
