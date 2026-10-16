/** candidates 表仓库（SPEC §5.1 candidates 表），prepared statements */

import type {
  Candidate,
  CandidateScores,
  CandidateStrategy,
  GenerationMode,
  Satisfaction,
} from '@novel-forge/shared';
import type { AppDatabase } from '../index.js';

interface CandidateRow {
  id: string;
  run_id: string;
  node_id: string;
  idx: number;
  text: string;
  strategy: string;
  scores: string;
  satisfaction: Satisfaction;
  satisfaction_reason: string | null;
  satisfaction_tags: string | null;
  parent_candidate_id: string | null;
  generation_mode: GenerationMode;
  generation_depth: number;
  lineage: string | null;
  marked_at: number | null;
  selected: number | null;
}

function rowToCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    index: row.idx,
    text: row.text,
    strategy: JSON.parse(row.strategy) as CandidateStrategy,
    scores: JSON.parse(row.scores) as CandidateScores,
    satisfaction: row.satisfaction,
    ...(row.satisfaction_reason != null ? { satisfactionReason: row.satisfaction_reason } : {}),
    ...(row.satisfaction_tags != null
      ? { satisfactionTags: JSON.parse(row.satisfaction_tags) as string[] }
      : {}),
    ...(row.parent_candidate_id != null ? { parentCandidateId: row.parent_candidate_id } : {}),
    generationMode: row.generation_mode,
    generationDepth: row.generation_depth,
    lineage: row.lineage != null ? (JSON.parse(row.lineage) as string[]) : [],
  };
}

export class CandidatesRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(candidate: Candidate): Candidate {
    this.db
      .prepare(
        `INSERT INTO candidates (
           id, run_id, node_id, idx, text, strategy, scores,
           satisfaction, satisfaction_reason, satisfaction_tags,
           parent_candidate_id, generation_mode, generation_depth, lineage
         ) VALUES (
           @id, @runId, @nodeId, @index, @text, @strategy, @scores,
           @satisfaction, @satisfactionReason, @satisfactionTags,
           @parentCandidateId, @generationMode, @generationDepth, @lineage
         )`,
      )
      .run({
        id: candidate.id,
        runId: candidate.runId,
        nodeId: candidate.nodeId,
        index: candidate.index,
        text: candidate.text,
        strategy: JSON.stringify(candidate.strategy),
        scores: JSON.stringify(candidate.scores),
        satisfaction: candidate.satisfaction,
        satisfactionReason: candidate.satisfactionReason ?? null,
        satisfactionTags:
          candidate.satisfactionTags != null ? JSON.stringify(candidate.satisfactionTags) : null,
        parentCandidateId: candidate.parentCandidateId ?? null,
        generationMode: candidate.generationMode,
        generationDepth: candidate.generationDepth,
        lineage: JSON.stringify(candidate.lineage),
      });
    return candidate;
  }

  insertMany(candidates: Candidate[]): void {
    const tx = this.db.transaction((items: Candidate[]) => {
      for (const c of items) this.insert(c);
    });
    tx(candidates);
  }

  get(id: string): Candidate | undefined {
    const row = this.db
      .prepare('SELECT * FROM candidates WHERE id = ?')
      .get(id) as CandidateRow | undefined;
    return row ? rowToCandidate(row) : undefined;
  }

  /** review.candidate-picker 选中标记（candidates.selected） */
  markSelected(id: string): void {
    this.db.prepare('UPDATE candidates SET selected = 1 WHERE id = ?').run(id);
  }

  /** 改后选：candidate:select 携带 editedText 时回写候选正文 */
  updateText(id: string, text: string): void {
    this.db.prepare('UPDATE candidates SET text = ? WHERE id = ?').run(text, id);
  }

  /** Phase 5：style.discriminator 等节点写回分数（整组 scores JSON 替换） */
  updateScores(id: string, scores: CandidateScores): void {
    this.db.prepare('UPDATE candidates SET scores = ? WHERE id = ?').run(JSON.stringify(scores), id);
  }

  /** 满意/不满意/取消标记（candidate:* IPC 与 picker onResume 共用） */
  setSatisfaction(id: string, satisfaction: Satisfaction, reason?: string, tags?: string[]): void {
    this.db
      .prepare(
        `UPDATE candidates
         SET satisfaction = ?, satisfaction_reason = ?, satisfaction_tags = ?, marked_at = ?
         WHERE id = ?`,
      )
      .run(
        satisfaction,
        reason ?? null,
        tags != null ? JSON.stringify(tags) : null,
        satisfaction === 'unrated' ? null : Date.now(),
        id,
      );
  }

  listByRun(runId: string, nodeId?: string): Candidate[] {
    const rows = (
      nodeId != null
        ? this.db
            .prepare('SELECT * FROM candidates WHERE run_id = ? AND node_id = ? ORDER BY idx ASC')
            .all(runId, nodeId)
        : this.db
            .prepare('SELECT * FROM candidates WHERE run_id = ? ORDER BY idx ASC')
            .all(runId)
    ) as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  /** 直接子候选（谱系树用，§9.4 parent_candidate_id） */
  listChildren(parentId: string): Candidate[] {
    const rows = this.db
      .prepare('SELECT * FROM candidates WHERE parent_candidate_id = ? ORDER BY idx ASC')
      .all(parentId) as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  /** 同 run/node 下一个可用 idx（定向重生成追加候选） */
  nextIndex(runId: string, nodeId: string): number {
    const row = this.db
      .prepare('SELECT MAX(idx) AS maxIdx FROM candidates WHERE run_id = ? AND node_id = ?')
      .get(runId, nodeId) as { maxIdx: number | null };
    return (row.maxIdx ?? -1) + 1;
  }

  /** 清除不满意候选（candidate:prune-unsatisfied）；返回被删 id 列表 */
  deleteUnsatisfied(runId: string, nodeId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM candidates WHERE run_id = ? AND node_id = ? AND satisfaction = 'unsatisfied'",
      )
      .all(runId, nodeId) as { id: string }[];
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ');
      this.db.prepare(`DELETE FROM candidates WHERE id IN (${placeholders})`).run(...ids);
    }
    return ids;
  }
}
