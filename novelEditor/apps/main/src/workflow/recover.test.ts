/** SPEC §7.1 验收：进程崩溃后恢复 paused 状态（2.5 RunState 持久化）
 *
 * 模拟崩溃重启：同一个数据库、全新 WorkflowEngine 实例（内存 Map 全丢），
 * recoverRuns() 从 runs 表读回 paused run（outputs/context/挂起信息），resume 继续。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { NodeType, Workflow, WorkflowEdge, WorkflowNode } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { WorkflowsRepository } from '../db/repositories/workflows.js';
import { NodeRegistry } from '../nodes/registry.js';
import type { NodeDefinition } from '../nodes/types.js';
import { WorkflowEngine } from './engine.js';
import { EventBus } from './events.js';

function mockDef(
  type: NodeType,
  execute: NodeDefinition['execute'],
  extra: Partial<NodeDefinition> = {},
): NodeDefinition {
  return { type, title: `mock ${type}`, inputs: [], outputs: [], params: [], execute, ...extra };
}

function node(id: string, type: NodeType): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, params: {} };
}

function edge(id: string, source: [string, string], target: [string, string]): WorkflowEdge {
  return { id, source: { nodeId: source[0], port: source[1] }, target: { nodeId: target[0], port: target[1] } };
}

let db: AppDatabase;
let workflows: WorkflowsRepository;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  db.prepare(
    'INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('p1', '测试项目', '仙侠', Date.now(), Date.now());
  workflows = new WorkflowsRepository(db);
});

function seedWorkflow(id: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return workflows.insert({ id, projectId: 'p1', name: id, nodes, edges, version: 1 });
}

function buildRegistry(hits: string[]): NodeRegistry {
  const reg = new NodeRegistry();
  reg.register(mockDef('input.context', async () => { hits.push('ctx'); return { context: 'c0' }; }));
  reg.register(
    mockDef('review.candidate-picker', async (_ctx, input) => ({ panel: input }), {
      pause: true,
      onResume: (_ctx, action) => ({ selected: (action as { candidateId?: string }).candidateId }),
    }),
  );
  reg.register(
    mockDef('chapter.accumulator', async (_ctx, input) => {
      hits.push('acc');
      return { chapterDraft: `draft+${String(input['selected'])}` };
    }),
  );
  return reg;
}

function seedPauseGraph(): void {
  seedWorkflow('w-recover', [
    node('ctx', 'input.context'),
    node('pick', 'review.candidate-picker'),
    node('acc', 'chapter.accumulator'),
  ], [
    edge('e1', ['ctx', 'context'], ['pick', 'candidates']),
    edge('e2', ['pick', 'selected'], ['acc', 'selected']),
  ]);
}

describe('recoverRuns（§7.1 验收：崩溃后恢复 paused）', () => {
  it('pause 后重建引擎实例：recover + resume 跑通', async () => {
    seedPauseGraph();
    const hits1: string[] = [];
    const engine1 = new WorkflowEngine(buildRegistry(hits1), db, new EventBus());
    const { runId } = await engine1.start({ projectId: 'p1', workflowId: 'w-recover' });
    expect(engine1.getRun(runId)!.status).toBe('paused');
    expect(hits1).toEqual(['ctx']);

    // 模拟进程崩溃重启：全新引擎实例（内存状态全丢），同一数据库
    const hits2: string[] = [];
    const engine2 = new WorkflowEngine(buildRegistry(hits2), db, new EventBus());
    expect(engine2.getRun(runId)).toBeUndefined(); // 内存中没有

    const restored = await engine2.recoverRuns();
    expect(restored.map((r) => r.runId)).toEqual([runId]);
    const run = engine2.getRun(runId)!;
    expect(run.status).toBe('paused');
    expect(run.currentNodeId).toBe('pick');
    // outputs/context 从 state JSON 还原
    expect(run.outputs['ctx']).toEqual({ context: 'c0' });
    expect(run.context.projectId).toBe('p1');
    expect(run.context.accumulatedParagraphs).toEqual([]);

    // resume 继续推进：pause 节点注入 userAction → acc 执行 → done
    await engine2.resume({ runId, nodeId: 'pick', userAction: { type: 'select', candidateId: 'C' } });
    const doneRun = engine2.getRun(runId)!;
    expect(doneRun.status).toBe('done');
    expect(hits2).toEqual(['acc']); // ctx 不重复执行
    expect(doneRun.outputs['pick']).toEqual({ selected: 'C' });
    expect(doneRun.outputs['acc']).toEqual({ chapterDraft: 'draft+C' });

    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('done');
  });

  it('recover 后 resume 节点不匹配仍报错（挂起信息随恢复校验）', async () => {
    seedPauseGraph();
    const engine1 = new WorkflowEngine(buildRegistry([]), db, new EventBus());
    const { runId } = await engine1.start({ projectId: 'p1', workflowId: 'w-recover' });

    const engine2 = new WorkflowEngine(buildRegistry([]), db, new EventBus());
    await engine2.recoverRuns();
    await expect(
      engine2.resume({ runId, nodeId: 'ctx', userAction: { type: 'select', candidateId: 'x' } }),
    ).rejects.toThrow(/未在节点 ctx 暂停/);
  });

  it('没有 paused run 时 recover 返回空', async () => {
    const engine = new WorkflowEngine(buildRegistry([]), db, new EventBus());
    await expect(engine.recoverRuns()).resolves.toEqual([]);
  });
});

describe('start({ fromNodeId })', () => {
  it('从指定节点恢复：上游节点不执行', async () => {
    const hits: string[] = [];
    const reg = new NodeRegistry();
    reg.register(mockDef('input.context', async () => { hits.push('n1'); return { out: '1' }; }));
    reg.register(mockDef('context.memory', async () => { hits.push('n2'); return { out: '2' }; }));
    reg.register(mockDef('chapter.finalizer', async () => { hits.push('n3'); return { out: '3' }; }));
    seedWorkflow('w-from', [
      node('n1', 'input.context'),
      node('n2', 'context.memory'),
      node('n3', 'chapter.finalizer'),
    ], [
      edge('e1', ['n1', 'out'], ['n2', 'in']),
      edge('e2', ['n2', 'out'], ['n3', 'in']),
    ]);

    const engine = new WorkflowEngine(reg, db, new EventBus());
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-from', fromNodeId: 'n3' });
    expect(engine.getRun(runId)!.status).toBe('done');
    expect(hits).toEqual(['n3']); // n1/n2 未执行
  });

  it('fromNodeId 不在图中时报错', async () => {
    seedWorkflow('w-empty', [node('n1', 'input.manual')], []);
    const engine = new WorkflowEngine(new NodeRegistry(), db, new EventBus());
    await expect(
      engine.start({ projectId: 'p1', workflowId: 'w-empty', fromNodeId: 'ghost' }),
    ).rejects.toThrow(/fromNodeId/);
  });
});
