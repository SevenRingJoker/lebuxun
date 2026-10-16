/** 谱系追踪单测（task 4.5）：3 代谱系树组装（含每代 satisfaction/avgScore/策略） */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import { buildLineageFromDb, buildLineageTree } from './candidate-lineage.js';

let db: AppDatabase;

function sixDim(v: number) {
  return { pacing: v, character: v, consistency: v, profileFit: v, styleSimilarity: v, rewardScore: v };
}

function cand(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    runId: 'run-1',
    nodeId: 'n1',
    index: 0,
    text: `正文-${id}`,
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
  db.prepare(
    "INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES ('p1', '测试', '仙侠', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO workflows (id, project_id, name, graph, version, updated_at) VALUES ('w1', 'p1', 'wf', '{}', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO runs (id, workflow_id, status, created_at, updated_at) VALUES ('run-1', 'w1', 'running', 1, 1)",
  ).run();
});

describe('buildLineageTree / buildLineageFromDb', () => {
  it('3 代谱系组装正确（A → B → C，B 另有兄弟 B2）', () => {
    const repo = new CandidatesRepository(db);
    repo.insert(cand('A', { satisfaction: 'unsatisfied', scores: sixDim(0.4) }));
    repo.insert(
      cand('B', {
        index: 1,
        parentCandidateId: 'A',
        generationMode: 'improve',
        generationDepth: 1,
        lineage: ['A'],
        satisfaction: 'satisfied',
        scores: sixDim(0.8),
        strategy: { label: '平衡', temperature: 0.7 },
      }),
    );
    repo.insert(
      cand('B2', { index: 2, parentCandidateId: 'A', generationMode: 'variant', generationDepth: 1, lineage: ['A'] }),
    );
    repo.insert(
      cand('C', {
        index: 3,
        parentCandidateId: 'B',
        generationMode: 'improve',
        generationDepth: 2,
        lineage: ['A', 'B'],
        scores: sixDim(0.9),
      }),
    );

    const tree = buildLineageFromDb(db, 'run-1', 'A')!;
    expect(tree.candidate.id).toBe('A');
    expect(tree.avgScore).toBeCloseTo(0.4);
    expect(tree.children.map((n) => n.candidate.id)).toEqual(['B', 'B2']);

    const b = tree.children[0]!;
    expect(b.candidate.satisfaction).toBe('satisfied');
    expect(b.candidate.strategy.label).toBe('平衡');
    expect(b.avgScore).toBeCloseTo(0.8);
    expect(b.children).toHaveLength(1);

    const c = b.children[0]!;
    expect(c.candidate.id).toBe('C');
    expect(c.candidate.generationDepth).toBe(2);
    expect(c.avgScore).toBeCloseTo(0.9);
    expect(c.children).toHaveLength(0);
  });

  it('叶子节点（无子）树只有根；未知 id 返回 undefined', () => {
    const repo = new CandidatesRepository(db);
    repo.insert(cand('A'));
    const tree = buildLineageTree(repo.listByRun('run-1'), 'A')!;
    expect(tree.children).toEqual([]);
    expect(buildLineageTree(repo.listByRun('run-1'), 'missing')).toBeUndefined();
  });
});
