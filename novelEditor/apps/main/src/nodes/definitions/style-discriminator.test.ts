/** style.discriminator 单测：打分写回 scores.styleSimilarity + 落库 / 异常透传 / 无 styleId 透传 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../../db/index.js';
import { CandidatesRepository } from '../../db/repositories/candidates.js';
import { styleDiscriminatorNode } from './style-discriminator.js';
import { makeCtx, mockSidecar, seedProject, seedRun } from './test-helpers.js';

let db: AppDatabase;

function sixDim(v: number) {
  return { pacing: v, character: v, consistency: v, profileFit: v, styleSimilarity: v, rewardScore: v };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c1',
    runId: 'run-1',
    nodeId: 'n1',
    index: 0,
    text: '候选正文',
    strategy: { label: '稳健', temperature: 0.5 },
    scores: sixDim(0.5),
    satisfaction: 'unrated',
    generationMode: 'fresh',
    generationDepth: 0,
    lineage: [],
    ...overrides,
  };
}

beforeEach(async () => {
  db = await openDatabase(':memory:');
  seedProject(db);
  seedRun(db);
});

describe('style.discriminator', () => {
  it('正常路径：styleSimilarity 写回输出与 candidates 表', async () => {
    const repo = new CandidatesRepository(db);
    repo.insert(makeCandidate({ id: 'c1' }));
    repo.insert(makeCandidate({ id: 'c2', index: 1, text: '候选二' }));

    const sidecar = mockSidecar({
      discriminatorScore: (req: { styleId: string; text: string }) =>
        Promise.resolve({ score: req.text === '候选正文' ? 0.91 : 0.32, verdict: 'ok' }),
    });
    const { ctx } = makeCtx(db, { sidecar, params: { styleId: 's1' }, nodeType: 'style.discriminator' });

    const out = (await styleDiscriminatorNode.execute(ctx, {
      candidates: [repo.get('c1')!, repo.get('c2')!],
    })) as { scored: Candidate[] };

    expect(out.scored.map((c) => c.scores.styleSimilarity)).toEqual([0.91, 0.32]);
    // 其他维度不受影响
    expect(out.scored[0]!.scores.pacing).toBe(0.5);
    // 落库
    expect(repo.get('c1')!.scores.styleSimilarity).toBe(0.91);
    expect(repo.get('c2')!.scores.styleSimilarity).toBe(0.32);
  });

  it('降级：单个候选打分失败原样保留，其余正常', async () => {
    const repo = new CandidatesRepository(db);
    repo.insert(makeCandidate({ id: 'c1' }));
    repo.insert(makeCandidate({ id: 'c2', index: 1, text: '炸' }));

    const sidecar = mockSidecar({
      discriminatorScore: (req: { styleId: string; text: string }) =>
        req.text === '炸' ? Promise.reject(new Error('判别器超时')) : Promise.resolve({ score: 0.88, verdict: 'ok' }),
    });
    const { ctx, logs } = makeCtx(db, { sidecar, params: { styleId: 's1' }, nodeType: 'style.discriminator' });

    const out = (await styleDiscriminatorNode.execute(ctx, {
      candidates: [repo.get('c1')!, repo.get('c2')!],
    })) as { scored: Candidate[] };

    expect(out.scored[0]!.scores.styleSimilarity).toBe(0.88);
    expect(out.scored[1]!.scores.styleSimilarity).toBe(0.5); // 原分保留
    expect(logs.some((l) => l.includes('风格判别失败'))).toBe(true);
  });

  it('无 styleId 且无风格档案 → 全部原样透传；无 sidecar → 透传', async () => {
    const candidates = [makeCandidate({ id: 'c1' })];

    const { ctx: ctxNoStyle } = makeCtx(db, {
      sidecar: mockSidecar(),
      params: {},
      nodeType: 'style.discriminator',
    });
    const out1 = (await styleDiscriminatorNode.execute(ctxNoStyle, { candidates })) as {
      scored: Candidate[];
    };
    expect(out1.scored).toEqual(candidates);

    const { ctx: ctxNoSidecar } = makeCtx(db, { params: { styleId: 's1' }, nodeType: 'style.discriminator' });
    const out2 = (await styleDiscriminatorNode.execute(ctxNoSidecar, { candidates })) as {
      scored: Candidate[];
    };
    expect(out2.scored).toEqual(candidates);
  });

  it('输出键名为 scored（与 main-loop.json e9 边一致）', async () => {
    const { ctx } = makeCtx(db, { params: {}, nodeType: 'style.discriminator' });
    const out = (await styleDiscriminatorNode.execute(ctx, { candidates: [] })) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['scored']);
  });
});
