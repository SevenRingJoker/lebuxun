// PTY 会话封装：基于 node-pty 的真实终端（Windows ConPTY / POSIX）。
// 用户终端与 AI 交互命令共用本层；旧哨兵管道（handlers/terminal.ts）保留为非 PTY 回退。
//
// 与旧 ShellProfile 的区别：PTY 是真 TTY——Windows 默认 PowerShell 7（pwsh），
// 输出统一 UTF-8（旧 GBK/iconv 只留给非 PTY 回退）。
import * as pty from 'node-pty'
import { existsSync } from 'node:fs'
import { resolveShellProfile, type ExistsFn } from './shellProbe'

/** PTY shell 类别（比旧 ShellKind 更细：区分 pwsh / powershell / cmd，便于 Tab 标题与展示） */
export type PtyShellKind = 'pwsh' | 'powershell' | 'cmd' | 'posix' | 'fish'

/** PTY shell 描述（无 encoding 字段：PTY 恒 UTF-8） */
export interface PtyShell {
  kind: PtyShellKind
  /** 可执行文件绝对路径或 PATH 内文件名 */
  command: string
  /** 启动参数（交互式 PTY 通常无需特殊参数） */
  args: string[]
}

/**
 * 在 PATH 环境变量中查找可执行文件（纯函数，不实际 spawn）。
 * @param bin      目标文件名（如 pwsh.exe）
 * @param pathEnv  PATH 环境变量原文
 * @param sep      路径分隔符（Windows ';' / POSIX ':'）
 * @param exists   路径存在谓词
 * @returns 首个命中的绝对路径；未命中返回 null
 */
export function findInPath(
  bin: string,
  pathEnv: string | undefined,
  sep: ';' | ':',
  exists: ExistsFn
): string | null {
  if (!pathEnv) return null
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    // 去尾部斜杠并把反斜杠归一为正斜杠，保证返回路径风格统一
    const trimmed = dir.replace(/[\\/]+$/, '').replace(/\\/g, '/')
    const candidate = `${trimmed}/${bin}`
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * 探测 PTY 默认 shell（纯函数）。
 * Windows 优先级：PowerShell 7（Program Files\PowerShell\7，含 preview）
 *                → PATH 中的 pwsh.exe
 *                → Windows PowerShell 5.1（SystemRoot\System32，必然存在）
 *                → cmd.exe（ComSpec）。
 * POSIX：复用 shellProbe 的 $SHELL 探测（bash/zsh/fish）。
 */
export function resolvePtyShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: ExistsFn = existsSync
): PtyShell {
  if (platform !== 'win32') {
    // 旧探测结果：command/args/kind 直接复用（encoding 与 PTY 无关）
    const profile = resolveShellProfile(platform, env, exists)
    return { kind: profile.kind, command: profile.command, args: profile.args }
  }

  // 1) PowerShell 7：标准安装目录（稳定版 + preview）
  const programFiles = env.ProgramFiles || env['ProgramFiles(x86)'] || 'C:\\Program Files'
  const pwshFixed: string[] = [
    `${programFiles}\\PowerShell\\7\\pwsh.exe`,
    `${programFiles}\\PowerShell\\7-preview\\pwsh.exe`
  ]
  for (const candidate of pwshFixed) {
    if (exists(candidate)) return { kind: 'pwsh', command: candidate, args: [] }
  }
  // 2) PATH 中的 pwsh.exe（自定义安装/ scoop / winget 链接）
  const pwshInPath = findInPath('pwsh.exe', env.PATH, ';', exists)
  if (pwshInPath) return { kind: 'pwsh', command: pwshInPath, args: [] }

  // 3) Windows PowerShell 5.1（System32 固定路径，存在性兜底）
  const ps51 = env.SystemRoot
    ? `${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
  if (exists(ps51)) return { kind: 'powershell', command: ps51, args: [] }

  // 4) cmd.exe（ComSpec 标准环境变量）
  return { kind: 'cmd', command: env.ComSpec || 'cmd.exe', args: [] }
}

/** PTY 会话构造参数 */
export interface PtySessionOptions {
  id: string
  cwd: string
  /** 指定 shell；缺省走 resolvePtyShell 平台探测 */
  shell?: PtyShell
  cols?: number
  rows?: number
}

/** 取消订阅函数 */
type Unsubscribe = () => void

/**
 * 单个 PTY 会话：封装 node-pty 一个实例，转发数据/退出事件。
 * 进程树兜底（taskkill /T、POSIX 进程组）由 ptyManager 层负责，本类只做 pty.kill。
 */
export class PtySession {
  readonly id: string
  readonly shell: PtyShell
  private readonly proc: pty.IPty
  private dataListeners: ((data: string) => void)[] = []
  private exitListeners: ((code: number | null) => void)[] = []
  private dead = false
  private exitCode: number | null = null

  constructor(opts: PtySessionOptions) {
    this.id = opts.id
    this.shell = opts.shell ?? resolvePtyShell(process.platform, process.env)
    // node-pty env 要求值均为 string：过滤掉 undefined
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    // name=xterm-256color：让程序按 256 色终端能力输出（与 xterm.js 对齐）
    // node-pty 不支持 windowsHide：ConPTY/winpty 本身无可见控制台窗口
    this.proc = pty.spawn(this.shell.command, this.shell.args, {
      name: 'xterm-256color',
      cols: Math.max(1, opts.cols ?? 80),
      rows: Math.max(1, opts.rows ?? 24),
      cwd: opts.cwd,
      env
    })
    this.proc.onData((data) => {
      for (const cb of this.dataListeners) cb(data)
    })
    this.proc.onExit(({ exitCode }) => {
      this.dead = true
      this.exitCode = exitCode
      for (const cb of this.exitListeners) cb(exitCode)
    })
  }

  /** shell 进程 PID（供树杀兜底使用） */
  get pid(): number {
    return this.proc.pid
  }

  /** 是否存活 */
  get alive(): boolean {
    return !this.dead
  }

  /** 退出码（未退出为 null） */
  get code(): number | null {
    return this.exitCode
  }

  /** 订阅终端输出，返回取消订阅函数 */
  onData(cb: (data: string) => void): Unsubscribe {
    this.dataListeners.push(cb)
    return () => {
      this.dataListeners = this.dataListeners.filter((f) => f !== cb)
    }
  }

  /** 订阅退出事件（进程已退出时订阅也不补推，由 Manager 查 alive 态） */
  onExit(cb: (code: number | null) => void): Unsubscribe {
    this.exitListeners.push(cb)
    return () => {
      this.exitListeners = this.exitListeners.filter((f) => f !== cb)
    }
  }

  /** 写入用户输入（按键序列原样写入 PTY） */
  write(data: string): void {
    if (!this.dead) this.proc.write(data)
  }

  /** 调整终端行列（来自 FitAddon 的实际尺寸） */
  resize(cols: number, rows: number): void {
    if (this.dead) return
    this.proc.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
  }

  /** 终止 PTY（树杀兜底在 Manager 层执行） */
  kill(): void {
    if (this.dead) return
    try {
      this.proc.kill()
    } catch {
      // 进程可能已退出，忽略 kill 异常
    }
  }
}

/**
 * 交互式命令写入 PTY 时的行尾（Windows ConPTY 需 CRLF 语义，实际 \r 即可触发执行；
 * POSIX 用 \n）。
 */
export function ptyEnter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? '\r' : '\n'
}
