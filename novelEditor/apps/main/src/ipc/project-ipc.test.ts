/** 收尾 IPC 单测：project:list（updatedAt 降序 + defaultWorkflowId 回填）
 *
 * electron 的 ipcMain 被 vi.mock 为内存 handler 表（同 phase6-ipc.test.ts 口径）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectListItem } from '@novel-forge/shared';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, req: unknown) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(ch, fn);
    },
  },
}));

import { openDatabase, type AppDatabase } from '../db/index.js';
import { ProjectsRepository } from '../db/repositories/projects.js';
import { WorkflowsRepository } from '../db/repositories/workflows.js';
import type { DefaultWorkflowGraph } from '../workflow/default-workflow.js';
import { registerProjectIpc } from './project.js';

let db: AppDatabase;

const DEFAULT_WORKFLOW: DefaultWorkflowGraph = {
  name: '主循环',
  version: 1,
  nodes: [{ id: 'ctx', type: 'input.context', position: { x: 0, y: 0 }, params: {} }],
  edges: [],
};

interface ListRes {
  ok: boolean;
  error?: string;
  projects?: ProjectListItem[];
}

interface CreateRes {
  ok: boolean;
  error?: string;
  project?: { id: string };
}

function call<T>(channel: string, req?: unknown): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler ${channel} 未注册`);
  return fn(null, req) as Promise<T>;
}

beforeEach(async () => {
  db = await openDatabase(':memory:');
  handlers.clear();
  registerProjectIpc({
    projects: new ProjectsRepository(db),
    workflows: new WorkflowsRepository(db),
    defaultWorkflow: DEFAULT_WORKFLOW,
  });
});

describe('project:list', () => {
  it('按 updatedAt 降序返回，并回填各项目默认工作流 id', async () => {
    const projects = new ProjectsRepository(db);
    const workflows = new WorkflowsRepository(db);
    projects.insert({ id: 'p-old', name: '旧项目', genre: '玄幻', createdAt: 1000, updatedAt: 1000 });
    projects.insert({ id: 'p-new', name: '新项目', genre: '科幻', createdAt: 2000, updatedAt: 2000 });
    workflows.insert({
      id: 'wf-old', projectId: 'p-old', name: '主循环',
      nodes: DEFAULT_WORKFLOW.nodes, edges: DEFAULT_WORKFLOW.edges, version: 1,
    });
    workflows.insert({
      id: 'wf-new', projectId: 'p-new', name: '主循环',
      nodes: DEFAULT_WORKFLOW.nodes, edges: DEFAULT_WORKFLOW.edges, version: 1,
    });

    const res = await call<ListRes>('project:list');
    expect(res.ok).toBe(true);
    expect(res.projects?.map((p) => p.id)).toEqual(['p-new', 'p-old']);
    // defaultWorkflowId 非空且对应该项目的工作流
    expect(res.projects?.[0]?.defaultWorkflowId).toBe('wf-new');
    expect(res.projects?.[1]?.defaultWorkflowId).toBe('wf-old');
  });

  it('project:create 播种默认工作流后，list 回填的 defaultWorkflowId 非空', async () => {
    const created = await call<CreateRes>('project:create', { name: '甲', genre: '武侠' });
    expect(created.ok).toBe(true);

    const res = await call<ListRes>('project:list');
    expect(res.ok).toBe(true);
    expect(res.projects).toHaveLength(1);
    const item = res.projects?.[0];
    expect(item?.id).toBe(created.project?.id);
    expect(item?.defaultWorkflowId).toBeTruthy();
  });

  it('无工作流的项目 defaultWorkflowId 缺省（播种失败口径）', async () => {
    new ProjectsRepository(db).insert({
      id: 'p-bare', name: '裸项目', genre: '其他', createdAt: 1, updatedAt: 1,
    });
    const res = await call<ListRes>('project:list');
    expect(res.ok).toBe(true);
    expect(res.projects?.[0]?.defaultWorkflowId).toBeUndefined();
  });
});
