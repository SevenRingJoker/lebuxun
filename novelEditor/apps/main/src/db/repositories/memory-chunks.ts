/** memory_chunks 表仓库（002 migration，SPEC-CHANGELOG 登记） */

import type { AppDatabase } from '../index.js';

export type MemoryChunkKind = 'chapter-summary' | 'paragraph' | 'note';

export interface MemoryChunk {
  id: string;
  projectId: string;
  chapterId?: string;
  kind: MemoryChunkKind;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

interface MemoryChunkRow {
  id: string;
  project_id: string;
  chapter_id: string | null;
  kind: string;
  content: string;
  metadata: string | null;
  created_at: number;
}

function rowToChunk(row: MemoryChunkRow): MemoryChunk {
  return {
    id: row.id,
    projectId: row.project_id,
    ...(row.chapter_id != null ? { chapterId: row.chapter_id } : {}),
    kind: row.kind as MemoryChunkKind,
    content: row.content,
    metadata: row.metadata != null ? (JSON.parse(row.metadata) as Record<string, unknown>) : {},
    createdAt: row.created_at,
  };
}

export class MemoryChunksRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(chunk: Omit<MemoryChunk, 'createdAt'>): MemoryChunk {
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO memory_chunks (id, project_id, chapter_id, kind, content, metadata, created_at)
         VALUES (@id, @projectId, @chapterId, @kind, @content, @metadata, @createdAt)`,
      )
      .run({
        id: chunk.id,
        projectId: chunk.projectId,
        chapterId: chunk.chapterId ?? null,
        kind: chunk.kind,
        content: chunk.content,
        metadata: JSON.stringify(chunk.metadata),
        createdAt,
      });
    return { ...chunk, createdAt };
  }

  /** 最近的记忆条目（按写入时间倒序） */
  listRecent(projectId: string, limit: number): MemoryChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_chunks WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(projectId, limit) as MemoryChunkRow[];
    return rows.map(rowToChunk);
  }
}
