// 运行门：带工具任务在「运行中」的软暂停 / 继续 / 放弃协调。
// 与硬 abort 的区别：暂停请求只登记，不掐断当前模型/工具调用，
// 主循环在安全点（轮首、工具批次内相邻调用之间）主动 parkIfPausing 挂起，
// 从而实现「先收尾再停 + 可同进程继续」。
// 本模块零 IO / 零 Electron 依赖（Promise 协调不是 IO），规则全部数据驱动以便单测。

/** 运行门相位（内存内实时态；盘上 TaskStatus 是另一维度，仅在挂起时写 paused 快照） */
export type ControlPhase = 'running' | 'pausing' | 'paused'

/** 驱动状态机的动作 */
export type ControlAction = 'requestPause' | 'reachSafePoint' | 'resume' | 'abort'

/**
 * 状态转移表：单元格为下一相位；缺省 = 无意义/非法动作，相位不变。
 * - requestPause 只能由 running 进入 pausing（重复请求、已挂起再请求均不生效）；
 * - pausing 到安全点才真正 paused；到安全点之前 resume 等于取消暂停请求；
 * - abort 一律回到 running 并释放挂起，后续 aborted 收尾交给调用方的 abort 路径。
 */
const TRANSITIONS: Record<ControlPhase, Partial<Record<ControlAction, ControlPhase>>> = {
  running: { requestPause: 'pausing', abort: 'running' },
  pausing: { reachSafePoint: 'paused', resume: 'running', abort: 'running' },
  paused: { reachSafePoint: 'paused', resume: 'running', abort: 'running' }
}

/**
 * 纯函数：计算动作后的下一相位。
 * 未知相位/动作一律原样返回，调用方无需先做合法性判断。
 */
export function nextControlPhase(phase: ControlPhase, action: ControlAction): ControlPhase {
  return TRANSITIONS[phase]?.[action] ?? phase
}

/**
 * 运行门实例：每个带工具任务一个，由 IPC 层创建、透传进 runWithTools。
 * 相位变化通过 onChange 通知调度器（落快照 / 推 UI 事件），门本身不碰 IO。
 */
export class TaskControlGate {
  private phase: ControlPhase = 'running'
  /** parkIfPausing 挂起中的等待者：resume/abort 时全部排空 */
  private waiters: Array<() => void> = []
  /**
   * 相位变化监听集合（1c 起支持多订阅者）：scheduler 在此落快照/推事件，
   * PausableTimeout 也在此挂表/走表。监听内抛错被逐个吞掉——外部监听故障绝不能反噬门本身。
   */
  private listeners = new Set<(phase: ControlPhase, prev: ControlPhase) => void>()

  /**
   * 订阅相位变化，返回退订函数。
   * 重复订阅同一函数引用会被 Set 去重。
   */
  addChangeListener(cb: (phase: ControlPhase, prev: ControlPhase) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  getPhase(): ControlPhase {
    return this.phase
  }

  /**
   * 执行一次转移；返回相位是否真的变化（供调用方区分幂等请求）。
   * 转到 running（resume/abort）时先通知监听再释放等待者，
   * 保证循环真正继续之前快照/事件已经处理。
   */
  private transition(action: ControlAction): boolean {
    const prev = this.phase
    const next = nextControlPhase(prev, action)
    if (next === prev) return false
    this.phase = next
    this.emitChange(next, prev)
    if (next === 'running') this.releaseAll()
    return true
  }

  private emitChange(phase: ControlPhase, prev: ControlPhase): void {
    for (const cb of this.listeners) {
      try {
        cb(phase, prev)
      } catch {
        // 单个监听异常不影响其他监听与门状态
      }
    }
  }

  private releaseAll(): void {
    const pending = this.waiters
    this.waiters = []
    for (const resolve of pending) resolve()
  }

  /** 请求软暂停：running → pausing；其余相位下为无操作 */
  requestPause(): boolean {
    return this.transition('requestPause')
  }

  /**
   * 继续：pausing（取消暂停请求）/ paused（释放挂起）→ running；
   * running 下无操作。
   */
  resume(): boolean {
    return this.transition('resume')
  }

  /**
   * 放弃：任意相位 → running 并释放挂起。
   * 调用方随后经 AbortSignal 走既有 aborted 收尾（持久化/轨迹/返回文案）。
   */
  abort(): void {
    this.transition('abort')
  }

  /**
   * 安全点：
   * - 已请求暂停（pausing）→ 切 paused（经 onChange 落快照/推事件）并挂起，
   *   直到 resume / abort，返回醒来的相位；
   * - 其余相位立即返回，不产生微任务之外的开销。
   *
   * 1c 起接受 abortSignal（超时/停止信号）：
   * - pausing 时信号已 abort → 不进 paused、不挂起（否则超时会卡死在暂停里），
   *   调用方随后的 abort 检查直接收尾；
   * - parked 期间信号 abort → 立即醒来（gate 相位保持 paused、不 emit），
   *   同样交给调用方的 abort 路径。
   * 调用方拿到返回值后应再检查一次 AbortSignal（resume/abort 醒来 → 中止路径）。
   */
  async parkIfPausing(abortSignal?: AbortSignal): Promise<ControlPhase> {
    if (this.phase !== 'pausing') return this.phase
    // 暂停请求刚到安全点，但 abort 已先到：取消这次挂起，直接交给 abort 收尾
    if (abortSignal?.aborted) return this.phase
    // 到达安全点：pausing → paused。此转移不释放等待者，挂起正是目的。
    this.transition('reachSafePoint')
    // 循环等待：允许极端情况下多个安全点并发 park，resume/abort 会一次性全部释放。
    // 用 getPhase() 读状态：transition() 是方法，TS 不会收窄 this.phase，直接比较会报无重叠
    while (this.getPhase() === 'paused') {
      if (abortSignal?.aborted) break
      await new Promise<void>((resolve) => {
        // gate 的 resume/abort 由 waiters 释放；外部 abort 信号则提前结束本轮等待
        const onAbort = () => {
          abortSignal?.removeEventListener('abort', onAbort)
          resolve()
        }
        if (abortSignal?.aborted) {
          resolve()
          return
        }
        abortSignal?.addEventListener('abort', onAbort, { once: true })
        this.waiters.push(() => {
          abortSignal?.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    }
    return this.phase
  }
}
