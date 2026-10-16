/** SPEC §10.2 / 验收「高频不满意标签自动进入反模式库，影响后续生成」
 *
 * 反模式库：从 satisfaction_tags 读 polarity='negative' 且 count 达到阈值的标签，
 * 按 count 降序取前 N 条，组装成追加到 system prompt 的约束文本。
 * 无命中返回空串（调用方不追加）。纯同步 DB 读，无外部依赖。
 */

import type { AppDatabase } from '../db/index.js';

/** 反模式入库阈值：负向标签累计被标记次数 ≥ 2 才算「高频」
 * （口径：candidate:dissatisfy 手动勾选理由标签的累计计数，1 次视为偶发不进库）。 */
export const ANTI_PATTERN_MIN_COUNT = 2;

/** 反模式条目上限：按 count 降序只取前 5 条，避免约束文本无限膨胀挤占上下文。 */
export const ANTI_PATTERN_MAX_ITEMS = 5;

interface NegativeTagRow {
  tag: string;
  count: number;
}

/** 组装反模式约束文本；无命中标签时返回空串 */
export function buildAntiPatternConstraints(db: AppDatabase, projectId: string): string {
  const rows = db
    .prepare(
      `SELECT tag, count FROM satisfaction_tags
       WHERE project_id = ? AND polarity = 'negative' AND count >= ?
       ORDER BY count DESC, tag ASC
       LIMIT ?`,
    )
    .all(projectId, ANTI_PATTERN_MIN_COUNT, ANTI_PATTERN_MAX_ITEMS) as NegativeTagRow[];
  if (rows.length === 0) return '';
  const lines = rows.map((r) => `- ${r.tag}（出现 ${r.count} 次）`);
  return `以下问题被用户多次标记为不满意，生成时务必避免：\n${lines.join('\n')}`;
}

/** 把反模式约束追加到现有 system prompt（空约束原样返回） */
export function appendAntiPattern(systemPrompt: string, constraints: string): string {
  if (constraints === '') return systemPrompt;
  return `${systemPrompt}\n\n${constraints}`;
}
