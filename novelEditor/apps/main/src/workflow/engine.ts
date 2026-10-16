/** SPEC §7.1 Workflow Engine：DAG 执行 + 循环 + 暂停/恢复 + 流式输出 + 状态持久化
 *
 * 执行算法（§7.1）：加载图 → 校验/起始节点 → 队列驱动逐节点执行（executor）
 * → pause 节点挂起（pauser，状态落库）→ 出边选择（graph.selectOutgoingEdges，
 * 含 §9.2 条件边与回边循环）→ 无出边则 done。
 *
 * start()/resume() 返回的 Promise 在 run 到达稳定态（done/error/paused）时兑现，
 * 调用方据此确定后续动作；stop()/requestPause() 为协作式中断（节点边界生效）。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RunState, UserAction, Workflow, WorkflowNode } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import { RunsRepository } from '../db/repositories/runs.js';
import { WorkflowsRepository } from '../db/repositories/workflows.js';
import type { LLMGateway } from '../llm/gateway.js';
import type { ModelRouter } from '../llm/model-router.js';
import type { NodeRegistry } from '../nodes/registry.js';
import type { NodeContext, NodeDefinition } from '../nodes/types.js';
import type { SidecarClient } from '../sidecar/client.js';
import type { EventBus } from './events.js';
import { buildNodeContext, collectInputs, executeNode } from './executor.js';
import { findStartNodes, selectOutgoingEdges, validateGraph } from './graph.js';
import { resolveResumeOutput } from './pauser.js';
import type { PausedNodeInfo } from './types.js';

export interface WorkflowEngineOptions {
  /** 防死循环步数上限（§7.1 循环支持的安全闸），默认 1000 */
  maxSteps?: number;
  /** ctx.log 可选落盘目录（<logDir>/<runId>.log） */
  logDir?: string;
  /** Phase 3 注入真实实例，传进 NodeContext */
  llm?: LLMGateway;
  sidecar?: SidecarClient;
  /** 全局 ModelRouter 单例（收尾批次 3），传进 NodeContext 以支持运行时路由覆盖 */
  router?: ModelRouter;
}

const DEFAULT_MAX_STEPS = 1000;

export class WorkflowEngine {
  private readonly runs = new Map<string, RunState>();
  private readonly pausedNodes = new Map<string, PausedNodeInfo>();
  private readonly stopRequested = new Set<string>();
  private readonly pauseRequested = new Set<string>();
  private readonly drives = new Map<string, Promise<void>>();
  private readonly workflowsRepo: WorkflowsRepository;
  private readonly runsRepo: RunsRepository;
  private readonly maxSteps: number;

  constructor(
    private readonly registry: NodeRegistry,
    private readonly db: AppDatabase,
    private readonly eventBus: EventBus,
    private readonly options: WorkflowEngineOptions = {},
  ) {
    this.workflowsRepo = new WorkflowsRepository(db);
    this.runsRepo = new RunsRepository(db);
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    if (options.logDir !== undefined) {
      fs.mkdirSync(options.logDir, { recursive: true });
    }
  }

  getRun(runId: string): RunState | undefined {
    return this.runs.get(runId);
  }

  /** 启动 run；Promise 在 run 到达 done/error/paused 时兑现，返回 runId 与稳定态状态 */
  async start(params: {
    projectId: string;
    workflowId: string;
    fromNodeId?: string;
  }): Promise<{ runId: string; status: RunState['status'] }> {
    const workflow = this.workflowsRepo.get(params.workflowId);
    if (!workflow) {
      throw new Error(`workflow 不存在: ${params.workflowId}`);
    }
    if (workflow.projectId !== params.projectId) {
      throw new Error(`workflow ${params.workflowId} 不属于项目 ${params.projectId}`);
    }
    validateGraph(workflow);

    let queue: string[];
    if (params.fromNodeId !== undefined) {
      if (!workflow.nodes.some((n) => n.id === params.fromNodeId)) {
        throw new Error(`fromNodeId 不在 workflow 中: ${params.fromNodeId}`);
      }
      queue = [params.fromNodeId];
    } else {
      queue = findStartNodes(workflow).map((n) => n.id);
      if (queue.length === 0) {
        throw new Error(`workflow ${params.workflowId} 没有起始节点（无入边的节点）`);
      }
    }

    const runId = randomUUID();
    const run: RunState = {
      runId,
      workflowId: workflow.id,
      status: 'running',
      outputs: {},
      context: { projectId: params.projectId, accumulatedParagraphs: [] },
    };
    this.runs.set(runId, run);
    this.runsRepo.insert(run);

    await this.drive(run, workflow, queue);
    return { runId, status: run.status };
  }

  /** 恢复 paused run：pause 节点注入 userAction 后继续推进；Promise 在下一个稳定态兑现并返回其状态 */
  async resume(params: { runId: string; nodeId: string; userAction: UserAction }): Promise<RunState['status']> {
    const run = this.runs.get(params.runId);
    if (!run) {
      throw new Error(`run 不存在: ${params.runId}`);
    }
    if (run.status !== 'paused') {
      throw new Error(`run ${params.runId} 不是 paused 状态（当前 ${run.status}）`);
    }
    const pause = this.pausedNodes.get(params.runId);
    if (!pause || pause.nodeId !== params.nodeId) {
      throw new Error(`run ${params.runId} 未在节点 ${params.nodeId} 暂停`);
    }
    const workflow = this.mustWorkflow(run.workflowId);
    const node = mustNode(workflow, params.nodeId);

    let branchOutput: Record<string, unknown>;
    if (pause.kind === 'node') {
      // pause 节点：userAction 映射为最终输出（§9.2），补发 node-done
      const def = this.registry.get(node.type);
      const ctx = this.buildContext(run, node);
      const output = await resolveResumeOutput(def, ctx, params.userAction, pause.payload);
      run.outputs[node.id] = output;
      this.eventBus.emit({ type: 'workflow:node-done', runId: run.runId, nodeId: node.id, output });
      branchOutput = output;
    } else {
      // requestPause 挂起：从最后完成节点的出边继续
      branchOutput = run.outputs[node.id] ?? {};
    }

    this.pausedNodes.delete(params.runId);
    run.status = 'running';
    this.persist(run);

    const edges = selectOutgoingEdges(workflow, node.id, branchOutput);
    await this.drive(run, workflow, edges.map((e) => e.target.nodeId));
    return run.status;
  }

  /** 优雅挂起：当前节点完成后在节点边界暂停（status=paused，可 resume 继续） */
  requestPause(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`run 不存在: ${runId}`);
    }
    if (run.status !== 'running') return;
    this.pauseRequested.add(runId);
  }

  /**
   * 中断运行：协作式（节点边界/生成器 yield 边界生效）。
   * 停止后 status='error'，state JSON 记 error='stopped by user'
   * （§6.6 无 stopped 状态，SPEC-CHANGELOG 登记）。
   */
  async stop(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.status === 'done' || run.status === 'error') return;
    this.stopRequested.add(runId);
    const drive = this.drives.get(runId);
    if (drive) {
      await drive;
    } else {
      // paused 挂起中的 run 没有活动循环，直接标记停止
      this.stopRequested.delete(runId);
      this.pauseRequested.delete(runId);
      this.haltAsStopped(run);
    }
  }

  /** 崩溃恢复（§7.1 验收）：把 status='paused' 的 run 读回内存，之后可正常 resume */
  async recoverRuns(): Promise<RunState[]> {
    const stored = this.runsRepo.findPaused();
    const restored: RunState[] = [];
    for (const { run, pause } of stored) {
      this.runs.set(run.runId, run);
      if (pause !== undefined) {
        this.pausedNodes.set(run.runId, pause);
      }
      restored.push(run);
    }
    return restored;
  }

  // ---- 内部 ----

  private mustWorkflow(workflowId: string): Workflow {
    const workflow = this.workflowsRepo.get(workflowId);
    if (!workflow) {
      throw new Error(`workflow 不存在: ${workflowId}`);
    }
    return workflow;
  }

  private buildContext(run: RunState, node: WorkflowNode): NodeContext {
    const { logDir, llm, sidecar, router } = this.options;
    const baseLog = (msg: string): void => {
      console.log(`[wf ${run.runId}/${node.id}]`, msg);
      if (logDir !== undefined) {
        fs.appendFileSync(
          path.join(logDir, `${run.runId}.log`),
          `${new Date().toISOString()} [${node.id}] ${msg}\n`,
        );
      }
    };
    return buildNodeContext({
      run,
      node,
      db: this.db,
      eventBus: this.eventBus,
      ...(llm !== undefined ? { llm } : {}),
      ...(sidecar !== undefined ? { sidecar } : {}),
      ...(router !== undefined ? { router } : {}),
      log: baseLog,
    });
  }

  private persist(run: RunState, pause?: PausedNodeInfo, error?: string): void {
    this.runsRepo.save(run, pause, error);
  }

  private haltAsStopped(run: RunState): void {
    this.pausedNodes.delete(run.runId);
    run.status = 'error';
    this.persist(run, undefined, 'stopped by user');
  }

  private failRun(run: RunState, nodeId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    run.status = 'error';
    run.currentNodeId = nodeId;
    this.eventBus.emit({ type: 'workflow:node-error', runId: run.runId, nodeId, error: message });
    this.persist(run, undefined, message);
  }

  private drive(run: RunState, workflow: Workflow, queue: string[]): Promise<void> {
    // 延迟到微任务启动，保证 drives 注册先于任何节点代码/事件监听器执行
    // （否则 node-start 监听器里同步调 stop() 会找不到活动循环）
    const promise = Promise.resolve()
      .then(() => this.driveInner(run, workflow, queue))
      .finally(() => {
        this.drives.delete(run.runId);
      });
    this.drives.set(run.runId, promise);
    return promise;
  }

  /** 就绪判定（SPEC §7.2 PortSpec.required）：节点的全部 required 输入端口都有值时才可执行。
   * 引擎按入边逐条触发入队、不做汇聚（#91），多入边节点会被重复入队或在生产者之前入队；
   * 配合 pending 去重 + 就绪门控，保证每个激活轮只执行一次且必需输入齐备。 */
  private inputsReady(
    workflow: Workflow,
    nodeId: string,
    run: RunState,
    def: NodeDefinition,
  ): boolean {
    const required = def.inputs.filter((p) => p.required === true);
    if (required.length === 0) return true;
    // 仅门控「图中实际连了入边」的 required 端口：未连线的 required 端口视为
    // 自定义/旧版图显式不提供该输入（由节点自身对 undefined 容错），避免误判死锁。
    const connectedPorts = new Set(
      workflow.edges
        .filter((e) => e.target.nodeId === nodeId)
        .map((e) => e.target.port),
    );
    const inputs = collectInputs(workflow, nodeId, run.outputs);
    return required
      .filter((p) => connectedPorts.has(p.name))
      .every((p) => inputs[p.name] !== undefined);
  }

  private async driveInner(run: RunState, workflow: Workflow, queue: string[]): Promise<void> {
    let steps = 0;
    // 必需输入未就绪的排队次数：仅用于识别「谁也无法满足」的死锁，不计入执行步数
    let deferrals = 0;
    // 同一激活轮内已排队的节点：去重后多入边节点只执行一次（汇聚语义，#91）
    const pending = new Set<string>();
    const enqueue = (ids: string[]): void => {
      for (const id of ids) {
        if (pending.has(id)) continue;
        pending.add(id);
        queue.push(id);
      }
    };
    enqueue(queue.splice(0, queue.length));

    while (queue.length > 0) {
      if (this.consumeFlag(this.stopRequested, run.runId)) {
        this.haltAsStopped(run);
        return;
      }
      if (this.consumeFlag(this.pauseRequested, run.runId) && run.currentNodeId !== undefined) {
        const pause: PausedNodeInfo = { kind: 'requested', nodeId: run.currentNodeId };
        run.status = 'paused';
        this.pausedNodes.set(run.runId, pause);
        this.persist(run, pause);
        this.eventBus.emit({
          type: 'workflow:node-paused',
          runId: run.runId,
          nodeId: run.currentNodeId,
          payload: null,
        });
        return;
      }

      const nodeId = queue.shift()!;
      pending.delete(nodeId);
      const node = mustNode(workflow, nodeId);

      let def: NodeDefinition;
      try {
        def = this.registry.get(node.type);
      } catch (err) {
        this.failRun(run, nodeId, err);
        return;
      }

      // 必需输入未就绪：让位给其它节点（生产者）先执行，本节点稍后重排。
      // pending 保证重排后仍只执行一次；deferrals 上限兜底「谁也无法满足」的死锁。
      if (!this.inputsReady(workflow, nodeId, run, def)) {
        deferrals += 1;
        if (deferrals > this.maxSteps) {
          this.failRun(run, nodeId, new Error(`节点 ${nodeId} 的必需输入始终未就绪（疑似死锁）`));
          return;
        }
        enqueue([nodeId]);
        continue;
      }

      let output: Record<string, unknown>;
      try {
        output = await executeNode({
          ctx: this.buildContext(run, node),
          def,
          workflow,
          run,
          eventBus: this.eventBus,
          shouldStop: () => this.stopRequested.has(run.runId),
        });
      } catch (err) {
        this.failRun(run, nodeId, err);
        return;
      }
      run.currentNodeId = nodeId;

      if (this.consumeFlag(this.stopRequested, run.runId)) {
        this.haltAsStopped(run);
        return;
      }

      if (def.pause === true) {
        // §7.1 步骤 4：持久化 → workflow:node-paused → 挂起等 resume
        const pause: PausedNodeInfo = { kind: 'node', nodeId, payload: output };
        run.status = 'paused';
        this.pausedNodes.set(run.runId, pause);
        this.persist(run, pause);
        this.eventBus.emit({ type: 'workflow:node-paused', runId: run.runId, nodeId, payload: output });
        return;
      }

      this.eventBus.emit({ type: 'workflow:node-done', runId: run.runId, nodeId, output });
      this.persist(run);

      const edges = selectOutgoingEdges(workflow, nodeId, output);
      enqueue(edges.map((e) => e.target.nodeId));

      steps += 1;
      if (steps > this.maxSteps) {
        this.failRun(run, nodeId, new Error(`超过最大步数 ${this.maxSteps}，疑似死循环`));
        return;
      }
    }
    run.status = 'done';
    this.persist(run);
  }

  private consumeFlag(flags: Set<string>, runId: string): boolean {
    const has = flags.has(runId);
    if (has) flags.delete(runId);
    return has;
  }
}

function mustNode(workflow: Workflow, nodeId: string): WorkflowNode {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) {
    throw new Error(`workflow ${workflow.id} 没有节点 ${nodeId}`);
  }
  return node;
}
