// taskDag 单测：解析容错、拓扑分层、就绪计算、越序拦截、修复子图、序列化往返。
import { describe, it, expect } from 'vitest'
import {
  parseTaskDag,
  buildLayers,
  createDagState,
  readyNodes,
  markDone,
  markFailed,
  checkOrderViolation,
  injectRepairSubgraph,
  serializeDagState,
  deserializeDagState,
  type TaskDag,
  type DagNode
} from './taskDag'

function dagJson(nodes: DagNode[]): string {
  return '```dag\n' + JSON.stringify({ version: 1, nodes }) + '\n```'
}

function n(id: string, deps: string[] = [], complexity: 'low' | 'high' = 'low'): DagNode {
  return { id, action: 'write_file', args: { path: `${id}.js` }, dependencies: deps, complexity }
}

describe('parseTaskDag', () => {
  it('正常解析 ```dag 代码块', () => {
    const r = parseTaskDag(dagJson([n('a'), n('b', ['a'])]))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.dag.nodes).toHaveLength(2)
      expect(r.dag.version).toBe(1)
    }
  })

  it('无代码块时尝试直接解析文本', () => {
    const r = parseTaskDag(JSON.stringify({ version: 1, nodes: [n('a')] }))
    expect(r.ok).toBe(true)
  })

  it('JSON 损坏 → 容错返回错误', () => {
    const r = parseTaskDag('```dag\n{invalid}\n```')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('JSON 解析失败')
  })

  it('空文本 → 错误', () => {
    const r = parseTaskDag('')
    expect(r.ok).toBe(false)
  })

  it('id 重复 → 错误', () => {
    const r = parseTaskDag(dagJson([n('a'), n('a')]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('重复')
  })

  it('依赖悬空 → 错误', () => {
    const r = parseTaskDag(dagJson([n('a', ['ghost'])]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('不存在')
  })

  it('环检测 → 错误', () => {
    const r = parseTaskDag(dagJson([n('a', ['b']), n('b', ['a'])]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('环')
  })

  it('complexity 非法 → 错误', () => {
    const bad = { ...n('a'), complexity: 'extreme' } as unknown as DagNode
    const r = parseTaskDag(dagJson([bad]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('complexity')
  })
})

describe('buildLayers', () => {
  it('无依赖 → 单层', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a'), n('b'), n('c')] }
    expect(buildLayers(dag)).toEqual([['a', 'b', 'c']])
  })

  it('线性依赖 → 逐层', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a'), n('b', ['a']), n('c', ['b'])] }
    expect(buildLayers(dag)).toEqual([['a'], ['b'], ['c']])
  })

  it('扇入扇出 → 正确分层', () => {
    const dag: TaskDag = {
      version: 1,
      nodes: [n('a'), n('b', ['a']), n('c', ['a']), n('d', ['b', 'c'])]
    }
    const layers = buildLayers(dag)
    expect(layers[0]).toEqual(['a'])
    expect(new Set(layers[1])).toEqual(new Set(['b', 'c']))
    expect(layers[2]).toEqual(['d'])
  })
})

describe('readyNodes / markDone / markFailed', () => {
  it('初始时无依赖节点就绪', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a'), n('b', ['a'])] }
    const s = createDagState(dag)
    expect(readyNodes(s).map((x) => x.id)).toEqual(['a'])
  })

  it('markDone 后下游就绪', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a'), n('b', ['a'])] }
    const s = createDagState(dag)
    markDone(s, 'a', 'ok')
    expect(readyNodes(s).map((x) => x.id)).toEqual(['b'])
  })

  it('markFailed 不释放下游', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a'), n('b', ['a'])] }
    const s = createDagState(dag)
    markFailed(s, 'a', 'err')
    expect(readyNodes(s).map((x) => x.id)).toEqual([])
    expect(s.status.a).toBe('failed')
  })
})

describe('checkOrderViolation', () => {
  it('无就绪节点 → 拦截', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a'), n('b', ['a'])] }
    const s = createDagState(dag)
    markFailed(s, 'a', 'x')
    const msg = checkOrderViolation(s, 'write_file', { path: 'b.js' })
    expect(msg).toContain('越序拦截')
    expect(msg).toContain('没有就绪节点')
  })

  it('就绪节点 action 匹配 → 放行', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a'), n('b', ['a'])] }
    const s = createDagState(dag)
    expect(checkOrderViolation(s, 'write_file', { path: 'a.js' })).toBeNull()
  })

  it('就绪节点 action 不匹配 → 拦截并列出 ready 节点', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a')] }
    const s = createDagState(dag)
    const msg = checkOrderViolation(s, 'run_command', { command: 'ls' })
    expect(msg).toContain('越序拦截')
    expect(msg).toContain('a(write_file)')
  })
})

describe('injectRepairSubgraph', () => {
  it('在失败节点与后继之间插入修复链', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a'), n('b', ['a']), n('c', ['b'])] }
    const repair: DagNode = { ...n('r1'), action: 'write_file', args: { path: 'fix.js' } }
    const next = injectRepairSubgraph(dag, 'b', [repair])
    // b 的下游 c 现在依赖 r1
    const c = next.nodes.find((x) => x.id === 'c')!
    expect(c.dependencies).toEqual(['r1'])
    // r1 依赖 b
    const r1 = next.nodes.find((x) => x.id === 'r1')!
    expect(r1.dependencies).toEqual(['b'])
    // 原 dag 不变
    expect(dag.nodes.find((x) => x.id === 'c')!.dependencies).toEqual(['b'])
  })

  it('多节点修复链式依赖', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a'), n('b', ['a'])] }
    const repairs: DagNode[] = [
      { ...n('r1'), args: { path: 'fix1.js' } },
      { ...n('r2'), args: { path: 'fix2.js' } }
    ]
    const next = injectRepairSubgraph(dag, 'a', repairs)
    expect(next.nodes.find((x) => x.id === 'r1')!.dependencies).toEqual(['a'])
    expect(next.nodes.find((x) => x.id === 'r2')!.dependencies).toEqual(['r1'])
    expect(next.nodes.find((x) => x.id === 'b')!.dependencies).toEqual(['r2'])
  })

  it('空修复数组原样返回', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a')] }
    expect(injectRepairSubgraph(dag, 'a', [])).toBe(dag)
  })
})

describe('serialize / deserialize', () => {
  it('往返一致', () => {
    const dag: TaskDag = { version: 1, nodes: [n('a'), n('b', ['a'])] }
    const s = createDagState(dag)
    markDone(s, 'a', 'ok')
    const raw = serializeDagState(s)
    const back = deserializeDagState(raw)
    expect(back).not.toBeNull()
    expect(back!.status.a).toBe('done')
    expect(back!.results.a).toBe('ok')
    expect(back!.dag.nodes).toHaveLength(2)
  })

  it('非法输入 → null', () => {
    expect(deserializeDagState(null)).toBeNull()
    expect(deserializeDagState({})).toBeNull()
    expect(deserializeDagState({ dag: { nodes: 'x' } })).toBeNull()
  })
})
