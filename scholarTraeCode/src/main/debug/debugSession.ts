// 调试会话状态机：管理 Node.js 调试会话（launch / attach），基于 CDP WebSocket。
//
// 实现说明：
// - Node ≥22 内置全局 WebSocket（undici），无需第三方依赖。
// - launch：spawn `node --inspect-brk=<port> <entry>`，从 stderr 解析
//   `Debugger listening on ws://...` 得实际 WebSocket 地址。
// - attach：直接连接 `ws://127.0.0.1:<port>`（Node Inspector 默认开启 CDP）。
// - CDP 命令：Runtime.enable / Debugger.enable / Debugger.setBreakpointByUrl /
//   Debugger.resume / stepOver / stepInto / stepOut / pause；
//   事件：Debugger.paused / Debugger.resumed / Runtime.consoleAPICalled /
//   Runtime.exceptionThrown。
// - 事件桥：所有窗口 webContents.send('debug:event', ...)。
// - DAP 通用编解码见 dapCore.ts（本层暂用 CDP，DAP 为未来多运行时预留）。
import { spawn, type ChildProcess } from 'node:child_process'
import { BrowserWindow } from 'electron'
import WebSocket from 'ws'

// ---------- 类型 ----------

export type DebugState =
  | 'idle'
  | 'connecting'
  | 'initialized'
  | 'running'
  | 'stopped'
  | 'terminated'

export interface StackFrame {
  id: string
  name: string
  file: string
  line: number
  column: number
}

export interface Scope {
  name: string
  variablesReference: string | number
}

export interface Variable {
  name: string
  value: string
  type?: string
  variablesReference: string | number
}

export interface DebugSnapshot {
  state: DebugState
  kind: 'launch' | 'attach' | null
  entry?: string
  port?: number
  pid?: number
}

export type DebugEvent =
  | { kind: 'state'; state: DebugState }
  | { kind: 'output'; text: string; source: 'stdout' | 'stderr' }
  | { kind: 'stopped'; stack: StackFrame[]; scopes: Scope[]; variables: Variable[] }
  | { kind: 'terminated'; exitCode: number | null }

// ---------- 会话内部结构 ----------

interface SessionEntry {
  proc: ChildProcess | null
  ws: WebSocket | null
  msgId: number
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>
  /** file -> lines */
  breakpoints: Map<string, number[]>
  /** 已下断点 id -> 文件，用于更新时清除 */
  bpIds: Map<string, string>
  state: DebugState
  kind: 'launch' | 'attach' | null
  entry?: string
  port?: number
  pid?: number
}

let session: SessionEntry | null = null

/** 最近一次 stopped 的上下文缓存（供 AI 工具 debug_get_context 读取） */
let lastStoppedContext: { stack: StackFrame[]; scopes: Scope[]; variables: Variable[] } | null = null

/** 最近一次异常文本（Runtime.exceptionThrown，供 AI 诊断） */
let lastException: string | null = null

function emit(ev: DebugEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('debug:event', ev)
  }
}

function updateState(s: DebugState): void {
  if (session) session.state = s
  emit({ kind: 'state', state: s })
}

// ---------- CDP 命令封装 ----------

function sendCommand(method: string, params?: Record<string, unknown>): Promise<any> {
  if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('调试会话未连接'))
  }
  const id = session.msgId++
  const msg = JSON.stringify({ id, method, params })
  return new Promise((resolve, reject) => {
    session!.pending.set(id, { resolve, reject })
    session!.ws!.send(msg)
  })
}

function handleMessage(raw: string): void {
  if (!session) return
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }
  if (data.id != null) {
    const p = session.pending.get(data.id)
    if (p) {
      session.pending.delete(data.id)
      if (data.error) p.reject(new Error(data.error.message || String(data.error)))
      else p.resolve(data.result)
    }
    return
  }
  switch (data.method) {
    case 'Debugger.paused':
      void onPaused(data.params)
      break
    case 'Debugger.resumed':
      updateState('running')
      break
    case 'Runtime.consoleAPICalled': {
      const args = (data.params?.args || [])
        .map((a: any) => a.value ?? a.description ?? '')
        .join(' ')
      emit({ kind: 'output', text: args + '\n', source: 'stdout' })
      break
    }
    case 'Runtime.exceptionThrown': {
      const t = data.params?.exceptionDetails?.text || 'exception'
      lastException = t
      emit({ kind: 'output', text: `[exception] ${t}\n`, source: 'stderr' })
      break
    }
  }
}

async function onPaused(params: any): Promise<void> {
  if (!session) return
  updateState('stopped')
  const callFrames = params?.callFrames || []
  const stack: StackFrame[] = callFrames.map((f: any) => ({
    id: f.callFrameId,
    name: f.functionName || '(anonymous)',
    file: f.url || '',
    line: (f.location?.lineNumber ?? 0) + 1,
    column: f.location?.columnNumber ?? 0
  }))

  let scopes: Scope[] = []
  let variables: Variable[] = []
  if (stack.length > 0) {
    const frame = callFrames[0]
    try {
      const scopeChain = frame.scopeChain || []
      scopes = scopeChain.map((s: any) => ({
        name: s.type,
        variablesReference: s.object?.objectId ?? 0
      }))
      const local = scopeChain.find((s: any) => s.type === 'local') || scopeChain[0]
      if (local?.object?.objectId) {
        const r = await sendCommand('Runtime.getProperties', {
          objectId: local.object.objectId,
          ownProperties: true
        })
        variables = (r?.result || []).map((p: any) => ({
          name: p.name,
          value: p.value?.value != null ? String(p.value.value) : p.value?.description ?? '',
          type: p.value?.type,
          variablesReference: p.value?.objectId ?? 0
        }))
      }
    } catch {
      // 拉取失败不阻塞 stopped 状态
    }
  }

  lastStoppedContext = { stack, scopes, variables }
  emit({ kind: 'stopped', stack, scopes, variables })
}

// ---------- 断点同步（按文件覆盖式） ----------

async function syncBreakpoints(): Promise<void> {
  if (!session) return
  // 先清除所有已下断点
  for (const [bpId] of session.bpIds) {
    await sendCommand('Debugger.removeBreakpoint', { breakpointId: bpId }).catch(() => {})
  }
  session.bpIds.clear()
  // 再按当前 map 重新下
  for (const [file, lines] of session.breakpoints.entries()) {
    const url = file.startsWith('file://') ? file : `file://${file}`
    for (const line of lines) {
      const r = await sendCommand('Debugger.setBreakpointByUrl', {
        url,
        lineNumber: Math.max(0, line - 1),
        columnNumber: 0
      }).catch(() => null)
      if (r?.breakpointId) {
        session.bpIds.set(r.breakpointId, file)
      }
    }
  }
}

// ---------- WebSocket 连接 ----------

function connectWebSocket(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!session) return reject(new Error('会话不存在'))
    const ws = new WebSocket(url)
    session.ws = ws as any
    ws.on('open', () => resolve())
    ws.on('error', (err) => reject(err))
    ws.on('message', (data: Buffer) => {
      handleMessage(data.toString('utf8'))
    })
    ws.on('close', () => {
      updateState('terminated')
      emit({ kind: 'terminated', exitCode: null })
    })
  })
}

// ---------- 公共 API ----------

export function getDebugSnapshot(): DebugSnapshot {
  if (!session) return { state: 'idle', kind: null }
  return {
    state: session.state,
    kind: session.kind,
    entry: session.entry,
    port: session.port,
    pid: session.pid
  }
}

/** 当前停驻上下文（供 AI 工具读取） */
export function getDebugStoppedContext(): { stack: StackFrame[]; scopes: Scope[]; variables: Variable[] } | null {
  return lastStoppedContext
}

/** 最近一次异常文本 */
export function getDebugLastException(): string | null {
  return lastException
}

/** 全部断点快照 */
export function getDebugBreakpoints(): Map<string, number[]> {
  if (!session) return new Map()
  const map = new Map<string, number[]>()
  for (const [file, lines] of session.breakpoints.entries()) {
    map.set(file, [...lines])
  }
  return map
}

export async function startDebugSession(
  cfg: { kind: 'launch'; entry: string; port?: number } | { kind: 'attach'; port: number; host?: string }
): Promise<{ ok: boolean; error?: string }> {
  if (session && session.state !== 'terminated' && session.state !== 'idle') {
    return { ok: false, error: '已有调试会话进行中，请先停止' }
  }

  session = {
    proc: null,
    ws: null,
    msgId: 1,
    pending: new Map(),
    breakpoints: new Map(),
    bpIds: new Map(),
    state: 'connecting',
    kind: cfg.kind,
    entry: cfg.kind === 'launch' ? cfg.entry : undefined,
    port: cfg.kind === 'launch' ? cfg.port ?? 9229 : cfg.port
  }

  updateState('connecting')
  lastStoppedContext = null
  lastException = null

  try {
    if (cfg.kind === 'launch') {
      const port = session.port ?? 9229
      const proc = spawn('node', [`--inspect-brk=${port}`, cfg.entry], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      session.proc = proc
      session.pid = proc.pid

      const wsUrl = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 Debugger listening 超时')), 10000)
        const onData = (buf: Buffer): void => {
          const text = buf.toString('utf8')
          const m = /ws:\/\/[^\s]+/.exec(text)
          if (m) {
            clearTimeout(timer)
            proc.stderr.off('data', onData)
            resolve(m[0])
          }
        }
        proc.stderr.on('data', onData)
        proc.on('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
      })

      proc.stdout.on('data', (buf: Buffer) => {
        emit({ kind: 'output', text: buf.toString('utf8'), source: 'stdout' })
      })
      proc.stderr.on('data', (buf: Buffer) => {
        emit({ kind: 'output', text: buf.toString('utf8'), source: 'stderr' })
      })
      proc.on('exit', (code) => {
        updateState('terminated')
        emit({ kind: 'terminated', exitCode: code })
      })

      await connectWebSocket(wsUrl)
    } else {
      const host = cfg.host ?? '127.0.0.1'
      await connectWebSocket(`ws://${host}:${cfg.port}`)
    }

    await sendCommand('Runtime.enable')
    await sendCommand('Debugger.enable')
    await syncBreakpoints()
    // launch 模式被 --inspect-brk 挂起，需要放行；attach 模式该命令无副作用
    await sendCommand('Runtime.runIfWaitingForDebugger').catch(() => {})
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

export async function stopDebugSession(): Promise<{ ok: boolean }> {
  if (!session) return { ok: true }
  const s = session
  session = null
  lastStoppedContext = null
  lastException = null
  try {
    if (s.ws) s.ws.close()
    if (s.proc && s.proc.exitCode === null) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(s.proc.pid), '/T', '/F'], { windowsHide: true })
      } else {
        s.proc.kill('SIGTERM')
      }
    }
  } catch {
    // 忽略关闭错误
  }
  updateState('terminated')
  emit({ kind: 'terminated', exitCode: null })
  return { ok: true }
}

export async function setDebugBreakpoints(
  file: string,
  lines: number[]
): Promise<{ ok: boolean; error?: string }> {
  if (!session) return { ok: false, error: '无调试会话' }
  session.breakpoints.set(file, lines.slice().sort((a, b) => a - b))
  await syncBreakpoints()
  return { ok: true }
}

export async function debugControl(
  action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause'
): Promise<{ ok: boolean; error?: string }> {
  if (!session) return { ok: false, error: '无调试会话' }
  try {
    switch (action) {
      case 'continue': await sendCommand('Debugger.resume'); break
      case 'next': await sendCommand('Debugger.stepOver'); break
      case 'stepIn': await sendCommand('Debugger.stepInto'); break
      case 'stepOut': await sendCommand('Debugger.stepOut'); break
      case 'pause': await sendCommand('Debugger.pause'); break
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}
