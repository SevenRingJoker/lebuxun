// PTY 多实例管理器 + IPC：维护多个真终端会话（用户手动新建 + AI 交互命令），
// 输出与退出事件按会话 id 广播。旧哨兵管道（handlers/terminal.ts）不动，两套通道并存。
import { app, ipcMain, BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import os from 'node:os'
import {
  PtySession,
  ptyEnter,
  type PtyShell,
  type PtySessionOptions
} from '../terminal/ptySession'

/** 对外的会话摘要（列表/创建返回） */
export interface PtyInfo {
  id: string
  /** shell 类别：pwsh/powershell/cmd/posix/fish */
  shell: string
  command: string
  alive: boolean
  exitCode: number | null
  /** 来源：user 用户手动新建；ai AI 交互命令启动 */
  origin: 'user' | 'ai'
}

/** 创建会话参数 */
export interface PtyCreateInput {
  cwd?: string
  shell?: PtyShell
  origin?: 'user' | 'ai'
  cols?: number
  rows?: number
}

/** 创建结果 */
type CreateResult = { ok: true; info: PtyInfo } | { ok: false; error: string }

/** 生成短会话 id（计数器 + 随机串，避免与本生命周期内历史 id 冲突） */
let seq = 0
function genId(): string {
  ++seq
  const rand = Math.random().toString(36).slice(2, 7)
  return `t${seq}_${rand}`
}

class PtyManager {
  private sessions = new Map<string, PtySession>()
  /** 会话来源旁路记录：id → user/ai（会话本身不持有来源字段） */
  private origins = new Map<string, 'user' | 'ai'>()
  /** 新建终端默认工作目录（工作区切换时更新） */
  private defaultCwd: string

  constructor() {
    // 防御：单测环境 electron app 可能未初始化（模块单例在 import 时即构造）
    this.defaultCwd = app && app.isPackaged ? os.homedir() : process.cwd()
  }

  /** 广播事件到所有渲染窗口 */
  private emit(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  }

  private toInfo(s: PtySession, origin: 'user' | 'ai'): PtyInfo {
    return {
      id: s.id,
      shell: s.shell.kind,
      command: s.shell.command,
      alive: s.alive,
      exitCode: s.code,
      origin
    }
  }

  /**
   * 创建 PTY 会话。shell 无效/启动失败返回 {ok:false}，不抛出。
   */
  create(input: PtyCreateInput): CreateResult {
    const id = genId()
    const options: PtySessionOptions = {
      id,
      cwd: input.cwd || this.defaultCwd,
      shell: input.shell,
      cols: input.cols ?? 80,
      rows: input.rows ?? 24
    }
    let session: PtySession
    try {
      session = new PtySession(options)
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
    const origin = input.origin ?? 'user'
    // 来源旁路登记（list() 组装 PtyInfo 时读取）
    this.origins.set(id, origin)
    // 输出按 id 广播
    session.onData((data) => this.emit('terminal:ptyData', { id, data }))
    // 外部退出（命令导致 shell 结束）：广播但保留会话，用户关 Tab 时才清理
    session.onExit((code) => this.emit('terminal:ptyExit', { id, code }))
    this.sessions.set(id, session)
    return { ok: true, info: this.toInfo(session, origin) }
  }

  /** 向指定会话写入按键数据 */
  write(id: string, data: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    s.write(data)
    return true
  }

  /** 调整指定会话行列 */
  resize(id: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    s.resize(cols, rows)
    return true
  }

  /**
   * 关闭终端：杀活进程 + 进程树兜底 + 移除会话。
   */
  kill(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    if (s.alive) {
      const pid = s.pid
      s.kill()
      this.treeKillFallback(pid)
    }
    this.sessions.delete(id)
    this.origins.delete(id)
    return true
  }

  /**
   * 进程树兜底：node-pty kill 后孙进程（npm run dev 派生的 node 等）可能残留。
   * Windows：taskkill /pid /T /F；POSIX：向进程组发 SIGTERM（错误一律忽略）。
   */
  private treeKillFallback(pid: number): void {
    if (!pid || pid <= 0) return
    if (process.platform === 'win32') {
      execFile(
        'taskkill',
        ['/pid', String(pid), '/T', '/F'],
        { windowsHide: true },
        () => {
          /* 进程可能已不存在，无需处理错误 */
        }
      )
      return
    }
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      // ESRCH（已退出）/ EPERM（无权限）：node-pty 自身 kill 已尽力
    }
  }

  /** 列出全部会话（含已退出待关闭的） */
  list(): PtyInfo[] {
    // origin 信息来自旁路记录
    return [...this.sessions.values()].map((s) =>
      this.toInfo(s, this.origins.get(s.id) ?? 'user')
    )
  }

  /** 工作区切换：更新后续新建终端默认目录（已有会话不强杀） */
  setDefaultCwd(cwd: string): void {
    if (cwd) this.defaultCwd = cwd
  }

  /**
   * AI 交互命令入口：新建一个 PTY 会话并写入命令（不带哨兵、不回收结果），
   * 用户可在终端 Tab 中继续输入。
   */
  runInteractive(command: string, cwd?: string): { terminalId: string } {
    const r = this.create({ cwd, origin: 'ai' })
    if (!r.ok) throw new Error(r.error)
    const session = this.sessions.get(r.info.id)
    session?.write(command + ptyEnter(process.platform))
    return { terminalId: r.info.id }
  }
}

// 单例 Manager
const manager = new PtyManager()

/** AI 交互命令在 PTY 中启动（scheduler 审批通过后调用） */
export function runInteractiveInPty(command: string, cwd?: string): { terminalId: string } {
  return manager.runInteractive(command, cwd)
}

/** 工作区切换：同步 PTY 默认目录 */
export function setPtyDefaultCwd(cwd: string): void {
  manager.setDefaultCwd(cwd)
}

/** 注册 PTY 相关 IPC */
export function registerPtyHandlers(): void {
  // 创建终端（返回会话摘要；shell 缺省走平台探测：Windows pwsh 优先）
  ipcMain.handle('terminal:ptyCreate', (_e, input?: PtyCreateInput) => manager.create(input ?? {}))

  // 用户按键写入
  ipcMain.handle('terminal:ptyWrite', (_e, id: string, data: string) => manager.write(id, data))

  // 终端行列调整（FitAddon 实测尺寸）
  ipcMain.handle('terminal:ptyResize', (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )

  // 关闭终端（树杀 + 清理）
  ipcMain.handle('terminal:ptyKill', (_e, id: string) => manager.kill(id))

  // 列出全部终端
  ipcMain.handle('terminal:ptyList', () => manager.list())
}
