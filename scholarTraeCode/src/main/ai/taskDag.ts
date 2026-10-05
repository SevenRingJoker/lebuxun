// 任务 DAG 纯函数层：schema、拓扑排序、就绪节点计算、越序拦截、修复子图注入。
// 零 IO / 零外部依赖，单测可 100% 覆盖。

export interface DagNode {
  id: string
  action: string
  args: Record<string, unknown>
  dependencies: string[]
  complexity: 'low' | 'high'
}

export interface TaskDag {
  version: 1
  targetDir?: string
  nodes: DagNode[]
}

export interface DagState {
  dag: TaskDag
  status: Record<string, 'pending' | 'running' | 'done' | 'failed' | 'skipped'>
  results: Record<string, string>
}

// ============== 解析校验 ==============

export function parseTaskDag(text: string): { ok: true; dag: TaskDag } | { ok: false; error: string } {
  // 提取 ```dag 代码块
  const match = text.match(/```(?:dag)?\s*\n?([\s\S]*?)```/)
  const raw = match ? match[1].trim() : text.trim()
  if (!raw) return { ok: false, error: 'DAG 文本为空，未找到 ```dag 代码块' }
  try {
    const parsed = JSON.parse(raw) as TaskDag
    if (!Array.isArray(parsed.nodes)) {
      return { ok: false, error: 'DAG JSON 缺少 nodes 数组' }
    }
    const ids = new Set<string>()
    for (const n of parsed.nodes) {
      if (!n.id || typeof n.id !== 'string') return { ok: false, error: `节点 id 缺失或非法：${JSON.stringify(n)}` }
      if (ids.has(n.id)) return { ok: false, error: `节点 id 重复：${n.id}` }
      ids.add(n.id)
      if (!n.action || typeof n.action !== 'string') return { ok: false, error: `节点 ${n.id} action 缺失` }
      if (!Array.isArray(n.dependencies)) return { ok: false, error: `节点 ${n.id} dependencies 不是数组` }
      if (!n.args || typeof n.args !== 'object') return { ok: false, error: `节点 ${n.id} args 缺失` }
      if (!['low', 'high'].includes(n.complexity)) return { ok: false, error: `节点 ${n.id} complexity 非法` }
    }
    // 依赖悬空检查
    for (const n of parsed.nodes) {
      for (const d of n.dependencies) {
        if (!ids.has(d)) return { ok: false, error: `节点 ${n.id} 依赖的节点 ${d} 不存在` }
      }
    }
    // 环检测
    const cycle = findCycle(parsed.nodes)
    if (cycle) return { ok: false, error: `DAG 存在环：${cycle.join(' → ')}` }
    return { ok: true, dag: parsed }
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

function findCycle(nodes: DagNode[]): string[] | null {
  const adj = new Map<string, string[]>()
  for (const n of nodes) adj.set(n.id, n.dependencies)
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const path: string[] = []

  function dfs(u: string): boolean {
    visiting.add(u)
    path.push(u)
    for (const v of adj.get(u) ?? []) {
      if (visited.has(v)) continue
      if (visiting.has(v)) {
        const idx = path.indexOf(v)
        return true // path[idx..] 即环
      }
      if (dfs(v)) return true
    }
    visiting.delete(u)
    visited.add(u)
    path.pop()
    return false
  }

  for (const n of nodes) {
    if (!visited.has(n.id) && dfs(n.id)) {
      const cycleStart = path[path.length - 1]
      const idx = path.indexOf(cycleStart)
      return path.slice(idx)
    }
  }
  return null
}

// ============== 拓扑分层 ==============

export function buildLayers(dag: TaskDag): string[][] {
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of dag.nodes) {
    inDegree.set(n.id, 0)
    adj.set(n.id, [])
  }
  for (const n of dag.nodes) {
    for (const d of n.dependencies) {
      adj.get(d)!.push(n.id)
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1)
    }
  }
  const layers: string[][] = []
  let queue = dag.nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id)
  while (queue.length > 0) {
    layers.push([...queue])
    const next: string[] = []
    for (const u of queue) {
      for (const v of adj.get(u) ?? []) {
        const deg = (inDegree.get(v) ?? 0) - 1
        inDegree.set(v, deg)
        if (deg === 0) next.push(v)
      }
    }
    queue = next
  }
  return layers
}

// ============== 运行态 ==============

export function createDagState(dag: TaskDag): DagState {
  const status: Record<string, DagState['status'][string]> = {}
  for (const n of dag.nodes) status[n.id] = 'pending'
  return { dag, status, results: {} }
}

export function readyNodes(state: DagState): DagNode[] {
  return state.dag.nodes.filter((n) => {
    if (state.status[n.id] !== 'pending') return false
    return n.dependencies.every((d) => state.status[d] === 'done')
  })
}

export function markDone(state: DagState, id: string, result: string): void {
  state.status[id] = 'done'
  state.results[id] = result
}

export function markFailed(state: DagState, id: string, error: string): void {
  state.status[id] = 'failed'
  state.results[id] = error
}

// ============== 越序拦截 ==============

/**
 * 检查模型试图调用的工具是否属于尚未 ready 的节点。
 * 返回拦截文案；放行返回 null。
 */
export function checkOrderViolation(
  state: DagState,
  toolName: string,
  args: Record<string, unknown>
): string | null {
  const ready = readyNodes(state)
  if (ready.length === 0) {
    return `【越序拦截】当前没有就绪节点可执行。请等待前置依赖完成后再继续。`
  }

  // 尝试匹配：按 toolName + path/command 与 ready 节点的 action/args 进行比对
  const matched = ready.filter((node) => node.action === toolName)
  if (matched.length === 0) {
    const readyIds = ready.map((n) => `${n.id}(${n.action})`).join('、')
    return (
      `【越序拦截】工具 ${toolName} 不在当前就绪节点中。` +
      `当前就绪节点：${readyIds}。请按 DAG 顺序执行。`
    )
  }

  // 如果有多条匹配，允许通过；如果零条匹配但 toolName 吻合（例如 write_file 有多个 ready），放行
  return null
}

// ============== 修复子图注入 ==============

/**
 * 在失败节点与其直接后继之间插入修复子图。
 * 修复节点的 dependencies 指向失败节点，原后继的 dependencies 从失败节点替换为修复节点。
 * 返回新 dag（原 dag 不变）。
 */
export function injectRepairSubgraph(dag: TaskDag, failedId: string, repairNodes: DagNode[]): TaskDag {
  if (repairNodes.length === 0) return dag
  const repairIds = repairNodes.map((n) => n.id)
  const lastRepairId = repairIds[repairIds.length - 1]
  const newNodes = dag.nodes.map((n) => {
    if (n.id === failedId) {
      // 失败节点自身状态由调用方 markFailed 处理，此处不修改
      return n
    }
    const newDeps = n.dependencies.map((d) => (d === failedId ? lastRepairId : d))
    return { ...n, dependencies: newDeps }
  })
  // 修复节点：第一条的依赖指向 failedId，后续链式依赖
  const wiredRepair = repairNodes.map((n, i) => ({
    ...n,
    dependencies: i === 0 ? [failedId] : [repairIds[i - 1]]
  }))
  return { ...dag, nodes: [...newNodes, ...wiredRepair] }
}

// ============== 序列化 ==============

export function serializeDagState(state: DagState): unknown {
  return {
    dag: state.dag,
    status: state.status,
    results: state.results
  }
}

export function deserializeDagState(raw: unknown): DagState | null {
  const r = raw as Record<string, unknown> | null
  if (!r) return null
  const dag = r.dag as TaskDag | undefined
  if (!dag || !Array.isArray(dag.nodes)) return null
  const status = r.status as Record<string, DagState['status'][string] | undefined>
  if (!status) return null
  const results = r.results as Record<string, string> | undefined
  return {
    dag,
    status: { ...status },
    results: { ...(results ?? {}) }
  }
}
