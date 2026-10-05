// vramMonitor 单测：mock fetch 覆盖 /api/ps 各分支 + 缓存窗口 + 失败宽容。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  probeVram,
  hasEnoughVram,
  waitUntilUnloaded,
  TOTAL_VRAM,
  _resetVramCacheForTest
} from './vramMonitor'

const GB = 1024 ** 3

function psResponse(models: Array<{ name: string; size_vram: number }>): Response {
  return new Response(JSON.stringify({ models }), { status: 200 })
}

describe('probeVram', () => {
  beforeEach(() => {
    _resetVramCacheForTest()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('正常返回时解析模型清单并计算空闲显存', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => psResponse([{ name: 'qwen3:8b', size_vram: 5 * GB }]))
    )
    const s = await probeVram()
    expect(s.ok).toBe(true)
    expect(s.loaded).toEqual([{ name: 'qwen3:8b', sizeVram: 5 * GB }])
    expect(s.freeVram).toBe(TOTAL_VRAM - 5 * GB)
  })

  it('空驻留时 freeVram 等于 TOTAL_VRAM', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => psResponse([])))
    const s = await probeVram()
    expect(s.ok).toBe(true)
    expect(s.freeVram).toBe(TOTAL_VRAM)
  })

  it('HTTP 非 200 → ok:false, freeVram:null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })))
    const s = await probeVram()
    expect(s.ok).toBe(false)
    expect(s.freeVram).toBeNull()
  })

  it('fetch 抛异常（Ollama 未启动）→ ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))
    const s = await probeVram()
    expect(s.ok).toBe(false)
    expect(s.freeVram).toBeNull()
  })

  it('字段缺失时容错（models 缺省 / size_vram 缺省）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    )
    const s = await probeVram()
    expect(s.ok).toBe(true)
    expect(s.loaded).toEqual([])
    expect(s.freeVram).toBe(TOTAL_VRAM)
  })

  it('500ms 缓存窗口内不重复请求', async () => {
    const spy = vi.fn(async () => psResponse([]))
    vi.stubGlobal('fetch', spy)
    await probeVram()
    await probeVram()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('hasEnoughVram', () => {
  beforeEach(() => {
    _resetVramCacheForTest()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('空闲充足 → true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => psResponse([])))
    expect(await hasEnoughVram(9 * GB)).toBe(true)
  })

  it('空闲不足 → false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => psResponse([{ name: 'm', size_vram: 10 * GB }]))
    )
    expect(await hasEnoughVram(9 * GB)).toBe(false)
  })

  it('探测失败按充足处理（防抖原则）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))))
    expect(await hasEnoughVram(9 * GB)).toBe(true)
  })

  it('显式传入 snapshot 时不再发请求', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const s = { ok: true, loaded: [], freeVram: 1 }
    expect(await hasEnoughVram(9 * GB, s)).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('waitUntilUnloaded', () => {
  beforeEach(() => {
    _resetVramCacheForTest()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('已卸载（空清单）→ 立即返回', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => psResponse([])))
    await waitUntilUnloaded()
  })

  it('探测失败按已卸载处理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))))
    await waitUntilUnloaded()
  })

  it('从占用到释放：轮询直到空清单', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        return calls < 3 ? psResponse([{ name: 'm', size_vram: 5 * GB }]) : psResponse([])
      })
    )
    const p = waitUntilUnloaded()
    // 前两轮探测后各等待 500ms
    await vi.advanceTimersByTimeAsync(1100)
    await p
    expect(calls).toBe(3)
  })

  it('超时放弃按成功处理（不抛错）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => psResponse([{ name: 'm', size_vram: 5 * GB }]))
    )
    const p = waitUntilUnloaded({ timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(2000)
    await p // 不抛即通过
  })
})
