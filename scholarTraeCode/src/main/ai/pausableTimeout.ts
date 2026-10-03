// 可暂停的整体超时：软暂停（gate paused）期间冻结预算，resume 后用剩余预算继续。
// 为什么要单独做：runWithTools 的总超时原本是纯墙钟 setTimeout，
// 用户主动暂停的时间也被计入预算——暂停中"等"来超时既不合理，
// 还会在循环挂起时触发 reject 造成死锁/孤儿。本模块只协调计时，零 IO / 零 Electron。
import type { TaskControlGate, ControlPhase } from './taskControl'

/**
 * 超时预算耗尽错误：作为 attemptAbort.abort(reason) 的原因，
 * 让 runWithTools 区分「整体超时」（快照记 interrupted，可续跑）与「用户主动停止」（aborted）。
 */
export class TimeoutBudgetError extends Error {
  constructor() {
    super('工具调用整体超时')
    this.name = 'TimeoutError'
  }
}

/**
 * 暂停感知超时器：
 * - start(onFire)：开始计时；
 * - cancel()：取消（幂等）；
 * - bindGate(gate)：paused 时挂表（记录剩余）、running 时走表；pausing 不影响。
 * 状态只有 remaining / deadline / timer，便于单测穷举。
 */
export class PausableTimeout {
  /** 剩余预算（ms）；每轮挂表/走表时更新 */
  private remaining: number
  /** 当前走表段的截止时刻（epoch ms）；挂表时据此扣已过时间 */
  private deadline = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private fired = false
  private onFire: (() => void) | null = null

  constructor(ms: number) {
    // 负预算直接归零：start 时立即点火，避免 setTimeout(负数) 的怪异行为
    this.remaining = Math.max(0, ms)
  }

  /** 开始计时；超时到点调用 onFire 一次。重复 start 不产生第二个计时器 */
  start(onFire: () => void): void {
    if (this.timer || this.fired) {
      // 已在计时：只更新回调（本实现实际不会走到，留作防御）
      this.onFire = onFire
      return
    }
    this.onFire = onFire
    this.arm()
  }

  /** 取消计时（幂等）；已点火后调用无效果 */
  cancel(): void {
    this.disarm()
    this.onFire = null
  }

  /**
   * 绑定运行门相位：paused 冻结、running 继续。返回退订函数。
   * 注意必须在 start 前后均可：绑定时若 gate 已 paused 立即挂表。
   */
  bindGate(gate: TaskControlGate): () => void {
    const onPhase = (phase: ControlPhase) => {
      if (phase === 'paused') {
        // 挂表：把已走过的时间从预算里扣掉
        this.disarm()
      } else if (phase === 'running') {
        // 走表：用剩余预算重新计时（已点火/已取消则忽略）
        if (!this.fired && this.onFire) this.arm()
      }
      // pausing 不动：暂停请求到真正挂起之间的时间照常计入
    }
    // 绑定时已处于 paused（极端时序：start 之后才 bind）→ 立刻补挂表
    if (gate.getPhase() === 'paused') this.disarm()
    return gate.addChangeListener(onPhase)
  }

  /** 走表：按剩余预算设定计时器；剩余 ≤0 立即点火 */
  private arm(): void {
    if (this.timer || this.fired) return
    if (this.remaining <= 0) {
      this.fire()
      return
    }
    this.deadline = Date.now() + this.remaining
    this.timer = setTimeout(() => {
      this.timer = null
      this.fire()
    }, this.remaining)
  }

  /** 挂表：清计时器并把本走表段已过时间从预算扣掉；未在计时时不动 */
  private disarm(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    this.remaining = Math.max(0, this.deadline - Date.now())
  }

  private fire(): void {
    if (this.fired) return
    this.fired = true
    const cb = this.onFire
    this.onFire = null
    cb?.()
  }
}
