/** Phase 3 集成冒烟（任务书验收 4）：
 * main-loop 简版 DAG：input.context → generate.chapter-plan → generate.paragraph-multi(N=2)
 *   → review.candidate-picker（pause，resume selected）→ chapter.accumulator
 *   → review.chapter-end（pause，resume decision=end）→ chapter.finalizer
 *   → memory.updater → chapter.next-starter
 * LLM 经真实 LLMGateway + mock provider（禁止连真实 Ollama）；sidecar mock。
 * 断言：chapters 表有正文（word_count>0）且 summary 非空，memory_chunks 有章节摘要。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Candidate,
  ChatChunk,
  ChatRequest,
  UserAction,
  WorkflowEdge,
  WorkflowNode,
} from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { ChaptersRepository } from '../db/repositories/chapters.js';
import { MemoryChunksRepository } from '../db/repositories/memory-chunks.js';
import { WorkflowsRepository } from '../db/repositories/workflows.js';
import { LLMGateway, type LLMProvider } from '../llm/gateway.js';
import { registerBuiltinNodes } from '../nodes/definitions/index.js';
import { NodeRegistry } from '../nodes/registry.js';
import type { SidecarClient } from '../sidecar/client.js';
import { WorkflowEngine } from './engine.js';
import { EventBus } from './events.js';

/** mock provider：按 prompt 内容路由响应（规划/段落/rank/定稿） */
function makeMockProvider(): LLMProvider {
  let paragraphCall = 0;
  const paragraphTexts = ['林尘踏着晨露下山，山风清爽。', '林尘回头望了一眼宗门，毅然下山。'];
  return {
    name: 'mock',
    async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
      const user = req.messages[req.messages.length - 1]!.content;
      let text: string;
      if (user.includes('规划本章大纲')) {
        text = JSON.stringify({
          title: '出山',
          goal: '引出主角',
          conflict: '宗门任务',
          hook: '山下有妖',
          estimatedParagraphs: 3,
          keyBeats: ['下山'],
        });
      } else if (user.includes('六个维度打')) {
        // §9.4 六维打分：候选 2 综合更高
        text = JSON.stringify({
          candidates: [
            { pacing: 0.6, character: 0.6, consistency: 0.6, profileFit: 0.6, styleSimilarity: 0.6, rewardScore: 0.6 },
            { pacing: 0.8, character: 0.8, consistency: 0.8, profileFit: 0.8, styleSimilarity: 0.8, rewardScore: 0.8 },
          ],
        });
      } else if (user.includes('请给出 JSON')) {
        text = JSON.stringify({ title: '出山', summary: '林尘下山，踏出历练第一步。' });
      } else {
        text = paragraphTexts[paragraphCall % paragraphTexts.length]!;
        paragraphCall += 1;
      }
      yield { delta: text, finishReason: 'stop' };
    },
    embed: () => Promise.resolve([[0.1, 0.2]]),
  };
}

function node(id: string, type: WorkflowNode['type'], params: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, params };
}

function edge(id: string, source: [string, string], target: [string, string]): WorkflowEdge {
  return { id, source: { nodeId: source[0], port: source[1] }, target: { nodeId: target[0], port: target[1] } };
}

let db: AppDatabase;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  db.prepare('INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'p1',
    '九州传',
    '仙侠',
    Date.now(),
    Date.now(),
  );
});

describe('Phase 3 主循环冒烟（mock LLM provider）', () => {
  it('端到端：context→plan→gen→pick→acc→endq→fin→memup→next，章节定稿 + 摘要落库', async () => {
    const workflows = new WorkflowsRepository(db);
    workflows.insert({
      id: 'w-smoke',
      projectId: 'p1',
      name: '冒烟',
      version: 1,
      nodes: [
        node('ctx', 'input.context', {
          worldSetting: '九州大陆，修仙者林立',
          characters: ['林尘：主角'],
          userInput: '写主角下山',
        }),
        node('plan', 'generate.chapter-plan'),
        node('gen', 'generate.paragraph-multi', { candidateCount: 2 }),
        node('pick', 'review.candidate-picker'),
        node('acc', 'chapter.accumulator'),
        node('endq', 'review.chapter-end'),
        node('fin', 'chapter.finalizer'),
        node('memup', 'memory.updater'),
        node('next', 'chapter.next-starter'),
      ],
      edges: [
        edge('e1', ['ctx', 'context'], ['plan', 'context']),
        edge('e2', ['plan', 'plan'], ['gen', 'plan']),
        edge('e3', ['gen', 'candidates'], ['pick', 'candidates']),
        edge('e4', ['pick', 'selected'], ['acc', 'selected']),
        edge('e5', ['acc', 'chapterDraft'], ['endq', 'chapterDraft']),
        (() => {
          const e = edge('e6', ['endq', 'chapterDraft'], ['fin', 'chapterDraft']);
          e.condition = { port: 'decision', equals: 'end' };
          return e;
        })(),
        edge('e7', ['fin', 'memoryUpdate'], ['memup', 'memoryUpdate']),
        edge('e8', ['memup', 'memory'], ['next', 'memory']),
      ],
    });

    const gateway = new LLMGateway();
    gateway.registerProvider('mock', makeMockProvider());
    const sidecar = { ragIndex: () => Promise.resolve({ ok: true, count: 1 }) } as unknown as SidecarClient;

    const registry = new NodeRegistry();
    registerBuiltinNodes(registry);
    const engine = new WorkflowEngine(registry, db, new EventBus(), { llm: gateway, sidecar });

    // start → 应在 pick 暂停
    const { runId } = await engine.start({ projectId: 'p1', workflowId: 'w-smoke' });
    const paused = engine.getRun(runId)!;
    expect(paused.status).toBe('paused');
    expect(paused.currentNodeId).toBe('pick');

    // resume：选中 rank 分最高的候选
    const candidates = paused.outputs['gen']!['candidates'] as Candidate[];
    expect(candidates).toHaveLength(2);
    await engine.resume({
      runId,
      nodeId: 'pick',
      userAction: { type: 'select', candidateId: candidates[0]!.id },
    });

    // 应在 endq 暂停
    const paused2 = engine.getRun(runId)!;
    expect(paused2.status).toBe('paused');
    expect(paused2.currentNodeId).toBe('endq');

    // resume：结束本章
    await engine.resume({
      runId,
      nodeId: 'endq',
      userAction: { type: 'select', candidateId: 'x', decision: 'end' } as unknown as UserAction,
    });

    const run = engine.getRun(runId)!;
    expect(run.status).toBe('done');

    // 验收断言：chapters 表有正文且 summary 非空
    const chapters = new ChaptersRepository(db).listByProject('p1');
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.status).toBe('draft');
    expect(chapters[0]!.wordCount).toBeGreaterThan(0);
    expect(chapters[0]!.summary).toBeTruthy();
    expect(chapters[0]!.title).toBe('出山');

    // memory_chunks 有章节摘要；下一章 context 产出
    const chunks = new MemoryChunksRepository(db).listRecent('p1', 10);
    expect(chunks).toHaveLength(1);
    expect(run.outputs['next']!['context']).toMatchObject({ chapterIndex: 2 });
  });
});
