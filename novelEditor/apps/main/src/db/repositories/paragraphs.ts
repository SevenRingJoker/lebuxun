/** paragraphs 表仓库（SPEC §5.1 paragraphs 表），prepared statements */

import type { Paragraph, ParagraphMetadata, SceneType } from '@novel-forge/shared';
import type { AppDatabase } from '../index.js';

interface ParagraphRow {
  id: string;
  chapter_id: string;
  idx: number;
  text: string;
  scene_type: string;
  metadata: string | null;
  created_at: number;
}

function rowToParagraph(row: ParagraphRow): Paragraph {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    index: row.idx,
    text: row.text,
    sceneType: row.scene_type as SceneType,
    metadata: row.metadata != null ? (JSON.parse(row.metadata) as ParagraphMetadata) : {},
  };
}

export class ParagraphsRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(paragraph: Paragraph): Paragraph {
    this.db
      .prepare(
        `INSERT INTO paragraphs (id, chapter_id, idx, text, scene_type, metadata, created_at)
         VALUES (@id, @chapterId, @index, @text, @sceneType, @metadata, @createdAt)`,
      )
      .run({
        id: paragraph.id,
        chapterId: paragraph.chapterId,
        index: paragraph.index,
        text: paragraph.text,
        sceneType: paragraph.sceneType,
        metadata: JSON.stringify(paragraph.metadata),
        createdAt: Date.now(),
      });
    return paragraph;
  }

  listByChapter(chapterId: string): Paragraph[] {
    const rows = this.db
      .prepare('SELECT * FROM paragraphs WHERE chapter_id = ? ORDER BY idx ASC')
      .all(chapterId) as ParagraphRow[];
    return rows.map(rowToParagraph);
  }

  countByChapter(chapterId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM paragraphs WHERE chapter_id = ?')
      .get(chapterId) as { cnt: number };
    return row.cnt;
  }
}
