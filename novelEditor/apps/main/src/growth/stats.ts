/** SPEC §6.5 GrowthStats 聚合（growth:stats IPC）
 *
 * 偏好/候选/满意度/风格段由 DB 真实聚合；model 段（rewardVersion/rewardAccuracy/
 * evaluatorAlignment）依赖 sidecar 与校准结果，由 IPC 层经 extras 注入，本函数保持同步纯函数。
 * growthIndex 定义：画像维度均值 ×100（SPEC 未给公式，SPEC-CHANGELOG 登记）。
 */

import type { CandidateScores, GrowthStats } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import { GrowthStatsRepository } from '../db/repositories/growth-stats.js';
import { SatisfactionTagsRepository } from '../db/repositories/satisfaction-tags.js';
import { PROFILE_DIMENSIONS } from './profile-updater.js';

interface CountRow {
  n: number;
}

/** sidecar / 校准派生的外部指标（缺省字段按 0 处理） */
export interface GrowthStatsExtras {
  rewardVersion?: number;
  rewardAccuracy?: number;
  evaluatorAlignment?: number;
}

export function aggregateGrowthStats(
  db: AppDatabase,
  projectId: string,
  extras: GrowthStatsExtras = {},
): GrowthStats {
  const growthRepo = new GrowthStatsRepository(db);
  const profile = growthRepo.getProfile(projectId);
  const tags = new SatisfactionTagsRepository(db);

  // 偏好样本统计
  const sampleCount = (
    db.prepare('SELECT COUNT(*) AS n FROM preference_samples WHERE project_id = ?').get(projectId) as CountRow
  ).n;
  const withReasons = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM preference_samples WHERE project_id = ? AND reasons IS NOT NULL AND reasons != '[]'",
      )
      .get(projectId) as CountRow
  ).n;

  // 候选统计（跨全部 run；candidates 不直接挂 project，经 runs→workflows 关联）
  const candidateRows = db
    .prepare(
      `SELECT c.satisfaction AS satisfaction, c.generation_depth AS depth, c.selected AS selected,
              c.run_id AS runId, c.node_id AS nodeId, c.scores AS scores
       FROM candidates c
       JOIN runs r ON r.id = c.run_id
       JOIN workflows w ON w.id = r.workflow_id
       WHERE w.project_id = ?`,
    )
    .all(projectId) as {
    satisfaction: string;
    depth: number;
    selected: number | null;
    runId: string;
    nodeId: string;
    scores: string;
  }[];

  const total = candidateRows.length;
  const satisfied = candidateRows.filter((c) => c.satisfaction === 'satisfied').length;
  const unsatisfied = candidateRows.filter((c) => c.satisfaction === 'unsatisfied').length;
  const selectedRows = candidateRows.filter((c) => c.selected === 1);
  const topPicked = selectedRows.filter((c) => c.depth === 0).length;
  const marked = satisfied + unsatisfied;
  const avgDepth = total > 0 ? candidateRows.reduce((a, c) => a + c.depth, 0) / total : 0;
  // 收敛率：经历过重生成的 run 中，最终选中深度 ≤1 的比例（近似，SPEC 未定义）
  const converged = selectedRows.filter((c) => c.depth <= 1).length;
  const panelCount = new Set(candidateRows.map((c) => `${c.runId}/${c.nodeId}`)).size;

  // 拒全弃率：累计拒全弃次数 / 面板总数（无面板时率 0，避免除零）
  const rejectAllCount = growthRepo.getRejectAllCount(projectId);
  const rejectAllRate = panelCount > 0 ? rejectAllCount / panelCount : 0;

  // 风格段（近似口径，PENDING 登记）：avgSimilarity=全部候选 styleSimilarity 均值；
  // discriminatorScore=已选中候选 styleSimilarity 均值（借 styleSimilarity 代判别器分）
  const parseStyleSimilarity = (scoresJson: string): number => {
    const scores = JSON.parse(scoresJson) as Partial<CandidateScores>;
    return scores.styleSimilarity ?? 0;
  };
  const avgSimilarity =
    total > 0 ? candidateRows.reduce((a, c) => a + parseStyleSimilarity(c.scores), 0) / total : 0;
  const discriminatorScore =
    selectedRows.length > 0
      ? selectedRows.reduce((a, c) => a + parseStyleSimilarity(c.scores), 0) / selectedRows.length
      : 0;

  const dimValues = PROFILE_DIMENSIONS.map((d) => profile.dimensions[d] ?? 0.5);
  const growthIndex = Math.round((dimValues.reduce((a, b) => a + b, 0) / dimValues.length) * 100);

  return {
    growthIndex,
    preference: {
      totalSamples: sampleCount,
      reasonCoverage: sampleCount > 0 ? withReasons / sampleCount : 0,
      dimensions: profile.dimensions,
    },
    candidate: {
      topPickRate: selectedRows.length > 0 ? topPicked / selectedRows.length : 0,
      avgCandidateCount: panelCount > 0 ? total / panelCount : 0,
      rejectAllRate,
    },
    satisfaction: {
      totalMarked: marked,
      satisfiedRate: marked > 0 ? satisfied / marked : 0,
      unsatisfiedRate: marked > 0 ? unsatisfied / marked : 0,
      topNegativeTags: tags.top(projectId, 'negative'),
      topPositiveTags: tags.top(projectId, 'positive'),
      avgGenerationDepth: avgDepth,
      convergenceRate: selectedRows.length > 0 ? converged / selectedRows.length : 0,
    },
    model: {
      rewardVersion: extras.rewardVersion ?? 0,
      rewardAccuracy: extras.rewardAccuracy ?? 0,
      evaluatorAlignment: extras.evaluatorAlignment ?? 0,
    },
    style: { avgSimilarity, discriminatorScore },
  };
}
