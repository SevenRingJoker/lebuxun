/** Phase 4 谱系追踪（task 4.5）：递归 parent_candidate_id 组装谱系树
 *
 * SPEC §5.1 candidates.parent_candidate_id 已有索引；§4.1 未定义 candidate:lineage
 * 频道（SPEC-CHANGELOG 登记）。树节点含候选本体 + avgScore（六维均值）。
 */

import type { Candidate, CandidateLineageNode } from '@novel-forge/shared';
import type { AppDatabase } from '../db/index.js';
import { CandidatesRepository } from '../db/repositories/candidates.js';
import { averageScore } from './candidate-scoring.js';

/** 由候选列表组装以 rootId 为根的谱系树（列表外父/子自动按 DB 补齐的调用方负责传入全量） */
export function buildLineageTree(
  candidates: Candidate[],
  rootId: string,
): CandidateLineageNode | undefined {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const root = byId.get(rootId);
  if (!root) return undefined;
  const children = candidates
    .filter((c) => c.parentCandidateId === rootId)
    .sort((a, b) => a.index - b.index)
    .map((c) => buildLineageTree(candidates, c.id))
    .filter((n): n is CandidateLineageNode => n !== undefined);
  return { candidate: root, avgScore: averageScore(root.scores), children };
}

/** DB 版：取 run 全量候选后组装（candidate:lineage IPC 用） */
export function buildLineageFromDb(
  db: AppDatabase,
  runId: string,
  candidateId: string,
): CandidateLineageNode | undefined {
  const repo = new CandidatesRepository(db);
  const all = repo.listByRun(runId);
  return buildLineageTree(all, candidateId);
}
