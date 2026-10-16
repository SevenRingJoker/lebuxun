/** project 域 IPC（SPEC §4.1）：project:create / project:get 走 db repositories */

import { ipcMain } from 'electron';
import { nanoid } from 'nanoid';
import type {
  ProjectCreateReq,
  ProjectCreateRes,
  ProjectGetReq,
  ProjectGetRes,
  ProjectListItem,
  ProjectListRes,
} from '@novel-forge/shared';
import type { ProjectsRepository } from '../db/repositories/projects.js';
import type { WorkflowsRepository } from '../db/repositories/workflows.js';
import type { DefaultWorkflowGraph } from '../workflow/default-workflow.js';

export interface ProjectIpcDeps {
  projects: ProjectsRepository;
  workflows: WorkflowsRepository;
  /** 默认工作流图模板（resources/default-workflows/main-loop.json）；缺失时仅 warn 跳过绑定 */
  defaultWorkflow?: DefaultWorkflowGraph;
}

export function registerProjectIpc(deps: ProjectIpcDeps): void {
  ipcMain.handle('project:create', async (_event, req: ProjectCreateReq): Promise<ProjectCreateRes> => {
    try {
      const now = Date.now();
      const project = deps.projects.insert({
        id: nanoid(),
        name: req.name,
        genre: req.genre,
        ...(req.description != null ? { description: req.description } : {}),
        createdAt: now,
        updatedAt: now,
      });
      // 项目维度绑定默认工作流（§9.1 主循环图模板深拷贝）
      if (deps.defaultWorkflow !== undefined) {
        try {
          deps.workflows.insert({
            id: nanoid(),
            projectId: project.id,
            name: deps.defaultWorkflow.name,
            nodes: structuredClone(deps.defaultWorkflow.nodes),
            edges: structuredClone(deps.defaultWorkflow.edges),
            version: deps.defaultWorkflow.version,
          });
        } catch (err) {
          console.warn('[novel-forge] 默认工作流绑定失败（项目已创建）：', err);
        }
      }
      return { ok: true, project };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 收尾新增：项目入口页列表（updatedAt 降序，附默认工作流 id）
  ipcMain.handle('project:list', async (): Promise<ProjectListRes> => {
    try {
      const projects: ProjectListItem[] = deps.projects
        .list()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((p) => {
          // listByProject 已按 updated_at 降序，取首条即该项目最新工作流
          const wf = deps.workflows.listByProject(p.id)[0];
          return { ...p, ...(wf !== undefined ? { defaultWorkflowId: wf.id } : {}) };
        });
      return { ok: true, projects };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('project:get', async (_event, req: ProjectGetReq): Promise<ProjectGetRes> => {
    try {
      const project = deps.projects.get(req.id);
      if (!project) {
        return { ok: false, error: `项目不存在: ${req.id}` };
      }
      return { ok: true, project };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
