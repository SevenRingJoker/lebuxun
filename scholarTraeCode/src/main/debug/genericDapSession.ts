// 3.3 通用 DAP 会话：Python（debugpy）/ Go（dlv dap）调试运行时。
// 基于 dapCore.ts 帧编解码，spawn adapter 进程经 stdio 通信。
// 与 debugSession.ts（Node CDP）对外暴露统一接口。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import { BrowserWindow } from 'electron'
import { runAffectedTests } from '../ai/autoTest'
import {
  encodeDapMessage,
  createDapDecoder,
  feedDapChunk,
  isResponse,
  isEvent,
  createSeqAllocator,
  matchResponse,
  parseStackFrames,
  parseScopes,
  parseVariables,
  type DapMessage,
  type DapResponse,
  type PendingRequest
} from './dapCore'

// ---------- 类型（与 debugSession.ts 对齐） ----------

export type DapRuntime = 'debugpy' | 'dlv'

export interface DapLaunchConfig {
  runtime: DapRuntime
  request: 'launch'
  /** 入口脚本（Python: .py；Go: 程序目录或 main.go） */
  program: string
  args?: string[]
  cwd?: string
  env?: Record<string, string | null>
  /** debugpy 监听端口（默认 5678）；dlv 默认 2345 */
  port?: number
}

export interface DapAttachConfig {
  runtime: DapRuntime
  request: 'attach'
  port: number
  host?: string
}

export type DapConfig = DapLaunchConfig | DapAttachConfig

export type DapState = 'idle' | 'connecting' | 'initialized' | 'running' | 'stopped' | 'terminated'

export interface DapStackFrame {
  id: number
  name: string
  file: string
  line: number
  column: number
}

export interface DapScope {
  name: string
  variablesReference: number
}

export interface DapVariable {
  name: string
  value: string
  type?: string
  variablesReference: number
}

export interface DapSnapshot {
  state: DapState
  runtime: DapRuntime | null
  program?: string
  pid?: number
}

export type DapEvent =
  | { kind: 'state'; state: DapState }
  | { kind: 'output'; text: string; source: 'stdout' | 'stderr' }
  | { kind: 'stopped'; stack: DapStackFrame[]; scopes: DapScope[]; variables: DapVariable[] }
  | { kind: 'terminated'; exitCode: number | null }
  // s52 异常停驻：reason=exception 时携带异常描述、堆栈、变量，供 AI 自动修复对话注入
  | {
      kind: 'exception'
      description: string
      stack: DapStackFrame[]
      scopes: DapScope[]
      variables: DapVariable[]
    }

// ---------- 会话内部 ----------

interface SessionEntry {
  proc: ChildProcess | null
  seq: () => number
  pending: PendingRequest[]
  decoder: ReturnType<typeof createDapDecoder>
  /** file -> lines */
  breakpoints: Map<string, number[]>
  /** DAP threadId（stopped 事件携带，步进/继续需要） */
  threadId: number | null
  /** 事件等待器（如 initialized）：event 名 → resolve 列表 */
  eventWaiters: Map<string, (() => void)[]>
  state: DapState
  runtime: DapRuntime | null
  program?: string
  pid?: number
}

let session: SessionEntry | null = null

/** 最近一次 stopped 的上下文缓存（供 AI 工具 debug_get_context 读取） */
let lastStoppedContext: { stack: DapStackFrame[]; scopes: DapScope[]; variables: DapVariable[] } | null = null

function emit(ev: DapEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('debug:event', ev)
  }
}

function updateState(s: DapState): void {
  if (session) session.state = s
  emit({ kind: 'state', state: s })
}

// ---------- DAP 请求/响应 ----------

function sendRequest(command: string, args?: Record<string, unknown>): Promise<DapResponse> {
  if (!session || !session.proc || !session.proc.stdin) {
    return Promise.reject(new Error('DAP 会话未连接'))
  }
  const seq = session.seq()
  const msg: DapMessage = { seq, type: 'request', command, arguments: args }
  const buf = encodeDapMessage(msg)
  return new Promise((resolve, reject) => {
    session!.pending.push({ seq, command, resolve, reject })
    session!.proc!.stdin!.write(buf)
  })
}

/** 进程退出/错误时拒绝全部在途请求，避免 sendRequest 永久挂起 */
function rejectAllPending(reason: string): void {
  if (!session) return
  const pending = session.pending
  session.pending = []
  for (const p of pending) {
    p.reject(new Error(reason))
  }
  // 同时唤醒事件等待器（让其走超时之外的快速失败路径）
  for (const list of session.eventWaiters.values()) {
    for (const fn of list) fn()
  }
  session.eventWaiters.clear()
}

function handleChunk(chunk: string): void {
  if (!session) return
  const { messages, state } = feedDapChunk(session.decoder, chunk)
  session.decoder = state
  for (const msg of messages) {
    if (isResponse(msg)) {
      const { matched, remaining } = matchResponse(session.pending, msg)
      session.pending = remaining
      if (matched) {
        if (msg.success) matched.resolve(msg)
        else matched.reject(new Error(msg.message || `DAP ${msg.command} 失败`))
      }
    } else if (isEvent(msg)) {
      handleDapEvent(msg)
    }
  }
}

/** 等待指定 DAP 事件一次（带超时） */
function waitForEvent(event: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!session) return reject(new Error('会话不存在'))
    const timer = setTimeout(() => reject(new Error(`等待 ${event} 事件超时`)), timeoutMs)
    const list = session.eventWaiters.get(event) ?? []
    list.push(() => { clearTimeout(timer); resolve() })
    session.eventWaiters.set(event, list)
  })
}

function fireEventWaiters(event: string): void {
  if (!session) return
  const list = session.eventWaiters.get(event)
  if (list?.length) {
    session.eventWaiters.delete(event)
    for (const fn of list) fn()
  }
}

function handleDapEvent(msg: Extract<DapMessage, { type: 'event' }>): void {
  if (!session) return
  fireEventWaiters(msg.event)
  switch (msg.event) {
    case 'stopped': {
      const body = msg.body as any
      session.threadId = body?.threadId ?? null
      const reason: string = body?.reason ?? ''
      updateState('stopped')
      // 异步拉取堆栈/作用域/变量；异常停驻时额外发出 exception 事件供 AI 修复
      void (async () => {
        await fetchStoppedContext()
        const ctx = lastStoppedContext
        if (reason === 'exception' && ctx) {
          const description = body?.description || body?.text || '未捕获异常'
          emit({
            kind: 'exception',
            description,
            stack: ctx.stack,
            scopes: ctx.scopes,
            variables: ctx.variables
          })
        }
      })()
      break
    }
    case 'continued':
      updateState('running')
      break
    case 'terminated':
    case 'exited': {
      const body = msg.body as any
      const exitCode = body?.exitCode ?? null
      updateState('terminated')
      emit({ kind: 'terminated', exitCode })
      // s52「继续到修复验证」：调试正常退出（exitCode=0）后联动 s46 受影响测试回归。
      // workspace 取入口文件所在目录；无 vitest 时 runAffectedTests 静默跳过。
      if (exitCode === 0 && session?.program) {
        const ws = dirname(session.program)
        void runAffectedTests(ws, [session.program])
      }
      break
    }
    case 'output': {
      const body = msg.body as any
      const text = body?.output ?? ''
      const source = body?.category === 'stderr' ? 'stderr' : 'stdout'
      emit({ kind: 'output', text, source })
      break
    }
  }
}

async function fetchStoppedContext(): Promise<void> {
  if (!session || session.threadId == null) return
  try {
    // 1. 堆栈
    const stackRes = await sendRequest('stackTrace', {
      threadId: session.threadId,
      startFrame: 0,
      levels: 20
    })
    const stack = parseStackFrames(stackRes.body).map((f) => ({
      id: f.id,
      name: f.name,
      file: f.file,
      line: f.line,
      column: f.column
    }))

    // 2. 作用域（取首帧）
    let scopes: DapScope[] = []
    let variables: DapVariable[] = []
    if (stack.length > 0) {
      const scopeRes = await sendRequest('scopes', { frameId: stack[0].id })
      scopes = parseScopes(scopeRes.body).map((s) => ({
        name: s.name,
        variablesReference: s.variablesReference
      }))
      // 3. 变量（首个非 expensive 作用域）
      const firstScope = scopes.find((s) => s.variablesReference > 0)
      if (firstScope) {
        const varRes = await sendRequest('variables', {
          variablesReference: firstScope.variablesReference
        })
        variables = parseVariables(varRes.body).map((v) => ({
          name: v.name,
          value: v.value,
          type: v.type,
          variablesReference: v.variablesReference
        }))
      }
    }
    lastStoppedContext = { stack, scopes, variables }
    emit({ kind: 'stopped', stack, scopes, variables })
  } catch {
    // 拉取失败不阻塞 stopped 状态
    lastStoppedContext = { stack: [], scopes: [], variables: [] }
    emit({ kind: 'stopped', stack: [], scopes: [], variables: [] })
  }
}

// ---------- 断点同步 ----------

async function syncBreakpoints(): Promise<void> {
  if (!session) return
  for (const [file, lines] of session.breakpoints.entries()) {
    await sendRequest('setBreakpoints', {
      source: { path: file },
      breakpoints: lines.map((line) => ({ line }))
    }).catch(() => {
      // 单文件失败不阻塞其他
    })
  }
}

// ---------- adapter 命令构造 ----------

/** 构造 adapter 启动命令（Python debugpy / Go dlv）。
 *  注意：adapter 走 stdio DAP（非 TCP listen）——
 *  debugpy 用 `python -m debugpy.adapter`，dlv 用 `dlv dap`（默认 stdio）。
 *  attach 的目标端口经 DAP attach 请求参数传递，不在命令行。 */
export function buildAdapterCommand(cfg: DapConfig): {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
} {
  if (cfg.runtime === 'debugpy') {
    return {
      command: 'python',
      args: ['-m', 'debugpy.adapter'],
      cwd: cfg.request === 'launch' ? cfg.cwd : undefined,
      env: cfg.request === 'launch' ? (cfg.env as Record<string, string>) : undefined
    }
  }
  // dlv dap：默认 stdio 模式
  return {
    command: 'dlv',
    args: ['dap'],
    cwd: cfg.request === 'launch' ? cfg.cwd : undefined
  }
}

/** 探测可用的 Python 命令（Windows 常无 python 仅有 py 启动器；结果缓存）。
 *  顺序：py（真实启动器）→ python3 → python（MS Store stub 风险） */
let cachedPythonCmd: string | null = null
function resolvePythonCommand(): string {
  if (cachedPythonCmd) return cachedPythonCmd
  for (const c of ['py', 'python3', 'python']) {
    const r = spawnSync(c, ['--version'], { stdio: 'ignore', windowsHide: true })
    if (!r.error) {
      cachedPythonCmd = c
      return c
    }
  }
  return 'python' // 兜底：让 spawn error 事件走安装引导文案
}

/** adapter 安装引导文案（按运行时给安装提示） */
function adapterGuide(runtime: DapRuntime): string {
  return runtime === 'debugpy'
    ? '未找到 Python 或 debugpy。请确认 python（或 py）在 PATH 中，并执行 pip install debugpy'
    : '未找到 dlv。请安装 Go 后执行 go install github.com/go-delve/delve/cmd/dlv@latest'
}

// ---------- 公共 API ----------

export function getDapSnapshot(): DapSnapshot {
  if (!session) return { state: 'idle', runtime: null }
  return {
    state: session.state,
    runtime: session.runtime,
    program: session.program,
    pid: session.pid
  }
}

/** 当前停驻上下文（供 AI 工具读取） */
export function getDapStoppedContext(): { stack: DapStackFrame[]; scopes: DapScope[]; variables: DapVariable[] } | null {
  return lastStoppedContext
}

/** 全部断点快照 */
export function getDapBreakpoints(): Map<string, number[]> {
  if (!session) return new Map()
  const map = new Map<string, number[]>()
  for (const [file, lines] of session.breakpoints.entries()) {
    map.set(file, [...lines])
  }
  return map
}

export async function startDapSession(cfg: DapConfig): Promise<{ ok: boolean; error?: string }> {
  if (session && session.state !== 'terminated' && session.state !== 'idle') {
    return { ok: false, error: '已有 DAP 会话进行中，请先停止' }
  }

  const cmd = buildAdapterCommand(cfg)
  session = {
    proc: null,
    seq: createSeqAllocator(),
    pending: [],
    decoder: createDapDecoder(),
    breakpoints: new Map(),
    threadId: null,
    eventWaiters: new Map(),
    state: 'connecting',
    runtime: cfg.runtime,
    program: cfg.request === 'launch' ? cfg.program : undefined
  }

  updateState('connecting')
  lastStoppedContext = null

  try {
    // debugpy：python 命令按本机实际解析（Windows 常仅 py 启动器）
    const command = cfg.runtime === 'debugpy' ? resolvePythonCommand() : cmd.command
    const proc = spawn(command, cmd.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cmd.cwd,
      env: cmd.env ? { ...process.env, ...cmd.env } : process.env,
      windowsHide: true
    })
    session.proc = proc
    session.pid = proc.pid

    // spawn 失败（ENOENT 等）：转安装引导错误，避免后续握手挂起
    let spawnError: Error | null = null
    proc.on('error', (err) => {
      spawnError = err
      rejectAllPending(`adapter 进程错误：${err.message}`)
      updateState('terminated')
      emit({ kind: 'output', text: `[adapter 启动失败] ${adapterGuide(cfg.runtime)}\n${err.message}\n`, source: 'stderr' })
      emit({ kind: 'terminated', exitCode: null })
    })

    // stdio 数据流
    proc.stdout!.on('data', (buf: Buffer) => handleChunk(buf.toString('utf8')))
    proc.stderr!.on('data', (buf: Buffer) => {
      emit({ kind: 'output', text: buf.toString('utf8'), source: 'stderr' })
    })
    proc.on('exit', (code) => {
      // 进程退出时在途请求全部失败（如 initialize 未收到响应）
      rejectAllPending(`adapter 进程已退出（code=${code}）`)
      updateState('terminated')
      emit({ kind: 'terminated', exitCode: code })
    })

    // DAP 初始化握手。
    // 注意顺序（探针实测 debugpy 行为）：launch 响应在 configurationDone 之后才返回，
    // 故 launch 发出后不 await，先等 initialized 事件 → 下断点 → configurationDone。
    // ENOENT 等 spawn 失败在下一事件循环拍触发，先让出一拍检查，避免握手空等超时
    await new Promise((r) => setImmediate(r))
    if (spawnError) throw new Error(adapterGuide(cfg.runtime))
    const initRes = await sendRequest('initialize', {
      clientID: 'scholar-trea-code',
      adapterID: cfg.runtime,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path'
    })
    if (!initRes.success) throw new Error(initRes.message || 'initialize 失败')

    // launch / attach 请求：发出后仅保留 promise，最后再收响应
    const launchPromise = cfg.request === 'launch'
      ? sendRequest('launch', {
          program: cfg.program,
          args: cfg.args ?? [],
          cwd: cfg.cwd,
          env: cfg.env,
          stopOnEntry: false,
          // debugpy 需要 console 字段；internalConsole 让 print 输出走 output 事件
          console: 'internalConsole'
        })
      : sendRequest('attach', {
          // debugpy attach：connect 子对象携带目标监听端口
          connect: { port: cfg.port, host: cfg.host ?? '127.0.0.1' }
        })
    launchPromise.catch(() => {}) // 防未捕获 rejection；最终结果在下方 await

    // 等 adapter 宣告可接收配置（initialized），再下断点并放行
    await waitForEvent('initialized', 15000)
    await syncBreakpoints()
    await sendRequest('configurationDone')
    // launch/attach 响应此刻应已返回
    await launchPromise

    updateState('initialized')
    updateState('running')
    return { ok: true }
  } catch (err: any) {
    updateState('terminated')
    const s = session
    session = null
    if (s?.proc && s.proc.exitCode === null) {
      try { s.proc.kill() } catch { /* 忽略 */ }
    }
    return { ok: false, error: err?.message || String(err) }
  }
}

export async function stopDapSession(): Promise<{ ok: boolean }> {
  if (!session) return { ok: true }
  const s = session
  session = null
  lastStoppedContext = null
  try {
    if (s.proc && s.proc.exitCode === null) {
      // 先发 terminate 请求（优雅退出）
      try {
        await sendRequest('terminate')
      } catch { /* 忽略 */ }
      // 超时后强杀
      setTimeout(() => {
        if (s.proc && s.proc.exitCode === null) {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(s.proc.pid), '/T', '/F'], { windowsHide: true })
          } else {
            s.proc.kill('SIGTERM')
          }
        }
      }, 3000)
    }
  } catch {
    // 忽略关闭错误
  }
  updateState('terminated')
  emit({ kind: 'terminated', exitCode: null })
  return { ok: true }
}

export async function setDapBreakpoints(
  file: string,
  lines: number[]
): Promise<{ ok: boolean; error?: string }> {
  if (!session) return { ok: false, error: '无 DAP 会话' }
  session.breakpoints.set(file, lines.slice().sort((a, b) => a - b))
  await syncBreakpoints()
  return { ok: true }
}

export async function dapControl(
  action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause'
): Promise<{ ok: boolean; error?: string }> {
  if (!session || session.threadId == null) return { ok: false, error: '无 DAP 会话或未停止' }
  try {
    switch (action) {
      case 'continue': await sendRequest('continue', { threadId: session.threadId }); break
      case 'next': await sendRequest('next', { threadId: session.threadId }); break
      case 'stepIn': await sendRequest('stepIn', { threadId: session.threadId }); break
      case 'stepOut': await sendRequest('stepOut', { threadId: session.threadId }); break
      case 'pause': await sendRequest('pause', { threadId: session.threadId }); break
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}

/** REPL evaluate（表达式求值）：frameId 传首帧，debugpy 要求有效帧上下文 */
export async function dapEvaluate(expression: string): Promise<{ ok: boolean; result?: string; error?: string }> {
  if (!session || session.threadId == null) return { ok: false, error: '无 DAP 会话或未停止' }
  const frameId = lastStoppedContext?.stack[0]?.id
  if (frameId == null) return { ok: false, error: '无停驻帧上下文' }
  try {
    const res = await sendRequest('evaluate', {
      expression,
      frameId,
      context: 'repl'
    })
    const body = res.body as any
    return { ok: true, result: body?.result ?? '' }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}
