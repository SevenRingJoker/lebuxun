/** evolution_patterns 表仓库（SPEC §10.4 Evolution Learner）
 *
 * selected：一次改进被采纳（parent_text=原候选、child_text=改进后、diff={removed,added} 计数）；
 * rejected：一次拒全弃（child_texts=JSON 数组，本 run 同父全部落选候选）。
 */

import { nanoid } from 'nanoid';
import type { AppDatabase } from '../index.js';

/** 句级 diff 近似计数值（JSON 存 diff 列） */
export interface EvolutionDiffSummary {
  removed: number;
  added: number;
}

export interface EvolutionPatternInput {
  projectId: string;
  parentText: string;
  mode: string;
  outcome: 'selected' | 'rejected';
  childText?: string;
  childTexts?: string[];
  hint?: string;
  diff?: EvolutionDiffSummary;
}

export interface EvolutionPattern extends EvolutionPatternInput {
  id: string;
  createdAt: number;
}

interface EvolutionRow {
  id: string;
  project_id: string;
  parent_text: string;
  child_text: string | null;
  child_texts: string | null;
  mode: string;
  hint: string | null;
  outcome: string | null;
  diff: string | null;
  created_at: number;
}

function rowToPattern(row: EvolutionRow): EvolutionPattern {
  return {
    id: row.id,
    projectId: row.project_id,
    parentText: row.parent_text,
    ...(row.child_text != null ? { childText: row.child_text } : {}),
    ...(row.child_texts != null ? { childTexts: JSON.parse(row.child_texts) as string[] } : {}),
    mode: row.mode,
    ...(row.hint != null ? { hint: row.hint } : {}),
    outcome: (row.outcome ?? 'selected') as EvolutionPattern['outcome'],
    ...(row.diff != null ? { diff: JSON.parse(row.diff) as EvolutionDiffSummary } : {}),
    createdAt: row.created_at,
  };
}

export class EvolutionPatternsRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(input: EvolutionPatternInput): EvolutionPattern {
    const pattern: EvolutionPattern = {
      id: nanoid(),
      ...input,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO evolution_patterns (
           id, project_id, parent_text, child_text, child_texts, mode, hint, outcome, diff, created_at
         ) VALUES (@id, @projectId, @parentText, @childText, @childTexts, @mode, @hint, @outcome, @diff, @createdAt)`,
      )
      .run({
        id: pattern.id,
        projectId: pattern.projectId,
        parentText: pattern.parentText,
        childText: pattern.childText ?? null,
        childTexts: pattern.childTexts != null ? JSON.stringify(pattern.childTexts) : null,
        mode: pattern.mode,
        hint: pattern.hint ?? null,
        outcome: pattern.outcome,
        diff: pattern.diff != null ? JSON.stringify(pattern.diff) : null,
        createdAt: pattern.createdAt,
      });
    return pattern;
  }

  countByProject(projectId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM evolution_patterns WHERE project_id = ?')
      .get(projectId) as { n: number };
    return row.n;
  }

  /** 最近 limit 条（新→旧；同毫秒 created_at 用 rowid 兜底保证插入序），供 Prompt Evolver 组伪偏好样本 */
  findRecent(projectId: string, limit: number): EvolutionPattern[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM evolution_patterns WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(projectId, limit) as EvolutionRow[];
    return rows.map(rowToPattern);
  }
}
