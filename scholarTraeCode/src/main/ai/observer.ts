// 观察者干预机制：Executor(8B) 在读取黑名单上连续踩坑时，
// 中断执行、切换到 Planner(14B) 进行失败轨迹诊断，
// 返回强策略指令（strategy）或代码修复方案（codefix）。
// 纯函数层：状态管理、提示词构建、回复解析；模型切换编排在 scheduler。

/** 观察者状态（随快照序列化，schema v2 observerState 字段） */
export interface ObserverState {
  /** 连续读取失败计数（按路径归一化后累计） */
  readFailures: number
  /** 已触发干预次数（防抖上限 MAX_TRIGGERS） */
  triggerCount: number
  /** 最近一次触发干预的失败路径（避免同一路径重复触发） */
  lastTriggerPath: string | null
}

/** 触发干预所需的连续失败次数 */
export const TRIGGER_THRESHOLD = 3
/** 单次任务内最大干预次数（防抖动，超过后不再触发） */
export const MAX_TRIGGERS = 2

/** 观察者诊断结论 */
export type ObserverVerdict =
  | {
      kind: 'strategy'
      /** 注入 convo 的强策略指令（Executor 继续执行时必须遵守） */
      instruction: string
    }
  | {
      kind: 'codefix'
      /** 给 Coder 的修复指令 */
      instruction: string
      /** 需要修复的目标文件路径（相对于 targetDir） */
      targetFiles: string[]
    }

export type ObserverVerdictError = { ok: false; error: string }
export type ObserverVerdictResult = { ok: true; verdict: ObserverVerdict } | ObserverVerdictError

/** 创建初始观察者状态 */
export function createObserverState(): ObserverState {
  return { readFailures: 0, triggerCount: 0, lastTriggerPath: null }
}

/** 序列化（落盘/快照用，可直接 JSON 化） */
export function serializeObserverState(state: ObserverState): Record<string, unknown> {
  return {
    readFailures: state.readFailures,
    triggerCount: state.triggerCount,
    lastTriggerPath: state.lastTriggerPath
  }
}

/** 反序列化（容忍缺失字段，向后兼容旧快照） */
export function deserializeObserverState(data: unknown): ObserverState {
  if (typeof data !== 'object' || data === null) return createObserverState()
  const d = data as Record<string, unknown>
  return {
    readFailures: typeof d.readFailures === 'number' && Number.isFinite(d.readFailures) && d.readFailures >= 0 ? Math.floor(d.readFailures) : 0,
    triggerCount: typeof d.triggerCount === 'number' && Number.isFinite(d.triggerCount) && d.triggerCount >= 0 ? Math.floor(d.triggerCount) : 0,
    lastTriggerPath: typeof d.lastTriggerPath === 'string' ? d.lastTriggerPath : null
  }
}

/**
 * 记录一次读取失败；返回是否达到触发阈值（首次达到时返回 true）。
 * 同一路径重复触发不重复计数（lastTriggerPath 短路）。
 */
export function noteReadFailure(state: ObserverState, failedPath: string): boolean {
  if (state.lastTriggerPath === failedPath) return false
  state.readFailures += 1
  if (state.readFailures >= TRIGGER_THRESHOLD) {
    if (canTrigger(state)) {
      state.triggerCount += 1
      state.lastTriggerPath = failedPath
      state.readFailures = 0 // 重置计数，下一轮重新累计
      return true
    }
  }
  return false
}

/** 读取成功 / 写入成功时重置连续失败计数 */
export function noteReadSuccess(state: ObserverState): void {
  state.readFailures = 0
}

/** 是否还能触发干预（未超过防抖上限） */
export function canTrigger(state: ObserverState): boolean {
  return state.triggerCount < MAX_TRIGGERS
}

/**
 * 构建发给 Planner(14B) 的诊断提示词。
 * failureTrace 为最近若干轮工具调用与错误摘要（由 scheduler 打包）。
 */
export function buildObserverPrompt(
  failedPath: string,
  failureTrace: string,
  ctxSummary: string
): string {
  return [
    '【观察者干预】执行器（8B）在任务中连续触发读取黑名单，已停止执行。请你（14B）诊断失败原因并给出干预指令。',
    '',
    `失败路径：${failedPath}`,
    '',
    '失败轨迹（最近几轮工具调用与错误）：',
    failureTrace,
    '',
    '当前任务状态：',
    ctxSummary,
    '',
    '请输出 JSON 格式诊断结论（只输出 JSON，不要其他文字）：',
    '{',
    '  "kind": "strategy" | "codefix",',
    '  "instruction": "给执行器的具体指令（中文，一句话说明该做什么、不该做什么）",',
    '  "targetFiles": ["相对路径1", "相对路径2"]  // 仅 codefix 时必填',
    '}',
    '',
    '判定规则：',
    '- strategy：执行器路径认知错误（如反复读不存在的文件），只需明确告诉它正确路径或正确动作',
    '- codefix：已存在文件有语法/逻辑错误导致后续读取或运行失败，需要代码级修复'
  ].join('\n')
}

/**
 * 解析 14B 返回的诊断 JSON。
 * 容错：从文本中提取第一个 {...} JSON 块；解析失败返回 error。
 */
export function parseObserverVerdict(text: string): ObserverVerdictResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { ok: false, error: '未找到 JSON 块' }
  let raw: unknown
  try {
    raw = JSON.parse(jsonMatch[0])
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'JSON 不是对象' }
  const obj = raw as Record<string, unknown>
  const kind = obj.kind
  const instruction = typeof obj.instruction === 'string' ? obj.instruction.trim() : ''
  if (!instruction) return { ok: false, error: 'instruction 为空' }

  if (kind === 'strategy') {
    return { ok: true, verdict: { kind: 'strategy', instruction } }
  }
  if (kind === 'codefix') {
    const targetFiles = Array.isArray(obj.targetFiles)
      ? obj.targetFiles.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      : []
    if (targetFiles.length === 0) return { ok: false, error: 'codefix 缺少 targetFiles' }
    return { ok: true, verdict: { kind: 'codefix', instruction, targetFiles } }
  }
  return { ok: false, error: `未知 kind：${String(kind)}` }
}
