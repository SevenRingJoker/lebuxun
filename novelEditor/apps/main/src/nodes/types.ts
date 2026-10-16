/** SPEC §7.2 Node Registry 类型：NodeDefinition / PortSpec / ParamSpec / NodeContext
 *
 * SPEC 只给出 NodeDefinition/NodeContext 的骨架，PortSpec/ParamSpec 字段细节未定义，
 * 按 §7.3 节点清单的端口/参数语义补全（SPEC-CHANGELOG 登记）。
 * NodeContext 补 `node`（§9.3 示例代码使用 ctx.node.params）；
 * llm/sidecar 在 Phase 2 由引擎可选注入（Phase 3 真实节点再强制要求）。
 */

import type { NodeType, StreamEvent, UserAction, WorkflowNode } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import type { LLMGateway } from '../llm/gateway.js';
import type { ModelRouter } from '../llm/model-router.js';
import type { SidecarClient } from '../sidecar/client.js';

/** 端口规格（§7.3 输入/输出列的元数据化） */
export interface PortSpec {
  name: string;
  /** 人类可读类型描述，如 'candidates[]'、'text'（Phase 2 仅作元数据，不做运行时校验） */
  dataType?: string;
  required?: boolean;
  description?: string;
}

/** 节点参数规格（params 中可编辑项的描述） */
export interface ParamSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'json';
  default?: unknown;
  /** type === 'select' 时的可选项 */
  options?: unknown[];
  description?: string;
}

export interface NodeContext {
  runId: string;
  nodeId: string;
  projectId: string;
  /** 当前节点（含 params；§9.3 示例用 ctx.node.params） */
  node: WorkflowNode;
  db: AppDatabase;
  /** Phase 3 由引擎注入真实实例；Phase 2 测试 mock 节点一般不使用 */
  llm?: LLMGateway;
  sidecar?: SidecarClient;
  /** 全局 ModelRouter 单例（收尾批次 3 注入，支持设置面板运行时路由覆盖） */
  router?: ModelRouter;
  /** 注入 eventBus，转发 StreamEvent → IPC → Renderer */
  emit: (event: StreamEvent) => void;
  /** console + 可选落盘（引擎 options.logDir） */
  log: (msg: string) => void;
}

export interface NodeDefinition<In = any, Out = any> {
  type: NodeType;
  title: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  params: ParamSpec[];
  /** 人工节点：execute 产出面板 payload 后挂起，等 resume 注入 userAction（§7.1 步骤 4） */
  pause?: boolean;
  execute(ctx: NodeContext, input: In): Promise<Out> | AsyncGenerator<Out>;
  /**
   * pause 节点专用：resume 时把 userAction 映射为最终节点输出。
   * 缺省实现：{ ...pausedPayload, ...userAction }（见 workflow/pauser.ts）。
   */
  onResume?(ctx: NodeContext, userAction: UserAction, pausedPayload: Out | undefined): Out | Promise<Out>;
}
