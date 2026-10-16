/** runs 表仓库（SPEC §5.1 runs 表 + §6.6 RunState）
 *
 * state 列 JSON 结构见 workflow/types.ts 的 PersistedRunState
 * （outputs + context + 可选挂起信息 + 可选错误信息）。
 */

import type { RunState } from '@novel-forge/shared';
import type { PausedNodeInfo, PersistedRunState } from '../../workflow/types.js';
import type { AppDatabase } from '../index.js';

interface RunRow {
  id: string;
  workflow_id: string;
  status: string;
  current_node_id: string | null;
  state: string | null;
  created_at: number;
  updated_at: number;
}

export interface StoredRun {
  run: RunState;
  pause?: PausedNodeInfo;
}

function toPersisted(run: RunState, pause?: PausedNodeInfo, error?: string): string {
  const state: PersistedRunState = {
    outputs: run.outputs,
    context: run.context,
    ...(pause !== undefined ? { pause } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  return JSON.stringify(state);
}

export class RunsRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(run: RunState): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO runs (id, workflow_id, status, current_node_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId,
        run.workflowId,
        run.status,
        run.currentNodeId ?? null,
        toPersisted(run),
        now,
        now,
      );
  }

  /** 状态迁移落库：status / current_node_id / state（pause 与 error 信息并入 state JSON） */
  save(run: RunState, pause?: PausedNodeInfo, error?: string): void {
    this.db
      .prepare('UPDATE runs SET status = ?, current_node_id = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(
        run.status,
        run.currentNodeId ?? null,
        toPersisted(run, pause, error),
        Date.now(),
        run.runId,
      );
  }

  /** 崩溃恢复：读回全部 paused run（outputs/context/挂起信息从 state JSON 还原） */
  findPaused(): StoredRun[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE status = 'paused' ORDER BY updated_at ASC")
      .all() as RunRow[];
    return rows.map((row) => {
      const state = row.state != null ? (JSON.parse(row.state) as PersistedRunState) : undefined;
      const run: RunState = {
        runId: row.id,
        workflowId: row.workflow_id,
        status: 'paused',
        ...(row.current_node_id != null ? { currentNodeId: row.current_node_id } : {}),
        outputs: state?.outputs ?? {},
        context: state?.context ?? { projectId: '', accumulatedParagraphs: [] },
      };
      return { run, ...(state?.pause !== undefined ? { pause: state.pause } : {}) };
    });
  }
}
