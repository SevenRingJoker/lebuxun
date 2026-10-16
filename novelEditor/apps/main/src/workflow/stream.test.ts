/** SPEC §4.1 / Phase 2.6：流式事件总线——AsyncGenerator 节点的 yield 经 eventBus
 *  发出 node-start → node-token* → node-done 序列（IPC 层订阅后转发 Renderer）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent, WorkflowNode } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { WorkflowsRepository } from '../db/repositories/workflows.js';
import { NodeRegistry } from '../nodes/registry.js';
import type { NodeDefinition } from '../nodes/types.js';
import { WorkflowEngine } from './engine.js';
import { EventBus } from './events.js';

let db: AppDatabase;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  db.prepare(
    'INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('p1', '测试项目', '仙侠', Date.now(), Date.now());
});

describe('流式事件（§4.1 StreamEvent 序列）', () => {
  it('生成器节点：node-start → node-token* → node-done，输出为 return 值', async () => {
    const reg = new NodeRegistry();
    const streamingDef: NodeDefinition = {
      type: 'generate.dialogue',
      title: 'mock 流式生成',
      inputs: [],
      outputs: [{ name: 'text' }],
      params: [],
      execute: async function* () {
        yield '你';
        yield '好';
        yield '，世界';
        return { text: '你好，世界' };
      },
    };
    reg.register(streamingDef);
    reg.register({
      type: 'generate.polish',
      title: 'mock 收流',
      inputs: [{ name: 'text' }],
      outputs: [{ name: 'text' }],
      params: [],
      execute: async (_ctx, input: Record<string, unknown>) => ({ text: `${String(input['text'])}!` }),
    });

    const nodes: WorkflowNode[] = [
      { id: 'gen', type: 'generate.dialogue', position: { x: 0, y: 0 }, params: {} },
      { id: 'polish', type: 'generate.polish', position: { x: 1, y: 0 }, params: {} },
    ];
    new WorkflowsRepository(db).insert({
      id: 'w-stream',
      projectId: 'p1',
      name: 'w-stream',
      nodes,
      edges: [{ id: 'e1', source: { nodeId: 'gen', port: 'text' }, target: { nodeId: 'polish', port: 'text' } }],
      version: 1,
    });

    const bus = new EventBus();
    const events: StreamEvent[] = [];
    bus.on((e) => events.push(e));
    const engine = new WorkflowEngine(reg, db, bus);

    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-stream' });
    expect(engine.getRun(runId)!.status).toBe('done');

    // token 流事件序列（node-start → node-token × 3 → node-done）之后接下一节点
    const seq = events.map((e) => {
      if (e.type === 'workflow:node-token') return `token:${e.token}`;
      if (e.type === 'workflow:node-done') return `done:${e.nodeId}`;
      return `start:${'nodeId' in e ? e.nodeId : ''}`;
    });
    expect(seq).toEqual([
      'start:gen',
      'token:你',
      'token:好',
      'token:，世界',
      'done:gen',
      'start:polish',
      'done:polish',
    ]);
    // 下游节点拿到上游 return 值
    expect(engine.getRun(runId)!.outputs['polish']).toEqual({ text: '你好，世界!' });
  });

  it('生成器无 return 值时收集 token 拼成 { text }', async () => {
    const reg = new NodeRegistry();
    reg.register({
      type: 'generate.dialogue',
      title: 'mock 纯 token 流',
      inputs: [],
      outputs: [{ name: 'text' }],
      params: [],
      execute: async function* () {
        yield 'ab';
        yield 'cd';
      },
    });
    new WorkflowsRepository(db).insert({
      id: 'w-tokens',
      projectId: 'p1',
      name: 'w-tokens',
      nodes: [{ id: 'gen', type: 'generate.dialogue', position: { x: 0, y: 0 }, params: {} }],
      edges: [],
      version: 1,
    });
    const engine = new WorkflowEngine(reg, db, new EventBus());
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-tokens' });
    expect(engine.getRun(runId)!.outputs['gen']).toEqual({ text: 'abcd' });
  });
});
