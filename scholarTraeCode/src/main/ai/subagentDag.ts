// 子代理 DAG 编排纯函数层（零 electron 依赖，可直接单测）：
// - validateSubTasks：dependsOn 依赖声明的合法性校验（越界/自依赖/重复/循环依赖）
// - buildDagLayers：Kahn 拓扑分层（同层可并行、层间按依赖串行）
// - mapWithConcurrency：信号量限流的并行映射（替代 Promise.all 一把梭）
// - raceWithControl：Promise 超时/AbortSignal 中止竞态包装
// - extractWrittenPaths / findConflicts：子任务产物路径提取与写入冲突检测
// - budgetExceeded：整批子代理的 Token 预算检查

/** 带依赖声明的任务规格（只关心 dependsOn 字段） */
export interface SubTaskDep {
  /** 依赖的前驱任务下标（0 起）：前驱完成后本任务才会被调度 */
  dependsOn?: number[]
}

export type ValidateResult = { ok: true } | { ok: false; error: string }

/**
 * 校验 dependsOn 合法性：下标必须是 [0,count) 内的整数、不允许自依赖、不允许重复声明、
 * 全图不允许出现环（Kahn 分层后仍有入度非零节点即存在环）。
 */
export function validateSubTasks(tasks: SubTaskDep[]): ValidateResult {
  const count = tasks.length
  for (let i = 0; i < count; i++) {
    const deps = tasks[i]?.dependsOn
    if (deps === undefined) continue
    if (!Array.isArray(deps)) {
      return { ok: false, error: `子任务${i + 1}的 dependsOn 必须是数组` }
    }
    const seen = new Set<number>()
    for (const d of deps) {
      if (!Number.isInteger(d) || d < 0 || d >= count) {
        return { ok: false, error: `子任务${i + 1}依赖了非法下标 ${d}（有效范围 0~${count - 1}）` }
      }
      if (d === i) {
        return { ok: false, error: `子任务${i + 1}不能依赖自身` }
      }
      if (seen.has(d)) {
        return { ok: false, error: `子任务${i + 1}重复依赖了子任务${d + 1}` }
      }
      seen.add(d)
    }
  }
  // 环检测：Kahn 拓扑，分批剥离入度为 0 的节点；剥离不干净即存在环
  const indeg = new Array<number>(count).fill(0)
  for (let i = 0; i < count; i++) {
    for (const d of tasks[i]?.dependsOn ?? []) indeg[i]++
  }
  let remaining = count
  let frontier = indeg.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0)
  while (frontier.length > 0) {
    const next: number[] = []
    for (const node of frontier) {
      remaining--
      for (let i = 0; i < count; i++) {
        if ((tasks[i]?.dependsOn ?? []).includes(node)) {
          indeg[i]--
          if (indeg[i] === 0) next.push(i)
        }
      }
    }
    frontier = next
  }
  if (remaining > 0) {
    return { ok: false, error: 'dependsOn 存在循环依赖，无法编排执行顺序' }
  }
  return { ok: true }
}

/**
 * Kahn 拓扑分层：返回层数组，同层下标之间无依赖可并行，层与层之间必须串行。
 * 调用前必须先通过 validateSubTasks（本函数假定无环）。
 */
export function buildDagLayers(count: number, deps: (number[] | undefined)[]): number[][] {
  const indeg = new Array<number>(count).fill(0)
  for (let i = 0; i < count; i++) indeg[i] = (deps[i] ?? []).length
  const layers: number[][] = []
  let current = indeg.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0)
  while (current.length > 0) {
    layers.push(current)
    const next: number[] = []
    for (const node of current) {
      for (let i = 0; i < count; i++) {
        if ((deps[i] ?? []).includes(node)) {
          indeg[i]--
          if (indeg[i] === 0) next.push(i)
        }
      }
    }
    current = next
  }
  return layers
}

/**
 * 信号量限流并行映射：同时运行的 worker 不超过 limit，队列耗尽后全部结束。
 * 单个 fn 抛错不会中断其他任务（错误向上收集为 rejected Promise.all？——不，调用方自行 catch）。
 */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items]
  const workerCount = Math.max(1, Math.min(limit, queue.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/** raceWithControl 的结束状态 */
export type RaceStatus = 'ok' | 'timeout' | 'aborted'
export interface RaceOutcome<T> {
  status: RaceStatus
  value?: T
}

/**
 * 超时/中止竞态包装：promise 正常完成 → ok；超过 timeoutMs → timeout；
 * signal 触发（含传入时已 aborted）→ aborted。
 * 注意：竞态返回后原 promise 不会被真正杀死（JS 无法强杀 Promise），
 * 调用方应配合 provider.abort() / 循环内 signal 检查做止损。
 */
export function raceWithControl<T>(
  promise: Promise<T>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<RaceOutcome<T>> {
  const { timeoutMs, signal } = opts
  return new Promise<RaceOutcome<T>>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (outcome: RaceOutcome<T>) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }
    const onAbort = () => finish({ status: 'aborted' })

    if (signal?.aborted) {
      finish({ status: 'aborted' })
      // 仍挂起 promise 观察，避免未处理拒绝
      promise.then(
        () => undefined,
        () => undefined
      )
      return
    }
    signal?.addEventListener('abort', onAbort)
    if (timeoutMs !== undefined && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs)
    }
    promise.then(
      (value) => finish({ status: 'ok', value }),
      () => finish({ status: 'ok', value: undefined })
    )
  })
}

/** 会从工具调用参数中产生文件写入/移动的工具名与路径字段 */
const WRITE_PATH_FIELDS: Record<string, string[]> = {
  write: ['path'],
  edit: ['path'],
  delete: ['path'],
  move: ['source', 'destination'],
  copy: ['source', 'destination'],
  write_file: ['path'],
  move_file: ['source', 'destination']
}

/** 工具执行记录条目（只需名称与参数） */
export interface ToolLogEntry {
  name: string
  args?: Record<string, unknown>
}

/** 从子代理的工具执行记录中提取所有被写入/移动过的文件路径（去重） */
export function extractWrittenPaths(log: ToolLogEntry[]): string[] {
  const paths = new Set<string>()
  for (const entry of log) {
    const fields = WRITE_PATH_FIELDS[entry.name]
    if (!fields || !entry.args) continue
    for (const f of fields) {
      const v = entry.args[f]
      if (typeof v === 'string' && v.trim()) paths.add(v.trim())
    }
  }
  return [...paths]
}

/** 跨子任务的写入冲突：同一路径被多个子任务写过 */
export interface PathConflict {
  path: string
  /** 涉及冲突的子任务下标（0 起） */
  tasks: number[]
}

/** 检测各子任务写入路径的交集，返回冲突清单（按路径排序保证输出稳定） */
export function findConflicts(perTaskPaths: string[][]): PathConflict[] {
  const owners = new Map<string, number[]>()
  perTaskPaths.forEach((paths, idx) => {
    for (const p of paths) {
      const list = owners.get(p) ?? []
      list.push(idx)
      owners.set(p, list)
    }
  })
  const conflicts: PathConflict[] = []
  for (const [path, tasks] of owners) {
    if (tasks.length > 1) conflicts.push({ path, tasks })
  }
  return conflicts.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Token 预算检查：budget 未传/<=0/非有限数 视为不设限；
 * used 达到或超过预算即视为耗尽（停止派发新任务）。
 */
export function budgetExceeded(used: number, budget?: number): boolean {
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return false
  return used >= budget
}
