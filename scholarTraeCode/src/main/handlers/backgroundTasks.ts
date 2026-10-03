// 后台任务运行器：独立于持久终端会话队列的一次性长任务（dev server、watch、监听类）。
//
// 与持久会话的区别：
// - spawn 后不占用终端命令队列，多个后台任务可并行；
// - POSIX 使用 detached 独立进程组，终止时整组杀（SIGTERM→SIGKILL 升级）；
// - Windows 用 taskkill /T 树杀；输出仍按 GBK 解码；
// - 每个任务保留最近 MAX_BUFFER 字符的环形缓冲，前端可按偏移追读。
import { ipcMain, BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import iconv from 'iconv-lite'
import { isAbsolute, resolve } from 'node:path'
import {
  type ShellProfile,
  isWithinWorkspace
} from '../terminal/shellProbe'
import {
  type RingBuffer,
  appendRing,
  buildTaskSpawnSpec,
  formatDuration,
  newTaskId
} from '../terminal/taskUtils'

// formatDuration 供 IPC 层/外部 UI 数据组装复用
export { formatDuration }

// ---------- 有状态运行器 ----------

const MAX_BUFFER = 200_000
/** 已结束任务最多保留条数（仍可查看缓冲） */
const FINISHED_KEEP = 20

export interface TaskSnapshot {
  id: string
  command: string
  cwd: string
  pid: number
  status: 'running' | 'exited'
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  /** 缓冲中保留的字符数 */
  bytes: number
}

export type BackgroundTaskEvent =
  | { kind: 'task-start'; task: TaskSnapshot }
  | { kind: 'task-data'; id: string; text: string }
  | { kind: 'task-exit'; id: string; exitCode: number | null }

interface TaskEntry {
  snap: TaskSnapshot
  proc: ChildProcessWithoutNullStreams | null
  ring: RingBuffer
  decoders: unknown[]
  killTimer: NodeJS.Timeout | null
}

/** 工作区根（由 terminalServer.setTerminalWorkspace 一并同步） */
let workspaceRoot: string | null = null
export function setBackgroundWorkspaceRoot(root: string | null): void {
  workspaceRoot = root
}

/** 当前 shell 配置提供者（由 terminal.ts 注入，保持单处探测） */
let profileProvider: (() => ShellProfile) | null = null
export function setTaskShellProfileProvider(fn: () => ShellProfile): void {
  profileProvider = fn
}

const tasks = new Map<string, TaskEntry>()
let seq = 0

function emit(ev: BackgroundTaskEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('task:event', ev)
  }
}

function snapshotOf(e: TaskEntry): TaskSnapshot {
  return { ...e.snap, bytes: e.ring.text.length }
}

/** 启动后台任务；越界/派生失败返回错误 */
export function startBackgroundTask(opts: {
  command: string
  cwd?: string
}): { ok: true; id: string } | { ok: false; error: string } {
  const command = opts.command?.trim()
  if (!command) return { ok: false, error: '命令为空' }
  if (!profileProvider) return { ok: false, error: '终端 shell 尚未初始化' }

  const base = workspaceRoot || process.cwd()
  const cwd = opts.cwd ? (isAbsolute(opts.cwd) ? opts.cwd : resolve(base, opts.cwd)) : base
  if (!isWithinWorkspace(cwd, base)) {
    return { ok: false, error: `工作目录必须在当前工作区内（${base}）` }
  }

  const profile = profileProvider()
  const spec = buildTaskSpawnSpec(profile, command)
  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(spec.command, spec.args, {
      cwd,
      windowsHide: true,
      // POSIX 独立进程组：pid 即进程组 leader，kill(-pid) 可整组终止
      detached: process.platform !== 'win32',
      env: { ...process.env, FORCE_COLOR: '0' } as NodeJS.ProcessEnv
    })
  } catch (err: any) {
    return { ok: false, error: `启动失败：${err?.message || String(err)}` }
  }

  const id = newTaskId(++seq, Date.now())
  const entry: TaskEntry = {
    snap: {
      id,
      command,
      cwd,
      pid: proc.pid ?? -1,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      bytes: 0
    },
    proc,
    ring: { text: '', base: 0 },
    decoders: [],
    killTimer: null
  }
  tasks.set(id, entry)

  const pushData = (s: string): void => {
    entry.ring = appendRing(entry.ring, s, MAX_BUFFER)
    emit({ kind: 'task-data', id, text: s })
  }

  if (profile.encoding === 'gbk') {
    const outDecoder = iconv.decodeStream('gbk')
    const errDecoder = iconv.decodeStream('gbk')
    proc.stdout.pipe(outDecoder)
    proc.stderr.pipe(errDecoder)
    outDecoder.on('data', (s: string | Buffer) => pushData(String(s)))
    errDecoder.on('data', (s: string | Buffer) => pushData(String(s)))
    entry.decoders = [outDecoder, errDecoder]
  } else {
    proc.stdout.on('data', (buf: Buffer) => pushData(buf.toString('utf8')))
    proc.stderr.on('data', (buf: Buffer) => pushData(buf.toString('utf8')))
  }

  proc.on('exit', (code) => {
    entry.snap.status = 'exited'
    entry.snap.exitCode = code
    entry.snap.endedAt = Date.now()
    entry.proc = null
    if (entry.killTimer) {
      clearTimeout(entry.killTimer)
      entry.killTimer = null
    }
    for (const d of entry.decoders) {
      try {
        ;(d as { destroy?: () => void }).destroy?.()
      } catch {
        // 忽略
      }
    }
    entry.decoders = []
    emit({ kind: 'task-exit', id, exitCode: code })
    pruneFinished()
  })
  proc.on('error', (err) => {
    pushData(`[任务错误] ${err.message}\n`)
  })

  emit({ kind: 'task-start', task: snapshotOf(entry) })
  return { ok: true, id }
}

/** 已结束任务超量裁剪（最旧的先丢） */
function pruneFinished(): void {
  const finished = [...tasks.values()].filter((e) => e.snap.status === 'exited')
  if (finished.length <= FINISHED_KEEP) return
  finished
    .sort((a, b) => (a.snap.endedAt ?? 0) - (b.snap.endedAt ?? 0))
    .slice(0, finished.length - FINISHED_KEEP)
    .forEach((e) => tasks.delete(e.snap.id))
}

/** 任务列表快照（运行中在前，其次按开始时间倒序） */
export function listBackgroundTasks(): TaskSnapshot[] {
  return [...tasks.values()]
    .map(snapshotOf)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1
      return b.startedAt - a.startedAt
    })
}

/** 按绝对字符偏移追读缓冲；offset 早于环形基准时返回现存全部并提示断层 */
export function tailBackgroundTask(
  id: string,
  offset: number
): { ok: true; text: string; base: number; next: number; status: TaskSnapshot['status']; exitCode: number | null; truncated: boolean } | { ok: false; error: string } {
  const e = tasks.get(id)
  if (!e) return { ok: false, error: '任务不存在或已被清理' }
  const start = Math.max(0, offset - e.ring.base)
  return {
    ok: true,
    text: e.ring.text.slice(start),
    base: e.ring.base,
    next: e.ring.base + e.ring.text.length,
    status: e.snap.status,
    exitCode: e.snap.exitCode,
    truncated: offset < e.ring.base
  }
}

/** 终止任务：POSIX 进程组 SIGTERM→SIGKILL；Windows taskkill 树杀 */
export function killBackgroundTask(id: string): { ok: boolean; error?: string } {
  const e = tasks.get(id)
  if (!e) return { ok: false, error: '任务不存在' }
  if (!e.proc || e.snap.status === 'exited') return { ok: true }

  const pid = e.snap.pid
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      // 负数 pid = 整个进程组
      process.kill(-pid, 'SIGTERM')
      e.killTimer = setTimeout(() => {
        if (e.proc && e.snap.status === 'running') {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            // 进程可能刚好退出
          }
        }
      }, 1500)
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}

/** 注册后台任务 IPC（随终端处理器一并注册） */
export function registerBackgroundTaskHandlers(): void {
  ipcMain.handle('task:start', (_e, opts: { command: string; cwd?: string }) =>
    startBackgroundTask(opts ?? { command: '' })
  )
  ipcMain.handle('task:list', () => listBackgroundTasks())
  ipcMain.handle('task:kill', (_e, id: string) => killBackgroundTask(id))
  ipcMain.handle('task:tail', (_e, payload: { id: string; offset?: number }) =>
    tailBackgroundTask(payload?.id ?? '', payload?.offset ?? 0)
  )
}
