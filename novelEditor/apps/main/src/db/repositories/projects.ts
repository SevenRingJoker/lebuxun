/** projects 表仓库（SPEC §5.1 projects 表），prepared statements */

import type { Project } from '@novel-forge/shared';
import type { AppDatabase } from '../index.js';

interface ProjectRow {
  id: string;
  name: string;
  genre: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    genre: row.genre,
    ...(row.description != null ? { description: row.description } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectsRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(project: Project): Project {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, genre, description, created_at, updated_at)
         VALUES (@id, @name, @genre, @description, @createdAt, @updatedAt)`,
      )
      .run({
        id: project.id,
        name: project.name,
        genre: project.genre,
        description: project.description ?? null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });
    return project;
  }

  get(id: string): Project | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    return row ? rowToProject(row) : undefined;
  }

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY created_at DESC')
      .all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  remove(id: string): boolean {
    const info = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return info.changes > 0;
  }
}
