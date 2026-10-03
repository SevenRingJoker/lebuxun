// Shell 探测与命令行构建纯函数层（零 IO / 零 electron，可单测）。
//
// 设计目标：
// - Windows 继续使用 cmd.exe（/V:ON /Q + GBK 转码 + !ERRORLEVEL! 哨兵），行为与旧实现逐字一致；
// - POSIX 按 $SHELL 识别 bash/zsh/fish；无 $SHELL 时在候选列表中按 exists 探测取首个可用；
// - fish 语法与 POSIX 不同（无 $?、无 ( ) 子 shell），单独生成命令行模板。
import { isAbsolute, resolve } from 'node:path'

/** shell 类别：决定哨兵语法、输出编码与进程组策略 */
export type ShellKind = 'cmd' | 'posix' | 'fish'

export interface ShellProfile {
  kind: ShellKind
  /** 可执行文件名或绝对路径 */
  command: string
  /** 持久会话（交互面板）启动参数 */
  args: string[]
  /** 输出编码：Windows cmd 走 GBK，其余 UTF-8 */
  encoding: 'gbk' | 'utf8'
}

/** exists 谓词注入：默认调用方用 fs.existsSync，测试可传假函数 */
export type ExistsFn = (p: string) => boolean

const POSIX_FALLBACKS = ['/bin/zsh', '/bin/bash', '/bin/sh']

/**
 * 探测当前平台应使用的 shell。
 * @param platform process.platform
 * @param env      环境变量（至少读 ComSpec / SHELL）
 * @param exists   路径存在谓词（POSIX 候选探测用）
 */
export function resolveShellProfile(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: ExistsFn = () => false
): ShellProfile {
  if (platform === 'win32') {
    // ComSpec 是 Windows 标准环境变量（通常 C:\Windows\system32\cmd.exe）
    return {
      kind: 'cmd',
      command: env.ComSpec || 'cmd.exe',
      args: ['/V:ON', '/Q'],
      encoding: 'gbk'
    }
  }

  const userShell = env.SHELL
  if (userShell) {
    // 显式指定优先：即使文件探测失败也尊重用户配置（登录 shell 通常必然存在）
    return {
      kind: classifyPosixShell(userShell),
      command: userShell,
      args: [],
      encoding: 'utf8'
    }
  }
  for (const candidate of POSIX_FALLBACKS) {
    if (exists(candidate)) {
      return { kind: classifyPosixShell(candidate), command: candidate, args: [], encoding: 'utf8' }
    }
  }
  // 兜底：POSIX 系统几乎必然有 /bin/sh
  return { kind: 'posix', command: '/bin/sh', args: [], encoding: 'utf8' }
}

/** 按可执行文件名识别 POSIX shell 方言 */
export function classifyPosixShell(commandPath: string): Exclude<ShellKind, 'cmd'> {
  const base = commandPath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  // busybox 形态如 /bin/bash、/usr/bin/zsh；fish 是唯一语法异类
  return base === 'fish' ? 'fish' : 'posix'
}

export interface CommandLineInput {
  /** 用户原始命令（可能含管道/括号/中文） */
  command: string
  /** 目标工作目录；与 currentCwd 不同时加 cd 段 */
  cwd?: string
  /** shell 当前工作目录 */
  currentCwd: string
  /** 完成哨兵标记名（如 __STC_DONE_1_1700__） */
  marker: string
}

/**
 * 构建「用户命令 + 完成哨兵」整行。
 * - 括号隔离：用户命令含管道时，哨兵 echo 不能被卷进管道；
 * - 退出码必须取用户命令的真实退出码而非 echo 自己的。
 */
export function buildCommandLine(profile: ShellProfile, input: CommandLineInput): string {
  const { command, cwd, currentCwd, marker } = input
  const needCd = !!cwd && cwd !== currentCwd

  if (profile.kind === 'cmd') {
    // /V:ON 下 !ERRORLEVEL! 延迟扩展；跨盘切换需要 cd /d。
    // (call ) 是 cmd 公认的「ERRORLEVEL 置 0」惯用法：必须在每条用户命令前清零——
    // echo/cd 等内部命令成功后不会重置 ERRORLEVEL，否则上一条失败命令的码（如 9009）
    // 会残留到下一条命令的哨兵，造成成功命令误判失败。
    const reset = '(call )'
    const body = needCd
      ? `cd /d "${cwd}" & ${reset} & ( ${command} )`
      : `${reset} & ( ${command} )`
    return `${body} & echo ${marker}=!ERRORLEVEL!`
  }

  if (profile.kind === 'fish') {
    // fish：$status 取退出码；begin...end 代替 ( ) 子 shell；and 保证 cd 失败不执行
    const body = needCd ? `cd "${cwd}"; and begin ${command}; end` : `begin ${command}; end`
    return `${body}; echo ${marker}=$status`
  }

  // POSIX bash/zsh/sh：$? 在执行后展开；括号隔离管道
  const body = needCd ? `cd "${cwd}" && ( ${command} )` : `( ${command} )`
  return `${body}; echo ${marker}=$?`
}

/** 行尾换行：cmd 习惯 CRLF，POSIX LF */
export function shellLineEnding(profile: ShellProfile): string {
  return profile.kind === 'cmd' ? '\r\n' : '\n'
}

/**
 * 解析哨兵结果行：整行形如 `MARKER=12`（允许首尾空白/回车残留）时返回退出码。
 * 命令回显行是复合长命令，不会精确相等，借此避免提前误判完成。
 */
export function parseMarkerLine(line: string, marker: string): number | null {
  const m = line.match(new RegExp('^\\s*' + marker + '=(\\d+)\\s*$'))
  return m ? Number(m[1]) : null
}

/** 判断一行是否包含哨兵名（回显行/结果行都应从面板输出中过滤） */
export function lineMentionsMarker(line: string, marker: string): boolean {
  return line.includes(marker)
}

/** 规范化路径用于前缀比较（去掉末尾分隔符） */
export function normPath(p: string): string {
  return p.replace(/[\\/]+$/, '')
}

/** 目录越界保护：dir 必须等于 base 或位于其下（复用终端/MCP 工具安全模型） */
export function isWithinWorkspace(dir: string, base: string): boolean {
  // 不使用 node:path 的 sep（Windows 上恒为反斜杠，会误判 POSIX 风格路径），
  // 边界字符同时接受 / 与 \；比较大小写不敏感以兼容 Windows 盘符
  const d = normPath(dir).toLowerCase()
  const b = normPath(base).toLowerCase()
  if (d === b) return true
  if (!d.startsWith(b)) return false
  const boundary = d.charAt(b.length)
  return boundary === '/' || boundary === '\\'
}

/** 把相对/绝对 cwd 解析为绝对路径（不触碰文件系统） */
export function resolveCwd(cwd: string | null | undefined, base: string): string {
  // null/undefined/空串一律回落 base（模型可能显式塞 null）
  if (!cwd) return base
  return isAbsolute(cwd) ? cwd : resolve(base, cwd)
}
