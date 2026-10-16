/** 成长系统单测（task 4.6 偏好采集 / 4.7 理由推断 / 4.8 画像更新 + growth:stats 聚合） */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import { GrowthStatsRepository } from '../db/repositories/growth-stats.js';
import { PreferenceSamplesRepository } from '../db/repositories/preference-samples.js';
import { PreferenceCollector } from './preference-collector.js';
import { applyReasons, emptyProfile } from './profile-updater.js';
import { inferReasons } from './reason-inference.js';
import { aggregateGrowthStats } from './stats.js';

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

describe('4.7 inferReasons（软标签）', () => {
  it('文风一致性显著低 → 软标签 style（inferred=true）', () => {
    const chosen = sixDim(0.8);
    const rejected = { ...sixDim(0.7), consistency: 0.3 };
    const reasons = inferReasons(chosen, rejected);
    expect(reasons).toContainEqual({ tag: 'style', inferred: true });
    expect(reasons.every((r) => r.inferred)).toBe(true);
  });

  it('无显著差异 → 空；pacing 差 → pacing 标签', () => {
    expect(inferReasons(sixDim(0.5), sixDim(0.5))).toEqual([]);
    const reasons = inferReasons({ ...sixDim(0.5), pacing: 0.9 }, sixDim(0.5));
    expect(reasons[0]).toEqual({ tag: 'pacing', inferred: true });
  });
});

describe('4.8 画像更新（EMA）', () => {
  it('多条「人设准」样本 → character_fidelity 维度上升', () => {
    let profile = emptyProfile();
    expect(profile.dimensions['character_fidelity']).toBe(0.5);
    for (let i = 0; i < 3; i++) {
      profile = applyReasons(profile, [[{ tag: '人设准', inferred: false }]], 1);
    }
    expect(profile.dimensions['character_fidelity']!).toBeGreaterThan(0.8);
    expect(profile.totalSamples).toBe(3);
    // 未触及维度保持 0.5
    expect(profile.dimensions['tension']).toBe(0.5);
  });

  it('「节奏太快」→ pacing 下降', () => {
    const profile = applyReasons(emptyProfile(), [[{ tag: '节奏太快', inferred: false }]], 1);
    expect(profile.dimensions['pacing']!).toBeLessThan(0.5);
  });
});

describe('4.6 PreferenceCollector（成对样本）', () => {
  it('choose A + B 不满意 → 样本落库字段正确', () => {
    const repo = new CandidatesRepository(db);
    repo.insert(cand('A', { satisfaction: 'satisfied', text: 'A 正文' }));
    repo.insert(
      cand('B', { index: 1, satisfaction: 'unsatisfied', satisfactionTags: ['人设崩'], text: 'B 正文' }),
    );

    const collector = new PreferenceCollector(db);
    const samples = collector.collectOnSelect('run-1', 'n1', 'A');

    expect(samples).toHaveLength(1);
    const s = samples[0]!;
    expect(s.projectId).toBe('p1');
    expect(s.chosen).toBe('A 正文');
    expect(s.rejected).toBe('B 正文');
    expect(s.reasons).toEqual([{ tag: '人设崩', inferred: false }]);
    expect(JSON.parse(s.context)).toMatchObject({ runId: 'run-1', nodeId: 'n1' });

    // 落库可读
    const stored = new PreferenceSamplesRepository(db).listByProject('p1');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.chosen).toBe('A 正文');

    // 画像已更新（人设崩 → character_fidelity 上升）
    const profile = new GrowthStatsRepository(db).getProfile('p1');
    expect(profile.totalSamples).toBe(1);
    expect(profile.dimensions['character_fidelity']!).toBeGreaterThan(0.5);
  });

  it('B 无标签时按六维分数差推断软标签', () => {
    const repo = new CandidatesRepository(db);
    repo.insert(cand('A', { satisfaction: 'satisfied', scores: { ...sixDim(0.5), consistency: 0.9 } }));
    repo.insert(cand('B', { index: 1, satisfaction: 'unsatisfied', scores: sixDim(0.4) }));

    const collector = new PreferenceCollector(db);
    const samples = collector.collectOnSatisfaction('run-1', 'n1', 'A');
    expect(samples).toHaveLength(1);
    expect(samples[0]!.reasons).toContainEqual({ tag: 'style', inferred: true });
  });

  it('满意度不高于对方 → 不生成样本', () => {
    const repo = new CandidatesRepository(db);
    repo.insert(cand('A', { satisfaction: 'unrated' }));
    repo.insert(cand('B', { index: 1, satisfaction: 'unrated' }));
    const collector = new PreferenceCollector(db);
    expect(collector.collectOnSelect('run-1', 'n1', 'A')).toEqual([]);
  });
});

describe('growth:stats 聚合', () => {
  it('聚合偏好/满意度维度', () => {
    const repo = new CandidatesRepository(db);
    repo.insert(cand('A', { satisfaction: 'satisfied', selected: 1 } as Partial<Candidate>));
    repo.insert(cand('B', { index: 1, satisfaction: 'unsatisfied', satisfactionTags: ['缺冲突'] }));
    const collector = new PreferenceCollector(db);
    collector.collectOnSelect('run-1', 'n1', 'A');

    const stats = aggregateGrowthStats(db, 'p1');
    expect(stats.preference.totalSamples).toBe(1);
    expect(stats.preference.reasonCoverage).toBe(1);
    expect(stats.preference.dimensions['tension']).toBeGreaterThan(0.5);
    expect(stats.satisfaction.totalMarked).toBe(2);
    expect(stats.satisfaction.satisfiedRate).toBeCloseTo(0.5);
    expect(stats.candidate.avgCandidateCount).toBe(2);
    expect(stats.growthIndex).toBeGreaterThanOrEqual(0);
  });
});
