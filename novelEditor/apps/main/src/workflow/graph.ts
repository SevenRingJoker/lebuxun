/** 工作流图工具（SPEC §7.1 执行算法步骤 2/5、§9.2 条件边） */

import type { Workflow, WorkflowEdge, WorkflowNode } from '@novel-forge/shared';

/** 校验图：节点 id 唯一、边两端引用的节点必须存在 */
export function validateGraph(workflow: Workflow): void {
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) {
      throw new Error(`workflow ${workflow.id} 节点 id 重复: ${node.id}`);
    }
    ids.add(node.id);
  }
  for (const edge of workflow.edges) {
    for (const nodeId of [edge.source.nodeId, edge.target.nodeId]) {
      if (!ids.has(nodeId)) {
        throw new Error(`workflow ${workflow.id} 边 ${edge.id} 引用了不存在的节点: ${nodeId}`);
      }
    }
  }
}

/** 起始节点：无入边的节点（§7.1 步骤 2） */
export function findStartNodes(workflow: Workflow): WorkflowNode[] {
  const hasIncoming = new Set(workflow.edges.map((e) => e.target.nodeId));
  return workflow.nodes.filter((n) => !hasIncoming.has(n.id));
}

/**
 * 拓扑排序（Kahn）。工作流允许循环（§7.1 步骤 5b），环上节点无法被 Kahn 排出，
 * 按声明顺序追加在末尾——本函数用于校验/确定性排序，引擎实际执行由边选择驱动。
 */
export function topoSort(workflow: Workflow): WorkflowNode[] {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    indegree.set(edge.target.nodeId, (indegree.get(edge.target.nodeId) ?? 0) + 1);
    outgoing.get(edge.source.nodeId)?.push(edge.target.nodeId);
  }

  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const queue = workflow.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const sorted: WorkflowNode[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (node) sorted.push(node);
    for (const next of outgoing.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  // 环上剩余节点按声明顺序追加
  for (const node of workflow.nodes) {
    if (!visited.has(node.id)) sorted.push(node);
  }
  return sorted;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * 出边选择（§7.1 步骤 5a、§9.2）：
 * - 带 condition 的边按 `output[condition.port]` 与 `condition.equals` 匹配；
 * - 有任一条件边命中 → 只走命中的条件边；
 * - 否则走全部无条件边（条件边全不命中且无无条件边 → 无出边，run 结束）。
 */
export function selectOutgoingEdges(
  workflow: Workflow,
  nodeId: string,
  output: Record<string, unknown>,
): WorkflowEdge[] {
  const outgoing = workflow.edges.filter((e) => e.source.nodeId === nodeId);
  const matched = outgoing.filter(
    (e) => e.condition !== undefined && valuesEqual(output[e.condition.port], e.condition.equals),
  );
  if (matched.length > 0) return matched;
  return outgoing.filter((e) => e.condition === undefined);
}
