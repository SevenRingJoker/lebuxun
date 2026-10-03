// taskControl 单测：状态转移表全组合 + 运行门异步行为。
import { describe, it, expect, vi } from 'vitest'
import { nextControlPhase, TaskControlGate, type ControlPhase, type ControlAction } from './taskControl'

describe('nextControlPhase 转移表', () => {
  // 全组合驱动测试：表格与 TRANSITIONS 同源校验，避免漏写单元格
  const cases: Array<[ControlPhase, ControlAction, ControlPhase]> = [
    // running
    ['running', 'requestPause', 'pausing'],
    ['running', 'reachSafePoint', 'running'],
    ['running', 'resume', 'running'],
    ['running', 'abort', 'running'],
    // pausing
    ['pausing', 'requestPause', 'pausing'],
    ['pausing', 'reachSafePoint', 'paused'],
    ['pausing', 'resume', 'running'],
    ['pausing', 'abort', 'running'],
    // paused
    ['paused', 'requestPause', 'paused'],
    ['paused', 'reachSafePoint', 'paused'],
    ['paused', 'resume', 'running'],
    ['paused', 'abort', 'running']
  ]
  for (const [phase, action, expected] of cases) {
    it(`${phase} + ${action} → ${expected}`, () => {
      expect(nextControlPhase(phase, action)).toBe(expected)
    })
  }
})

describe('TaskControlGate', () => {
  it('初始相位为 running', () => {
    expect(new TaskControlGate().getPhase()).toBe('running')
  })

  it('requestPause：running → pausing，重复请求不生效', () => {
    const gate = new TaskControlGate()
    expect(gate.requestPause()).toBe(true)
    expect(gate.getPhase()).toBe('pausing')
    expect(gate.requestPause()).toBe(false)
    expect(gate.getPhase()).toBe('pausing')
  })

  it('running 下 parkIfPausing 立即返回，不挂起', async () => {
    const gate = new TaskControlGate()
    await expect(gate.parkIfPausing()).resolves.toBe('running')
  })

  it('paused 下 parkIfPausing 立即返回当前相位（只有 pausing 才挂起）', async () => {
    const gate = new TaskControlGate()
    gate.requestPause()
    // park 调用同步完成 reachSafePoint 转移（then 之前相位已是 paused）
    const parked = gate.parkIfPausing()
    expect(gate.getPhase()).toBe('paused')
    // 挂起期间另一个安全点探测不改变状态
    await expect(gate.parkIfPausing()).resolves.toBe('paused')
    gate.resume()
    await parked
  })
  it('软暂停：请求 → park 挂起 → resume 释放，返回 running', async () => {
    const gate = new TaskControlGate()
    gate.requestPause()
    let done = false
    const park = gate.parkIfPausing().then((v) => {
      done = true
      return v
    })
    // 让出微任务：此时应仍挂起
    await Promise.resolve()
    expect(done).toBe(false)
    expect(gate.getPhase()).toBe('paused')
    gate.resume()
    await expect(park).resolves.toBe('running')
    expect(done).toBe(true)
    expect(gate.getPhase()).toBe('running')
  })

  it('到安全点之前 resume：取消暂停请求，park 不再挂起', async () => {
    const gate = new TaskControlGate()
    gate.requestPause()
    expect(gate.resume()).toBe(true)
    expect(gate.getPhase()).toBe('running')
    await expect(gate.parkIfPausing()).resolves.toBe('running')
  })

  it('pausing 下 abort：立即回 running，随后 park 不挂起', async () => {
    const gate = new TaskControlGate()
    gate.requestPause()
    gate.abort()
    expect(gate.getPhase()).toBe('running')
    await expect(gate.parkIfPausing()).resolves.toBe('running')
  })

  it('挂起中 abort：释放等待并返回 running', async () => {
    const gate = new TaskControlGate()
    gate.requestPause()
    const park = gate.parkIfPausing()
    expect(gate.getPhase()).toBe('paused')
    gate.abort()
    await expect(park).resolves.toBe('running')
  })

  it('running 下 abort 是幂等无操作（不触发监听）', () => {
    const gate = new TaskControlGate()
    const changes: string[] = []
    gate.addChangeListener((phase) => changes.push(phase))
    gate.abort()
    expect(changes).toEqual([])
  })

  it('监听按真实转移触发，参数为 (新相位, 旧相位)', () => {
    const gate = new TaskControlGate()
    const changes: Array<[string, string]> = []
    gate.addChangeListener((phase, prev) => changes.push([phase, prev]))
    gate.requestPause()
    gate.parkIfPausing()
    gate.resume()
    expect(changes).toEqual([
      ['pausing', 'running'],
      ['paused', 'pausing'],
      ['running', 'paused']
    ])
  })

  it('无转移时不触发监听', () => {
    const gate = new TaskControlGate()
    const changes: string[] = []
    gate.addChangeListener((phase) => changes.push(phase))
    gate.requestPause()
    // 重复请求、pausing 上 resume 之外的无操作
    gate.requestPause()
    expect(gate.requestPause()).toBe(false)
    expect(changes).toEqual(['pausing'])
  })

  it('监听抛错被吞掉，不影响其他监听、门状态与释放', async () => {
    const gate = new TaskControlGate()
    const other: string[] = []
    gate.addChangeListener(() => {
      throw new Error('监听故障')
    })
    gate.addChangeListener((phase) => other.push(phase))
    expect(() => gate.requestPause()).not.toThrow()
    expect(gate.getPhase()).toBe('pausing')
    expect(other).toEqual(['pausing'])
    const park = gate.parkIfPausing()
    expect(gate.getPhase()).toBe('paused')
    gate.abort()
    await expect(park).resolves.toBe('running')
  })

  it('addChangeListener 返回退订函数：退订后不再收到变化；支持多订阅者', () => {
    const gate = new TaskControlGate()
    const a: string[] = []
    const b: string[] = []
    const unsubA = gate.addChangeListener((phase) => a.push(phase))
    gate.addChangeListener((phase) => b.push(phase))
    gate.requestPause()
    unsubA()
    gate.resume()
    expect(a).toEqual(['pausing'])
    expect(b).toEqual(['pausing', 'running'])
  })

  it('resume 先触发监听再释放挂起（快照/事件先于循环继续）', async () => {
    const gate = new TaskControlGate()
    const order: string[] = []
    gate.requestPause()
    const park = gate.parkIfPausing().then(() => order.push('park-released'))
    gate.addChangeListener((phase) => {
      if (phase === 'running') order.push('change-running')
    })
    gate.resume()
    await park
    expect(order).toEqual(['change-running', 'park-released'])
  })

  it('完整生命周期：暂停后再暂停被忽略，继续后可再次暂停', async () => {
    const gate = new TaskControlGate()
    gate.requestPause()
    const park = gate.parkIfPausing()
    // 已挂起后重复请求暂停无效
    expect(gate.requestPause()).toBe(false)
    expect(gate.getPhase()).toBe('paused')
    gate.resume()
    await park
    // 回到 running 后可以重新暂停
    expect(gate.requestPause()).toBe(true)
    expect(gate.getPhase()).toBe('pausing')
  })
})

// ==================== 1c：parkIfPausing 的 abort 感知 ====================
describe('parkIfPausing abort 感知', () => {
  it('pausing 且信号已 abort：不进 paused、不触发监听，立即返回', async () => {
    const gate = new TaskControlGate()
    const ac = new AbortController()
    gate.requestPause()
    ac.abort()
    const changes: string[] = []
    gate.addChangeListener((phase) => changes.push(phase))
    await expect(gate.parkIfPausing(ac.signal)).resolves.toBe('pausing')
    expect(gate.getPhase()).toBe('pausing')
    expect(changes).toEqual([])
  })

  it('parked 期间信号 abort：立即醒来，gate 相位保持 paused（不 emit）', async () => {
    const gate = new TaskControlGate()
    const ac = new AbortController()
    gate.requestPause()
    const changes: string[] = []
    gate.addChangeListener((phase) => changes.push(phase))
    const park = gate.parkIfPausing(ac.signal)
    expect(gate.getPhase()).toBe('paused')
    ac.abort()
    await expect(park).resolves.toBe('paused')
    // 只有进 paused 那一次监听，abort 醒来不产生相位变化事件
    expect(changes).toEqual(['paused'])
  })

  it('并发两个 park：信号 abort 后全部醒来', async () => {
    const gate = new TaskControlGate()
    const ac = new AbortController()
    gate.requestPause()
    const p1 = gate.parkIfPausing(ac.signal)
    // 第二个安全点在 paused 相位立即返回（既定语义），不占 waiter
    const p2 = gate.parkIfPausing(ac.signal)
    ac.abort()
    await Promise.all([
      expect(p1).resolves.toBe('paused'),
      expect(p2).resolves.toBe('paused')
    ])
  })

  it('parked 期间正常 resume 不受 abort 信号影响（回归）', async () => {
    const gate = new TaskControlGate()
    const ac = new AbortController()
    gate.requestPause()
    const park = gate.parkIfPausing(ac.signal)
    gate.resume()
    await expect(park).resolves.toBe('running')
    expect(gate.getPhase()).toBe('running')
  })
})
