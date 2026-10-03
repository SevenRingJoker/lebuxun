// Agent 执行轨迹录制：按轮记录模型调用、工具调用与耗时，落盘 JSON 供回放分析
// 设计：纯函数层（注入 traceDir），不直接 import electron，便于 vitest 测试
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 单轮模型调用记录 */
export interface TraceModelCall {
  round: number
  /** 模型调用耗时（毫秒） */
  durationMs: number
  /** token 用量（若供应商返回） */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  /** 本轮系统提示词长度（字符数，用于诊断上下文膨胀） */
  systemChars: number
}

/** 单次工具调用记录 */
export interface TraceToolCall {
  name: string
  args: string
  result: string
  durationMs: number
  /** 是否被去重/权限拦截（true 表示未实际执行） */
  skipped?: boolean
}

/** 单轮重规划记录（Self-Reflection 触发时） */
export interface TraceReplan {
  /** 触发类型摘要（连续命令失败/门控拦截/验证锁拦截） */
  trigger: string
  /** 重规划产出的修复步骤 */
  steps: string[]
  /** LLM 调用耗时（毫秒） */
  durationMs: number
}

/** 单轮轨迹 */
export interface TraceRound {
  round: number
  modelCall?: TraceModelCall
  tools: TraceToolCall[]
  /** 本轮触发的动态重规划（至多一条） */
  replan?: TraceReplan
}

/** 一次完整 Agent 执行轨迹 */
export interface AgentTrace {
  version: 1
  taskId: string
  startTime: string
  endTime?: string
  model: string
  workspace?: string | null
  currentFile?: string | null
  /** 是否为项目创建任务 */
  isProjectCreation: boolean
  rounds: TraceRound[]
  /** 最终输出内容（截断） */
  finalContent?: string
  /** 结束状态 */
  status: 'running' | 'completed' | 'aborted' | 'error'
  /** 错误信息（status=error 时） */
  error?: string
}

/** 截断长字符串，保留头尾 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max / 2) + `\n...[截断 ${s.length - max} 字符]...\n` + s.slice(-max / 2)
}

/** 轨迹录制器：记录单次 Agent 执行的所有轮次 */
export class TraceRecorder {
  private trace: AgentTrace
  private roundStart = 0

  constructor(taskId: string, model: string, workspace?: string | null, currentFile?: string | null, isProjectCreation = false) {
    this.trace = {
      version: 1,
      taskId,
      startTime: new Date().toISOString(),
      model,
      workspace,
      currentFile,
      isProjectCreation,
      rounds: [],
      status: 'running'
    }
  }

  /** 开始一轮模型调用 */
  beginRound(round: number): void {
    this.roundStart = Date.now()
    this.trace.rounds.push({ round, tools: [] })
  }

  /** 记录本轮模型调用结果 */
  recordModelCall(round: number, systemChars: number, usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): void {
    const r = this.trace.rounds.find((x) => x.round === round)
    if (!r) return
    r.modelCall = {
      round,
      durationMs: Date.now() - this.roundStart,
      usage,
      systemChars
    }
  }

  /** 记录一次工具调用 */
  recordToolCall(round: number, name: string, args: unknown, result: string, durationMs: number, skipped = false): void {
    const r = this.trace.rounds.find((x) => x.round === round)
    if (!r) return
    r.tools.push({
      name,
      args: truncate(typeof args === 'string' ? args : JSON.stringify(args ?? {}), 500),
      result: truncate(result, 2000),
      durationMs,
      skipped
    })
  }

  /** 记录本轮触发的动态重规划 */
  recordReplan(round: number, trigger: string, steps: string[], durationMs: number): void {
    const r = this.trace.rounds.find((x) => x.round === round)
    if (!r) return
    r.replan = { trigger, steps: steps.map((s) => truncate(s, 500)), durationMs }
  }

  /** 标记执行结束 */
  finish(status: AgentTrace['status'], finalContent?: string, error?: string): void {
    this.trace.endTime = new Date().toISOString()
    this.trace.status = status
    if (finalContent) this.trace.finalContent = truncate(finalContent, 3000)
    if (error) this.trace.error = error
  }

  /** 获取轨迹快照（只读） */
  snapshot(): AgentTrace {
    return JSON.parse(JSON.stringify(this.trace))
  }
}

/** 原子写入轨迹文件 */
export function saveTrace(traceDir: string, trace: AgentTrace): void {
  if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true })
  const safeId = trace.taskId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const file = join(traceDir, `${trace.startTime.slice(0, 19).replace(/[:T]/g, '-')}-${safeId}.json`)
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(trace, null, 2), 'utf-8')
  renameSync(tmp, file)
}

/** 列出所有轨迹元数据（按时间倒序），不加载完整内容 */
export function listTraces(traceDir: string): Array<{
  file: string
  taskId: string
  startTime: string
  model: string
  status: AgentTrace['status']
  rounds: number
}> {
  if (!existsSync(traceDir)) return []
  const items = readdirSync(traceDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const raw = readFileSync(join(traceDir, f), 'utf-8')
        const t = JSON.parse(raw) as AgentTrace
        return {
          file: f,
          taskId: t.taskId,
          startTime: t.startTime,
          model: t.model,
          status: t.status,
          rounds: t.rounds.length
        }
      } catch {
        return null
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  items.sort((a, b) => b.startTime.localeCompare(a.startTime))
  return items
}

/** 加载单条完整轨迹 */
export function loadTrace(traceDir: string, file: string): AgentTrace | null {
  const path = join(traceDir, file)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AgentTrace
  } catch {
    return null
  }
}

/** 清理超过保留天数的轨迹文件 */
export function rotateTraces(traceDir: string, retentionDays: number): void {
  if (!existsSync(traceDir)) return
  const now = Date.now()
  const maxAge = retentionDays * 24 * 60 * 60 * 1000
  for (const name of readdirSync(traceDir)) {
    if (!name.endsWith('.json')) continue
    try {
      const st = statSync(join(traceDir, name))
      if (now - st.mtimeMs > maxAge) unlinkSync(join(traceDir, name))
    } catch {
      // ignore
    }
  }
}
