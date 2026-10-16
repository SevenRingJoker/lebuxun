/** chapters 表仓库（SPEC §5.1 chapters 表），prepared statements */

import type { Chapter } from '@novel-forge/shared';
import type { AppDatabase } from '../index.js';

interface ChapterRow {
  id: string;
  project_id: string;
  idx: number;
  title: string;
  status: string;
  word_count: number | null;
  summary: string | null;
  created_at: number;
  updated_at: number;
}

function rowToChapter(row: ChapterRow): Chapter {
  return {
    id: row.id,
    projectId: row.project_id,
    index: row.idx,
    title: row.title,
    status: row.status as Chapter['status'],
    wordCount: row.word_count ?? 0,
    ...(row.summary != null ? { summary: row.summary } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ChaptersRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(chapter: Chapter): Chapter {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO chapters (id, project_id, idx, title, status, word_count, summary, created_at, updated_at)
         VALUES (@id, @projectId, @index, @title, @status, @wordCount, @summary, @createdAt, @updatedAt)`,
      )
      .run({
        id: chapter.id,
        projectId: chapter.projectId,
        index: chapter.index,
        title: chapter.title,
        status: chapter.status,
        wordCount: chapter.wordCount,
        summary: chapter.summary ?? null,
        createdAt: chapter.createdAt || now,
        updatedAt: chapter.updatedAt || now,
      });
    return chapter;
  }

  get(id: string): Chapter | undefined {
    const row = this.db.prepare('SELECT * FROM chapters WHERE id = ?').get(id) as
      | ChapterRow
      | undefined;
    return row ? rowToChapter(row) : undefined;
  }

  update(chapter: Chapter): void {
    this.db
      .prepare(
        `UPDATE chapters SET title = ?, status = ?, word_count = ?, summary = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(chapter.title, chapter.status, chapter.wordCount, chapter.summary ?? null, Date.now(), chapter.id);
  }

  listByProject(projectId: string): Chapter[] {
    const rows = this.db
      .prepare('SELECT * FROM chapters WHERE project_id = ? ORDER BY idx ASC')
      .all(projectId) as ChapterRow[];
    return rows.map(rowToChapter);
  }

  /** 写作中的草稿章（chapter.accumulator 逐段追加的目标） */
  findWriting(projectId: string): Chapter | undefined {
    const row = this.db
      .prepare("SELECT * FROM chapters WHERE project_id = ? AND status = 'writing' ORDER BY idx DESC LIMIT 1")
      .get(projectId) as ChapterRow | undefined;
    return row ? rowToChapter(row) : undefined;
  }

  /** 下一章序号（max(idx) + 1；无章节时为 1） */
  nextIndex(projectId: string): number {
    const row = this.db
      .prepare('SELECT MAX(idx) AS maxIdx FROM chapters WHERE project_id = ?')
      .get(projectId) as { maxIdx: number | null };
    return (row.maxIdx ?? 0) + 1;
  }
}
