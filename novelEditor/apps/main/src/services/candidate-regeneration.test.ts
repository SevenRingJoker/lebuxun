/** 定向重生成单测（task 4.4 / SPEC §9.4）
 *
 * - improve：1 个候选，prompt 带「在保持情节不变的前提下改进以下方面：reasonTags」，
 *   temperature 0.5，parent_candidate_id/depth/lineage 落库，candidate_lineage 记录
 * - variant：3 个候选，prompt 换风格轴指令，父子关系落库
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate, ChatRequest, StreamEvent } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import { PromptVersionsRepository } from '../db/repositories/prompt-versions.js';
import { SatisfactionTagsRepository } from '../db/repositories/satisfaction-tags.js';
import type { LLMGateway } from '../llm/gateway.js';
import {
  regenerateFromCandidate,
  regenerateSimilarCandidates,
} from './candidate-regeneration.js';

let db: AppDatabase;

function seed() {
  db.prepare(
    "INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES ('p1', '测试', '仙侠', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO workflows (id, project_id, name, graph, version, updated_at) VALUES ('w1', 'p1', 'wf', '{}', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO runs (id, workflow_id, status, created_at, updated_at) VALUES ('run-1', 'w1', 'running', 1, 1)",
  ).run();
}

function makeParent(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c-parent',
    runId: 'run-1',
    nodeId: 'n1',
    index: 0,
    text: '原候选正文',
    strategy: { label: '平衡', temperature: 0.7, perspective: '外聚焦', pacing: '中', dialogueRatio: '中' },
    scores: { pacing: 0.5, character: 0.5, consistency: 0.5, profileFit: 0.5, styleSimilarity: 0.5, rewardScore: 0.5 },
    satisfaction: 'unrated',
    generationMode: 'fresh',
    generationDepth: 0,
    lineage: [],
    ...overrides,
  };
}

/** mock LLM：rank 请求（含"六个维度"）返回六维 JSON，生成请求返回正文并记录 */
function regenLlm(calls: ChatRequest[], text = '重生成正文'): LLMGateway {
  return {
    collect: (req: ChatRequest) => {
      calls.push(req);
      const user = req.messages[req.messages.length - 1]!.content;
      if (user.includes('六个维度')) {
        return Promise.resolve(
          '{"candidates":[{"pacing":0.6,"character":0.6,"consistency":0.6,"profileFit":0.6,"styleSimilarity":0.6,"rewardScore":0.6}]}',
        );
      }
      return Promise.resolve(text);
    },
  } as unknown as LLMGateway;
}

function deps(calls: ChatRequest[], text?: string) {
  const events: StreamEvent[] = [];
  return {
    d: {
      db,
      llm: regenLlm(calls, text),
      runId: 'run-1',
      nodeId: 'n1',
      emit: (e: StreamEvent) => events.push(e),
      log: () => {},
    },
    events,
  };
}

beforeEach(async () => {
  db = await openDatabase(':memory:');
  seed();
});

describe('regenerateFromCandidate · improve', () => {
  it('prompt 带 reasonTags 改进要求 + parent 关系落库', async () => {
    const repo = new CandidatesRepository(db);
    repo.insert(makeParent({ satisfaction: 'unsatisfied', satisfactionTags: ['节奏太快'] }));
    const calls: ChatRequest[] = [];
    const { d, events } = deps(calls);

    const created = await regenerateFromCandidate(d, { candidateId: 'c-parent', mode: 'improve' });

    expect(created).toHaveLength(1);
    const genCall = calls.find((c) => !c.messages[c.messages.length - 1]!.content.includes('六个维度'))!;
    const userPrompt = genCall.messages[genCall.messages.length - 1]!.content;
    expect(userPrompt).toContain('在保持情节不变的前提下改进以下方面：节奏太快');
    expect(userPrompt).toContain('原候选正文');
    expect(genCall.temperature).toBe(0.5);

    const stored = repo.get(created[0]!.id)!;
    expect(stored.parentCandidateId).toBe('c-parent');
    expect(stored.generationMode).toBe('improve');
    expect(stored.generationDepth).toBe(1);
    expect(stored.lineage).toEqual(['c-parent']);
    expect(stored.index).toBe(1);

    // candidate_lineage 落库
    const lin = db
      .prepare("SELECT * FROM candidate_lineage WHERE parent_id = 'c-parent'")
      .get() as { child_ids: string; mode: string };
    expect(JSON.parse(lin.child_ids)).toEqual([created[0]!.id]);
    expect(lin.mode).toBe('improve');

    // 事件
    expect(events.some((e) => e.type === 'candidate:generated')).toBe(true);
  });

  it('无 reasonTags 时用 hint/默认改进要求', async () => {
    new CandidatesRepository(db).insert(makeParent());
    const calls: ChatRequest[] = [];
    const { d } = deps(calls);
    await regenerateFromCandidate(d, { candidateId: 'c-parent', mode: 'improve', hint: '加强钩子' });
    const userPrompt = calls[0]!.messages[1]!.content;
    expect(userPrompt).toContain('加强钩子');
  });

  // §10.5 Prompt Evolver 产物消费点 + 反模式库（§10.2/验收）
  it('improve 系统 prompt：优先 prompt_versions 演化模板，其后仍追加反模式段', async () => {
    new CandidatesRepository(db).insert(makeParent());
    new PromptVersionsRepository(db).insert({ projectId: 'p1', nodeType: 'improve', content: '演化后的改进提示词' });
    const tags = new SatisfactionTagsRepository(db);
    tags.increment('p1', '节奏太快', 'negative');
    tags.increment('p1', '节奏太快', 'negative');
    const calls: ChatRequest[] = [];
    const { d } = deps(calls);

    await regenerateFromCandidate(d, { candidateId: 'c-parent', mode: 'improve' });

    const genCall = calls.find((c) => !c.messages[c.messages.length - 1]!.content.includes('六个维度'))!;
    const system = genCall.messages[0]!.content;
    expect(system).toContain('演化后的改进提示词');
    expect(system).toContain('以下问题被用户多次标记为不满意，生成时务必避免：');
    expect(system).toContain('- 节奏太快（出现 2 次）');
  });

  it('improve 系统 prompt：无演化模板/反模式时为缺省「你是小说作家。」', async () => {
    new CandidatesRepository(db).insert(makeParent());
    const calls: ChatRequest[] = [];
    const { d } = deps(calls);
    await regenerateFromCandidate(d, { candidateId: 'c-parent', mode: 'improve' });
    const genCall = calls.find((c) => !c.messages[c.messages.length - 1]!.content.includes('六个维度'))!;
    expect(genCall.messages[0]!.content).toBe('你是小说作家。');
  });

  it('variant/similar 不消费演化模板：system prompt 保持缺省', async () => {
    new CandidatesRepository(db).insert(makeParent());
    new PromptVersionsRepository(db).insert({ projectId: 'p1', nodeType: 'improve', content: '演化后的改进提示词' });
    const calls: ChatRequest[] = [];
    const { d } = deps(calls);
    await regenerateFromCandidate(d, { candidateId: 'c-parent', mode: 'variant' });
    const genCalls = calls.filter((c) => !c.messages[c.messages.length - 1]!.content.includes('六个维度'));
    expect(genCalls.length).toBeGreaterThan(0);
    for (const call of genCalls) {
      expect(call.messages[0]!.content).toBe('你是小说作家。');
    }
  });
});

describe('regenerateFromCandidate · variant', () => {
  it('换风格轴：prompt 含新轴指令，3 个候选，父子关系落库', async () => {
    const repo = new CandidatesRepository(db);
    repo.insert(makeParent());
    const calls: ChatRequest[] = [];
    const { d } = deps(calls);

    const created = await regenerateFromCandidate(d, { candidateId: 'c-parent', mode: 'variant' });

    expect(created).toHaveLength(3);
    const genCalls = calls.filter((c) => !c.messages[c.messages.length - 1]!.content.includes('六个维度'));
    expect(genCalls).toHaveLength(3);
    const prompt = genCalls[0]!.messages[1]!.content;
    expect(prompt).toContain('请换一种写作风格重新生成同一段落');
    // 父是「平衡（外聚焦）」，variant 换到不同轴
    expect(prompt).not.toContain('视角：外聚焦');
    expect(genCalls[0]!.temperature).toBe(0.8);

    for (const c of created) {
      const stored = repo.get(c.id)!;
      expect(stored.parentCandidateId).toBe('c-parent');
      expect(stored.generationMode).toBe('variant');
      expect(stored.generationDepth).toBe(1);
    }
    const lin = db
      .prepare("SELECT * FROM candidate_lineage WHERE parent_id = 'c-parent'")
      .get() as { child_ids: string; mode: string };
    expect(JSON.parse(lin.child_ids)).toHaveLength(3);
    expect(lin.mode).toBe('variant');
  });
});

describe('regenerateSimilarCandidates', () => {
  it('count 个相似候选，温度 0.75+i*0.05，父子关系落库', async () => {
    const repo = new CandidatesRepository(db);
    repo.insert(makeParent({ satisfaction: 'satisfied' }));
    const calls: ChatRequest[] = [];
    const { d } = deps(calls);

    const created = await regenerateSimilarCandidates(d, { candidateId: 'c-parent', count: 2 });

    expect(created).toHaveLength(2);
    const genCalls = calls.filter((c) => !c.messages[c.messages.length - 1]!.content.includes('六个维度'));
    expect(genCalls[0]!.temperature).toBeCloseTo(0.75);
    expect(genCalls[1]!.temperature).toBeCloseTo(0.8);
    expect(genCalls[0]!.messages[1]!.content).toContain('保持相同风格、节奏、氛围');
    expect(created.every((c) => c.parentCandidateId === 'c-parent')).toBe(true);
    expect(repo.get(created[0]!.id)).toBeDefined();
  });

  it('父候选不存在抛错', async () => {
    const calls: ChatRequest[] = [];
    const { d } = deps(calls);
    await expect(regenerateFromCandidate(d, { candidateId: 'nope', mode: 'improve' })).rejects.toThrow(
      /父候选不存在/,
    );
  });
});
