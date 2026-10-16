/** SPEC §10.2 理由推断（软标签）：用户不填 reasonTags 时，用六维分数差推断
 *
 * 规则：chosen 某维分数显著高于 rejected（差值 >= 阈值）→ 该维映射为软标签，
 * 标记 inferred: true。例：rejected 的 styleSimilarity（文风一致性）显著低于
 * chosen → 软标签 style。
 */

import type { CandidateScores, PreferenceReason } from '@novel-forge/shared';
import { SCORE_DIMS } from '../services/candidate-scoring.js';

/** 显著差值阈值 */
export const SCORE_DIFF_THRESHOLD = 0.2;

/** 六维 → 偏好软标签（§10.2/§10.3 维度键） */
const DIM_TO_SOFT_TAG: Record<(typeof SCORE_DIMS)[number], string> = {
  pacing: 'pacing',
  character: 'character',
  consistency: 'style',
  profileFit: 'profile',
  styleSimilarity: 'style',
  rewardScore: 'overall',
};

/** 推断软标签：按差值降序，去重；无显著差异返回空 */
export function inferReasons(chosen: CandidateScores, rejected: CandidateScores): PreferenceReason[] {
  const diffs = SCORE_DIMS
    .map((dim) => ({ dim, diff: chosen[dim] - rejected[dim] }))
    .filter((d) => d.diff >= SCORE_DIFF_THRESHOLD)
    .sort((a, b) => b.diff - a.diff);
  const seen = new Set<string>();
  const reasons: PreferenceReason[] = [];
  for (const d of diffs) {
    const tag = DIM_TO_SOFT_TAG[d.dim];
    if (!seen.has(tag)) {
      seen.add(tag);
      reasons.push({ tag, inferred: true });
    }
  }
  return reasons;
}
