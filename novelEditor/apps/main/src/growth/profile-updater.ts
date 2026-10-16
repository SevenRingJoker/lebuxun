/** SPEC §10.3 偏好画像更新：维度向量指数滑动平均（EMA）
 *
 * 维度（§10.3 表）：pacing / character_fidelity / lexicon / tension /
 * restraint / dialogue / atmosphere / density，初始 0.5。
 * 每条偏好样本的理由标签映射到维度与方向，new = old + α·(target - old)，
 * target = 1（正向偏好）或 0（负向），α = 0.3，clamp [0,1]。
 */

import type { PreferenceProfile, PreferenceReason } from '@novel-forge/shared';

export const PROFILE_DIMENSIONS = [
  'pacing',
  'character_fidelity',
  'lexicon',
  'tension',
  'restraint',
  'dialogue',
  'atmosphere',
  'density',
] as const;

export type ProfileDimension = (typeof PROFILE_DIMENSIONS)[number];

export const EMA_ALPHA = 0.3;

/** 标签 → { 维度, 方向 }；方向 +1 表示用户偏好该维度更强，-1 表示更弱 */
const TAG_DIRECTIONS: Record<string, { dim: ProfileDimension; dir: 1 | -1 }> = {
  // 不满意标签（REASON_TAGS，§12.2）
  节奏太快: { dim: 'pacing', dir: -1 },
  节奏太慢: { dim: 'pacing', dir: 1 },
  对白生硬: { dim: 'dialogue', dir: 1 }, // 更重视对白自然度
  描写过多: { dim: 'restraint', dir: 1 }, // 更偏好留白
  出戏: { dim: 'atmosphere', dir: 1 },
  人设崩: { dim: 'character_fidelity', dir: 1 },
  用词不贴: { dim: 'lexicon', dir: 1 },
  信息密度不合适: { dim: 'density', dir: -1 }, // 默认倾向更低密度
  缺冲突: { dim: 'tension', dir: 1 },
  缺留白: { dim: 'restraint', dir: 1 },
  // 满意标签（POSITIVE_REASON_TAGS，§10.3）
  节奏好: { dim: 'pacing', dir: 1 },
  人设准: { dim: 'character_fidelity', dir: 1 },
  用词贴: { dim: 'lexicon', dir: 1 },
  冲突强: { dim: 'tension', dir: 1 },
  留白好: { dim: 'restraint', dir: 1 },
  对白自然: { dim: 'dialogue', dir: 1 },
  氛围对: { dim: 'atmosphere', dir: 1 },
  信息密度合适: { dim: 'density', dir: 1 },
  // 软标签（§10.2 推断键）
  pacing: { dim: 'pacing', dir: 1 },
  character: { dim: 'character_fidelity', dir: 1 },
  style: { dim: 'lexicon', dir: 1 },
  profile: { dim: 'density', dir: 1 },
  overall: { dim: 'tension', dir: 1 },
};

export function emptyProfile(): PreferenceProfile {
  const dimensions: Record<string, number> = {};
  for (const dim of PROFILE_DIMENSIONS) dimensions[dim] = 0.5;
  return { dimensions, totalSamples: 0, updatedAt: Date.now() };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 纯函数：把一批样本理由按 EMA 应用画像（返回新对象，不改入参） */
export function applyReasons(
  profile: PreferenceProfile,
  reasonsList: PreferenceReason[][],
  sampleCount: number,
): PreferenceProfile {
  const dimensions = { ...profile.dimensions };
  for (const reasons of reasonsList) {
    for (const reason of reasons) {
      const map = TAG_DIRECTIONS[reason.tag];
      if (!map) continue;
      const target = map.dir > 0 ? 1 : 0;
      const old = dimensions[map.dim] ?? 0.5;
      dimensions[map.dim] = clamp01(old + EMA_ALPHA * (target - old));
    }
  }
  return {
    dimensions,
    totalSamples: profile.totalSamples + sampleCount,
    updatedAt: Date.now(),
  };
}
