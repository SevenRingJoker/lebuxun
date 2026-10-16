/** SPEC §14 任务 6.3 评估器校准（growth:calibration IPC）
 *
 * computeEvaluatorAlignment：项目内 satisfaction∈(satisfied,unsatisfied) 候选两两成对，
 * 比较 scores.rewardScore：满意>不满意→concordant，<→discordant，=→tie，
 * alignment = (concordant + 0.5·tie) / 总对数，无对 → 0（肯德尔 tau-b 的简化口径）。
 * listCalibrationPairs：已标记候选按标记时间倒序前 CALIBRATION_PAIRS_LIMIT 条。
 * 注：candidates 表无 created_at 列，契约「按创建时间倒序」以 marked_at 近似（PENDING 登记）。
 */

import type { CalibrationPair, CandidateScores, Satisfaction } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';

/** 校准 pairs 返回上限：契约约定前 50 条（UI 列表展示，过多无意义且拖慢 IPC） */
export const CALIBRATION_PAIRS_LIMIT = 50;

interface MarkedRow {
  id: string;
  satisfaction: Satisfaction;
  scores: string;
  marked_at: number | null;
}

function queryMarked(db: AppDatabase, projectId: string): MarkedRow[] {
  return db
    .prepare(
      `SELECT c.id AS id, c.satisfaction AS satisfaction, c.scores AS scores, c.marked_at AS marked_at
       FROM candidates c
       JOIN runs r ON r.id = c.run_id
       JOIN workflows w ON w.id = r.workflow_id
       WHERE w.project_id = ? AND c.satisfaction IN ('satisfied', 'unsatisfied')`,
    )
    .all(projectId) as MarkedRow[];
}

function rewardScoreOf(scoresJson: string): number {
  const scores = JSON.parse(scoresJson) as Partial<CandidateScores>;
  return scores.rewardScore ?? 0;
}

/** 六维分数均值（§9.4） */
function avgScoreOf(scoresJson: string): number {
  const s = JSON.parse(scoresJson) as Partial<CandidateScores>;
  const vals = [s.pacing, s.character, s.consistency, s.profileFit, s.styleSimilarity, s.rewardScore];
  const nums = vals.filter((v): v is number => typeof v === 'number');
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

/** 满意×不满意成对一致率 0..1（无足够标注对时为 0） */
export function computeEvaluatorAlignment(db: AppDatabase, projectId: string): number {
  const marked = queryMarked(db, projectId);
  const satisfiedScores = marked
    .filter((r) => r.satisfaction === 'satisfied')
    .map((r) => rewardScoreOf(r.scores));
  const unsatisfiedScores = marked
    .filter((r) => r.satisfaction === 'unsatisfied')
    .map((r) => rewardScoreOf(r.scores));

  const totalPairs = satisfiedScores.length * unsatisfiedScores.length;
  if (totalPairs === 0) return 0;

  let concordant = 0;
  let tie = 0;
  for (const s of satisfiedScores) {
    for (const u of unsatisfiedScores) {
      if (s > u) concordant += 1;
      else if (s === u) tie += 1;
    }
  }
  return (concordant + 0.5 * tie) / totalPairs;
}

/** 校准 pairs：按标记时间倒序（marked_at 为空排最后），封顶 CALIBRATION_PAIRS_LIMIT */
export function listCalibrationPairs(db: AppDatabase, projectId: string): CalibrationPair[] {
  return queryMarked(db, projectId)
    .sort((a, b) => (b.marked_at ?? 0) - (a.marked_at ?? 0))
    .slice(0, CALIBRATION_PAIRS_LIMIT)
    .map((r) => ({
      candidateId: r.id,
      rewardScore: rewardScoreOf(r.scores),
      avgScore: avgScoreOf(r.scores),
      satisfaction: r.satisfaction,
    }));
}
