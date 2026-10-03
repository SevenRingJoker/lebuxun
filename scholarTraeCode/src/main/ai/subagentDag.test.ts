// subagentDag 纯函数单测：依赖校验、拓扑分层、限流映射、超时/中止竞态、
// 写入路径提取、冲突检测、Token 预算检查。
import { describe, expect, it } from 'vitest'
import {
  budgetExceeded,
  buildDagLayers,
  extractWrittenPaths,
  findConflicts,
  mapWithConcurrency,
  raceWithControl,
  validateSubTasks
} from './subagentDag'

describe('validateSubTasks 依赖校验', () => {
  it('无 dependsOn 时全部合法', () => {
    expect(validateSubTasks([{}, {}, {}]).ok).toBe(true)
  })
  it('正常依赖声明合法', () => {
    expect(validateSubTasks([{}, { dependsOn: [0] }, { dependsOn: [0, 1] }]).ok).toBe(true)
  })
  it('依赖下标越界（>=count）被拒绝', () => {
    const r = validateSubTasks([{}, { dependsOn: [2] }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('非法下标')
  })
  it('依赖下标为负数被拒绝', () => {
    const r = validateSubTasks([{ dependsOn: [-1] }])
    expect(r.ok).toBe(false)
  })
  it('依赖下标非整数被拒绝', () => {
    const r = validateSubTasks([{}, { dependsOn: [0.5] }])
    expect(r.ok).toBe(false)
  })
  it('自依赖被拒绝', () => {
    const r = validateSubTasks([{}, { dependsOn: [1] }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('自身')
  })
  it('重复依赖被拒绝', () => {
    const r = validateSubTasks([{}, { dependsOn: [0, 0] }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('重复依赖')
  })
  it('dependsOn 非数组被拒绝', () => {
    const r = validateSubTasks([{ dependsOn: 0 as unknown as number[] }])
    expect(r.ok).toBe(false)
  })
  it('双节点互环被拒绝', () => {
    const r = validateSubTasks([{ dependsOn: [1] }, { dependsOn: [0] }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('循环依赖')
  })
  it('三节点环被拒绝', () => {
    const r = validateSubTasks([
      { dependsOn: [2] },
      { dependsOn: [0] },
      { dependsOn: [1] }
    ])
    expect(r.ok).toBe(false)
  })
  it('有向无环图（菱形）合法', () => {
    const r = validateSubTasks([
      {},
      { dependsOn: [0] },
      { dependsOn: [0] },
      { dependsOn: [1, 2] }
    ])
    expect(r.ok).toBe(true)
  })
})

describe('buildDagLayers 拓扑分层', () => {
  it('无依赖时全部落在第一层（并行）', () => {
    expect(buildDagLayers(3, [undefined, undefined, undefined])).toEqual([[0, 1, 2]])
  })
  it('链式依赖拆成逐层串行', () => {
    expect(buildDagLayers(3, [undefined, [0], [1]])).toEqual([[0], [1], [2]])
  })
  it('扇出：0 被 1、2 依赖 → 1、2 同层并行', () => {
    expect(buildDagLayers(3, [undefined, [0], [0]])).toEqual([[0], [1, 2]])
  })
  it('菱形依赖：[[0],[1,2],[3]]', () => {
    expect(buildDagLayers(4, [undefined, [0], [0], [1, 2]])).toEqual([[0], [1, 2], [3]])
  })
  it('混合：孤立节点与依赖链并存', () => {
    // 0 无依赖；1 依赖 0；2 无依赖 → 第一层 [0,2]，第二层 [1]
    expect(buildDagLayers(3, [undefined, [0], undefined])).toEqual([[0, 2], [1]])
  })
  it('空任务列表返回空层数组', () => {
    expect(buildDagLayers(0, [])).toEqual([])
  })
})

describe('mapWithConcurrency 限流并行', () => {
  it('并发峰值不超过 limit', async () => {
    let running = 0
    let peak = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    await mapWithConcurrency(items, 3, async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 10))
      running--
    })
    expect(peak).toBeLessThanOrEqual(3)
  })
  it('所有元素都被处理且只处理一次', async () => {
    const done: number[] = []
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      done.push(n)
    })
    expect(done.sort()).toEqual([1, 2, 3, 4, 5])
  })
  it('空数组直接返回', async () => {
    await expect(mapWithConcurrency([], 3, async () => undefined)).resolves.toBeUndefined()
  })
  it('limit 大于元素数时按元素数并行', async () => {
    let peak = 0
    let running = 0
    await mapWithConcurrency([1, 2], 99, async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
    })
    expect(peak).toBe(2)
  })
})

describe('raceWithControl 超时/中止竞态', () => {
  it('正常完成返回 ok 与值', async () => {
    const r = await raceWithControl(Promise.resolve(42), { timeoutMs: 1000 })
    expect(r).toEqual({ status: 'ok', value: 42 })
  })
  it('超时时返回 timeout', async () => {
    const slow = new Promise((r) => setTimeout(r, 200))
    const r = await raceWithControl(slow, { timeoutMs: 20 })
    expect(r.status).toBe('timeout')
  })
  it('signal 预先 aborted 时立即返回 aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await raceWithControl(Promise.resolve(1), { signal: ac.signal })
    expect(r.status).toBe('aborted')
  })
  it('执行中途 abort 返回 aborted', async () => {
    const ac = new AbortController()
    const slow = new Promise((r) => setTimeout(r, 200))
    const raced = raceWithControl(slow, { signal: ac.signal, timeoutMs: 5000 })
    setTimeout(() => ac.abort(), 20)
    const r = await raced
    expect(r.status).toBe('aborted')
  })
  it('promise reject 时不抛出，按 ok 收尾（竞态已结束）', async () => {
    const r = await raceWithControl(Promise.reject(new Error('x')), {})
    expect(r.status).toBe('ok')
  })
  it('timeoutMs 不传时不会因超时结束', async () => {
    const r = await raceWithControl(new Promise((res) => setTimeout(() => res('done'), 30)))
    expect(r).toEqual({ status: 'ok', value: 'done' })
  })
})

describe('extractWrittenPaths 写入路径提取', () => {
  it('write/edit/delete 提取 path', () => {
    const paths = extractWrittenPaths([
      { name: 'write', args: { path: 'a.ts' } },
      { name: 'edit', args: { path: 'b.ts' } },
      { name: 'delete', args: { path: 'c.ts' } }
    ])
    expect(paths).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })
  it('move/copy 提取 source 与 destination', () => {
    const paths = extractWrittenPaths([
      { name: 'move', args: { source: 'a.ts', destination: 'dir/a.ts' } },
      { name: 'copy', args: { source: 'b.ts', destination: 'dir/b.ts' } }
    ])
    expect(paths).toContain('a.ts')
    expect(paths).toContain('dir/a.ts')
    expect(paths).toHaveLength(4)
  })
  it('bash/read/grep 等只读或命令工具不提取', () => {
    const paths = extractWrittenPaths([
      { name: 'bash', args: { command: 'echo hi > x.txt' } },
      { name: 'read', args: { path: 'a.ts' } },
      { name: 'grep', args: { pattern: 'x' } }
    ])
    expect(paths).toEqual([])
  })
  it('路径去重且忽略空串', () => {
    const paths = extractWrittenPaths([
      { name: 'write', args: { path: 'a.ts' } },
      { name: 'edit', args: { path: 'a.ts' } },
      { name: 'write', args: { path: '  ' } }
    ])
    expect(paths).toEqual(['a.ts'])
  })
})

describe('findConflicts 写入冲突检测', () => {
  it('无交集时返回空', () => {
    expect(findConflicts([['a.ts'], ['b.ts'], ['c.ts']])).toEqual([])
  })
  it('两个子任务写同一路径时报告冲突', () => {
    const c = findConflicts([['a.ts', 'x.ts'], ['x.ts']])
    expect(c).toEqual([{ path: 'x.ts', tasks: [0, 1] }])
  })
  it('三个子任务共享路径时列出全部涉及者', () => {
    const c = findConflicts([['s.ts'], ['s.ts'], ['s.ts']])
    expect(c).toEqual([{ path: 's.ts', tasks: [0, 1, 2] }])
  })
  it('输出按路径排序保证稳定', () => {
    const c = findConflicts([['b.ts', 'a.ts'], ['a.ts', 'b.ts']])
    expect(c.map((x) => x.path)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('budgetExceeded Token 预算检查', () => {
  it('budget 未传时不设限', () => {
    expect(budgetExceeded(999999)).toBe(false)
  })
  it('budget <=0 视为不设限', () => {
    expect(budgetExceeded(100, 0)).toBe(false)
    expect(budgetExceeded(100, -5)).toBe(false)
  })
  it('used 达到预算即耗尽', () => {
    expect(budgetExceeded(200, 200)).toBe(true)
  })
  it('used 超过预算为耗尽', () => {
    expect(budgetExceeded(201, 200)).toBe(true)
  })
  it('used 低于预算为未耗尽', () => {
    expect(budgetExceeded(199, 200)).toBe(false)
  })
})
