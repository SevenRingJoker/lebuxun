/** SPEC §15「混合选」句级合并服务：按 sources 顺序取候选文本、按 span 截取片段拼接
 *
 * 容错口径（注释说明）：
 * - span 为字符偏移区间 [start, end)；越界（start<0 / end>文本长）、倒置/空片段（start>=end）
 *   一律忽略该段，不阻断整体合并；
 * - candidateId 不存在同样忽略（面板期间候选可能被 prune）；
 * - sources 为空抛错（混合选至少需一个片段来源）。
 */

import type { AppDatabase } from '../db/index.js';

export interface MixSource {
  candidateId: string;
  /** 字符偏移区间 [start, end) */
  span: [number, number];
}

export function composeMixText(db: AppDatabase, sources: MixSource[]): string {
  if (sources.length === 0) {
    throw new Error('混合选 sources 不能为空');
  }
  const stmt = db.prepare('SELECT text FROM candidates WHERE id = ?');
  const parts: string[] = [];
  for (const source of sources) {
    const row = stmt.get(source.candidateId) as { text: string } | undefined;
    if (row === undefined) continue; // 候选不存在：忽略该段
    const [start, end] = source.span;
    // 越界 / 倒置 / 空片段：忽略该段
    if (start < 0 || end > row.text.length || start >= end) continue;
    parts.push(row.text.slice(start, end));
  }
  return parts.join('\n');
}
