/** SPEC §7.1 WorkflowEngine 验收：线性 DAG / pause-resume / 条件边 / 循环 / stop / 步数上限
 *
 * 全部使用测试专用 mock 节点（§7.3 真实节点是 Phase 3 范围）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type {
  NodeType,
  StreamEvent,
  UserAction,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { WorkflowsRepository } from '../db/repositories/workflows.js';
import { NodeRegistry } from '../nodes/registry.js';
import type { NodeDefinition } from '../nodes/types.js';
import { WorkflowEngine, type WorkflowEngineOptions } from './engine.js';
import { loadDefaultWorkflow } from './default-workflow.js';
import { EventBus } from './events.js';

// ---- 测试工具 ----

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
  db.prepare('INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'p1', '测试项目', '仙侠', Date.now(), Date.now(),
  );
  workflows = new WorkflowsRepository(db);
});

function seedWorkflow(id: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return workflows.insert({ id, projectId: 'p1', name: id, nodes, edges, version: 1 });
}

function makeEngine(registry: NodeRegistry, bus: EventBus, options?: WorkflowEngineOptions): WorkflowEngine {
  return new WorkflowEngine(registry, db, bus, options);
}

/** resume 时附带 decision 字段（§9.2 chapter-end 场景）；UserAction 无此字段，测试显式扩展 */
function decideAction(decision: 'continue' | 'end'): UserAction {
  return { type: 'select', candidateId: 'x', decision } as unknown as UserAction;
}

// ---- 1. 线性 DAG ----

describe('线性 DAG（§7.1 验收：5 节点）', () => {
  it('5 节点顺序执行，输出逐节点传递', async () => {
    const seen: string[] = [];
    const inputs: Record<string, unknown> = {};
    const reg = new NodeRegistry();
    const chain: [string, NodeType][] = [
      ['n1', 'input.context'],
      ['n2', 'context.memory'],
      ['n3', 'generate.chapter-plan'],
      ['n4', 'generate.paragraph-multi'],
      ['n5', 'chapter.finalizer'],
    ];
    for (const [id, type] of chain) {
      reg.register(
        mockDef(type, async (_ctx, input) => {
          seen.push(id);
          inputs[id] = input;
          return { out: `from-${id}` };
        }),
      );
    }
    seedWorkflow('w-linear', chain.map(([id, type]) => node(id, type)), [
      edge('e1', ['n1', 'out'], ['n2', 'in']),
      edge('e2', ['n2', 'out'], ['n3', 'in']),
      edge('e3', ['n3', 'out'], ['n4', 'in']),
      edge('e4', ['n4', 'out'], ['n5', 'in']),
    ]);

    const bus = new EventBus();
    const events: StreamEvent[] = [];
    bus.on((e) => events.push(e));
    const engine = makeEngine(reg, bus);

    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-linear' });
    const run = engine.getRun(runId)!;

    expect(run.status).toBe('done');
    expect(seen).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    // 输出逐节点传递：n(k+1) 的 input.in 来自 nk 的 out 端口
    expect(inputs['n2']).toEqual({ in: 'from-n1' });
    expect(inputs['n5']).toEqual({ in: 'from-n4' });
    expect(run.outputs['n3']).toEqual({ out: 'from-n3' });
    // 事件序列：每节点 node-start → node-done
    const seq = events.map((e) => `${e.type}:${'nodeId' in e ? e.nodeId : ''}`);
    expect(seq.filter((s) => s.startsWith('workflow:node-start'))).toHaveLength(5);
    expect(seq.filter((s) => s.startsWith('workflow:node-done'))).toHaveLength(5);
    expect(seq[0]).toBe('workflow:node-start:n1');
    expect(seq[seq.length - 1]).toBe('workflow:node-done:n5');
    // runs 表落库
    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('done');
  });
});

// ---- 2. pause / resume ----

describe('pause/resume（§7.1 验收：人工节点暂停恢复）', () => {
  it('pause 节点暂停 → resume 注入 userAction → 继续到 done', async () => {
    let pickerInput: unknown;
    let accInput: unknown;
    const reg = new NodeRegistry();
    reg.register(mockDef('generate.paragraph-multi', async () => ({ candidates: ['A', 'B'] })));
    reg.register(
      mockDef('review.candidate-picker', async (_ctx, input) => {
        pickerInput = input;
        return { candidates: input['candidates'] };
      }, {
        pause: true,
        onResume: (_ctx, action) => ({
          selected: (action as { candidateId?: string }).candidateId,
        }),
      }),
    );
    reg.register(
      mockDef('chapter.accumulator', async (_ctx, input) => {
        accInput = input;
        return { chapterDraft: `draft+${String(input['selected'])}` };
      }),
    );
    seedWorkflow('w-pause', [
      node('gen', 'generate.paragraph-multi'),
      node('pick', 'review.candidate-picker'),
      node('acc', 'chapter.accumulator'),
    ], [
      edge('e1', ['gen', 'candidates'], ['pick', 'candidates']),
      edge('e2', ['pick', 'selected'], ['acc', 'selected']),
    ]);

    const bus = new EventBus();
    const events: StreamEvent[] = [];
    bus.on((e) => events.push(e));
    const engine = makeEngine(reg, bus);

    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-pause' });
    // 暂停在 pick
    const pausedRun = engine.getRun(runId)!;
    expect(pausedRun.status).toBe('paused');
    expect(pausedRun.currentNodeId).toBe('pick');
    expect(pickerInput).toEqual({ candidates: ['A', 'B'] });
    const pausedEvent = events.find((e) => e.type === 'workflow:node-paused');
    expect(pausedEvent).toMatchObject({ nodeId: 'pick', payload: { candidates: ['A', 'B'] } });
    // 暂停状态落库
    const row = db.prepare('SELECT status, current_node_id FROM runs WHERE id = ?').get(runId) as {
      status: string; current_node_id: string;
    };
    expect(row).toEqual({ status: 'paused', current_node_id: 'pick' });

    // resume：userAction 映射为 selected，继续推进到 done
    await engine.resume({
      runId,
      nodeId: 'pick',
      userAction: { type: 'select', candidateId: 'B' },
    });
    const run = engine.getRun(runId)!;
    expect(run.status).toBe('done');
    expect(run.outputs['pick']).toEqual({ selected: 'B' });
    expect(accInput).toEqual({ selected: 'B' });
    expect(events.some((e) => e.type === 'workflow:node-done' && e.nodeId === 'pick')).toBe(true);
  });

  it('末位 pause 节点 resume 后无出边：直达 done 且返回权威状态（#56）', async () => {
    // pause 节点是图的末位节点：resume 后无节点执行（无 node-start 事件），
    // renderer 旧启发会把状态滞留 paused；引擎现返回稳定态 done 供 IPC 响应携带
    const reg = new NodeRegistry();
    let started = 0;
    reg.register(
      mockDef('review.candidate-picker', async () => ({ selected: null }), {
        pause: true,
        onResume: () => ({ selected: 'A' }),
      }),
    );
    seedWorkflow('w-terminal-pause', [node('pick', 'review.candidate-picker')], []);

    const bus = new EventBus();
    bus.on((e) => {
      if (e.type === 'workflow:node-start') started += 1;
    });
    const engine = makeEngine(reg, bus);
    const { runId, status: startStatus } = await engine.start({ projectId: 'p1', workflowId: 'w-terminal-pause' });
    expect(startStatus).toBe('paused');

    const after = await engine.resume({
      runId,
      nodeId: 'pick',
      userAction: { type: 'select', candidateId: 'A' },
    });
    expect(after).toBe('done');
    expect(engine.getRun(runId)!.status).toBe('done');
    // resume 后确实没有任何节点重新执行
    expect(started).toBe(1);
  });

  it('resume 校验：未暂停 / 节点不匹配均报错', async () => {
    const reg = new NodeRegistry();
    reg.register(mockDef('input.manual', async () => ({ text: 't' })));
    seedWorkflow('w-nopick', [node('n1', 'input.manual')], []);
    const engine = makeEngine(reg, new EventBus());
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-nopick' });
    await expect(
      engine.resume({ runId, nodeId: 'n1', userAction: { type: 'select', candidateId: 'x' } }),
    ).rejects.toThrow(/不是 paused/);
    await expect(engine.resume({ runId: 'nope', nodeId: 'n1', userAction: { type: 'select', candidateId: 'x' } })).rejects.toThrow(/不存在/);
  });
});

// ---- 3. 条件边 ----

describe('条件边（§9.2 { port, equals }）', () => {
  function buildDecisionWorkflow(): { reg: NodeRegistry; hits: string[]; setDecision: (d: string) => void } {
    const hits: string[] = [];
    let decision = 'continue';
    const reg = new NodeRegistry();
    reg.register(mockDef('review.chapter-end', async () => ({ decision }), { pause: false }));
    reg.register(mockDef('generate.dialogue', async () => { hits.push('A'); return { text: 'A' }; }));
    reg.register(mockDef('chapter.finalizer', async () => { hits.push('B'); return { finalChapter: 'B' }; }));
    return { reg, hits, setDecision: (d: string) => { decision = d; } };
  }

  function seedDecisionGraph(): void {
    const e1 = edge('e1', ['dec', 'decision'], ['branchA', 'trigger']);
    e1.condition = { port: 'decision', equals: 'continue' };
    const e2 = edge('e2', ['dec', 'decision'], ['branchB', 'trigger']);
    e2.condition = { port: 'decision', equals: 'end' };
    seedWorkflow('w-cond', [
      node('dec', 'review.chapter-end'),
      node('branchA', 'generate.dialogue'),
      node('branchB', 'chapter.finalizer'),
    ], [e1, e2]);
  }

  it("decision='continue' 走 A 分支", async () => {
    const { reg, hits, setDecision } = buildDecisionWorkflow();
    setDecision('continue');
    seedDecisionGraph();
    const engine = makeEngine(reg, new EventBus());
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-cond' });
    expect(engine.getRun(runId)!.status).toBe('done');
    expect(hits).toEqual(['A']);
  });

  it("decision='end' 走 B 分支", async () => {
    const { reg, hits, setDecision } = buildDecisionWorkflow();
    setDecision('end');
    seedDecisionGraph();
    const engine = makeEngine(reg, new EventBus());
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-cond' });
    expect(engine.getRun(runId)!.status).toBe('done');
    expect(hits).toEqual(['B']);
  });
});

// ---- 4. 循环 ----

describe('循环（§7.1 验收：生成 → 审阅 → 回生成）', () => {
  it('跑 3 轮后经条件边结束，节点执行次数正确', async () => {
    const counts = { gen: 0, review: 0, fin: 0 };
    const reg = new NodeRegistry();
    reg.register(mockDef('generate.paragraph-multi', async () => {
      counts.gen += 1;
      return { candidates: [`v${counts.gen}`] };
    }));
    reg.register(
      mockDef('review.candidate-picker', async (_ctx, input) => {
        counts.review += 1;
        return input;
      }, {
        pause: true,
        onResume: (_ctx, action) => ({
          decision: (action as { decision?: string }).decision,
        }),
      },
    ));
    reg.register(mockDef('chapter.finalizer', async () => {
      counts.fin += 1;
      return { finalChapter: 'done' };
    }));
    reg.register(mockDef('input.manual', async () => ({ text: 'seed' })));
    const eBack = edge('e-back', ['review', 'decision'], ['gen', 'trigger']);
    eBack.condition = { port: 'decision', equals: 'continue' };
    const eEnd = edge('e-end', ['review', 'decision'], ['fin', 'trigger']);
    eEnd.condition = { port: 'decision', equals: 'end' };
    seedWorkflow('w-loop', [
      node('start', 'input.manual'),
      node('gen', 'generate.paragraph-multi'),
      node('review', 'review.candidate-picker'),
      node('fin', 'chapter.finalizer'),
    ], [
      edge('e0', ['start', 'text'], ['gen', 'trigger']),
      edge('e1', ['gen', 'candidates'], ['review', 'candidates']),
      eBack,
      eEnd,
    ]);

    const engine = makeEngine(reg, new EventBus());
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-loop' });
    expect(engine.getRun(runId)!.status).toBe('paused');

    const after1 = await engine.resume({ runId, nodeId: 'review', userAction: decideAction('continue') });
    expect(after1).toBe('paused');
    expect(engine.getRun(runId)!.status).toBe('paused');
    const after2 = await engine.resume({ runId, nodeId: 'review', userAction: decideAction('continue') });
    expect(after2).toBe('paused');
    expect(engine.getRun(runId)!.status).toBe('paused');
    const after3 = await engine.resume({ runId, nodeId: 'review', userAction: decideAction('end') });
    expect(after3).toBe('done');

    const run = engine.getRun(runId)!;
    expect(run.status).toBe('done');
    expect(counts).toEqual({ gen: 3, review: 3, fin: 1 });
    // 循环中输出逐轮覆盖：gen 最终输出是第 3 轮候选
    expect(run.outputs['gen']).toEqual({ candidates: ['v3'] });
  });

  it('maxSteps 防死循环', async () => {
    let count = 0;
    const reg = new NodeRegistry();
    reg.register(mockDef('input.manual', async () => ({ text: 'seed' })));
    reg.register(mockDef('generate.polish', async () => {
      count += 1;
      return { text: `p${count}` };
    }));
    seedWorkflow('w-inf', [node('seed', 'input.manual'), node('loop', 'generate.polish')], [
      edge('e1', ['seed', 'text'], ['loop', 'text']),
      edge('e2', ['loop', 'text'], ['loop', 'text']),
    ]);
    const engine = makeEngine(reg, new EventBus(), { maxSteps: 3 });
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-inf' });
    const run = engine.getRun(runId)!;
    expect(run.status).toBe('error');
    expect(count).toBe(3); // seed 计第 1 步；loop 第 3 次执行后 steps=4 > 3
    const state = db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string };
    expect(JSON.parse(state.state).error).toMatch(/最大步数/);
  });
});

// ---- 4b. 汇聚与就绪门控（#91 多入边重复执行缺陷） ----

describe('多入边汇聚与必需输入就绪（#91）', () => {
  it('多入边节点在同一激活轮只执行一次，且输入齐备', async () => {
    const counts = { a: 0, b: 0, c: 0 };
    let cInput: Record<string, unknown> | undefined;
    const reg = new NodeRegistry();
    reg.register(mockDef('input.manual', async () => ({ text: 'seed' })));
    reg.register(mockDef('generate.dialogue', async () => { counts.a += 1; return { out: 'A' }; }));
    reg.register(mockDef('generate.polish', async () => { counts.b += 1; return { out: 'B' }; }));
    reg.register(
      mockDef(
        'chapter.finalizer',
        async (_ctx, input) => {
          counts.c += 1;
          cInput = input;
          return { finalChapter: 'done' };
        },
        {
          inputs: [
            { name: 'x', required: true },
            { name: 'y', required: true },
          ],
        },
      ),
    );
    // s 同时扇出 a/b，a 与 b 又各自有一条入边汇聚到 c：旧实现会让 c 执行两次
    seedWorkflow('w-join', [
      node('s', 'input.manual'),
      node('a', 'generate.dialogue'),
      node('b', 'generate.polish'),
      node('c', 'chapter.finalizer'),
    ], [
      edge('e1', ['s', 'text'], ['a', 'in']),
      edge('e2', ['s', 'text'], ['b', 'in']),
      edge('e3', ['a', 'out'], ['c', 'x']),
      edge('e4', ['b', 'out'], ['c', 'y']),
    ]);

    const engine = makeEngine(reg, new EventBus());
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-join' });
    expect(engine.getRun(runId)!.status).toBe('done');
    expect(counts).toEqual({ a: 1, b: 1, c: 1 }); // 汇聚后只执行一次
    expect(cInput).toEqual({ x: 'A', y: 'B' }); // 两个上游输出均就位
  });

  it('必需输入未就绪时让位生产者，重排后仍只执行一次', async () => {
    const order: string[] = [];
    let nInput: Record<string, unknown> | undefined;
    let nCount = 0;
    const reg = new NodeRegistry();
    reg.register(mockDef('input.manual', async () => { order.push('s'); return { text: 'seed' }; }));
    reg.register(mockDef('generate.dialogue', async () => { order.push('p'); return { out: 'P' }; }));
    reg.register(
      mockDef(
        'chapter.finalizer',
        async (_ctx, input) => {
          order.push('n');
          nCount += 1;
          nInput = input;
          return { finalChapter: 'done' };
        },
        {
          inputs: [
            { name: 'x', required: true },
            { name: 'y', required: true },
          ],
        },
      ),
    );
    // s 的出边顺序为 [s→n, s→p]：n 先入队但其必需输入 y 尚由 p 生产，需重排等待
    seedWorkflow('w-ready', [
      node('s', 'input.manual'),
      node('p', 'generate.dialogue'),
      node('n', 'chapter.finalizer'),
    ], [
      edge('e1', ['s', 'text'], ['n', 'x']),
      edge('e2', ['s', 'text'], ['p', 'in']),
      edge('e3', ['p', 'out'], ['n', 'y']),
    ]);

    const engine = makeEngine(reg, new EventBus());
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-ready' });
    expect(engine.getRun(runId)!.status).toBe('done');
    expect(nCount).toBe(1); // 重排后不重复执行
    expect(order).toEqual(['s', 'p', 'n']); // n 等到 p 完成才执行
    expect(nInput).toEqual({ x: 'seed', y: 'P' });
  });

  it('required 端口在图中未连入边时不门控（兼容旧版/自定义工作流）', async () => {
    const order: string[] = [];
    let nInput: Record<string, unknown> | undefined;
    const reg = new NodeRegistry();
    reg.register(mockDef('input.manual', async () => { order.push('s'); return { text: 'seed' }; }));
    reg.register(
      mockDef(
        'chapter.finalizer',
        async (_ctx, input) => { order.push('n'); nInput = input; return { finalChapter: 'done' }; },
        {
          // x 连线且必需；y 标记 required 但图中无入边（如旧版图没有 rag 节点）→ 不阻塞
          inputs: [
            { name: 'x', required: true },
            { name: 'y', required: true },
          ],
        },
      ),
    );
    seedWorkflow('w-unwired', [
      node('s', 'input.manual'),
      node('n', 'chapter.finalizer'),
    ], [
      edge('e1', ['s', 'text'], ['n', 'x']),
    ]);

    const engine = makeEngine(reg, new EventBus());
    const { runId, status } = await engine.start({ projectId: 'p1', workflowId: 'w-unwired' });
    expect(status).toBe('done');
    expect(engine.getRun(runId)!.status).toBe('done'); // 旧语义会误判死锁 → error
    expect(order).toEqual(['s', 'n']);
    expect(nInput).toEqual({ x: 'seed' });
  });
});

// ---- 6. 真实 main-loop.json 拓扑（#91 汇聚回归） ----

describe('main-loop.json 真实拓扑（#91 多入边重复执行回归）', () => {
  it('章级循环下多入边节点每轮只执行一次（plan/gen 不重复）', async () => {
    const graph = loadDefaultWorkflow();
    const counts: Record<string, number> = {};
    const reg = new NodeRegistry();

    // 逐 type 注册 mock；inputs 的 required 标记与 §7.3 真实节点定义一致（就绪门控依赖它）
    const defs: [NodeType, Partial<NodeDefinition>, NodeDefinition['execute']][] = [
      ['input.context', { inputs: [], outputs: [{ name: 'context' }] }, async () => ({ context: { prompt: 'p' } })],
      ['context.memory', { inputs: [{ name: 'context', required: true }], outputs: [{ name: 'memory' }] }, async () => ({ memory: { hits: [] } })],
      ['context.style', { inputs: [{ name: 'context' }], outputs: [{ name: 'stylePrompt' }] }, async () => ({ stylePrompt: 'sp' })],
      ['generate.chapter-plan', { inputs: [{ name: 'context', required: true }, { name: 'memory' }], outputs: [{ name: 'plan' }] }, async () => ({ plan: { title: 't' } })],
      ['style.rag-retrieve', { inputs: [{ name: 'plan', required: true }], outputs: [{ name: 'fewshot' }, { name: 'plan' }] }, async (_ctx, input) => ({ fewshot: [], plan: input['plan'] })],
      ['generate.paragraph-multi', { inputs: [{ name: 'plan', required: true }, { name: 'memory' }, { name: 'stylePrompt' }, { name: 'fewshot', required: true }], outputs: [{ name: 'candidates' }] }, async () => ({ candidates: [] })],
      ['style.discriminator', { inputs: [{ name: 'candidates', required: true }], outputs: [{ name: 'scored' }] }, async () => ({ scored: [] })],
      ['chapter.accumulator', { inputs: [{ name: 'selected', required: true }], outputs: [{ name: 'chapterDraft' }] }, async () => ({ chapterDraft: { paragraphs: [] } })],
      ['chapter.finalizer', { inputs: [{ name: 'chapterDraft', required: true }], outputs: [{ name: 'memoryUpdate' }] }, async () => ({ memoryUpdate: {} })],
      ['memory.updater', { inputs: [{ name: 'memoryUpdate', required: true }], outputs: [{ name: 'memory' }] }, async () => ({ memory: {} })],
      ['chapter.next-starter', { inputs: [{ name: 'memory', required: true }], outputs: [{ name: 'context' }] }, async () => ({ context: { chapterIndex: 2 } })],
    ];
    for (const [type, extra, exec] of defs) {
      // 包装计数：按 ctx.nodeId 累加（main-loop 中 id 与 type 一一对应）
      reg.register(
        mockDef(type, (ctx, input) => {
          counts[ctx.nodeId] = (counts[ctx.nodeId] ?? 0) + 1;
          return exec(ctx, input);
        }, extra),
      );
    }
    // 两个 pause 节点单独注册（带 onResume）
    reg.register(
      mockDef('review.candidate-picker', async (ctx) => {
        counts[ctx.nodeId] = (counts[ctx.nodeId] ?? 0) + 1;
        return { candidates: [] };
      }, {
        inputs: [{ name: 'candidates', required: true }],
        outputs: [{ name: 'selected' }],
        pause: true,
        onResume: () => ({ selected: null }),
      }),
    );
    reg.register(
      mockDef('review.chapter-end', async (ctx) => {
        counts[ctx.nodeId] = (counts[ctx.nodeId] ?? 0) + 1;
        return { chapterDraft: { paragraphs: [] } };
      }, {
        inputs: [{ name: 'chapterDraft', required: true }],
        outputs: [{ name: 'decision' }, { name: 'chapterDraft' }],
        pause: true,
        onResume: (_ctx, action) => ({
          decision: (action as { decision?: string }).decision,
          chapterDraft: { paragraphs: [] },
        }),
      }),
    );

    seedWorkflow('w-mainloop', graph.nodes, graph.edges);
    const engine = makeEngine(reg, new EventBus());
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-mainloop' });

    // 第 1 章启动阶段：停在 pick；旧实现 plan×2、gen×4
    const run = engine.getRun(runId)!;
    expect(run.status).toBe('paused');
    expect(run.currentNodeId).toBe('pick');
    expect(counts).toEqual({ ctx: 1, mem: 1, style: 1, plan: 1, rag: 1, gen: 1, disc: 1, pick: 1 });

    // 选中并继续：写第 2 段（acc → endq 暂停）
    await engine.resume({ runId, nodeId: 'pick', userAction: { type: 'select', candidateId: 'x' } });
    expect(engine.getRun(runId)!.currentNodeId).toBe('endq');
    expect(counts['acc']).toBe(1);

    // 继续写：endq 回边驱动 gen 再跑 1 次（属新激活轮，不算重复）
    await engine.resume({ runId, nodeId: 'endq', userAction: decideAction('continue') });
    expect(engine.getRun(runId)!.currentNodeId).toBe('pick');
    expect(counts['gen']).toBe(2);
    expect(counts['plan']).toBe(1); // 继续写不重跑 plan
    expect(counts['rag']).toBe(1); // few-shot 章级检索，段落循环不重跑 rag

    // 结束本章：fin → memup → next → 第 2 章 plan；每章 plan/gen 各只执行一次
    await engine.resume({ runId, nodeId: 'pick', userAction: { type: 'select', candidateId: 'x' } });
    await engine.resume({ runId, nodeId: 'endq', userAction: decideAction('end') });
    expect(engine.getRun(runId)!.currentNodeId).toBe('pick');
    expect(counts['fin']).toBe(1);
    expect(counts['memup']).toBe(1);
    expect(counts['next']).toBe(1);
    expect(counts['plan']).toBe(2);
    expect(counts['rag']).toBe(2); // 新章 plan 重跑后 rag 随之重跑一次
    expect(counts['gen']).toBe(3);

    await engine.stop(runId);
    expect(engine.getRun(runId)!.status).toBe('error');
  });
});

// ---- 5. stop / requestPause ----

describe('stop 与 requestPause', () => {
  it('stop() 中断运行：当前节点完成后不再推进，后续节点不执行', async () => {
    const hits: string[] = [];
    const reg = new NodeRegistry();
    reg.register(mockDef('input.manual', async () => { hits.push('n1'); return { text: 't' }; }));
    reg.register(mockDef('generate.polish', async () => { hits.push('n2'); return { text: 'p' }; }));
    seedWorkflow('w-stop', [node('n1', 'input.manual'), node('n2', 'generate.polish')], [
      edge('e1', ['n1', 'text'], ['n2', 'text']),
    ]);

    const bus = new EventBus();
    const engine = makeEngine(reg, bus);
    bus.on((e) => {
      if (e.type === 'workflow:node-start' && e.nodeId === 'n1') {
        void engine.stop(e.runId);
      }
    });
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-stop' });
    const run = engine.getRun(runId)!;
    expect(run.status).toBe('error');
    expect(hits).toEqual(['n1']); // n2 未执行
    const state = db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string };
    expect(JSON.parse(state.state).error).toBe('stopped by user');
  });

  it('requestPause：当前节点完成后挂起，resume 后继续', async () => {
    const hits: string[] = [];
    const reg = new NodeRegistry();
    reg.register(mockDef('input.manual', async () => { hits.push('n1'); return { text: 't' }; }));
    reg.register(mockDef('generate.polish', async () => { hits.push('n2'); return { text: 'p' }; }));
    seedWorkflow('w-rpause', [node('n1', 'input.manual'), node('n2', 'generate.polish')], [
      edge('e1', ['n1', 'text'], ['n2', 'text']),
    ]);

    const bus = new EventBus();
    const engine = makeEngine(reg, bus);
    bus.on((e) => {
      if (e.type === 'workflow:node-start' && e.nodeId === 'n1') {
        engine.requestPause(e.runId);
      }
    });
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-rpause' });
    expect(engine.getRun(runId)!.status).toBe('paused');
    expect(hits).toEqual(['n1']); // n1 完成后挂起，n2 未执行

    await engine.resume({ runId, nodeId: 'n1', userAction: { type: 'select', candidateId: 'x' } });
    expect(engine.getRun(runId)!.status).toBe('done');
    expect(hits).toEqual(['n1', 'n2']);
  });
});
