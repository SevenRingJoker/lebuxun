/** prompt_versions 表仓库（SPEC §10.5 Prompt Evolver 产物落库）
 *
 * 同 project+node_type 下 version 递增；消费方（improve 再生成）取最新一条 content。
 */

import { nanoid } from 'nanoid';
import type { AppDatabase } from '../index.js';

export interface PromptVersionInput {
  projectId: string;
  nodeType: string;
  content: string;
  /** sidecar 返回的版本号（含 parentVersion/basedOn 溯源，存 metrics 列备查） */
  version?: number;
  parentVersion?: number | null;
  basedOn?: string | null;
}

export interface PromptVersion extends PromptVersionInput {
  id: string;
  createdAt: number;
}

interface PromptVersionRow {
  id: string;
  project_id: string;
  node_type: string;
  version: number;
  content: string;
  metrics: string | null;
  created_at: number;
}

function rowToVersion(row: PromptVersionRow): PromptVersion {
  const metrics = row.metrics != null ? (JSON.parse(row.metrics) as Record<string, unknown>) : {};
  return {
    id: row.id,
    projectId: row.project_id,
    nodeType: row.node_type,
    version: row.version,
    content: row.content,
    parentVersion: typeof metrics['parentVersion'] === 'number' ? metrics['parentVersion'] : null,
    basedOn: typeof metrics['basedOn'] === 'string' ? metrics['basedOn'] : null,
    createdAt: row.created_at,
  };
}

export class PromptVersionsRepository {
  constructor(private readonly db: AppDatabase) {}

  /** 落一条新版本；version 缺省时在同 project+node_type 下自增 */
  insert(input: PromptVersionInput): PromptVersion {
    const version =
      input.version ??
      (() => {
        const row = this.db
          .prepare(
            'SELECT MAX(version) AS v FROM prompt_versions WHERE project_id = ? AND node_type = ?',
          )
          .get(input.projectId, input.nodeType) as { v: number | null };
        return (row.v ?? 0) + 1;
      })();
    const record: PromptVersion = {
      id: nanoid(),
      ...input,
      version,
      createdAt: Date.now(),
    };
    const metrics: Record<string, unknown> = {
      ...(input.parentVersion != null ? { parentVersion: input.parentVersion } : {}),
      ...(input.basedOn != null ? { basedOn: input.basedOn } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO prompt_versions (id, project_id, node_type, version, content, metrics, created_at)
         VALUES (@id, @projectId, @nodeType, @version, @content, @metrics, @createdAt)`,
      )
      .run({
        id: record.id,
        projectId: record.projectId,
        nodeType: record.nodeType,
        version: record.version,
        content: record.content,
        metrics: JSON.stringify(metrics),
        createdAt: record.createdAt,
      });
    return record;
  }

  /** 最新一条（单行查询，improve 再生成热路径消费） */
  latestFor(projectId: string, nodeType: string): PromptVersion | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM prompt_versions WHERE project_id = ? AND node_type = ? ORDER BY version DESC, created_at DESC LIMIT 1',
      )
      .get(projectId, nodeType) as PromptVersionRow | undefined;
    return row != null ? rowToVersion(row) : undefined;
  }
}
