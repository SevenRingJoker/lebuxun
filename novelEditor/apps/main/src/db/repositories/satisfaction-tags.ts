/** satisfaction_tags 表仓库（SPEC §5.1）：满意/不满意理由标签计数（成长仪表盘 Top 标签） */

import { nanoid } from 'nanoid';
import type { AppDatabase } from '../index.js';

export type TagPolarity = 'positive' | 'negative';

export interface TagCount {
  tag: string;
  count: number;
}

interface TagRow {
  id: string;
  project_id: string;
  tag: string;
  polarity: TagPolarity;
  count: number;
  updated_at: number;
}

export class SatisfactionTagsRepository {
  constructor(private readonly db: AppDatabase) {}

  /** 标签计数 +1（不存在则插入） */
  increment(projectId: string, tag: string, polarity: TagPolarity): void {
    const row = this.db
      .prepare(
        'SELECT * FROM satisfaction_tags WHERE project_id = ? AND tag = ? AND polarity = ?',
      )
      .get(projectId, tag, polarity) as TagRow | undefined;
    if (row) {
      this.db
        .prepare('UPDATE satisfaction_tags SET count = count + 1, updated_at = ? WHERE id = ?')
        .run(Date.now(), row.id);
    } else {
      this.db
        .prepare(
          'INSERT INTO satisfaction_tags (id, project_id, tag, polarity, count, updated_at) VALUES (?, ?, ?, ?, 1, ?)',
        )
        .run(nanoid(), projectId, tag, polarity, Date.now());
    }
  }

  /** Top 标签（按计数降序） */
  top(projectId: string, polarity: TagPolarity, limit = 5): TagCount[] {
    const rows = this.db
      .prepare(
        'SELECT tag, count FROM satisfaction_tags WHERE project_id = ? AND polarity = ? ORDER BY count DESC, tag ASC LIMIT ?',
      )
      .all(projectId, polarity, limit) as { tag: string; count: number }[];
    return rows;
  }
}
