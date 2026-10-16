/** candidate/growth 域 IPC 单测（task 4.3/4.8）：IPC handler 层覆盖
 *
 * electron 的 ipcMain 被 vi.mock 为内存 handler 表，直接调用 handler，
 * 不启动真实 Electron 进程。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candidate, ChatRequest, StreamEvent } from '@novel-forge/shared';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, req: unknown) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(ch, fn);
    },
  },
}));

import { openDatabase, type AppDatabase } from '../db/index.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import type { LLMGateway } from '../llm/gateway.js';
import { registerCandidateIpc } from './candidate.js';
import { registerGrowthIpc } from './growth.js';

let db: AppDatabase;
let events: StreamEvent[];

function regenLlm(text = '重生成正文'): LLMGateway {
  return {
    collect: (req: ChatRequest) => {
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

function call<T = unknown>(channel: string, req: unknown): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler ${channel} 未注册`);
  return fn(null, req) as Promise<T>;
}

beforeEach(async () => {
  db = await openDatabase(':memory:');
  handlers.clear();
  events = [];
  registerCandidateIpc({ db, llm: regenLlm(), emit: (e: StreamEvent) => events.push(e) });
  registerGrowthIpc({ db });
  seed();
});

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

function sixDim(v: number) {
  return { pacing: v, character: v, consistency: v, profileFit: v, styleSimilarity: v, rewardScore: v };
}

function insertCandidate(overrides: Partial<Candidate> = {}): void {
  new CandidatesRepository(db).insert({
    id: 'c1',
    runId: 'run-1',
    nodeId: 'n1',
    index: 0,
    text: '正文',
    strategy: { label: '稳健', temperature: 0.5 },
    scores: sixDim(0.5),
    satisfaction: 'unrated',
    generationMode: 'fresh',
    generationDepth: 0,
    lineage: [],
    ...overrides,
  });
}

describe('candidate:list / candidate:select / candidate:reject-all', () => {
  it('list 返回 candidates', async () => {
    insertCandidate();
    const res = await call<{ ok: boolean; candidates?: unknown[] }>('candidate:list', {
      runId: 'run-1',
      nodeId: 'n1',
    });
    expect(res.ok).toBe(true);
    expect(res.candidates).toHaveLength(1);
  });

  it('select 标记选中 + 触发偏好采集（样本落库）', async () => {
    insertCandidate({ id: 'A', text: 'A', satisfaction: 'satisfied' });
    insertCandidate({ id: 'B', index: 1, text: 'B', satisfaction: 'unsatisfied', satisfactionTags: ['节奏太快'] });
    const res = await call<{ ok: boolean }>('candidate:select', {
      runId: 'run-1',
      nodeId: 'n1',
      candidateId: 'A',
    });
    expect(res.ok).toBe(true);
    const rows = db
      .prepare('SELECT chosen, rejected, reasons FROM preference_samples WHERE project_id = ?')
      .all('p1') as { chosen: string; rejected: string; reasons: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chosen).toBe('A');
    expect(rows[0]!.rejected).toBe('B');
    expect(JSON.parse(rows[0]!.reasons)).toEqual([{ tag: '节奏太快', inferred: false }]);
  });

  it('select 带 editedText：先回写候选正文再标记选中', async () => {
    insertCandidate({ id: 'c1', text: '原文' });
    const res = await call<{ ok: boolean }>('candidate:select', {
      runId: 'run-1',
      nodeId: 'n1',
      candidateId: 'c1',
      editedText: '改后文',
    });
    expect(res.ok).toBe(true);
    const repo = new CandidatesRepository(db);
    expect(repo.get('c1')!.text).toBe('改后文');
    const row = db.prepare('SELECT selected FROM candidates WHERE id = ?').get('c1') as { selected: number };
    expect(row.selected).toBe(1);
  });

  it('select 不传 editedText：候选正文不变', async () => {
    insertCandidate({ id: 'c1', text: '原文' });
    const res = await call<{ ok: boolean }>('candidate:select', {
      runId: 'run-1',
      nodeId: 'n1',
      candidateId: 'c1',
    });
    expect(res.ok).toBe(true);
    expect(new CandidatesRepository(db).get('c1')!.text).toBe('原文');
  });

  it('select 带 editedText 但候选不存在 → ok:false', async () => {
    const res = await call<{ ok: boolean; error?: string }>('candidate:select', {
      runId: 'run-1',
      nodeId: 'n1',
      candidateId: 'ghost',
      editedText: '改后文',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('候选不存在');
  });

  it('reject-all 标记所有为不满意', async () => {
    insertCandidate();
    insertCandidate({ id: 'c2', index: 1 });
    const res = await call<{ ok: boolean }>('candidate:reject-all', {
      runId: 'run-1',
      nodeId: 'n1',
      reason: '全不满意',
    });
    expect(res.ok).toBe(true);
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM candidates WHERE run_id = 'run-1' AND satisfaction = 'unsatisfied'")
      .get() as { n: number };
    expect(row.n).toBe(2);
  });
});

describe('candidate:satisfy / candidate:dissatisfy / candidate:unmark', () => {
  it('satisfy 持久化 + emit candidate:marked', async () => {
    insertCandidate();
    const res = await call<{ ok: boolean }>('candidate:satisfy', {
      runId: 'run-1',
      nodeId: 'n1',
      candidateId: 'c1',
    });
    expect(res.ok).toBe(true);
    expect(new CandidatesRepository(db).get('c1')!.satisfaction).toBe('satisfied');
    expect(
      events.some((e) => e.type === 'candidate:marked' && e.satisfaction === 'satisfied'),
    ).toBe(true);
  });

  it('dissatisfy 非法 reasonTags → ok:false', async () => {
    insertCandidate();
    const res = await call<{ ok: boolean; error?: string }>('candidate:dissatisfy', {
      runId: 'run-1',
      nodeId: 'n1',
      candidateId: 'c1',
      reasonTags: ['不存在标签'],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('无效标签');
  });

  it('dissatisfy 合法标签：持久化 + 标签计数 + 成对样本', async () => {
    insertCandidate({ id: 'A', text: 'A', satisfaction: 'satisfied' });
    insertCandidate({ id: 'B', index: 1, text: 'B', satisfaction: 'unsatisfied' });
    const res = await call<{ ok: boolean }>('candidate:dissatisfy', {
      runId: 'run-1',
      nodeId: 'n1',
      candidateId: 'B',
      reasonTags: ['缺冲突'],
      reason: '太水',
    });
    expect(res.ok).toBe(true);
    const b = new CandidatesRepository(db).get('B')!;
    expect(b.satisfaction).toBe('unsatisfied');
    expect(b.satisfactionTags).toEqual(['缺冲突']);
    const tagRow = db
      .prepare("SELECT count FROM satisfaction_tags WHERE project_id = 'p1' AND tag = '缺冲突' AND polarity = 'negative'")
      .get() as { count: number };
    expect(tagRow.count).toBe(1);
    const rows = db.prepare('SELECT * FROM preference_samples WHERE project_id = ?').all('p1') as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('unmark 回置 unrated + emit 事件', async () => {
    insertCandidate({ satisfaction: 'unsatisfied' });
    const res = await call<{ ok: boolean }>('candidate:unmark', {
      runId: 'run-1',
      nodeId: 'n1',
      candidateId: 'c1',
    });
    expect(res.ok).toBe(true);
    expect(new CandidatesRepository(db).get('c1')!.satisfaction).toBe('unrated');
    expect(events.some((e) => e.type === 'candidate:marked' && e.satisfaction === 'unrated')).toBe(true);
  });
});

describe('candidate:regenerate-from / candidate:regenerate-similar', () => {
  it('regenerate-from improve：返回新候选 ids，父子关系落库', async () => {
    insertCandidate({ id: 'parent', text: '父正文' });
    const res = await call<{ ok: boolean; newCandidateIds?: string[] }>('candidate:regenerate-from', {
      runId: 'run-1',
      nodeId: 'n1',
      candidateId: 'parent',
      mode: 'improve',
    });
    expect(res.ok).toBe(true);
    expect(res.newCandidateIds).toHaveLength(1);
    const child = new CandidatesRepository(db).get(res.newCandidateIds![0]!)!;
    expect(child.parentCandidateId).toBe('parent');
  });

  it('regenerate-similar：count=2 返回 2 个新候选', async () => {
    insertCandidate({ id: 'seed', text: '种子正文', satisfaction: 'satisfied' });
    const res = await call<{ ok: boolean; newCandidateIds?: string[] }>('candidate:regenerate-similar', {
      runId: 'run-1',
      nodeId: 'n1',
      candidateId: 'seed',
      count: 2,
    });
    expect(res.ok).toBe(true);
    expect(res.newCandidateIds).toHaveLength(2);
  });
});

describe('candidate:prune-unsatisfied + candidate:lineage', () => {
  it('prune 清除不满意并 emit candidate:pruned', async () => {
    insertCandidate({ satisfaction: 'unsatisfied' });
    insertCandidate({ id: 'c2', index: 1, satisfaction: 'satisfied' });
    const res = await call<{ ok: boolean; removed?: number }>('candidate:prune-unsatisfied', {
      runId: 'run-1',
      nodeId: 'n1',
    });
    expect(res.ok).toBe(true);
    expect(res.removed).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM candidates').get() as { n: number }).n).toBe(1);
    expect(events.some((e) => e.type === 'candidate:pruned')).toBe(true);
  });

  it('lineage 返回嵌套谱系树', async () => {
    insertCandidate({ id: 'A', text: 'A' });
    insertCandidate({
      id: 'B',
      index: 1,
      text: 'B',
      generationMode: 'improve',
      generationDepth: 1,
      lineage: ['A'],
      parentCandidateId: 'A',
    });
    const res = await call<{ ok: boolean; lineage?: { candidate: { id: string }; children: unknown[] } }>(
      'candidate:lineage',
      { runId: 'run-1', candidateId: 'A' },
    );
    expect(res.ok).toBe(true);
    expect(res.lineage!.candidate.id).toBe('A');
    expect(res.lineage!.children).toHaveLength(1);
  });
});

describe('growth:stats / growth:profile', () => {
  it('空项目返回零初始化结构', async () => {
    const statsRes = await call<{ ok: boolean; stats?: { preference: { totalSamples: number } } }>(
      'growth:stats',
      { projectId: 'p1' },
    );
    expect(statsRes.ok).toBe(true);
    expect(statsRes.stats!.preference.totalSamples).toBe(0);

    const profileRes = await call<{ ok: boolean; profile?: { dimensions: Record<string, number> } }>(
      'growth:profile',
      { projectId: 'p1' },
    );
    expect(profileRes.ok).toBe(true);
    expect(profileRes.profile!.dimensions['pacing']).toBe(0.5);
  });

  it('样本写入后 stats/profile 反映更新', async () => {
    insertCandidate({ id: 'A', text: 'A', satisfaction: 'satisfied' });
    insertCandidate({ id: 'B', index: 1, text: 'B', satisfaction: 'unsatisfied', satisfactionTags: ['人设崩'] });
    await call('candidate:select', { runId: 'run-1', nodeId: 'n1', candidateId: 'A' });

    const statsRes = await call<{ ok: boolean; stats?: { preference: { totalSamples: number } } }>(
      'growth:stats',
      { projectId: 'p1' },
    );
    expect(statsRes.stats!.preference.totalSamples).toBe(1);
    const profileRes = await call<{ ok: boolean; profile?: { dimensions: Record<string, number>; totalSamples: number } }>(
      'growth:profile',
      { projectId: 'p1' },
    );
    expect(profileRes.profile!.totalSamples).toBe(1);
    expect(profileRes.profile!.dimensions['character_fidelity']!).toBeGreaterThan(0.5);
  });
});

describe('§10.4 Evolution Learner：evolution_patterns 记录', () => {
  function evolutionRows(): { parent_text: string; child_text: string | null; child_texts: string | null; mode: string; outcome: string; diff: string | null }[] {
    return db
      .prepare('SELECT parent_text, child_text, child_texts, mode, outcome, diff FROM evolution_patterns ORDER BY created_at ASC')
      .all() as never[];
  }

  it('select 有父候选 → 记一条 selected pattern（parentText=父文本、diff 计数）', async () => {
    insertCandidate({ id: 'P', text: '第一句。第二句。' });
    insertCandidate({
      id: 'C',
      index: 1,
      text: '第一句。改后第二句。',
      parentCandidateId: 'P',
      generationMode: 'improve',
    });
    const res = await call<{ ok: boolean }>('candidate:select', { runId: 'run-1', nodeId: 'n1', candidateId: 'C' });
    expect(res.ok).toBe(true);
    const rows = evolutionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      parent_text: '第一句。第二句。',
      child_text: '第一句。改后第二句。',
      mode: 'improve',
      outcome: 'selected',
    });
    // 近似口径：句级 LCS 合并后 del/add 段条数（第二句被替换 → 删 1 增 1）
    expect(JSON.parse(rows[0]!.diff!)).toEqual({ removed: 1, added: 1 });
  });

  it('select 无父候选 → 不记录 evolution pattern', async () => {
    insertCandidate({ id: 'A', text: 'A' });
    await call('candidate:select', { runId: 'run-1', nodeId: 'n1', candidateId: 'A' });
    expect(evolutionRows()).toHaveLength(0);
  });

  it('reject-all → 按 parent_candidate_id 分组记 rejected（child_texts），无父候选组跳过', async () => {
    insertCandidate({ id: 'P', text: '父文本' });
    insertCandidate({ id: 'A', index: 1, text: '改进1', parentCandidateId: 'P', generationMode: 'improve' });
    insertCandidate({ id: 'B', index: 2, text: '改进2', parentCandidateId: 'P', generationMode: 'improve' });
    insertCandidate({ id: 'F', index: 3, text: '无父候选' });
    const res = await call<{ ok: boolean }>('candidate:reject-all', { runId: 'run-1', nodeId: 'n1' });
    expect(res.ok).toBe(true);
    const rows = evolutionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ parent_text: '父文本', mode: 'improve', outcome: 'rejected' });
    expect(JSON.parse(rows[0]!.child_texts!)).toEqual(['改进1', '改进2']);
  });

  it('select 带 editedText：child_text 取回写后的正文（记录发生在 updateText 之后）', async () => {
    insertCandidate({ id: 'P', text: '父文本' });
    insertCandidate({ id: 'C', index: 1, text: '原文', parentCandidateId: 'P', generationMode: 'improve' });
    const res = await call<{ ok: boolean }>('candidate:select', {
      runId: 'run-1',
      nodeId: 'n1',
      candidateId: 'C',
      editedText: '改后文',
    });
    expect(res.ok).toBe(true);
    const rows = evolutionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.child_text).toBe('改后文');
  });
});
