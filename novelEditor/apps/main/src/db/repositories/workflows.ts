/** workflows 表仓库（SPEC §5.1 workflows 表），graph 列为 { nodes, edges } JSON */

import type { Workflow, WorkflowEdge, WorkflowNode } from '@novel-forge/shared';
import type { AppDatabase } from '../index.js';

interface WorkflowRow {
  id: string;
  project_id: string;
  name: string;
  graph: string;
  version: number;
  updated_at: number;
}

function rowToWorkflow(row: WorkflowRow): Workflow {
  const graph = JSON.parse(row.graph) as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    nodes: graph.nodes,
    edges: graph.edges,
    version: row.version,
  };
}

export class WorkflowsRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(workflow: Workflow): Workflow {
    this.db
      .prepare(
        `INSERT INTO workflows (id, project_id, name, graph, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workflow.id,
        workflow.projectId,
        workflow.name,
        JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges }),
        workflow.version,
        Date.now(),
      );
    return workflow;
  }

  get(id: string): Workflow | undefined {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as
      | WorkflowRow
      | undefined;
    return row ? rowToWorkflow(row) : undefined;
  }

  listByProject(projectId: string): Workflow[] {
    const rows = this.db
      .prepare('SELECT * FROM workflows WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as WorkflowRow[];
    return rows.map(rowToWorkflow);
  }
}
