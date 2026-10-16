/** ③ 节点画布：当前工作流只读 DAG 渲染（SPEC §12.1）
 *
 * 数据：workflowStore.workflow（workflow:load 载入的真实图）。
 * 状态着色：
 * - 当前执行节点（running，currentNodeId）高亮描边
 * - 当前暂停节点（paused，currentNodeId）琥珀色
 * - 已产出过输出的节点（nodeOutputs 命中）淡绿
 * 只读：禁止拖拽/连线/选择（本期不提供画布编辑，编排走 JSON/后续迭代）。
 */

import { useMemo } from 'react';
import ReactFlow, { Background, type Edge, type Node } from 'reactflow';
import 'reactflow/dist/style.css';
import type { NodeType } from '@novel-forge/shared';
import { useWorkflowStore } from '../stores/workflowStore.js';

/** 节点类型 → 中文短名（与 main 侧 NodeDefinition.title 对齐，仅展示用） */
const NODE_LABELS: Record<NodeType, string> = {
  'input.context': '上下文输入',
  'input.manual': '人工输入',
  'context.memory': '记忆装配',
  'context.style': '文风装配',
  'generate.chapter-plan': '章节大纲',
  'generate.paragraph-multi': '段落生成×N',
  'generate.dialogue': '对白生成',
  'generate.polish': '润色',
  'review.candidate-picker': '候选评审',
  'review.chapter-end': '章末评审',
  'chapter.accumulator': '章节累加器',
  'chapter.finalizer': '章节定稿',
  'chapter.next-starter': '下一章启动',
  'memory.updater': '记忆更新',
  'growth.capture-diff': '差异捕获',
  'growth.update-profile': '画像更新',
  'growth.calibrate-evaluator': '评估校准',
  'style.rag-retrieve': '文风检索',
  'style.discriminator': '文风判别',
};

export default function CanvasArea() {
  const workflow = useWorkflowStore((s) => s.workflow);
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const currentNodeId = useWorkflowStore((s) => s.currentNodeId);
  const nodeOutputs = useWorkflowStore((s) => s.nodeOutputs);

  const { nodes, edges } = useMemo(() => {
    if (workflow === null) return { nodes: [] as Node[], edges: [] as Edge[] };
    const rfNodes: Node[] = workflow.nodes.map((n) => {
      const isCurrent = n.id === currentNodeId;
      const stateClass = isCurrent && runStatus === 'paused'
        ? 'dag-node dag-node--paused'
        : isCurrent && runStatus === 'running'
          ? 'dag-node dag-node--running'
          : nodeOutputs[n.id] !== undefined
            ? 'dag-node dag-node--done'
            : 'dag-node';
      return {
        id: n.id,
        position: n.position,
        data: { label: NODE_LABELS[n.type] ?? n.type },
        className: stateClass,
        draggable: false,
        connectable: false,
      };
    });
    const rfEdges: Edge[] = workflow.edges.map((e) => ({
      id: e.id,
      source: e.source.nodeId,
      target: e.target.nodeId,
      sourceHandle: e.source.port,
      targetHandle: e.target.port,
    }));
    return { nodes: rfNodes, edges: rfEdges };
  }, [workflow, currentNodeId, runStatus, nodeOutputs]);

  return (
    <main className="app-canvas">
      {workflow === null ? (
        <div className="canvas-empty">未加载工作流（从项目入口打开项目后自动载入）</div>
      ) : (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnScroll
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
        </ReactFlow>
      )}
    </main>
  );
}
