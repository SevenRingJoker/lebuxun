/** 默认工作流播种（resources/default-workflows/main-loop.json，§9.1 主循环） */

import { beforeEach, describe, expect, it } from 'vitest';
import type { NodeType } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { WorkflowsRepository } from '../db/repositories/workflows.js';
import { loadDefaultWorkflow } from './default-workflow.js';

/** §7.3 节点清单的全部合法 type（main-loop.json 只能引用这些） */
const KNOWN_NODE_TYPES: readonly NodeType[] = [
  'input.context', 'input.manual',
  'context.memory', 'context.style',
  'generate.chapter-plan', 'generate.paragraph-multi',
  'generate.dialogue', 'generate.polish',
  'review.candidate-picker', 'review.chapter-end',
  'chapter.accumulator', 'chapter.finalizer', 'chapter.next-starter',
  'memory.updater',
  'growth.capture-diff', 'growth.update-profile', 'growth.calibrate-evaluator',
  'style.rag-retrieve', 'style.discriminator',
];

describe('main-loop.json 图模板', () => {
  it('加载成功，节点/边结构与 §7.3、§9.2 一致', () => {
    const graph = loadDefaultWorkflow();
    expect(graph.name).toBe('主循环');
    expect(graph.nodes.length).toBeGreaterThanOrEqual(12);

    const ids = new Set(graph.nodes.map((n) => n.id));
    // 全部节点 type 合法
    for (const n of graph.nodes) {
      expect(KNOWN_NODE_TYPES).toContain(n.type);
    }
    // 边两端节点存在
    for (const e of graph.edges) {
      expect(ids).toContain(e.source.nodeId);
      expect(ids).toContain(e.target.nodeId);
    }
    // §9.2：review.chapter-end 的两条条件边
    const condEdges = graph.edges.filter((e) => e.condition !== undefined);
    expect(condEdges).toHaveLength(2);
    const byCondition = new Map(condEdges.map((e) => [String(e.condition!.equals), e]));
    expect(byCondition.get('continue')?.target.nodeId).toBe('gen');
    expect(byCondition.get('end')?.target.nodeId).toBe('fin');
    for (const e of condEdges) {
      expect(e.source.nodeId).toBe('endq');
      expect(e.condition!.port).toBe('decision');
    }
    // 起始节点是 input.context
    const hasIncoming = new Set(graph.edges.map((e) => e.target.nodeId));
    const starts = graph.nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id);
    expect(starts).toEqual(['ctx']);
  });
});

describe('默认工作流播种（项目维度绑定）', () => {
  let db: AppDatabase;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
    db.prepare(
      'INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('p1', '测试项目', '仙侠', Date.now(), Date.now());
  });

  it('模板图插入 workflows 表并能按项目读回（project:create 绑定的核心路径）', () => {
    const graph = loadDefaultWorkflow();
    const workflows = new WorkflowsRepository(db);
    workflows.insert({
      id: 'wf-default-p1',
      projectId: 'p1',
      name: graph.name,
      nodes: structuredClone(graph.nodes),
      edges: structuredClone(graph.edges),
      version: graph.version,
    });

    const got = workflows.get('wf-default-p1');
    expect(got?.name).toBe('主循环');
    expect(got?.nodes).toEqual(graph.nodes);
    expect(got?.edges).toEqual(graph.edges);
    expect(workflows.listByProject('p1').map((w) => w.id)).toEqual(['wf-default-p1']);
  });
});
