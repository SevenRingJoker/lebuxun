// 跨平台检测纯函数层：零依赖，可在主进程/渲染进程/vitest 任意环境复用。
// 统一平台判断逻辑，避免散落各处的 process.platform === 'win32' 字面量。
// 渲染进程无 process 对象，由调用方注入 platform 字符串（来自 navigator.platform 或 IPC）。

/** 平台标识字符串（与 NodeJS process.platform 取值对齐） */
export type PlatformId = 'win32' | 'darwin' | 'linux' | 'aix' | 'freebsd' | 'openbsd' | 'sunos' | 'cygwin' | string

/** 是否为 Windows */
export function isWindows(platform: PlatformId): boolean {
  return platform === 'win32' || platform === 'cygwin'
}

/** 是否为 macOS（darwin） */
export function isMacos(platform: PlatformId): boolean {
  return platform === 'darwin'
}

/** 是否为 Linux/类 Unix（不含 macOS） */
export function isLinux(platform: PlatformId): boolean {
  return platform === 'linux' || platform === 'freebsd' || platform === 'openbsd' || platform === 'aix' || platform === 'sunos'
}

/** 主修饰键显示名：macOS 用 Cmd（⌘），其余用 Ctrl */
export function modKeyName(platform: PlatformId): 'Cmd' | 'Ctrl' {
  return isMacos(platform) ? 'Cmd' : 'Ctrl'
}

/** 平台人类可读名（用于日志/诊断/关于面板） */
export function platformDisplayName(platform: PlatformId): string {
  if (isWindows(platform)) return 'Windows'
  if (isMacos(platform)) return 'macOS'
  if (isLinux(platform)) return 'Linux/BSD'
  return platform
}

/**
 * 从 navigator.platform（渲染进程可用）推断 NodeJS 风格 platform id。
 * navigator.platform 取值示例：'Win32'、'MacIntel'、'Linux x86_64'、'Linux armv8l'。
 * 主进程可直接传 process.platform。
 */
export function platformFromNavigator(navigatorPlatform: string): PlatformId {
  const p = navigatorPlatform.toLowerCase()
  if (p.startsWith('win')) return 'win32'
  if (p.startsWith('mac')) return 'darwin'
  if (p.startsWith('linux') || p.includes('freebsd') || p.includes('openbsd')) return 'linux'
  return 'linux' // 兜底：未知平台按 POSIX 风格处理（更宽容）
}

/**
 * 平台默认等宽字体栈：优先 JetBrains Mono/Fira Code（需用户安装），
 * 之后按平台补系统预装字体，最后 monospace 兜底。
 * 浏览器按序挑选首个可用字体，无需运行时检测字体是否存在。
 */
export function monospaceFontStack(platform: PlatformId = 'win32'): string {
  // 通用首选：用户安装的编程字体（跨平台一致体验）
  const commonPreferred = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Source Code Pro'"
  if (isMacos(platform)) {
    // macOS 预装：Menlo（默认 Terminal/Code 字体）、Monaco（Xcode）
    return `${commonPreferred}, 'Menlo', 'Monaco', monospace`
  }
  if (isLinux(platform)) {
    // Linux 常见发行版预装：DejaVu Sans Mono（Debian/Fedora）、Liberation Mono（RHEL 系）
    return `${commonPreferred}, 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', monospace`
  }
  if (isWindows(platform)) {
    // Windows 10+ 预装：Consolas（默认 VS/记事本等宽字体）
    return `${commonPreferred}, 'Consolas', 'Courier New', monospace`
  }
  // 未知平台：通用回退
  return `${commonPreferred}, 'Consolas', 'Menlo', 'DejaVu Sans Mono', monospace`
}
