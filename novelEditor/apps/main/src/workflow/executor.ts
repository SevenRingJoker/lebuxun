/** 单节点执行器（SPEC §7.1 步骤 3）：收集输入 → execute → 流式事件 → 写 outputs */

import type { RunState, StreamEvent, Workflow, WorkflowNode } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import type { LLMGateway } from '../llm/gateway.js';
import type { ModelRouter } from '../llm/model-router.js';
import type { NodeContext, NodeDefinition } from '../nodes/types.js';
import type { SidecarClient } from '../sidecar/client.js';
import type { EventBus } from './events.js';

export interface BuildContextParams {
  run: RunState;
  node: WorkflowNode;
  db: AppDatabase;
  eventBus: EventBus;
  llm?: LLMGateway;
  sidecar?: SidecarClient;
  /** 全局 ModelRouter 单例（收尾批次 3），供节点取路由以支持运行时覆盖 */
  router?: ModelRouter;
  log?: (msg: string) => void;
}

export function buildNodeContext(params: BuildContextParams): NodeContext {
  const { run, node, db, eventBus, llm, sidecar, router, log } = params;
  return {
    runId: run.runId,
    nodeId: node.id,
    projectId: run.context.projectId,
    node,
    db,
    ...(llm !== undefined ? { llm } : {}),
    ...(sidecar !== undefined ? { sidecar } : {}),
    ...(router !== undefined ? { router } : {}),
    emit: (event: StreamEvent) => eventBus.emit(event),
    log: log ?? ((msg: string) => console.log(`[wf ${run.runId}/${node.id}]`, msg)),
  };
}

/** 收集输入端口数据：按入边从 RunState.outputs 取 source 端口的值，写到 target 端口名上 */
export function collectInputs(
  workflow: Workflow,
  nodeId: string,
  outputs: RunState['outputs'],
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const edge of workflow.edges) {
    if (edge.target.nodeId !== nodeId) continue;
    const sourceOutput = outputs[edge.source.nodeId];
    if (sourceOutput === undefined) continue;
    inputs[edge.target.port] = sourceOutput[edge.source.port];
  }
  return inputs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAsyncIterable(value: unknown): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { next?: unknown }).next === 'function'
  );
}

function isStreamEventLike(value: unknown): value is StreamEvent {
  return isRecord(value) && typeof value.type === 'string';
}

/** 节点输出统一落成 Record（端口名 → 值）；原始值包一层 { value } */
export function normalizeOutput(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return isRecord(value) ? value : { value };
}

export interface ExecuteNodeParams {
  ctx: NodeContext;
  def: NodeDefinition;
  workflow: Workflow;
  run: RunState;
  eventBus: EventBus;
  /** 协作式中断：生成器每个 yield 前检查（stop() 触发） */
  shouldStop?: () => boolean;
}

/**
 * 执行单节点（§7.1 步骤 3）：
 * a. 收集输入端口数据；b. registry 定义 execute；c. 流式事件经 eventBus 发出；
 * d. 输出写入 RunState.outputs[nodeId] 并返回。
 *
 * execute 返回 AsyncGenerator 时：string yield → workflow:node-token；
 * 带 type 字段的对象 yield → 按 StreamEvent 原样转发；return 值为节点输出
 * （无 return 值时收集 token 拼成 { text }）。
 */
export async function executeNode(params: ExecuteNodeParams): Promise<Record<string, unknown>> {
  const { ctx, def, workflow, run, eventBus, shouldStop } = params;
  const { runId } = run;
  const nodeId = ctx.nodeId;

  eventBus.emit({ type: 'workflow:node-start', runId, nodeId });

  const inputs = collectInputs(workflow, nodeId, run.outputs);
  const result = def.execute(ctx, inputs);

  let output: Record<string, unknown>;
  if (isAsyncIterable(result)) {
    const tokens: string[] = [];
    let returnValue: unknown;
    const iterator = result[Symbol.asyncIterator]();
    for (;;) {
      if (shouldStop?.()) {
        await iterator.return?.(undefined);
        break;
      }
      const { done, value } = await iterator.next();
      if (done) {
        returnValue = value;
        break;
      }
      if (typeof value === 'string') {
        tokens.push(value);
        eventBus.emit({ type: 'workflow:node-token', runId, nodeId, token: value });
      } else if (isStreamEventLike(value)) {
        eventBus.emit(value);
      } else {
        eventBus.emit({ type: 'workflow:node-token', runId, nodeId, token: String(value) });
      }
    }
    output = returnValue !== undefined ? normalizeOutput(returnValue) : { text: tokens.join('') };
  } else {
    output = normalizeOutput(await result);
  }

  run.outputs[nodeId] = output;
  return output;
}
