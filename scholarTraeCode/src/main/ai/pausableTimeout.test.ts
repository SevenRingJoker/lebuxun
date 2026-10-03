// PausableTimeout 单测：fake timers 驱动，验证挂表/走表的预算语义与 gate 联动。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PausableTimeout } from './pausableTimeout'
import { TaskControlGate } from './taskControl'

describe('PausableTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('到点触发 onFire，且只触发一次', () => {
    const cb = vi.fn()
    const t = new PausableTimeout(1000)
    t.start(cb)
    vi.advanceTimersByTime(999)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(cb).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('cancel 后到点不触发（cancel 幂等）', () => {
    const cb = vi.fn()
    const t = new PausableTimeout(1000)
    t.start(cb)
    t.cancel()
    t.cancel()
    vi.advanceTimersByTime(5000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('0/负预算：start 时立即点火', () => {
    const cb = vi.fn()
    const t = new PausableTimeout(-5)
    t.start(cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('绑定 gate：paused 期间冻结预算，resume 后剩余预算完整保留', () => {
    const gate = new TaskControlGate()
    const cb = vi.fn()
    const t = new PausableTimeout(1000)
    const unbind = t.bindGate(gate)
    t.start(cb)

    // 走 400 后暂停：剩余应 600
    vi.advanceTimersByTime(400)
    gate.requestPause()
    gate.parkIfPausing() // pausing → paused，触发挂表
    expect(gate.getPhase()).toBe('paused')
    // 暂停多久都不点火
    vi.advanceTimersByTime(10_000)
    expect(cb).not.toHaveBeenCalled()

    // 继续：剩余 600 后点火
    gate.resume()
    vi.advanceTimersByTime(599)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(cb).toHaveBeenCalledTimes(1)

    unbind()
  })

  it('pausing 不冻结：暂停请求到真正挂起之间的时间照常计入', () => {
    const gate = new TaskControlGate()
    const cb = vi.fn()
    const t = new PausableTimeout(1000)
    t.bindGate(gate)
    t.start(cb)
    vi.advanceTimersByTime(400)
    gate.requestPause() // 只进 pausing，未到安全点
    vi.advanceTimersByTime(601) // 预算耗尽
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('退订 gate 后相位变化不再影响计时', () => {
    const gate = new TaskControlGate()
    const cb = vi.fn()
    const t = new PausableTimeout(1000)
    const unbind = t.bindGate(gate)
    t.start(cb)
    unbind()
    gate.requestPause()
    gate.parkIfPausing()
    // 未挂表：墙钟照常走，到点触发
    vi.advanceTimersByTime(1001)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('点火后 gate 再 paused/running 不会重启计时', () => {
    const gate = new TaskControlGate()
    const cb = vi.fn()
    const t = new PausableTimeout(100)
    t.bindGate(gate)
    t.start(cb)
    vi.advanceTimersByTime(101)
    expect(cb).toHaveBeenCalledTimes(1)
    gate.requestPause()
    gate.parkIfPausing()
    gate.resume()
    vi.advanceTimersByTime(5000)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('多次暂停/继续：各走表段消耗累加，剩余预算跨周期保留', () => {
    const gate = new TaskControlGate()
    const cb = vi.fn()
    const t = new PausableTimeout(1000)
    t.bindGate(gate)
    t.start(cb)

    vi.advanceTimersByTime(300)
    gate.requestPause()
    gate.parkIfPausing() // 剩余 700
    gate.resume()

    vi.advanceTimersByTime(200)
    gate.requestPause()
    gate.parkIfPausing() // 剩余 500
    vi.advanceTimersByTime(99_999) // 暂停多久都不点火
    gate.resume()

    vi.advanceTimersByTime(499)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
