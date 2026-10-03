// s48 执行时间线纯函数层（零 IO / 零 Electron 依赖）：
// 在 31 流式工具事件之上固化「步骤时间线」——每次工具调用一条记录，
// 含 AI 自述理由、参数/diff 摘要、耗时、结果状态；失败步骤可「从此步重跑」。
// 记录与配对规则全部数据驱动，便于确定性单测。

/** 步骤状态（与 ToolEventData 同构，便于视图复用样式） */
export type TimelineStatus = 'running' | 'ok' | 'fail' | 'cancelled'

/** 单条时间线步骤 */
export interface TimelineStep {
  /** 单调 id */
  id: number
  /** 所属工具循环轮次（0 起，回放定位用） */
  round: number
  /** 工具名 */
  name: string
  /** 参数摘要 */
  title: string
  /** AI 自述理由（调用该工具前最近一条 assistant 文本） */
  reason: string
  /** diff/产物摘要（写改文件时的路径与行数） */
  diffSummary: string
  /** 开始时间戳 */
  startedAt: number
  /** 耗时毫秒（结果回填） */
  durationMs?: number
  status: TimelineStatus
  /** 结果尾部文本（展开查看） */
  resultTail: string
}

/** 时间线状态（有序步骤 + 自增序号） */
export interface TimelineState {
  seq: number
  steps: TimelineStep[]
}

/** 保留步骤上限（超出丢弃最旧，防止超长任务 IPC 负载膨胀） */
export const MAX_TIMELINE_STEPS = 200
/** 单字段长度上限（reason/resultTail），防止整段长文进入广播 */
const FIELD_LIMIT = 600
const RESULT_LIMIT = 800

export function createTimeline(): TimelineState {
  return { seq: 0, steps: [] }
}

/** 字段截断兜底 */
function clip(s: unknown, limit = FIELD_LIMIT): string {
  const t = typeof s === 'string' ? s : ''
  return t.length > limit ? t.slice(0, limit) + '…' : t
}

/** 判定结果状态：取消优先，其次「错误/失败」关键字（与渲染端既有启发式一致） */
export function stepStatusOf(result: string): TimelineStatus {
  const t = String(result ?? '')
  if (t.includes('已被用户中止') || t.includes('已取消')) return 'cancelled'
  if (/error|错误|failed|失败|traceback|exception/i.test(t)) return 'fail'
  return 'ok'
}

/** 参数摘要：优先路径类参数，其次关键参数键值 */
export function argsBriefOf(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  const pathFields = ['path', 'file_path', 'file', 'source', 'pattern', 'command', 'query']
  for (const f of pathFields) {
    const v = a[f]
    if (typeof v === 'string' && v.trim()) {
      return `${name} ${v.length > 80 ? v.slice(0, 80) + '…' : v}`
    }
  }
  const keys = Object.keys(a).slice(0, 3)
  return keys.length ? `${name} { ${keys.join(', ')} }` : name
}

/**
 * diff 摘要：写/改文件工具 → 路径 + 内容行数；删除/移动 → 源→目标。
 * 非文件类工具返回空串（视图不显示该字段）。
 */
export function diffSummaryOf(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  const isWrite = /write|edit/i.test(name)
  if (isWrite) {
    const p = typeof a.path === 'string' ? a.path : typeof a.file_path === 'string' ? a.file_path : ''
    const content = typeof a.content === 'string' ? a.content : typeof a.new_string === 'string' ? a.new_string : ''
    const lines = content ? content.split(/\r?\n/).length : 0
    return p ? `${p}（${lines} 行）` : ''
  }
  if (/delete/i.test(name) && typeof a.path === 'string') return `删除 ${a.path}`
  if (/move|copy/i.test(name)) {
    const s = typeof a.source === 'string' ? a.source : ''
    const d = typeof a.destination === 'string' ? a.destination : ''
    return s && d ? `${s} → ${d}` : ''
  }
  return ''
}

/** tlStart 入参 */
export interface TimelineStartInput {
  round: number
  name: string
  args: unknown
  /** AI 自述理由（由调度层从 convo 提取） */
  reason: string
}

/**
 * 记录一次工具调用开始：追加 running 步骤并返回该步骤。
 * 调用方负责随后广播最新快照。
 */
export function tlStart(state: TimelineState, input: TimelineStartInput): TimelineStep {
  const step: TimelineStep = {
    id: ++state.seq,
    round: input.round,
    name: input.name,
    title: argsBriefOf(input.name, input.args),
    reason: clip(input.reason),
    diffSummary: diffSummaryOf(input.name, input.args),
    startedAt: Date.now(),
    status: 'running',
    resultTail: ''
  }
  state.steps.push(step)
  if (state.steps.length > MAX_TIMELINE_STEPS) {
    state.steps.splice(0, state.steps.length - MAX_TIMELINE_STEPS)
  }
  return step
}

/**
 * 回填工具结果：从尾部找最近一条同名 running 步骤（同一轮批量调用按发起顺序匹配）。
 * 未匹配到（如协调工具未录制）返回 null。
 */
export function tlFinish(state: TimelineState, name: string, result: string): TimelineStep | null {
  for (let i = state.steps.length - 1; i >= 0; i--) {
    const s = state.steps[i]
    if (s.name === name && s.status === 'running') {
      s.status = stepStatusOf(result)
      s.durationMs = Date.now() - s.startedAt
      s.resultTail = clip(result, RESULT_LIMIT)
      return s
    }
  }
  return null
}

/** 全部失败步骤（红色标记，供视图筛选） */
export function failedSteps(state: TimelineState): TimelineStep[] {
  return state.steps.filter((s) => s.status === 'fail')
}

/**
 * 「从此步重跑」的回放定位：回到该步骤所属轮次重新执行。
 * 重跑轮次直接取步骤 round（调度层会与当前快照可续跑轮次取 min 钳制）。
 */
export function replayRoundOf(step: TimelineStep): number {
  return Math.max(0, step.round)
}

/** IPC 广播视图：剥离内部字段、截断后的可序列化步骤（按时间正序） */
export function serializeTimeline(state: TimelineState): TimelineStep[] {
  return state.steps.map((s) => ({ ...s }))
}
