// DAP（Debug Adapter Protocol）消息编解码纯函数层（零 IO / 零 electron，可单测）。
//
// 设计说明：
// - 提供 Content-Length 帧的完整编解码、请求序号管理、响应匹配、断点规范化、
//   以及 launch/attach 参数构造与常用响应解析。
// - 当前 Node.js 调试直接走 CDP（WebSocket）与 Inspector 通信，本层为未来
//   接入标准 DAP adapter（如 debugpy、vscode-js-debug）预留通用协议能力。
// - 所有函数无副作用，不依赖 electron / fs / net，可在 Node 环境单测。

// ---------- 基础类型 ----------

/** DAP 请求消息 */
export interface DapRequest {
  seq: number
  type: 'request'
  command: string
  arguments?: Record<string, unknown>
}

/** DAP 响应消息 */
export interface DapResponse {
  seq: number
  type: 'response'
  request_seq: number
  success: boolean
  command: string
  message?: string
  body?: unknown
}

/** DAP 事件消息 */
export interface DapEvent {
  seq: number
  type: 'event'
  event: string
  body?: unknown
}

/** DAP 消息联合体 */
export type DapMessage = DapRequest | DapResponse | DapEvent

/** 待匹配请求记录 */
export interface PendingRequest {
  seq: number
  command: string
  resolve: (res: DapResponse) => void
  reject: (err: Error) => void
}

/** 帧解码器状态 */
export interface DapDecoderState {
  /** 接收缓冲 */
  buffer: string
  /** 等待读取的长度；null 表示正在读头部 */
  expectLength: number | null
}

// ---------- 编解码 ----------

/** 将 DAP 消息编码为 Content-Length 帧（返回 Buffer）。 */
export function encodeDapMessage(msg: DapMessage): Buffer {
  const body = JSON.stringify(msg)
  const head = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`
  return Buffer.concat([Buffer.from(head, 'ascii'), Buffer.from(body, 'utf8')])
}

/** 创建全新解码器状态。 */
export function createDapDecoder(): DapDecoderState {
  return { buffer: '', expectLength: null }
}

/** 喂入字节块，返回 { messages, state }。
 *  支持：半包头部、半包 JSON、多帧粘连、空块。 */
export function feedDapChunk(
  state: DapDecoderState,
  chunk: string
): { messages: DapMessage[]; state: DapDecoderState } {
  let buf = state.buffer + chunk
  let expect = state.expectLength
  const messages: DapMessage[] = []

  while (true) {
    if (expect === null) {
      // 还在读头部
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) break
      const header = buf.slice(0, idx)
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) {
        // 非法头部：丢弃到下一个 \r\n\r\n 之前？保守做法：丢弃当前头部段，继续尝试
        buf = buf.slice(idx + 4)
        continue
      }
      expect = parseInt(m[1], 10)
      buf = buf.slice(idx + 4)
    }

    const needBytes = expect
    // 用 Buffer 精确计算 UTF-8 字节长度，避免多字节字符截断
    const bufBytes = Buffer.byteLength(buf, 'utf8')
    if (bufBytes < needBytes) break

    // 从 buf 中切出恰好 needBytes 字节
    let consumed = 0
    let charIdx = 0
    for (; charIdx < buf.length; charIdx++) {
      const c = buf[charIdx]
      consumed += Buffer.byteLength(c, 'utf8')
      if (consumed >= needBytes) {
        charIdx++
        break
      }
    }
    const bodyStr = buf.slice(0, charIdx)
    buf = buf.slice(charIdx)
    expect = null

    try {
      const msg = JSON.parse(bodyStr) as DapMessage
      messages.push(msg)
    } catch {
      // 解析失败的帧丢弃，继续处理后续数据
    }
  }

  return { messages, state: { buffer: buf, expectLength: expect } }
}

// ---------- 消息判别 ----------

export function isRequest(msg: DapMessage): msg is DapRequest {
  return msg.type === 'request'
}

export function isResponse(msg: DapMessage): msg is DapResponse {
  return msg.type === 'response'
}

export function isEvent(msg: DapMessage): msg is DapEvent {
  return msg.type === 'event'
}

// ---------- 请求序号与匹配 ----------

/** 原子分配序号（闭包工厂）。 */
export function createSeqAllocator(initial = 1): () => number {
  let n = initial
  return () => {
    const v = n
    n += 1
    return v
  }
}

/** 从 pending 列表中按 request_seq 匹配响应，返回匹配项与剩余列表。 */
export function matchResponse(
  pending: PendingRequest[],
  msg: DapMessage
): { matched: PendingRequest | null; remaining: PendingRequest[] } {
  if (!isResponse(msg)) return { matched: null, remaining: pending }
  const idx = pending.findIndex((p) => p.seq === msg.request_seq)
  if (idx === -1) return { matched: null, remaining: pending }
  const matched = pending[idx]
  const remaining = pending.slice(0, idx).concat(pending.slice(idx + 1))
  return { matched, remaining }
}

// ---------- 断点规范化 ----------

export interface BreakpointSpec {
  /** 绝对路径 */
  file: string
  /** 1-based 行号 */
  line: number
}

/** 规范化断点：路径转为绝对、行号至少为 1。 */
export function normalizeBreakpoint(file: string, line: number, root?: string): BreakpointSpec {
  const trimmed = file.trim()
  const abs = trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed) ? trimmed : root ? `${root}/${trimmed}` : trimmed
  return { file: abs, line: Math.max(1, Math.floor(line)) }
}

/** 按文件聚合同一文件的断点行号。 */
export function groupBreakpointsByFile(bps: BreakpointSpec[]): Map<string, number[]> {
  const map = new Map<string, number[]>()
  for (const bp of bps) {
    const arr = map.get(bp.file) || []
    arr.push(bp.line)
    map.set(bp.file, arr)
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a - b)
  }
  return map
}

// ---------- launch / attach 参数 ----------

export interface LaunchConfig {
  /** 入口脚本绝对路径 */
  entry: string
  /** 传给脚本的参数 */
  args?: string[]
  /** 工作目录 */
  cwd?: string
  /** 环境变量 */
  env?: Record<string, string | null>
}

export interface AttachConfig {
  /** Inspector 端口 */
  port: number
  /** 主机 */
  host?: string
}

/** 构造 launch 请求参数（传给 DAP adapter）。 */
export function buildLaunchArgs(cfg: LaunchConfig): Record<string, unknown> {
  return {
    type: 'node',
    request: 'launch',
    name: 'Launch',
    program: cfg.entry,
    args: cfg.args ?? [],
    cwd: cfg.cwd,
    env: cfg.env,
    // 让 Node 启动时自动挂起，等前端 setBreakpoints 后再继续
    stopOnEntry: false
  }
}

/** 构造 attach 请求参数。 */
export function buildAttachArgs(cfg: AttachConfig): Record<string, unknown> {
  return {
    type: 'node',
    request: 'attach',
    name: 'Attach',
    port: cfg.port,
    host: cfg.host ?? '127.0.0.1'
  }
}

// ---------- 常用响应解析（UI 友好结构 + 兜底） ----------

export interface StackFrame {
  id: number
  name: string
  file: string
  line: number
  column: number
}

export interface Scope {
  name: string
  variablesReference: number
  expensive: boolean
}

export interface Variable {
  name: string
  value: string
  type?: string
  variablesReference: number
}

/** 解析 stackTrace 响应体。 */
export function parseStackFrames(body: unknown): StackFrame[] {
  if (!body || typeof body !== 'object') return []
  const arr = (body as any).stackFrames
  if (!Array.isArray(arr)) return []
  return arr
    .map((f: any) => ({
      id: typeof f?.id === 'number' ? f.id : -1,
      name: String(f?.name ?? ''),
      file: String(f?.source?.path ?? f?.source?.name ?? ''),
      line: typeof f?.line === 'number' ? f.line : 0,
      column: typeof f?.column === 'number' ? f.column : 0
    }))
    .filter((f) => f.id !== -1)
}

/** 解析 scopes 响应体。 */
export function parseScopes(body: unknown): Scope[] {
  if (!body || typeof body !== 'object') return []
  const arr = (body as any).scopes
  if (!Array.isArray(arr)) return []
  return arr.map((s: any) => ({
    name: String(s?.name ?? ''),
    variablesReference: typeof s?.variablesReference === 'number' ? s.variablesReference : 0,
    expensive: Boolean(s?.expensive)
  }))
}

/** 解析 variables 响应体。 */
export function parseVariables(body: unknown): Variable[] {
  if (!body || typeof body !== 'object') return []
  const arr = (body as any).variables
  if (!Array.isArray(arr)) return []
  return arr.map((v: any) => ({
    name: String(v?.name ?? ''),
    value: String(v?.value ?? ''),
    type: v?.type != null ? String(v.type) : undefined,
    variablesReference: typeof v?.variablesReference === 'number' ? v.variablesReference : 0
  }))
}
