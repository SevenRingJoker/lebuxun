// 任务快照纯函数层：把 runWithTools 闭包内存态序列化为可落盘 JSON，
// 并提供恢复解析、可恢复任务分类、PromptContext 互转。
// 零 IO / 零 Electron 依赖，所有规则在此一处，便于确定性单测。
import type { AiMessage } from './types'
import type { PromptContext } from './promptBuilder'
import type { TodoItem, TodoStatus, TodoPriority } from './todoManager'
import type { ReplanState, ReplanSignal, ReplanTrigger } from './replanner'
import type { ArtifactManifest } from './validation'
// ㊝ 暂停/中断快照携带未决暂存变更；仅类型依赖（changeStage 零反向依赖，无环）
import type { StagedChange } from './changeStage'
import { deserializeStage, serializeStage } from './changeStage'

/** 任务生命周期状态 */
export type TaskStatus = 'running' | 'paused' | 'completed' | 'aborted' | 'interrupted'

/** 快照结构版本号：未来不兼容变更时 bump，旧文件 parse 直接放弃 */
export const TASK_SCHEMA_VERSION = 1
/**
 * 工具循环最大轮数（与 scheduler.MAX_TOOL_ROUNDS 保持一致）。
 * 此处独立声明而非反向 import scheduler，避免 scheduler ↔ taskSnapshot 循环依赖。
 */
export const TASK_MAX_ROUNDS = 20
/** 用户请求摘要最大长度（恢复条展示用，超出截断） */
export const USER_REQUEST_LIMIT = 500

/** 序列化后的 PromptContext：createdFiles 由 Set 转为排序数组，可直接 JSON 化 */
export interface SerializedPromptContext {
  workspace: string | null
  currentFile: string | null
  plan: string | null
  isProjectCreation: boolean
  createdFiles: string[]
  ranNpmInstall: boolean
  ranServe: boolean
  ranMkdir: boolean
  round: number
  stallRestarts: number
  agentsMd: string | null
  rulesText: string | null
  notesText: string
  tools: Array<{ name: string; description?: string }>
  mcpServers: string[]
  skillsText: string | null
  todosText: string
  currentTodo: string | null
  directive: string | null
  artifactManifest: ArtifactManifest | null
  environmentReport: string
}

/** 任务前检查点绑定信息 */
export interface SnapshotCheckpoint {
  hash: string
  label: string
}

/** 快照文件结构（.trae/tasks/<taskId>.json） */
export interface TaskSnapshotFile {
  schemaVersion: number
  taskId: string
  /** 归一化工作区绝对路径，恢复时必须与当前打开工作区一致 */
  workspace: string
  /** 原模型全 id（providerId:modelName），恢复时必须回到同一模型 */
  modelId: string
  /** 所属会话 id（可为空，仅用于排查关联） */
  sessionId: string | null
  status: TaskStatus
  /** 末条用户请求文本（截断，恢复条摘要） */
  userRequest: string
  /** 恢复后进入的轮次（0 基） */
  startRound: number
  /** 完整工具对话（恢复后作为 convo，含验证锁/停滞重启/重规划注入消息） */
  convo: AiMessage[]
  ctx: SerializedPromptContext
  todoSeq: number
  todos: TodoItem[]
  replan: ReplanState
  /** dedup 表 entry（键 → 首次结果） */
  executed: Array<[string, string]>
  counters: { stallCount: number; stallRestarts: number; dedupStallCount: number }
  preTaskCheckpoint: SnapshotCheckpoint | null
  /** ㊝ 未决暂存变更（旧快照缺省 null，向后兼容不 bump schemaVersion） */
  stagedChanges: StagedChange[] | null
  startedAt: number
  updatedAt: number
}

/**
 * parse 之后、恢复链路使用的快照：与盘上结构同构，
 * 唯独 ctx 已还原为 PromptContext（createdFiles 是 Set 而非数组）。
 */
export type ParsedTaskSnapshot = Omit<TaskSnapshotFile, 'ctx'> & { ctx: PromptContext }

/** buildTaskSnapshot 的收集输入：runWithTools 闭包里的活对象 */
export interface SnapshotCollectInput {
  taskId: string
  workspace: string
  modelId: string
  sessionId: string | null
  startRound: number
  convo: AiMessage[]
  ctx: PromptContext
  todoSeq: number
  todos: TodoItem[]
  replan: ReplanState
  executed: Map<string, string>
  counters: { stallCount: number; stallRestarts: number; dedupStallCount: number }
  preTaskCheckpoint: SnapshotCheckpoint | null
  /** ㊝ 随快照一起落盘的未决暂存（可缺省，build 时归一化为 null） */
  stagedChanges?: StagedChange[] | null
  startedAt: number
}

const VALID_ROLES: ReadonlySet<AiMessage['role']> = new Set(['system', 'user', 'assistant', 'tool'])
const VALID_TODO_STATUS: ReadonlySet<TodoStatus> = new Set(['pending', 'in_progress', 'completed'])
const VALID_TODO_PRIORITY: ReadonlySet<TodoPriority> = new Set(['high', 'medium', 'low'])
const VALID_TRIGGERS: ReadonlySet<ReplanTrigger> = new Set([
  'commandFailure',
  'preflightBlock',
  'validationBlock'
])

/** 非负有限数兜底 */
function nonNeg(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

/** 字符串兜底（null/undefined → fallback） */
function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

/** 可空字符串兜底 */
function nullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** 轮次钳制：负数归零，超过最大轮数时钳到上限（恢复后循环立即正常收尾） */
export function clampRound(round: unknown): number {
  const n = nonNeg(round, 0)
  return Math.min(Math.floor(n), TASK_MAX_ROUNDS)
}

/** PromptContext 序列化：createdFiles Set → 排序数组（排序保证落盘内容确定） */
export function serializeCtx(ctx: PromptContext): SerializedPromptContext {
  return {
    workspace: ctx.workspace ?? null,
    currentFile: ctx.currentFile ?? null,
    plan: ctx.plan ?? null,
    isProjectCreation: !!ctx.isProjectCreation,
    createdFiles: Array.from(ctx.createdFiles).sort(),
    ranNpmInstall: !!ctx.ranNpmInstall,
    ranServe: !!ctx.ranServe,
    ranMkdir: !!ctx.ranMkdir,
    round: nonNeg(ctx.round),
    stallRestarts: nonNeg(ctx.stallRestarts),
    agentsMd: ctx.agentsMd ?? null,
    rulesText: ctx.rulesText ?? null,
    notesText: ctx.notesText ?? '',
    tools: Array.isArray(ctx.tools)
      ? ctx.tools
          .filter((t) => t && typeof t.name === 'string')
          .map((t) => ({ name: t.name, description: typeof t.description === 'string' ? t.description : undefined }))
      : [],
    mcpServers: Array.isArray(ctx.mcpServers) ? ctx.mcpServers.filter((s) => typeof s === 'string') : [],
    skillsText: ctx.skillsText ?? null,
    todosText: ctx.todosText ?? '',
    currentTodo: ctx.currentTodo ?? null,
    directive: ctx.directive ?? null,
    artifactManifest: ctx.artifactManifest ?? null,
    environmentReport: ctx.environmentReport ?? ''
  }
}

/** 快照 ctx 还原为 PromptContext：createdFiles 数组 → 新 Set */
export function restoreCtx(data: SerializedPromptContext): PromptContext {
  return {
    workspace: data.workspace,
    currentFile: data.currentFile,
    plan: data.plan,
    isProjectCreation: !!data.isProjectCreation,
    createdFiles: new Set(Array.isArray(data.createdFiles) ? data.createdFiles : []),
    ranNpmInstall: !!data.ranNpmInstall,
    ranServe: !!data.ranServe,
    ranMkdir: !!data.ranMkdir,
    round: nonNeg(data.round),
    stallRestarts: nonNeg(data.stallRestarts),
    agentsMd: data.agentsMd,
    rulesText: data.rulesText,
    notesText: data.notesText,
    tools: Array.isArray(data.tools) ? data.tools : [],
    mcpServers: Array.isArray(data.mcpServers) ? data.mcpServers : [],
    // PromptContext 中 skillsText/directive 只接受 undefined（非 null），落盘的 null 需归一化
    skillsText: data.skillsText ?? undefined,
    todosText: data.todosText,
    currentTodo: data.currentTodo,
    directive: data.directive ?? undefined,
    artifactManifest: data.artifactManifest,
    environmentReport: data.environmentReport
  }
}

/** 构造完整快照（不落盘；IO 由 taskStore 薄壳负责） */
export function buildTaskSnapshot(
  input: SnapshotCollectInput,
  meta: { status: TaskStatus; updatedAt: number }
): TaskSnapshotFile {
  const userRequest = strOr(input.ctx.plan, '') || lastUserText(input.convo)
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId: input.taskId,
    workspace: input.workspace,
    modelId: input.modelId,
    sessionId: input.sessionId,
    status: meta.status,
    userRequest: userRequest.length > USER_REQUEST_LIMIT ? userRequest.slice(0, USER_REQUEST_LIMIT) + '…' : userRequest,
    startRound: clampRound(input.startRound),
    convo: input.convo,
    ctx: serializeCtx(input.ctx),
    todoSeq: nonNeg(input.todoSeq),
    todos: input.todos,
    replan: input.replan,
    // Map → entry 数组，按键排序保证落盘字节稳定
    executed: Array.from(input.executed.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    counters: {
      stallCount: nonNeg(input.counters?.stallCount),
      stallRestarts: nonNeg(input.counters?.stallRestarts),
      dedupStallCount: nonNeg(input.counters?.dedupStallCount)
    },
    preTaskCheckpoint: input.preTaskCheckpoint
      ? { hash: strOr(input.preTaskCheckpoint.hash, ''), label: strOr(input.preTaskCheckpoint.label, '') }
      : null,
    stagedChanges: input.stagedChanges ?? null,
    startedAt: nonNeg(input.startedAt),
    updatedAt: nonNeg(meta.updatedAt, Date.now())
  }
}

/** 从 convo 中取末条 user 文本（无 plan 时的用户请求兜底） */
function lastUserText(convo: AiMessage[]): string {
  for (let i = convo.length - 1; i >= 0; i--) {
    if (convo[i].role === 'user') return convo[i].content
  }
  return ''
}

/** 校验并清洗单条消息；非法返回 null */
function sanitizeMessage(v: unknown): AiMessage | null {
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  if (typeof m.role !== 'string' || !VALID_ROLES.has(m.role as AiMessage['role'])) return null
  if (typeof m.content !== 'string') return null
  return {
    role: m.role as AiMessage['role'],
    content: m.content,
    name: typeof m.name === 'string' ? m.name : undefined
  }
}

/** 校验并清洗单条 Todo */
function sanitizeTodo(v: unknown): TodoItem | null {
  if (!v || typeof v !== 'object') return null
  const t = v as Record<string, unknown>
  if (typeof t.id !== 'number' || !Number.isFinite(t.id) || t.id < 1) return null
  if (typeof t.content !== 'string' || !t.content) return null
  const status = (VALID_TODO_STATUS.has(t.status as TodoStatus) ? t.status : 'pending') as TodoStatus
  const priority = (VALID_TODO_PRIORITY.has(t.priority as TodoPriority) ? t.priority : 'medium') as TodoPriority
  return { id: Math.floor(t.id), content: t.content, status, priority }
}

/** 校验并清洗重规划信号 */
function sanitizeSignal(v: unknown): ReplanSignal | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  if (typeof s.trigger !== 'string' || !VALID_TRIGGERS.has(s.trigger as ReplanTrigger)) return null
  return {
    trigger: s.trigger as ReplanTrigger,
    detail: typeof s.detail === 'string' ? s.detail : '',
    at: nonNeg(s.at)
  }
}

/**
 * 解析快照 JSON：
 * - 非法 JSON / 版本不符 / convo 缺失或清洗后无有效消息 → null（调用方跳过并告警）；
 * - 其余字段全部经清洗与默认值兜底，保证恢复路径不脏。
 */
export function parseTaskSnapshot(raw: string): ParsedTaskSnapshot | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (o.schemaVersion !== TASK_SCHEMA_VERSION) return null
  if (typeof o.taskId !== 'string' || !o.taskId) return null
  if (typeof o.workspace !== 'string' || !o.workspace) return null
  if (typeof o.modelId !== 'string' || !o.modelId) return null
  if (!Array.isArray(o.convo)) return null

  const convo = o.convo.map(sanitizeMessage).filter((m): m is AiMessage => m !== null)
  if (convo.length === 0) return null

  const todos = Array.isArray(o.todos)
    ? o.todos.map(sanitizeTodo).filter((t): t is TodoItem => t !== null)
    : []
  const todoSeq = Math.max(nonNeg(o.todoSeq), ...todos.map((t) => t.id))

  const executed: Array<[string, string]> = Array.isArray(o.executed)
    ? o.executed
        .filter((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string')
        .map((e) => [e[0], e[1]] as [string, string])
    : []

  // replan 缺省时按初始空状态恢复
  const replanSrc = (o.replan ?? {}) as Record<string, unknown>
  const replan: ReplanState = {
    consecutiveFailures: nonNeg(replanSrc.consecutiveFailures),
    replanCount: nonNeg(replanSrc.replanCount),
    signals: Array.isArray(replanSrc.signals)
      ? replanSrc.signals.map(sanitizeSignal).filter((s): s is ReplanSignal => s !== null)
      : []
  }

  const checkpoint = o.preTaskCheckpoint as Record<string, unknown> | null
  const status: TaskStatus =
    o.status === 'running' || o.status === 'paused' || o.status === 'completed' ||
    o.status === 'aborted' || o.status === 'interrupted'
      ? o.status
      : 'interrupted'

  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId: o.taskId,
    workspace: o.workspace,
    modelId: o.modelId,
    sessionId: nullableStr(o.sessionId),
    status,
    userRequest: strOr(o.userRequest, ''),
    startRound: clampRound(o.startRound),
    convo,
    ctx: restoreCtx((o.ctx ?? {}) as SerializedPromptContext),
    todoSeq,
    todos,
    replan,
    executed,
    counters: {
      stallCount: nonNeg((o.counters as Record<string, unknown>)?.stallCount),
      stallRestarts: nonNeg((o.counters as Record<string, unknown>)?.stallRestarts),
      dedupStallCount: nonNeg((o.counters as Record<string, unknown>)?.dedupStallCount)
    },
    preTaskCheckpoint:
      checkpoint && typeof checkpoint.hash === 'string' && checkpoint.hash
        ? { hash: checkpoint.hash, label: strOr(checkpoint.label, '') }
        : null,
    // ㊝ 经纯函数清洗（宽容坏数据），数组非数组/坏记录一律降级 null
    stagedChanges: Array.isArray(o.stagedChanges)
      ? serializeStage(deserializeStage(o.stagedChanges))
      : null,
    startedAt: nonNeg(o.startedAt),
    updatedAt: nonNeg(o.updatedAt)
  }
}

/**
 * 可恢复任务分类：
 * - 文件里残留 running = 进程崩溃/强杀 → 归类 interrupted；
 * - paused 保留（1b 起会出现）；
 * - completed/aborted 不进恢复列表；
 * - 结果按 updatedAt 倒序（最近中断的排最前）。
 */
export function classifyRecoverable(files: ParsedTaskSnapshot[]): ParsedTaskSnapshot[] {
  return files
    .filter((f) => f.status === 'running' || f.status === 'paused' || f.status === 'interrupted')
    .map((f) => (f.status === 'running' ? { ...f, status: 'interrupted' as TaskStatus } : f))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
