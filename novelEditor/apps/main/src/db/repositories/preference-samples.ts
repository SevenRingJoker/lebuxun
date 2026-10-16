/** preference_samples 表仓库（SPEC §5.1 / §10.2 Preference Collector） */

import type { PreferenceReason, PreferenceSample } from '@novel-forge/shared';
import type { AppDatabase } from '../index.js';

interface PreferenceSampleRow {
  id: string;
  project_id: string;
  style_id: string | null;
  context: string;
  chosen: string;
  rejected: string;
  reasons: string | null;
  created_at: number;
}

function rowToSample(row: PreferenceSampleRow): PreferenceSample {
  return {
    id: row.id,
    projectId: row.project_id,
    ...(row.style_id != null ? { styleId: row.style_id } : {}),
    context: row.context,
    chosen: row.chosen,
    rejected: row.rejected,
    reasons: row.reasons != null ? (JSON.parse(row.reasons) as PreferenceReason[]) : [],
    createdAt: row.created_at,
  };
}

export class PreferenceSamplesRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(sample: PreferenceSample): PreferenceSample {
    this.db
      .prepare(
        `INSERT INTO preference_samples (id, project_id, style_id, context, chosen, rejected, reasons, created_at)
         VALUES (@id, @projectId, @styleId, @context, @chosen, @rejected, @reasons, @createdAt)`,
      )
      .run({
        id: sample.id,
        projectId: sample.projectId,
        styleId: sample.styleId ?? null,
        context: sample.context,
        chosen: sample.chosen,
        rejected: sample.rejected,
        reasons: JSON.stringify(sample.reasons),
        createdAt: sample.createdAt,
      });
    return sample;
  }

  listByProject(projectId: string, limit = 100): PreferenceSample[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM preference_samples WHERE project_id = ? ORDER BY created_at ASC LIMIT ?',
      )
      .all(projectId, limit) as PreferenceSampleRow[];
    return rows.map(rowToSample);
  }

  countByProject(projectId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM preference_samples WHERE project_id = ?')
      .get(projectId) as { n: number };
    return row.n;
  }
}
