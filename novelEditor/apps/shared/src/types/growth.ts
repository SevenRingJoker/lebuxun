/** SPEC §6.5 growth.ts */

/** 偏好样本理由条目；inferred=true 表示系统按 §10.2 分数差推断的软标签（用户未手填） */
export interface PreferenceReason {
  tag: string;
  inferred: boolean;
}

export interface PreferenceSample {
  id: string;
  projectId: string;
  styleId?: string;
  context: string;
  chosen: string;
  rejected: string;
  /** SPEC §6.5 为 string[]；Phase 4 需要区分软标签，扩展为 PreferenceReason[]（SPEC-CHANGELOG 登记） */
  reasons: PreferenceReason[];
  createdAt: number;
}

/** 偏好画像（§10.3 维度向量，EMA 更新；存 growth_stats.stats JSON） */
export interface PreferenceProfile {
  /** §10.3 维度：pacing/character_fidelity/lexicon/tension/restraint/dialogue/atmosphere/density */
  dimensions: Record<string, number>;
  totalSamples: number;
  updatedAt: number;
}

/** 偏好画像历史快照（Phase 6 成长仪表盘趋势图；存 growth_stats.stats JSON history 数组，封顶 50 条） */
export interface ProfileSnapshot {
  at: number;
  dimensions: Record<string, number>;
}

export interface GrowthStats {
  growthIndex: number;
  preference: {
    totalSamples: number;
    reasonCoverage: number;
    dimensions: Record<string, number>;
  };
  candidate: {
    topPickRate: number;
    avgCandidateCount: number;
    rejectAllRate: number;
  };
  satisfaction: {
    totalMarked: number;
    satisfiedRate: number;
    unsatisfiedRate: number;
    topNegativeTags: { tag: string; count: number }[];
    topPositiveTags: { tag: string; count: number }[];
    avgGenerationDepth: number;
    convergenceRate: number;
  };
  model: {
    rewardVersion: number;
    rewardAccuracy: number;
    evaluatorAlignment: number;
  };
  style: {
    avgSimilarity: number;
    discriminatorScore: number;
  };
}
