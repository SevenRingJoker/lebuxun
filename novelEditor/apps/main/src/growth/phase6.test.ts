/** Phase 6 成长仪表盘单测：stats 真值（rejectAllRate/style/model extras）、
 * 校准一致率、reward/status 缓存降级、画像历史快照、stats JSON 兄弟字段合并 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate, RewardStatusResponse } from '@novel-forge/shared';
import { openDatabase, type AppDatabase } from '../db/index.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import { GrowthStatsRepository, PROFILE_HISTORY_LIMIT } from '../db/repositories/growth-stats.js';
import type { SidecarClient } from '../sidecar/client.js';
import { computeEvaluatorAlignment, listCalibrationPairs } from './calibration.js';
import { emptyProfile } from './profile-updater.js';
import { parseRewardVersion, resolveRewardExtras } from './reward-status.js';
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

describe('GrowthStatsRepository：stats JSON 兄弟字段合并', () => {
  it('saveProfile 不吞 counters/rewardStatusCache；incrementRejectAll 不吞 profile', () => {
    const repo = new GrowthStatsRepository(db);
    const profile = emptyProfile();
    repo.saveProfile('p1', profile);
    repo.incrementRejectAll('p1');
    repo.saveRewardStatusCache('p1', {
      version: 'v2',
      accuracy: 0.7,
      kendallTau: null,
      sampleCount: 10,
      trainedAt: 123,
    });
    // 再次 saveProfile：计数与缓存仍在
    repo.saveProfile('p1', { ...profile, totalSamples: 5 });

    expect(repo.getRejectAllCount('p1')).toBe(1);
    expect(repo.getRewardStatusCache('p1')?.version).toBe('v2');
    expect(repo.getProfile('p1').totalSamples).toBe(5);
    expect(repo.getHistory('p1')).toHaveLength(2);
  });

  it(`history 封顶 ${PROFILE_HISTORY_LIMIT} 条，超出丢最旧`, () => {
    const repo = new GrowthStatsRepository(db);
    const profile = emptyProfile();
    for (let i = 0; i < PROFILE_HISTORY_LIMIT + 5; i += 1) {
      repo.saveProfile('p1', { ...profile, totalSamples: i });
    }
    const history = repo.getHistory('p1');
    expect(history).toHaveLength(PROFILE_HISTORY_LIMIT);
    // 时间升序：最早一条晚于前 5 次写入
    expect(history[0]!.at).toBeLessThanOrEqual(history[PROFILE_HISTORY_LIMIT - 1]!.at);
  });
});

describe('growth:stats Phase 6 真值', () => {
  it('rejectAllRate = 拒全弃次数 / 面板总数；extras 注入 model 段', () => {
    const repo = new CandidatesRepository(db);
    repo.insert(cand('A'));
    repo.insert(cand('B', { index: 1 }));
    const growthRepo = new GrowthStatsRepository(db);
    growthRepo.incrementRejectAll('p1');
    growthRepo.incrementRejectAll('p1');

    const stats = aggregateGrowthStats(db, 'p1', {
      rewardVersion: 3,
      rewardAccuracy: 0.8,
      evaluatorAlignment: 0.6,
    });
    // 1 个面板（run-1/n1），拒全弃 2 次 → 率 2
    expect(stats.candidate.rejectAllRate).toBe(2);
    expect(stats.model).toEqual({ rewardVersion: 3, rewardAccuracy: 0.8, evaluatorAlignment: 0.6 });
  });

  it('无候选时 rejectAllRate=0；extras 缺省 model 段全 0', () => {
    const stats = aggregateGrowthStats(db, 'p1');
    expect(stats.candidate.rejectAllRate).toBe(0);
    expect(stats.model).toEqual({ rewardVersion: 0, rewardAccuracy: 0, evaluatorAlignment: 0 });
    expect(stats.style).toEqual({ avgSimilarity: 0, discriminatorScore: 0 });
  });

  it('style 段：avgSimilarity=全部候选 styleSimilarity 均值，discriminatorScore=选中候选均值', () => {
    const repo = new CandidatesRepository(db);
    repo.insert(cand('A', { scores: { ...sixDim(0.5), styleSimilarity: 0.4 } }));
    repo.insert(cand('B', { index: 1, scores: { ...sixDim(0.5), styleSimilarity: 0.8 } }));
    repo.markSelected('A'); // insert 不落 selected 列，须显式标记
    const stats = aggregateGrowthStats(db, 'p1');
    expect(stats.style.avgSimilarity).toBeCloseTo(0.6);
    expect(stats.style.discriminatorScore).toBeCloseTo(0.4);
  });
});

describe('评估器校准（§14 任务 6.3）', () => {
  it('成对一致率：concordant/discordant/tie 全计入', () => {
    const repo = new CandidatesRepository(db);
    // 满意 reward 0.9/0.8；不满意 0.7/0.9 → 对: (0.9>0.7)c (0.9=0.9)t (0.8>0.7)c (0.8<0.9)d
    repo.insert(cand('S1', { satisfaction: 'satisfied', scores: { ...sixDim(0.5), rewardScore: 0.9 } }));
    repo.insert(cand('S2', { index: 1, satisfaction: 'satisfied', scores: { ...sixDim(0.5), rewardScore: 0.8 } }));
    repo.insert(cand('U1', { index: 2, satisfaction: 'unsatisfied', scores: { ...sixDim(0.5), rewardScore: 0.7 } }));
    repo.insert(cand('U2', { index: 3, satisfaction: 'unsatisfied', scores: { ...sixDim(0.5), rewardScore: 0.9 } }));
    // (2 concordant + 0.5×1 tie) / 4 = 0.625
    expect(computeEvaluatorAlignment(db, 'p1')).toBeCloseTo(0.625);
  });

  it('无满意或不满意 → 无对 → alignment 0', () => {
    const repo = new CandidatesRepository(db);
    repo.insert(cand('S1', { satisfaction: 'satisfied' }));
    expect(computeEvaluatorAlignment(db, 'p1')).toBe(0);
  });

  it('pairs 按标记时间倒序，含 rewardScore/avgScore/satisfaction', () => {
    const repo = new CandidatesRepository(db);
    repo.insert(cand('old', { satisfaction: 'satisfied', scores: { ...sixDim(0.5), rewardScore: 0.6 } }));
    repo.insert(cand('new', { index: 1, satisfaction: 'unsatisfied', scores: { ...sixDim(0.6), rewardScore: 0.3 } }));
    db.prepare("UPDATE candidates SET marked_at = 100 WHERE id = 'old'").run();
    db.prepare("UPDATE candidates SET marked_at = 200 WHERE id = 'new'").run();

    const pairs = listCalibrationPairs(db, 'p1');
    expect(pairs.map((p) => p.candidateId)).toEqual(['new', 'old']);
    // avgScore=六维（含 rewardScore）均值：(0.6×5+0.3)/6 = 0.55
    expect(pairs[0]!.rewardScore).toBeCloseTo(0.3);
    expect(pairs[0]!.avgScore).toBeCloseTo(0.55);
    expect(pairs[0]!.satisfaction).toBe('unsatisfied');
  });
});

describe('reward/status 解析与降级', () => {
  it('parseRewardVersion：v3→3，null/非数字→0', () => {
    expect(parseRewardVersion('v3')).toBe(3);
    expect(parseRewardVersion('12')).toBe(12);
    expect(parseRewardVersion(null)).toBe(0);
    expect(parseRewardVersion('abc')).toBe(0);
  });

  const STATUS: RewardStatusResponse = {
    version: 'v4',
    accuracy: 0.75,
    kendallTau: 0.5,
    sampleCount: 100,
    trainedAt: 999,
  };

  it('sidecar 成功 → 返回解析值并写缓存', async () => {
    const repo = new GrowthStatsRepository(db);
    const sidecar = { rewardStatus: async () => STATUS } as unknown as SidecarClient;
    const extras = await resolveRewardExtras(repo, 'p1', sidecar);
    expect(extras).toEqual({ rewardVersion: 4, rewardAccuracy: 0.75 });
    expect(repo.getRewardStatusCache('p1')).toEqual(STATUS);
  });

  it('sidecar 失败 → 降级缓存；从未成功 → 全 0', async () => {
    const repo = new GrowthStatsRepository(db);
    const failing = {
      rewardStatus: async () => {
        throw new Error('sidecar 挂了');
      },
    } as unknown as SidecarClient;
    // 从未成功 → 全 0
    expect(await resolveRewardExtras(repo, 'p1', failing)).toEqual({ rewardVersion: 0, rewardAccuracy: 0 });
    // 有缓存后 → 降级用缓存
    repo.saveRewardStatusCache('p1', STATUS);
    expect(await resolveRewardExtras(repo, 'p1', failing)).toEqual({ rewardVersion: 4, rewardAccuracy: 0.75 });
    // 未配置 sidecar 也走缓存
    expect(await resolveRewardExtras(repo, 'p1')).toEqual({ rewardVersion: 4, rewardAccuracy: 0.75 });
  });
});
