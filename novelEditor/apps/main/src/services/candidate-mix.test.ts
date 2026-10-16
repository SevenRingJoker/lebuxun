/** candidate-mix（SPEC §15「混合选」句级合并）单测：多源 span 合并 / 越界容错 / 空 sources 抛错 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import { composeMixText } from './candidate-mix.js';

let db: AppDatabase;

function fakeCandidate(id: string, text: string): Candidate {
  return {
    id,
    runId: 'r1',
    nodeId: 'n1',
    index: 0,
    text,
    strategy: { label: '平衡', temperature: 0.7 },
    scores: {
      pacing: 0.5,
      character: 0.5,
      consistency: 0.5,
      profileFit: 0.5,
      styleSimilarity: 0.5,
      rewardScore: 0.5,
    },
    satisfaction: 'unrated',
    generationMode: 'fresh',
    generationDepth: 0,
    lineage: [],
  };
}

beforeEach(async () => {
  db = await openDatabase(':memory:');
  db.prepare('INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'p1',
    '测试项目',
    '仙侠',
    Date.now(),
    Date.now(),
  );
  db.prepare(
    "INSERT INTO workflows (id, project_id, name, graph, version, updated_at) VALUES ('w1', 'p1', 'wf', '{}', 1, ?)",
  ).run(Date.now());
  db.prepare(
    "INSERT INTO runs (id, workflow_id, status, created_at, updated_at) VALUES ('r1', 'w1', 'running', ?, ?)",
  ).run(Date.now(), Date.now());
  const repo = new CandidatesRepository(db);
  repo.insert(fakeCandidate('c1', 'ABCDEF'));
  repo.insert(fakeCandidate('c2', '123456'));
});

describe('composeMixText（§15 混合选）', () => {
  it('多源 span 合并：按 sources 顺序截取 [start,end) 片段，换行拼接', () => {
    const text = composeMixText(db, [
      { candidateId: 'c1', span: [1, 4] },
      { candidateId: 'c2', span: [0, 3] },
      { candidateId: 'c1', span: [4, 6] },
    ]);
    expect(text).toBe('BCD\n123\nEF');
  });

  it('越界/倒置/空片段/候选不存在：忽略该段，其余照常合并', () => {
    const text = composeMixText(db, [
      { candidateId: 'c1', span: [-1, 2] }, // start 越界
      { candidateId: 'c1', span: [2, 99] }, // end 越界
      { candidateId: 'c1', span: [3, 3] }, // 空片段
      { candidateId: 'c1', span: [4, 2] }, // 倒置
      { candidateId: 'ghost', span: [0, 2] }, // 候选不存在
      { candidateId: 'c2', span: [3, 6] },
    ]);
    expect(text).toBe('456');
  });

  it('空 sources 抛错', () => {
    expect(() => composeMixText(db, [])).toThrow(/sources 不能为空/);
  });
});
